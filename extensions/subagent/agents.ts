/**
 * Agent discovery and configuration (Hybrid Pi + Ralph architecture).
 *
 * Supports flat markdown files:
 *   ~/.pi/agent/agents/<name>.md   (user-level, always loaded)
 *   .pi/agents/<name>.md           (project-level, only with agentScope "project" or "both")
 *   .claude/agents/<name>.md       (project-level, Claude Code compat)
 *
 * Frontmatter schema:
 *   name:          required, lowercase identifier
 *   description:   required, what this agent does and when to use it
 *   tools:         optional, comma-separated string or YAML list of tool names
 *   model:         optional, provider model ID or role alias (@smol, @slow, @plan, @task, @designer)
 *   thinking:      optional, thinking level (off|minimal|low|medium|high|xhigh|max|auto)
 *   spawns:        optional, list of allowed downstream agent names or "*"
 *   output:        optional, JSON schema / JTD defining expected structured output
 *   timeoutMs:     optional, wall-clock limit (e.g., 300000, "5m", "60s"); omit or 0 = infinite
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	spawns?: string[];
	output?: Record<string, unknown>;
	timeoutMs?: number;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	projectAgentDirs: string[];
}

function parseStringList(val: unknown): string[] | undefined {
	if (!val) return undefined;
	if (Array.isArray(val)) {
		const list = val.map((x) => String(x).trim()).filter(Boolean);
		return list.length > 0 ? list : undefined;
	}
	if (typeof val === "string") {
		const list = val.split(",").map((s) => s.trim()).filter(Boolean);
		return list.length > 0 ? list : undefined;
	}
	return undefined;
}

function parseSingleString(val: unknown): string | undefined {
	if (!val) return undefined;
	if (Array.isArray(val)) {
		const first = val[0];
		return first ? String(first).trim() : undefined;
	}
	if (typeof val === "string") {
		const s = val.trim();
		return s || undefined;
	}
	return undefined;
}

function parseTimeout(val: unknown): number | undefined {
	if (typeof val === "number" && !isNaN(val) && val > 0) return val;
	if (typeof val === "string") {
		const str = val.trim().toLowerCase();
		if (str.endsWith("ms")) {
			const n = parseInt(str.slice(0, -2), 10);
			return isNaN(n) ? undefined : n;
		}
		if (str.endsWith("s")) {
			const n = parseInt(str.slice(0, -1), 10);
			return isNaN(n) ? undefined : n * 1000;
		}
		if (str.endsWith("m")) {
			const n = parseInt(str.slice(0, -1), 10);
			return isNaN(n) ? undefined : n * 60 * 1000;
		}
		const num = parseInt(str, 10);
		if (!isNaN(num) && num > 0) return num;
	}
	return undefined;
}

function getSettings(): Record<string, any> {
	try {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		if (fs.existsSync(settingsPath)) {
			return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// Ignore
	}
	return {};
}

export function resolveModelRole(modelSpec?: string): { resolvedModel?: string; role?: string } {
	if (!modelSpec) return {};
	const clean = modelSpec.trim();
	if (!clean) return {};

	const isRole = clean.startsWith("@");
	const roleName = isRole ? clean.slice(1).toLowerCase() : null;

	if (roleName) {
		const settings = getSettings();
		let resolved: string | undefined;
		if (roleName === "smol" || roleName === "fast") {
			resolved =
				process.env.PI_SMOL_MODEL ||
				process.env.PI_FAST_MODEL ||
				settings.smolModel ||
				settings.fastModel ||
				settings.modelRoles?.smol ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "slow" || roleName === "reasoning") {
			resolved =
				process.env.PI_SLOW_MODEL ||
				process.env.PI_REASONING_MODEL ||
				settings.slowModel ||
				settings.reasoningModel ||
				settings.modelRoles?.slow ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "plan") {
			resolved =
				process.env.PI_PLAN_MODEL ||
				process.env.PI_SLOW_MODEL ||
				settings.planModel ||
				settings.slowModel ||
				settings.modelRoles?.plan ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "task") {
			resolved =
				process.env.PI_TASK_MODEL ||
				settings.taskModel ||
				settings.modelRoles?.task ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "designer") {
			resolved =
				process.env.PI_DESIGNER_MODEL ||
				settings.designerModel ||
				settings.modelRoles?.designer ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else {
			resolved = process.env.PI_MODEL || settings.defaultModel;
		}
		return { resolvedModel: resolved, role: `@${roleName}` };
	}

	return { resolvedModel: clean };
}

export function formatOutputSchemaPrompt(outputSchema: Record<string, unknown>): string {
	return [
		"",
		"## Structured Output Specification",
		"You MUST format your final response as valid JSON matching the following schema:",
		"```json",
		JSON.stringify(outputSchema, null, 2),
		"```",
		"Return the JSON object cleanly. Avoid conversational filler before the JSON.",
	].join("\n");
}

export function extractStructuredOutput(text: string): { data?: unknown; error?: string; raw: string } {
	const trimmed = text.trim();
	if (!trimmed) return { error: "Empty output", raw: text };

	try {
		return { data: JSON.parse(trimmed), raw: text };
	} catch {
		// Not top-level JSON, proceed to extract
	}

	const jsonFenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
	const match = jsonFenceRegex.exec(trimmed);
	if (match && match[1]) {
		try {
			return { data: JSON.parse(match[1].trim()), raw: text };
		} catch (e: any) {
			return { error: `Malformed JSON in code block: ${e.message}`, raw: text };
		}
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		try {
			return { data: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)), raw: text };
		} catch {
			// Ignore
		}
	}

	return { error: "Could not extract valid JSON from response", raw: text };
}

function parseAgentFile(filePath: string, source: "user" | "project"): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, any>>(content);

	if (!frontmatter || !frontmatter.name || !frontmatter.description) {
		return null;
	}

	const tools = parseStringList(frontmatter.tools);
	const model = parseSingleString(frontmatter.model);
	const thinking = parseSingleString(frontmatter.thinking || frontmatter.thinkingLevel);
	const spawns = parseStringList(frontmatter.spawns);
	const output =
		typeof frontmatter.output === "object" && frontmatter.output !== null
			? (frontmatter.output as Record<string, unknown>)
			: undefined;
	const timeoutMs = parseTimeout(frontmatter.timeoutMs || frontmatter.timeout);

	return {
		name: String(frontmatter.name).trim(),
		description: String(frontmatter.description).trim(),
		tools,
		model,
		thinking,
		spawns,
		output,
		timeoutMs,
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const cfg = parseAgentFile(path.join(dir, entry.name), source);
		if (cfg) agents.push(cfg);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findProjectAgentDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	let currentDir = cwd;
	while (true) {
		const piCandidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(piCandidate)) {
			const real = tryReal(piCandidate);
			if (real && !seen.has(real)) {
				seen.add(real);
				dirs.push(real);
			}
		}

		const claudeCandidate = path.join(currentDir, ".claude", "agents");
		if (isDirectory(claudeCandidate)) {
			const real = tryReal(claudeCandidate);
			if (real && !seen.has(real)) {
				seen.add(real);
				dirs.push(real);
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return dirs;
}

function tryReal(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentDirs = scope === "user" ? [] : findProjectAgentDirs(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents: AgentConfig[] = [];
	for (const dir of projectAgentDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectAgents.push(agent);
		}
	}

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir: projectAgentDirs[0] ?? null,
		projectAgentDirs,
	};
}
