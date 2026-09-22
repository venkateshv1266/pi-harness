import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JevAuditRecord = {
	ts: string;
	decision: "admission" | "pregate" | "correction" | "rerank" | "consolidation";
	target?: string;
	outcome: "allow" | "block" | "skip" | "run" | "degraded" | "cache" | "exact-duplicate" | "aborted";
	/** True when the decision ran status-quo because Jev was unavailable. */
	degraded?: boolean;
	scores?: Record<string, number>;
	latency_ms: number;
	usage?: { input_tokens: number; output_tokens: number };
	error?: string;
};

function auditPath(): string {
	return process.env.JEVM_AUDIT_PATH ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent", "refine", "jev-memory.jsonl");
}
export function appendAudit(record: JevAuditRecord): void {
	try {
		const path = auditPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify(record) + "\n");
	} catch {
		return;
	}
}
export function readAudit(): JevAuditRecord[] {
	try {
		return readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JevAuditRecord);
	} catch {
		return [];
	}
}
