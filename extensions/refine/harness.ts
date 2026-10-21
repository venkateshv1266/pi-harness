/**
 * Multi-kind proposal plumbing for refine: parsing, coverage, staging,
 * arming and rollback. Kept free of pi imports so it is unit-testable with
 * temp directories; the extension entry point owns prompts, Jev and the TUI.
 *
 * Staging is inert by construction: everything lands under
 * `<refineRoot>/staging/<kind>/<name>/` and nothing reaches the live harness
 * until the user arms it in /refine-review.
 */

import { cp, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	HARNESS_KINDS,
	KIND_SPECS,
	PROPOSABLE_KINDS,
	applySettingsPatch,
	bundleHash,
	contentHash,
	describeSettingsPatch,
	extensionPairing,
	isSlug,
	primaryContent,
	stagingDir,
	stagingFilesDir,
	validateBundle,
	validateExpectation,
	validateSettingsPatch,
	type ExtensionPairing,
	type HarnessKind,
	type ProposalFiles,
	type StagedManifest,
} from "../../utils/harness-surface.ts";
import { runExtensionGate, type ExtensionGateResult } from "./extension-gate.ts";
import { synthesizeFragmentRules } from "../ttsr/registry.ts";

export type Proposal = {
	kind: HarnessKind;
	name: string;
	title: string;
	evidence: string;
	files: ProposalFiles;
	/** Extension-only usage signal: `tool:<name>` or `command:<name>`. */
	expectation?: string;
	/** Planner axis: INV (how the agent works) vs DOM (what a practitioner knows). */
	dimension?: "inv" | "dom";
};

export type Coverage = {
	rules: string[];
	notes: string[];
	contexts: string[];
	agents: string[];
	skills: string[];
	extensions: string[];
	staged: string[];
};

export type CoverageBodies = { rules: { name: string; body: string }[]; others: { name: string; body: string }[] };

export type StagedItem = {
	kind: HarnessKind;
	name: string;
	title: string;
	evidence: string;
	files: ProposalFiles;
	content: string;
	dir: string;
	meta: StagedManifest;
};

export type ArmTarget = { target: string; backup?: string };

export type ArmResult =
	| { ok: true; targets: string[]; armed: ArmTarget[]; backupDir: string }
	| { ok: false; reason: string };

const slugOrThrow = (name: unknown): string | null => (typeof name === "string" && isSlug(name) ? name : null);

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * First reason a bundle would be rejected, or null when it is valid.
 * Context fragments are checked against the ttsr synthesizer that will consume
 * them: a fragment that yields no rule would arm silently and never fire.
 */
export function describeInvalidProposal(kind: HarnessKind, name: string, files: ProposalFiles): string | null {
	const bundle = validateBundle(kind, name, files);
	if (!bundle.ok) return bundle.error;
	if (kind === "extension") {
		const pairing = extensionPairing(files);
		if (!pairing.ok || pairing.pairing.kind !== "context") return null;
		if (synthesizeFragmentRules(pairing.pairing.entry, pairing.pairing.name, `${pairing.pairing.name}.md`).length === 0) {
			return "pairing.yaml synthesizes no TTSR rule — triggers must be objects with a `tool:` key (`- tool: bash`, plus optional `match:` / `globs:`), or set `subagents: true` with `reads:`";
		}
		return null;
	}
	if (kind !== "context") return null;
	const fragment = files["entry.yaml"];
	if (typeof fragment !== "string") return "context bundle is missing entry.yaml";
	if (synthesizeFragmentRules(fragment, name, `${name}.md`).length === 0) {
		return "entry.yaml synthesizes no TTSR rule — triggers must be objects with a `tool:` key (`- tool: bash`, plus optional `match:` / `globs:`), or set `subagents: true` with `reads:`";
	}
	return null;
}

/**
 * Normalize planner/tool output into a bundle. Accepts the legacy
 * `{ kind, name, content }` shape for rule/note so old prompts and staged
 * items keep working, and the bundle shape `{ files: {...} }` for everything.
 * `onError` receives the rejection reason so callers can feed it back to the model.
 */
