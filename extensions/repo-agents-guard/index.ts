import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
	AGENTS_FILE,
	canonicalPath,
	expandHome,
	findGovernedRepo,
	isAgentsReadPath,
	type GovernedRepo,
} from "./paths.ts";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const CHILD_TOOLS = new Set(["subagent", "subagent_spawn", "delegate"]);

function shellPathCandidates(command: string, cwd: string): string[] {
	const candidates = [cwd];
	const absolutePaths = /(?:^|[\s="'`])((?:~\/|\/)[^\s"'`;|&()<>]+)/g;
	for (const match of command.matchAll(absolutePaths)) candidates.push(match[1].replace(/[),.;]+$/, ""));

	const directoryArguments = /\b(?:cd|git\s+(?:-C|--git-dir|--work-tree)\s*=?)[ \t]+(?:--[ \t]+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
	for (const match of command.matchAll(directoryArguments)) {
		const value = match[1] ?? match[2] ?? match[3];
		if (value) candidates.push(value);
	}
	return candidates;
}

function inputValues(input: Record<string, unknown>): string[] {
	const values: string[] = [];
	for (const value of Object.values(input)) {
		if (typeof value === "string") values.push(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") values.push(item);
				if (item && typeof item === "object") values.push(...inputValues(item as Record<string, unknown>));
			}
		}
	}
	return values;
}

function targetPaths(event: ToolCallEvent, cwd: string): string[] {
	const input = event.input as Record<string, unknown>;
	if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
		return shellPathCandidates(typeof input.command === "string" ? input.command : "", cwd);
	}

	if (PATH_TOOLS.has(event.toolName)) {
		return typeof input.path === "string" ? [input.path] : [];
	}

	if (CHILD_TOOLS.has(event.toolName)) {
		const paths = [cwd];
		if (typeof input.cwd === "string") paths.push(input.cwd);
		for (const value of inputValues(input)) paths.push(...shellPathCandidates(value, cwd));
		return paths;
	}

	return typeof input.cwd === "string" ? [input.cwd] : [];
}

function governedTargets(event: ToolCallEvent, cwd: string): GovernedRepo[] {
	const repos = new Map<string, GovernedRepo>();
	for (const target of targetPaths(event, cwd)) {
		const repo = findGovernedRepo(target, cwd);
		if (repo) repos.set(repo.agentsPath, repo);
	}
	return [...repos.values()];
}

function isAgentsRead(event: ToolCallEvent, repo: GovernedRepo, cwd: string): boolean {
	return isToolCallEventType("read", event) && isAgentsReadPath(event.input.path, repo, cwd);
}

export default function (pi: ExtensionAPI) {
	const confirmed = new Set<string>();
	const pendingReads = new Map<string, string>();

	pi.on("before_agent_start", (event, ctx) => {
		for (const file of event.systemPromptOptions.contextFiles ?? []) {
			if (basename(expandHome(file.path)) !== AGENTS_FILE) continue;
			const path = canonicalPath(file.path, ctx.cwd);
			const repo = findGovernedRepo(path, ctx.cwd);
			if (repo?.agentsPath === path) confirmed.add(repo.agentsPath);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const repos = governedTargets(event, ctx.cwd);
		for (const repo of repos) {
			if (confirmed.has(repo.agentsPath)) continue;
			if (isAgentsRead(event, repo, ctx.cwd)) {
				pendingReads.set(event.toolCallId, repo.agentsPath);
				continue;
			}
			return {
				block: true,
				reason: `Read ${repo.displayPath} with the read tool before using tools in ${repo.root}.`,
			};
		}
	});

	pi.on("tool_result", (event) => {
		const agentsPath = pendingReads.get(event.toolCallId);
		if (!agentsPath) return;
		pendingReads.delete(event.toolCallId);
		if (!event.isError) confirmed.add(agentsPath);
	});
}
