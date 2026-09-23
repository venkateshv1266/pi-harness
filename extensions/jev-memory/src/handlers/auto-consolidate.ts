/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts), used only when a caller
 * supplies model/modelRegistry access (the manual `/memory-consolidate`
 * command has it; the automatic over-capacity consolidator registered on
 * MemoryStore does not, since MemoryStore itself has no extension-runtime
 * access, so that path stays subprocess-only). Falls back to a `pi -p`
 * subprocess when direct mode is unavailable, declines, or fails.
 *
 * The subprocess child process modifies files on disk, so the parent MUST
 * reload from disk after a subprocess-based consolidation completes.
 */
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  CONSOLIDATION_PROMPT,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { AGENT_ROOT } from "../paths.js";
import { execChildPrompt } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { appendAudit } from "../jev/audit.js";
import { CallBudget, jevCall, type JevState, type JevQuestions } from "../jev/client.js";
import { DEFAULT_JEV_CONFIG, type JevConfig } from "../jev/config.js";
import {
  buildExecutorPlan,
  chunkEntries,
  selectPairs,
  type ConsolidatorEntry,
  type ConsolidatorPair,
  type ExecutorRetire,
} from "../jev/consolidator.js";
import { CONSOLIDATION_QUESTIONS } from "../jev/questions.js";
import { parseMetadataComment } from "../store/sqlite-memory-store.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ConsolidationLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "reviewTransport">;

// staleMs is deliberately decoupled from the consolidation timeout. The holder
// beats every CONSOLIDATION_LOCK_HEARTBEAT_MS while its child runs, so a
// legitimately slow consolidation (up to 2x timeoutMs once retryWithoutOverrides
// fires) never loses its lease, while a holder that stops making progress is
// reclaimable after seconds instead of after its worst-case runtime (#144).
const CONSOLIDATION_LOCK_STALE_MS = 45_000;
const CONSOLIDATION_LOCK_HEARTBEAT_MS = 10_000;
// Contention is usually transient. Poll for the lock the way
// acquireMarkdownMutationLock does instead of hard-failing the memory write
// that triggered auto-consolidation on the very first collision.
const CONSOLIDATION_LOCK_WAIT_MS = 5_000;
const CONSOLIDATION_LOCK_POLL_MS = 50;
const CONSOLIDATION_LOCK_ENV = "PI_HERMES_CONSOLIDATION_LOCK_DIR";
const CONSOLIDATION_LOCK_WAIT_ENV = "PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS";

interface ConsolidationLock {
  release: () => Promise<void>;
}

interface ConsolidationLockAttempt {
  lock: ConsolidationLock | null;
  /** True when the lock was held by someone else on the first attempt. */
  contended: boolean;
  waitedMs: number;
}

function consolidationLockRoot(): string {
  return process.env[CONSOLIDATION_LOCK_ENV]?.trim()
    || path.join(AGENT_ROOT, "jev-memory", ".consolidation-locks");
}

function sanitizeLockPart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "unknown";
}

function consolidationLockKey(target: MemoryTarget, toolTarget: ToolMemoryTarget, storageIdentity: string): string {
  const storageHash = createHash("sha256").update(storageIdentity).digest("hex");
  return `${sanitizeLockPart(toolTarget)}:${sanitizeLockPart(target)}:${storageHash}`;
}

function consolidationLockWaitMs(): number {
  const configured = Number(process.env[CONSOLIDATION_LOCK_WAIT_ENV]);
  return Number.isFinite(configured) && configured >= 0 ? configured : CONSOLIDATION_LOCK_WAIT_MS;
}