export function toProposal(input: unknown, onError?: (reason: string) => void): Proposal | null {
	const raw = asRecord(input);
	if (!raw) {
		onError?.("proposal must be an object");
		return null;
	}
	const kind = raw.kind as HarnessKind;
	if (!HARNESS_KINDS.includes(kind)) {
		onError?.(`kind must be one of ${PROPOSABLE_KINDS.join(", ")}`);
		return null;
	}
	const name = slugOrThrow(raw.name);
	if (!name) {
		onError?.("name must be kebab-case");
		return null;
	}

	const filesRaw = asRecord(raw.files);
	let files: ProposalFiles | null = null;
	if (filesRaw) {
		const entries = Object.entries(filesRaw).filter((entry): entry is [string, string] => typeof entry[1] === "string");
		if (entries.length > 0) files = Object.fromEntries(entries);
	} else if (typeof raw.content === "string" && raw.content.trim()) {
		const spec = KIND_SPECS[kind];
		files = { [spec.primaryFile(name, {})]: raw.content.trim() };
	}
	if (!files) {
		onError?.("bundle has no string files");
		return null;
	}

	const invalid = describeInvalidProposal(kind, name, files);
	if (invalid) {
		onError?.(invalid);
		return null;
	}
	const expectation = typeof raw.expectation === "string" ? raw.expectation.trim() : undefined;
	const expectationError = kind === "extension" ? validateExpectation(expectation) : null;
	if (expectationError) {
		onError?.(expectationError);
		return null;
	}

	const rawDimension = typeof raw.dimension === "string" ? raw.dimension.trim().toLowerCase() : "";
	const dimension = rawDimension === "inv" || rawDimension === "invariant" ? "inv" : rawDimension === "dom" || rawDimension === "domain" ? "dom" : undefined;

	return {
		kind,
		name,
		title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : name,
		evidence: typeof raw.evidence === "string" && raw.evidence.trim() ? raw.evidence.trim() : "(no evidence provided)",
		files,
		expectation,
		dimension,
	};
}

export function parseProposals(raw: string): Proposal[] {
	const jsonText = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
	const start = jsonText.indexOf("{");
	const end = jsonText.lastIndexOf("}");
	if (start === -1 || end <= start) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText.slice(start, end + 1));
	} catch (error) {
		if (error instanceof SyntaxError) return [];
		throw error;
	}

	const proposals = (parsed as { proposals?: unknown }).proposals;
	if (!Array.isArray(proposals)) return [];
	return proposals.map((item) => toProposal(item)).filter((p): p is Proposal => p !== null);
}

export const proposalContent = (p: Proposal): string => primaryContent(p.kind, p.name, p.files);

export const proposalHash = (p: Proposal): string => bundleHash(p.kind, p.name, p.files);

export function dedupeProposals(proposals: Proposal[], coverage: Coverage): Proposal[] {
	const known = {
		rule: new Set(coverage.rules),
		note: new Set(coverage.notes),
		context: new Set(coverage.contexts),
		agent: new Set(coverage.agents),
		skill: new Set(coverage.skills),
		extension: new Set(coverage.extensions),
	} as Partial<Record<HarnessKind, Set<string>>>;
	const staged = new Set(coverage.staged);
	return proposals.filter((p) => {
		if (staged.has(`${p.kind}:${p.name}`) || staged.has(p.name)) return false;
		const set = known[p.kind];
		return !set || !set.has(p.name);
	});
}

const normalizedTitle = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cross-kind dedupe, then interleave INV / DOM / unclassified so one dimension
 * cannot crowd the other out of the cap. Order within a dimension is preserved;
 * the cap defaults to the auto loop's 3 proposals per scan.
 */
export function aggregateProposals(proposals: Proposal[], coverage: Coverage, cap = 3): Proposal[] {
	const buckets: Record<"inv" | "dom" | "none", Proposal[]> = { inv: [], dom: [], none: [] };
	const titles = new Set<string>();
	for (const proposal of dedupeProposals(proposals, coverage)) {
		const title = normalizedTitle(proposal.title);
		if (title && titles.has(title)) continue;
		if (title) titles.add(title);
		buckets[proposal.dimension ?? "none"].push(proposal);
	}

	const out: Proposal[] = [];
	const order: ("inv" | "dom" | "none")[] = ["inv", "dom", "none"];
	while (out.length < cap) {
		let progressed = false;
		for (const dimension of order) {
			const next = buckets[dimension].shift();
			if (!next) continue;
			out.push(next);
			progressed = true;
			if (out.length >= cap) break;
		}
		if (!progressed) break;
	}
	return out;
}

