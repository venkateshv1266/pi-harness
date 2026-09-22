import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';
import { appendAudit } from "../jev/audit.js";
import { CallBudget, jevCall, type JevAnswers, type JevQuestions } from "../jev/client.js";
import { DEFAULT_JEV_CONFIG, type JevConfig } from "../jev/config.js";
import { GATE_CALL_DEADLINE_MS } from "../jev/gates.js";
import { RERANK_QUESTIONS } from "../jev/questions.js";
import { rerankKeep, rerankScore } from "../jev/scoring.js";

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

function expandRerankQuestions(candidateCount: number): JevQuestions {
  const questions: JevQuestions = {};
  for (let i = 0; i < candidateCount; i++) {
    for (const [key, question] of Object.entries(RERANK_QUESTIONS)) {
      questions[key.replaceAll("{i}", String(i))] = {
        ...question,
        instructions: question.instructions.replaceAll("{i}", String(i)),
      };
    }
  }
  return questions;
}

function rerankNoul(answer: unknown): number | undefined {
  if (typeof answer === "number") return answer;
  const noul = (answer as { noul?: unknown } | undefined)?.noul;
  return typeof noul === "number" ? noul : undefined;
}

export interface RerankBlendResult {
  /** Indices into the BM25-ordered candidate list, best blended score first, floor applied. */
  order: number[];
  /** True when Jev was unavailable or any per-candidate answer was missing/malformed. */
  degraded: boolean;
}

/** Pure JEVRERANK rescore: 0.5 · min-max-normalized BM25 rank position +
 * 0.5 · mean(relevance, adds_detail, actionable_now). Null or malformed
 * per-candidate answers keep the identity BM25 order (the caller audits
 * degraded); the floor never reduces the pool below three results. */
export function rerankBlendOrder(candidateCount: number, answers: JevAnswers | null, floor: number): RerankBlendResult {
  const identity = Array.from({ length: candidateCount }, (_, index) => index);
  if (!answers) return { order: identity, degraded: true };
  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < candidateCount; i++) {
    const relevance = rerankNoul(answers[`pair_${i}_relevance`]);
    const addsDetail = rerankNoul(answers[`pair_${i}_adds_detail`]);
    const actionableNow = rerankNoul(answers[`pair_${i}_actionable_now`]);
    if (relevance === undefined || addsDetail === undefined || actionableNow === undefined) {
      return { order: identity, degraded: true };
    }
    const mean = (relevance + addsDetail + actionableNow) / 3;
    scored.push({ index: i, score: rerankScore(i + 1, mean, { maxRank: candidateCount }) });
  }
  const aboveFloor = scored.filter((candidate) => rerankKeep(candidate.score, { rerankFloor: floor }));
  const minKeep = Math.min(3, candidateCount);
  const pool = aboveFloor.length >= minKeep
    ? aboveFloor
    : [...scored].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, minKeep);
  pool.sort((a, b) => b.score - a.score || a.index - b.index);
  return { order: pool.map((candidate) => candidate.index), degraded: false };
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, jevConfig: JevConfig = DEFAULT_JEV_CONFIG): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      // JEVRERANK: fetch an internal over-sample, rescore with one batched Jev
      // call, then trim to the user's limit. Ordering-only post-processing —
      // the SQL/BM25 query itself is untouched, the rendered format is
      // unchanged, and a Jev failure leaves BM25 order exactly as before.
      const rerankActive = jevConfig.enabled && jevConfig.rerank.enabled;
      const searchLimit = rerankActive ? Math.max(limit, jevConfig.rerank.topK) : limit;
      const results = searchMemories(dbManager, query, { project, target, category, limit: searchLimit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let ordered = results;
      if (rerankActive) {
        const startedAt = Date.now();
        const answers = await jevCall(
          { query, candidates: results.map((entry) => ({ id: entry.id, content: entry.content })) },
          expandRerankQuestions(results.length),
          { budget: new CallBudget(1, Date.now() + GATE_CALL_DEADLINE_MS) },
        );
        const blend = rerankBlendOrder(results.length, answers, jevConfig.rerank.floor);
        if (jevConfig.audit.enabled) {
          appendAudit({
            ts: new Date().toISOString(),
            decision: 'rerank',
            target,
            outcome: blend.degraded ? 'degraded' : 'run',
            degraded: blend.degraded || undefined,
            scores: { candidates: results.length, kept: blend.order.length },
            latency_ms: Date.now() - startedAt,
          });
        }
        if (!blend.degraded) ordered = blend.order.map((index) => results[index]!);
      }

      const finalResults = ordered.slice(0, limit);

      let output = `Found ${finalResults.length} memories matching "${query}":\n\n`;

      for (const entry of finalResults) {
        const target = mutationTarget(entry);
        const projectLabel = `scope=${scopeLabel(entry.project)}`;
        const mutationTargetLabel = `[target=${target}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: finalResults.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