async function acquireConsolidationLock(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  waitMs: number = consolidationLockWaitMs(),
): Promise<ConsolidationLockAttempt> {
  const storageIdentity = await store.getStorageIdentity(target);
  const root = consolidationLockRoot();
  await fs.mkdir(root, { recursive: true });
  const coordinator = AtomicLockCoordinator.shared(path.join(root, "locks.sqlite"));
  const key = consolidationLockKey(target, toolTarget, storageIdentity);
  const lockOptions = { staleMs: CONSOLIDATION_LOCK_STALE_MS };

  const startedAt = Date.now();
  let lease = coordinator.tryAcquire(key, lockOptions);
  const contended = !lease;
  if (contended) {
    const deadline = startedAt + waitMs;
    while (!lease && Date.now() < deadline) {
      // Same shape as acquireMarkdownMutationLock; Promise.withResolvers would
      // need an ES2024 lib this project does not target.
      await new Promise((resolve) => setTimeout(resolve, CONSOLIDATION_LOCK_POLL_MS));
      lease = coordinator.tryAcquire(key, lockOptions);
    }
  }

  const waitedMs = Date.now() - startedAt;
  if (!lease) return { lock: null, contended, waitedMs };

  const held = lease;
  const heartbeat = setInterval(() => {
    try {
      held.renew();
    } catch {
      // A missed beat only moves the lease closer to staleMs; the next beat
      // recovers, and a permanently broken lock DB should not crash the run.
    }
  }, CONSOLIDATION_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    lock: {
      release: async () => {
        clearInterval(heartbeat);
        held.release();
      },
    },
    contended,
    waitedMs,
  };
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

function describeConsolidationFailure(
  result: { code: number; stderr?: string; killed?: boolean },
  timeoutMs: number,
): string {
  const stderr = result.stderr?.trim();
  const terminated = result.killed || result.code === 124 || result.code === 143;

  if (terminated) {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Raise consolidationTimeoutMs if consolidation legitimately needs longer.`;
  }

  return `Consolidation process exited with code ${result.code}: ${stderr?.slice(0, 200) || "unknown error"}`;
}

function buildConsolidationPrompt(
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  entries: string[],
): string {
  return [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
    "",
    `Use memory_add, memory_replace, or memory_remove to consolidate. Target: '${toolTarget}'`,
  ].join("\n");
}

// ── JEVCONSOLIDATE: typed retire-only engine ──

const CONSOLIDATOR_MAX_CALLS = 16;
const CONSOLIDATOR_DEADLINE_MS = 60_000;

type JevCallFn = typeof jevCall;

function expandConsolidationQuestions(pairs: ConsolidatorPair[]): JevQuestions {
  const questions: JevQuestions = {};
  for (let p = 0; p < pairs.length; p++) {
    for (const [key, question] of Object.entries(CONSOLIDATION_QUESTIONS)) {
      questions[key.replaceAll("{i}", String(p))] = {
        ...question,
        instructions: question.instructions
          .replaceAll("candidates[{i}]", `candidates[${p}]`)
          .replaceAll("{j}", pairs[p].secondId)
          .replaceAll("{i}", pairs[p].firstId),
      };
    }
  }
  return questions;
}

function buildConsolidationState(chunk: ConsolidatorEntry[], pairs: ConsolidatorPair[]): JevState {
  const byId = new Map(chunk.map((entry) => [entry.id, entry]));
  const entryState = (entry: ConsolidatorEntry) => ({
    id: entry.id,
    content: entry.content,
    created: entry.created,
    last_referenced: entry.lastReferenced,
  });
  return {
    entries: chunk.map(entryState),
    candidates: pairs.map((pair) => ({
      i: pair.firstId,
      j: pair.secondId,
      first: entryState(byId.get(pair.firstId)!),
      second: entryState(byId.get(pair.secondId)!),
    })),
  };
}

export interface TypedConsolidationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  deps?: { jevCall?: JevCallFn; now?: () => Date };
}

export type TypedConsolidationStatus = "applied" | "empty" | "aborted" | "unavailable";

export interface TypedConsolidationOutcome {
  status: TypedConsolidationStatus;
  removed: number;
  shrinkBytes: number;
  chunks: number;
  pairsJudged: number;
  reason?: string;
}

export function shouldAttemptFreestyleFallback(length: number, config: JevConfig): boolean {
  return length <= config.consolidation.freestyleFallbackMaxChars;
}

/** One typed consolidation run for a single target: chunk the raw entries,
 * deterministically select duplicate-ish pairs per chunk, ask Jev about them
 * in batched calls under one budget, then apply all retire decisions as ONE
 * atomic requireShrink mutation plan. Merge verdicts are deferred to audit
 * only in v1 — no free-text rewriting. */
export async function runTypedConsolidation(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  jevConfig: JevConfig = DEFAULT_JEV_CONFIG,
  options: TypedConsolidationOptions = {},
): Promise<TypedConsolidationOutcome> {
  const callJev = options.deps?.jevCall ?? jevCall;
  const now = options.deps?.now ?? (() => new Date());
  const auditEnabled = jevConfig.audit.enabled;

  const rawEntries = store.getRawEntriesForSync(target);
  if (rawEntries.length < 2) {
    return { status: "empty", removed: 0, shrinkBytes: 0, chunks: 0, pairsJudged: 0 };
  }
  const entries: ConsolidatorEntry[] = rawEntries.map((raw, index) => {
    const meta = parseMetadataComment(raw);
    return { id: String(index), content: meta.text, created: meta.created, lastReferenced: meta.lastReferenced };
  });
  const chunks = chunkEntries(entries);
  const budget = new CallBudget(
    CONSOLIDATOR_MAX_CALLS,
    Date.now() + Math.min(options.timeoutMs ?? DEFAULT_CONSOLIDATION_TIMEOUT_MS, CONSOLIDATOR_DEADLINE_MS),
  );

  let processedChunks = 0;
  let pairsJudged = 0;
  let stoppedReason: string | undefined;
  const gathered: ExecutorRetire[] = [];
  let plannedShrinkBytes = 0;

  for (const chunk of chunks) {
    if (options.signal?.aborted) {
      stoppedReason = "signal aborted";
      break;
    }
    processedChunks++;
    const pairs = selectPairs(chunk, { now: now() });
    if (pairs.length === 0) {
      if (auditEnabled) {
        appendAudit({
          ts: new Date().toISOString(),
          decision: "consolidation",
          target: toolTarget,
          outcome: "run",
          scores: { pairs: 0 },
          latency_ms: 0,
        });
      }
      continue;
    }
    const startedAt = Date.now();
    const answers = await callJev(buildConsolidationState(chunk, pairs), expandConsolidationQuestions(pairs), { budget });
    const latencyMs = Date.now() - startedAt;
    if (!answers) {
      // Jev down or budget exhausted: stop after the first null chunk.
      if (auditEnabled) {
        appendAudit({
          ts: new Date().toISOString(),
          decision: "consolidation",
          target: toolTarget,
          outcome: "degraded",
          degraded: true,
          scores: { pairs: pairs.length },
          latency_ms: latencyMs,
        });
      }
      stoppedReason = "jev unavailable";
      break;
    }
    pairsJudged += pairs.length;
    const plan = buildExecutorPlan(chunk, pairs, answers, { now: now() });
    const shrinkBytes = plan.retires.reduce((sum, retire) => sum + retire.oldText.length + ENTRY_DELIMITER.length, 0);
    plannedShrinkBytes += shrinkBytes;
    if (auditEnabled) {
      appendAudit({
        ts: new Date().toISOString(),
        decision: "consolidation",
        target: toolTarget,
        outcome: plan.degraded ? "degraded" : "run",
        degraded: plan.degraded || undefined,
        scores: {
          pairs: pairs.length,
          retires: plan.retires.length,
          merges_deferred: plan.mergeDeferred.length,
          sticky_blocked: plan.stickyBlocked,
          shrink_bytes: shrinkBytes,
        },
        latency_ms: latencyMs,
      });
    }
    gathered.push(...plan.retires);
  }

  if (stoppedReason === "signal aborted") {
    return { status: "unavailable", removed: 0, shrinkBytes: 0, chunks: processedChunks, pairsJudged, reason: stoppedReason };
  }
  if (gathered.length === 0) {
    return stoppedReason
      ? { status: "unavailable", removed: 0, shrinkBytes: 0, chunks: processedChunks, pairsJudged, reason: stoppedReason }
      : { status: "empty", removed: 0, shrinkBytes: 0, chunks: processedChunks, pairsJudged };
  }

  // applyMutationPlan publishes through saveToDisk's displaced-file recovery
  // snapshot (.recovery-*), so the pre-apply snapshot requirement is met by
  // the existing non-destructive mechanism — no new snapshot format.
  // Overlapping retire pairs (one entry losing to several duplicates in a
  // cluster) collapse to one remove op — a repeated remove would match
  // nothing and abort the whole run.
  const plan = [...new Map(gathered.map((retire) => [retire.entryId, retire])).values()];
  const beforeBytes = store.getRawEntriesForSync(target).join(ENTRY_DELIMITER).length;
  const applyStartedAt = Date.now();
  const result = await store.applyMutationPlan(
    target,
    plan.map((retire) => ({ action: "remove" as const, oldText: retire.oldText })),
    { requireShrink: true, signal: options.signal },
  );
  if (!result.success) {
    const reason = result.error ?? "plan did not strictly shrink";
    if (auditEnabled) {
      appendAudit({
        ts: new Date().toISOString(),
        decision: "consolidation",
        target: toolTarget,
        outcome: "aborted",
        scores: { retires: plan.length, planned_shrink_bytes: plannedShrinkBytes },
        latency_ms: Date.now() - applyStartedAt,
        error: reason,
      });
    }
    return { status: "aborted", removed: 0, shrinkBytes: 0, chunks: processedChunks, pairsJudged, reason };
  }
  const shrinkBytes = Math.max(0, beforeBytes - store.getRawEntriesForSync(target).join(ENTRY_DELIMITER).length);
  return { status: "applied", removed: plan.length, shrinkBytes, chunks: processedChunks, pairsJudged };
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: ConsolidationLlmConfig = {},
  directCtx: Pick<ExtensionContext, "model" | "modelRegistry"> | null = null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  jevConfig: JevConfig = DEFAULT_JEV_CONFIG,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion; runTypedConsolidation?: typeof runTypedConsolidation } = {},
): Promise<ConsolidationResult> {
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;
  const runTyped = deps.runTypedConsolidation ?? runTypedConsolidation;
  let typedOutcome: TypedConsolidationOutcome | null = null;

  // JEVCONSOLIDATE — the typed retire-only engine runs ahead of both LLM
  // transports. Only a genuinely applied plan short-circuits; every other
  // outcome falls through to the status-quo freestyle paths below.
  if (jevConfig.enabled && jevConfig.consolidation.enabled) {
    try {
      typedOutcome = await runTyped(store, target, toolTarget, jevConfig, { signal, timeoutMs });
      if (typedOutcome.status === "applied") return { consolidated: true };
    } catch {
      // A typed-engine crash is not a consolidation failure — fall through.
    }
  }

  // Read fresh (post-typed) entries for the LLM prompts.
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);

  if (typedOutcome && !shouldAttemptFreestyleFallback(currentContent.length, jevConfig)) {
    const sizeKb = Math.ceil(currentContent.length / 1000);
    return {
      consolidated: false,
      error: `typed consolidation found nothing to retire (${typedOutcome.pairsJudged} pairs judged); whole-file LLM fallback skipped — target is ${sizeKb}KB (limit ${Math.floor(jevConfig.consolidation.freestyleFallbackMaxChars / 1000)}KB). Raise jev.consolidation thresholds only if you have real duplicates; bulk cleanup needs a retention pass.`,
    };
  }

  if (directCtx && usesDirectTransport(llmConfig)) {
    try {
      const directResult = await runDirect(
        directCtx,
        store,
        toolTarget === "project" ? store : null,
        {
          systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
          userPrompt: [
            `--- Current ${labelForTarget(target, toolTarget)} Entries (target: '${toolTarget}') ---`,
            currentContent || "(empty)",
            "",
            `Only emit operations with "target": "${toolTarget}".`,
          ].join("\n"),
          config: llmConfig,
          timeoutMs,
          signal,
          requireAtomicShrink: true,
          expectedTarget: toolTarget,
        },
        dbManager,
        projectName,
      );
      // Consolidation only did its job if it actually freed space — unlike
      // review/flush/correction, an empty or fully-skipped result here is a
      // failure worth falling back to subprocess for, not a normal outcome.
      if (directResult.ok && directResult.appliedCount > 0) {
        return { consolidated: true };
      }
    } catch {
      // Fall through to subprocess below.
    }
  }

  let lock: ConsolidationLock | null = null;

  try {
    const attempt = await acquireConsolidationLock(store, target, toolTarget);
    lock = attempt.lock;
    if (!lock) {
      // Not a failure: the work is already running in another session. Say so
      // plainly so the memory-write path can ask for a retry instead of
      // reporting a broken consolidation mid-task (#144).
      return {
        consolidated: false,
        deferred: true,
        error: `Consolidation already in progress for target '${toolTarget}' in another session`
          + ` (waited ${attempt.waitedMs}ms). Nothing was consolidated here — retry shortly.`,
      };
    }

    let promptEntries = entries;
    if (attempt.contended) {
      // We queued behind another session's consolidation and it has now
      // finished. If it already freed space, running a second LLM pass here
      // costs a child turn and over-compresses memory for nothing — hand the
      // caller a reload-and-retry instead.
      try {
        await store.loadFromDisk();
        const refreshed = entriesForTarget(store, target);
        if (refreshed.join(ENTRY_DELIMITER).length < currentContent.length) {
          return { consolidated: true };
        }
        promptEntries = refreshed;
      } catch {
        // Reload failed — consolidate the entries we already read instead.
      }
    }

    const result = await execChildPrompt(pi, buildConsolidationPrompt(target, toolTarget, promptEntries), llmConfig, {
      signal,
      timeoutMs,
      retryWithoutOverrides: true,
    }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

    if (result.code === 0) {
      return { consolidated: true };
    }
    return {
      consolidated: false,
      error: describeConsolidationFailure(result, timeoutMs),
    };
} catch (err) {
    const message = String(err);
    if (message.includes("extension ctx is stale")) {
      // Session replaced/reloaded while consolidation was running. The new
      // session re-initializes the store and will consolidate on its own next
      // write, so this is a skip, not a failure — report it as deferred so the
      // caller asks for a retry instead of surfacing a stale-ctx error.
      return {
        consolidated: false,
        deferred: true,
        error: "session replaced or reloaded during consolidation — will consolidate on next write",
      };
    }
    return {
      consolidated: false,
      error: `Consolidation failed: ${message.slice(0, 200)}`,
    };
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* best-effort cleanup */ }
    }
  }
}

/** Scheduled (write-count triggered) consolidation: lock-first, typed engine
 * only. Contention or any Jev failure just stops the run — the LLM freestyle
 * path is reserved for overflow-driven consolidation. */
export async function runScheduledConsolidation(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  jevConfig: JevConfig = DEFAULT_JEV_CONFIG,
  deps: { runTypedConsolidation?: typeof runTypedConsolidation } = {},
): Promise<ConsolidationResult> {
  if (signal?.aborted) return { consolidated: false, error: "aborted before start" };
  if (!jevConfig.enabled || !jevConfig.consolidation.enabled) {
    return { consolidated: false, error: "jev consolidation disabled" };
  }
  const runTyped = deps.runTypedConsolidation ?? runTypedConsolidation;

  let lock: ConsolidationLock | null = null;
  try {
    // Abandon promptly when contended: another session is already consolidating.
    const attempt = await acquireConsolidationLock(store, target, toolTarget, 0);
    lock = attempt.lock;
    if (!lock) {
      return {
        consolidated: false,
        deferred: true,
        error: "consolidation already in progress for this target in another session",
      };
    }
    const typed = await runTyped(store, target, toolTarget, jevConfig, { signal, timeoutMs });
    if (typed.status === "applied" || typed.status === "empty") return { consolidated: true };
    return { consolidated: false, error: typed.reason ?? `typed consolidation ${typed.status}` };
  } catch (err) {
    return { consolidated: false, error: `Scheduled consolidation failed: ${String(err).slice(0, 200)}` };
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectStore: ProjectStoreRef = null,
  projectName: ProjectNameRef = null,
  llmConfig: ConsolidationLlmConfig = {},
  dbManager: DatabaseManager | null = null,
  deps: {
    runDirectMemoryCompletion?: typeof runDirectMemoryCompletion;
    runTypedConsolidation?: typeof runTypedConsolidation;
    /** Called after a target consolidated successfully (e.g. to reset write counters). */
    onTargetConsolidated?: (toolTarget: ToolMemoryTarget) => void;
  } = {},
  jevConfig: JevConfig = DEFAULT_JEV_CONFIG,
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (activeProjectStore) {
        targets.push({
          label: activeProjectName ? `project:${activeProjectName}` : "project",
          store: activeProjectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${item.label}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        const result = await triggerConsolidation(
          pi,
          item.store,
          item.target,
          ctx.signal,
          timeoutMs,
          item.toolTarget,
          llmConfig,
          ctx,
          dbManager,
          activeProjectName,
          jevConfig,
          deps,
        );

        if (result.consolidated) {
          deps.onTargetConsolidated?.(item.toolTarget);
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