async function mdNames(dir: string, suffix = ""): Promise<string[]> {
	try {
		return (await readdir(dir))
			.filter((f) => f.endsWith(`.md${suffix}`))
			.map((f) => f.replace(/\.md.*$/, ""));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function subdirNames(dir: string): Promise<string[]> {
	try {
		const out: string[] = [];
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))) out.push(entry.name);
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function extensionNames(dir: string): Promise<string[]> {
	try {
		const out: string[] = [];
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(dir, entry.name, "index.ts"))) out.push(entry.name);
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function contextIds(contextsDir: string): Promise<string[]> {
	const ids = new Set<string>();
	for (const file of ["registry.yaml", ...(await yamlNames(join(contextsDir, "entries")))]) {
		const abs = file === "registry.yaml" ? join(contextsDir, file) : file;
		let raw: string;
		try {
			raw = await readFile(abs, "utf8");
		} catch (error) {
			// expected: no registry yet, or a fragment removed between readdir and read
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const match of raw.matchAll(/^\s*(?:-\s*)?id\s*:\s*["']?([a-z0-9-]+)["']?\s*$/gm)) ids.add(match[1]);
	}
	return [...ids];
}

async function yamlNames(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((f) => f.endsWith(".yaml")).map((f) => join(dir, f));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function stagedKeys(refineRoot: string): Promise<string[]> {
	const root = join(refineRoot, "staging");
	const keys: string[] = [];
	let kinds: string[];
	try {
		kinds = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	for (const kind of kinds) {
		let names: string[];
		try {
			names = await readdir(join(root, kind));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const name of names) {
			if (HARNESS_KINDS.includes(kind as HarnessKind) && isSlug(name)) {
				keys.push(`${kind}:${name}`, name);
			}
		}
	}
	return keys;
}

export async function listCoverage(agentRoot: string, refineRoot: string, contextsRoot: string): Promise<Coverage> {
	return {
		rules: await mdNames(join(agentRoot, "rules")),
		notes: await mdNames(join(refineRoot, "notes")),
		contexts: await contextIds(contextsRoot),
		agents: await mdNames(join(agentRoot, "agents")),
		skills: await subdirNames(join(agentRoot, "skills")),
		extensions: await extensionNames(join(agentRoot, "extensions")),
		staged: await stagedKeys(refineRoot),
	};
}

async function bodies(dir: string, suffix = ""): Promise<{ name: string; body: string }[]> {
	try {
		const files = (await readdir(dir)).filter((f) => f.endsWith(`.md${suffix}`)).sort().slice(0, 30);
		const out: { name: string; body: string }[] = [];
		for (const f of files) {
			const raw = await readFile(join(dir, f), "utf8");
			out.push({ name: f.replace(/\.md.*$/, ""), body: raw.replace(/\s+/g, " ").trim().slice(0, 300) });
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function readCoverageBodies(agentRoot: string, refineRoot: string): Promise<CoverageBodies> {
	const rules = await bodies(join(agentRoot, "rules"));
	const notes = await bodies(join(refineRoot, "notes"));
	const agents = await bodies(join(agentRoot, "agents"));
	const skills: { name: string; body: string }[] = [];
	for (const name of (await subdirNames(join(agentRoot, "skills"))).sort().slice(0, 15)) {
		const raw = await readFile(join(agentRoot, "skills", name, "SKILL.md"), "utf8");
		skills.push({ name, body: raw.replace(/\s+/g, " ").trim().slice(0, 300) });
	}
	return { rules, others: [...notes, ...agents, ...skills] };
}

export function manifestFor(p: Proposal, meta: Omit<StagedManifest, "kind" | "name" | "title" | "evidence" | "files">): StagedManifest {
	return {
		kind: p.kind,
		name: p.name,
		title: p.title,
		evidence: p.evidence,
		files: p.files,
		...(p.expectation ? { expectation: p.expectation } : {}),
		...meta,
	};
}

/** Write an inert staged bundle. Returns false when this (kind, name) is already staged. */
export async function stageProposal(refineRoot: string, p: Proposal, manifest: StagedManifest): Promise<boolean> {
	const dir = stagingDir(refineRoot, p.kind, p.name);
	if (existsSync(join(dir, "manifest.json"))) return false;
	await mkdir(stagingFilesDir(refineRoot, p.kind, p.name), { recursive: true });
	for (const [rel, content] of Object.entries(p.files)) {
		const target = join(stagingFilesDir(refineRoot, p.kind, p.name), rel);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return true;
}

/** Merge a probe result (extension gate, later rule probes) into a staged manifest. */
export async function updateStagedProbe(refineRoot: string, kind: HarnessKind, name: string, probe: Record<string, unknown>): Promise<void> {
	const file = join(stagingDir(refineRoot, kind, name), "manifest.json");
	let manifest: StagedManifest;
	try {
		manifest = JSON.parse(await readFile(file, "utf8")) as StagedManifest;
	} catch (error) {
		// expected: the item was discarded between staging and the probe write
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	manifest.probe = { ...(manifest.probe ?? {}), ...probe };
	await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readStagedBundle(refineRoot: string, kind: HarnessKind, name: string): Promise<StagedItem | null> {
	const dir = stagingDir(refineRoot, kind, name);
	let manifest: StagedManifest;
	try {
		manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as StagedManifest;
	} catch (error) {
		// expected: no manifest (legacy item or concurrent removal) — not staged in the new layout
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const files = manifest.files ?? {};
	return {
		kind,
		name,
		title: manifest.title ?? name,
		evidence: manifest.evidence ?? "(staged by background auto-refine)",
		files,
		content: primaryContent(kind, name, files),
		dir,
		meta: manifest,
	};
}

export async function listStaged(refineRoot: string): Promise<StagedItem[]> {
	const root = join(refineRoot, "staging");
	let kinds: string[];
	try {
		kinds = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const items: StagedItem[] = [];
	for (const kind of kinds.sort()) {
		if (!HARNESS_KINDS.includes(kind as HarnessKind)) continue;
		let names: string[];
		try {
			names = await readdir(join(root, kind));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const name of names.sort()) {
			if (!isSlug(name)) continue;
			const item = await readStagedBundle(refineRoot, kind as HarnessKind, name);
			if (item) items.push(item);
		}
	}
	return items;
}

/**
 * One-time move of the pre-wave-1 `rules-staging/<name>.md` layout into
 * `staging/rule/<name>/`. Idempotent; returns how many items moved.
 */
export async function migrateLegacyStaging(refineRoot: string): Promise<number> {
	const legacy = join(refineRoot, "rules-staging");
	let entries: string[];
	try {
		entries = await readdir(legacy);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let moved = 0;
	for (const entry of entries.filter((f) => f.endsWith(".md"))) {
		const name = entry.replace(/\.md$/, "");
		if (!isSlug(name)) continue;
		const content = await readFile(join(legacy, entry), "utf8");
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(await readFile(join(legacy, `${name}.meta.json`), "utf8")) as Record<string, unknown>;
		} catch (error) {
			// expected: older staged rules may have no sidecar metadata
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const manifest: StagedManifest = {
			kind: "rule",
			name,
			title: typeof meta.title === "string" ? meta.title : name,
			evidence: typeof meta.evidence === "string" ? meta.evidence : "(staged before multi-kind refine)",
			score: typeof meta.score === "number" ? meta.score : 0,
			parts: (meta.parts as Record<string, number>) ?? { evidence: 0, trigger: 0, novelty: 0 },
			session: typeof meta.session === "string" ? meta.session : "legacy",
			stagedAt: typeof meta.stagedAt === "string" ? meta.stagedAt : new Date().toISOString(),
			trigger: typeof meta.trigger === "string" ? meta.trigger : "legacy",
			tier: meta.tier === "ready" || meta.tier === "near-miss" ? meta.tier : undefined,
			files: { [`${name}.md`]: content },
		};
		const ok = await stageProposal(refineRoot, { kind: "rule", name, title: manifest.title, evidence: manifest.evidence, files: manifest.files }, manifest);
		if (!ok) continue;
		await unlink(join(legacy, entry));
		await rm(join(legacy, `${name}.meta.json`), { force: true });
		moved++;
	}
	await rmdir(legacy).catch(() => {
		// expected: directory not empty (other artifacts) or already gone
	});
	return moved;
}

async function readTextOr(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}

async function backupFile(refineRoot: string, backupDir: string, target: string): Promise<string | undefined> {
	if (!existsSync(target)) return undefined;
	const rel = target.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
	const dest = join(backupDir, "files", rel);
	await mkdir(dirname(dest), { recursive: true });
	await cp(target, dest);
	return dest;
}

export type ArmOptions = {
	agentRoot: string;
	/** Context docs + registry fragments live where the ttsr registry reads them (`~/.pi/contexts`), not under agentRoot. */
	contextsRoot: string;
	refineRoot: string;
	item: StagedItem;
	timestamp?: string;
	/** Cached gate result; arm runs the gate itself when absent. */
	gate?: ExtensionGateResult;
};

/** Arm one staged bundle. Writes a pre-arm backup for every target it touches. */
export async function armProposal({ agentRoot, contextsRoot, refineRoot, item, timestamp, gate }: ArmOptions): Promise<ArmResult> {
	const stamp = timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = join(refineRoot, "backups", `${stamp}-${item.kind}-${item.name}`);
	const armed: ArmTarget[] = [];

	const checkFree = (targets: string[]): string | null => {
		const taken = targets.find((t) => existsSync(t));
		return taken ? `${taken} already exists` : null;
	};

	if (item.kind === "rule") {
		const target = join(agentRoot, "rules", `${item.name}.md`);
		const blocked = checkFree([target]);
		if (blocked) return { ok: false, reason: blocked };
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, item.content.endsWith("\n") ? item.content : `${item.content}\n`, "utf8");
		armed.push({ target });
	} else if (item.kind === "note") {
		const target = join(refineRoot, "notes", `${item.name}.md`);
		const blocked = checkFree([target]);
		if (blocked) return { ok: false, reason: blocked };
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, item.content.endsWith("\n") ? item.content : `${item.content}\n`, "utf8");
		armed.push({ target });
	} else if (item.kind === "context") {
		const docTarget = join(contextsRoot, `${item.name}.md`);
		const entryTarget = join(contextsRoot, "entries", `${item.name}.yaml`);
		const blocked = checkFree([docTarget, entryTarget]);
		if (blocked) return { ok: false, reason: blocked };
		const doc = item.files[`${item.name}.md`];
		const entry = item.files["entry.yaml"];
		if (typeof doc !== "string" || typeof entry !== "string") return { ok: false, reason: "context bundle is incomplete" };
		await atomicWrite(docTarget, doc.endsWith("\n") ? doc : `${doc}\n`);
		await atomicWrite(entryTarget, entry.endsWith("\n") ? entry : `${entry}\n`);
		armed.push({ target: docTarget }, { target: entryTarget });
	} else if (item.kind === "agent") {
		const target = join(agentRoot, "agents", `${item.name}.md`);
		const blocked = checkFree([target]);
		if (blocked) return { ok: false, reason: blocked };
		await atomicWrite(target, item.content.endsWith("\n") ? item.content : `${item.content}\n`);
		armed.push({ target });
	} else if (item.kind === "skill") {
		const target = join(agentRoot, "skills", item.name, "SKILL.md");
		const blocked = checkFree([target]);
		if (blocked) return { ok: false, reason: blocked };
		await atomicWrite(target, item.content.endsWith("\n") ? item.content : `${item.content}\n`);
		armed.push({ target });
	} else if (item.kind === "settings") {
		const target = join(agentRoot, "settings.json");
		const raw = item.files["patch.json"];
		if (typeof raw !== "string") return { ok: false, reason: "settings bundle has no patch.json" };
		const patch = JSON.parse(raw) as Record<string, unknown>;
		const invalid = validateSettingsPatch(patch);
		if (invalid) return { ok: false, reason: invalid };
		const current = JSON.parse(await readTextOr(target) || "{}") as Record<string, unknown>;
		const next = applySettingsPatch(current, patch);
		if (JSON.stringify(next) === JSON.stringify(current)) return { ok: false, reason: "patch changes nothing" };
		const backup = await backupFile(refineRoot, backupDir, target);
		await atomicWrite(target, `${JSON.stringify(next, null, 2)}\n`);
		armed.push({ target, backup });
	} else if (item.kind === "extension") {
		const pairing = extensionPairing(item.files);
		if (!pairing.ok) return { ok: false, reason: pairing.error };
		const result = gate ?? (await runExtensionGate({ name: item.name, files: item.files, expectation: item.meta.expectation }));
		if (!result.ok) return { ok: false, reason: `validation gate failed — ${result.reasons.join("; ")}` };

		const extensionDir = join(agentRoot, "extensions", item.name);
		const extensionDirExisted = existsSync(extensionDir);
		const writes: { target: string; content: string }[] = [
			{ target: join(extensionDir, "index.ts"), content: item.files["index.ts"] },
			{ target: join(extensionDir, "README.md"), content: item.files["README.md"] },
		];
		if (pairing.pairing.kind === "rule") {
			writes.push({ target: join(agentRoot, "rules", `${pairing.pairing.name}.md`), content: pairing.pairing.content });
		} else {
			writes.push({ target: join(contextsRoot, `${pairing.pairing.name}.md`), content: pairing.pairing.doc });
			writes.push({ target: join(contextsRoot, "entries", `${pairing.pairing.name}.yaml`), content: pairing.pairing.entry });
		}
		const blocked = checkFree(writes.map((write) => write.target));
		if (blocked) return { ok: false, reason: blocked };

		const created: string[] = [];
		try {
			for (const write of writes) {
				const backup = await backupFile(refineRoot, backupDir, write.target);
				await atomicWrite(write.target, write.content.endsWith("\n") ? write.content : `${write.content}\n`);
				created.push(write.target);
				armed.push({ target: write.target, backup });
			}
		} catch (error) {
			for (const target of created) {
				await unlink(target).catch(() => {
					// expected: best-effort cleanup after a partial arm
				});
			}
			if (!extensionDirExisted) await rm(extensionDir, { recursive: true, force: true });
			return { ok: false, reason: `arm failed after ${created.length} file(s); nothing was armed: ${error instanceof Error ? error.message : String(error)}` };
		}
	} else {
		return { ok: false, reason: `${item.kind} arming is not implemented yet` };
	}

	return { ok: true, targets: armed.map((a) => a.target), armed, backupDir };
}

/** Preview the human-readable settings diff, or the bundle's files, for review. */
export async function previewArm(agentRoot: string, item: StagedItem): Promise<string[]> {
	if (item.kind !== "settings") return [];
	const raw = item.files["patch.json"];
	if (typeof raw !== "string") return [];
	let patch: Record<string, unknown>;
	try {
		patch = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return ["patch.json is not valid JSON"];
	}
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(await readTextOr(join(agentRoot, "settings.json")) || "{}") as Record<string, unknown>;
	} catch {
		return ["settings.json is not valid JSON — patch cannot be previewed"];
	}
	return describeSettingsPatch(current, patch);
}

/** Restore or remove the files an arm touched. Never throws; reports what happened. */
export async function rollbackArm(entry: { kind: HarnessKind; name: string; armed?: ArmTarget[]; path?: string }): Promise<{ ok: boolean; reason?: string }> {
	const armed = entry.armed ?? (entry.path ? [{ target: entry.path }] : []);
	if (armed.length === 0) return { ok: false, reason: "history entry records no armed files" };
	for (const item of armed) {
		if (item.backup && existsSync(item.backup)) {
			await cp(item.backup, item.target);
		} else {
			try {
				await unlink(item.target);
			} catch (error) {
				// expected: the armed file was already deleted out-of-band
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	return { ok: true };
}

/** Arm-target preview used by the review overlay. */
export async function describeArm(agentRoot: string, contextsRoot: string, item: StagedItem): Promise<string[]> {
	if (item.kind === "settings") return previewArm(agentRoot, item);
	if (item.kind === "extension") {
		const pairing = extensionPairing(item.files);
		if (!pairing.ok) return [pairing.error];
		return [
			`write ${join(agentRoot, "extensions", item.name, "index.ts")}`,
			`write ${join(agentRoot, "extensions", item.name, "README.md")}`,
			pairing.pairing.kind === "rule"
				? `pair rule ${pairing.pairing.name} → ${join(agentRoot, "rules", `${pairing.pairing.name}.md`)}`
				: `pair context ${pairing.pairing.name} → ${join(contextsRoot, `${pairing.pairing.name}.md`)} + entries/`,
		];
	}
	if (item.kind === "context") return [`write ${join(contextsRoot, `${item.name}.md`)}`, `write ${join(contextsRoot, "entries", `${item.name}.yaml`)}`];
	return item.kind === "skill" ? [`write ${join(agentRoot, "skills", item.name, "SKILL.md")}`] : [`write ${join(agentRoot, item.kind === "rule" ? "rules" : `${item.kind}s`, `${item.name}.md`)}`];
}

export { PROPOSABLE_KINDS, KIND_SPECS, contentHash, bundleHash };
