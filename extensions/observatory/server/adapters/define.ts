import * as path from "node:path";
import { decisionsDir } from "../config";
/**
 * Adapter contract. Every harness subsystem is described by one adapter:
 * where its log lives, how to normalize a raw record into the shared event
 * envelope, and which panels/metrics describe it. The server auto-discovers
 * adapter modules from this directory — adding a file here is the only step
 * required to observe a new subsystem.
 */

export type Severity = "info" | "ok" | "warn" | "error";

export interface RawRecord {
	[key: string]: unknown;
}

export interface EventDraft {
	ts: string;
	tsMs?: number;
	kind: string;
	severity: Severity;
	sessionId?: string;
	turn?: number;
	costUsd?: number;
	latencyMs?: number;
	ref?: string;
	title?: string;
	summary?: string;
	data: RawRecord;
}

export interface PanelSpec {
	id: string;
	title: string;
	kind: "kpi" | "timeseries" | "stacked-area" | "bar" | "histogram" | "table" | "sankey" | "timeline" | "list";
	query: string;
	description?: string;
}

export interface Adapter {
	/** Stable id, also used as URL filter value. */
	id: string;
	/** Human name shown in the UI. */
	title: string;
	description: string;
	/** Log path inside the jev-decisions dir (or absolute), or null for non-jsonl sources. */
	file: string | null;
	/** Extension that owns this log, when it differs from the adapter id. */
	extension?: string;
	/** Target table context: decision logs normalize into `events`. */
	channel: "decisions" | "sessions" | "snapshot";
	panels: PanelSpec[];
	map?: (record: RawRecord, lineNo: number) => EventDraft | EventDraft[] | null;
}

export function jsonlAdapter(
	spec: Omit<Adapter, "channel" | "file"> & { file: string; map: (record: RawRecord) => EventDraft | EventDraft[] | null },
): Adapter {
	return { ...spec, file: spec.file, channel: "decisions" };
}

/**
 * Resolve an adapter's log path. Subsystems are free to keep their logs beside
 * the other jev-decisions files or at the agent root, so the adapter says which.
 */
export function adapterFilePath(adapter: Adapter): string | null {
	if (!adapter.file) return null;
	return path.isAbsolute(adapter.file) ? adapter.file : path.join(decisionsDir(), adapter.file);
}

export const info = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function tsMsOf(ts: string): number | undefined {
	const ms = Date.parse(ts);
	return Number.isFinite(ms) ? ms : undefined;
}

export function truncate(text: string | undefined, max = 160): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function tailModel(model: string | undefined): string {
	if (!model) return "?";
	const parts = model.split("/");
	return parts[parts.length - 1] ?? model;
}

export function worst(a: Severity, b: Severity): Severity {
	const rank: Record<Severity, number> = { info: 0, ok: 1, warn: 2, error: 3 };
	return rank[a] >= rank[b] ? a : b;
}
