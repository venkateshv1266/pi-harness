/**
 * Instrument anti-cheat: the self-improvement loop may never improve its own
 * report card by blinding, muting, deleting, or fabricating the telemetry it
 * is judged on.
 *
 * The extension gate already hard-rejects any reference to the telemetry store
 * (extensions are code that runs continuously, so the stricter rule is right).
 * Rules, notes, memory entries, contexts, agents and skills are instructions
 * rather than live code, so a plain mention is legitimate ("read
 * jev-decisions/ttsr-jev.jsonl to see outcomes"). What is never legitimate is
 * an instruction or snippet that *removes, redirects, disables, truncates or
 * overwrites* the instruments — or reassigns the outcomes loggers.
 *
 * The scan is deliberately narrow (imperative shell/file-operation shapes and
 * logger reassignment) and carries a negation guard so "never delete
 * jev-decisions" is not mistaken for the thing it forbids.
 */

export type AntiCheatFinding = {
	/** Which rule fired, for the audit trail. */
	pattern: string;
	/** Actionable description shown to the proposer. */
	detail: string;
	/** The matched text, trimmed for review. */
	match: string;
};

const INSTRUMENT = String.raw`(?:jev-decisions|observatory[/\\]server[/\\]adapters|probe\.jsonl|lessons\.jsonl|auto-refine\.jsonl|tsr-jev\.jsonl|ttsr-jev\.jsonl|decision-tuner[/\\]proposals\.jsonl|refine[/\\]history\.jsonl)`;
const NEGATION = /\b(?:never|not|don'?t|do not|must not|no need to|instead of)\b[^.;\n]{0,32}$/i;

type Pattern = { name: string; re: RegExp; detail: string };

const PATTERNS: Pattern[] = [
	{
		name: "shell-delete",
		re: new RegExp(String.raw`(?:^|[\s;|&])(?:rm|mv|truncate|chmod|tee|unlink)\s+[^\n]{0,140}${INSTRUMENT}`, "i"),
		detail: "remove or move the telemetry store or its adapters",
	},
	{
		name: "file-write",
		re: new RegExp(String.raw`(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\s*\([^)\n]{0,180}${INSTRUMENT}`, "i"),
		detail: "write or append to the telemetry store",
	},
	{
		name: "shell-redirect",
		re: new RegExp(String.raw`(?:^|[\s;|&])>{1,2}\s*[^\n]{0,140}${INSTRUMENT}`, "i"),
		detail: "redirect output over the telemetry store",
	},
	{
		name: "suppression-prose",
		re: new RegExp(String.raw`\b(?:suppress|mute|silence|disable|blind|turn off|switch off)\b[^\n]{0,100}${INSTRUMENT}`, "i"),
		detail: "suppress the telemetry instruments",
	},
	{
		name: "prose-delete",
		re: new RegExp(String.raw`\b(?:delete|erase|remove|wipe|truncate|overwrite)\b[^\n]{0,80}${INSTRUMENT}`, "i"),
		detail: "delete or overwrite the telemetry store",
	},
	{
		name: "logger-reassign",
		re: /\b(?:logDecision|logOutcome|logEvent|appendDecision)\s*=(?!=)/,
		detail: "reassign the outcomes logger",
	},
	{
		name: "logger-delete",
		re: /\bdelete\s+[\w.$]*\b(?:logDecision|logOutcome|logEvent|appendDecision)\b/,
		detail: "delete the outcomes logger",
	},
	{
		name: "env-kill-switch",
		re: /\b(?:DEV|PI|JEV)_(?:DISABLE|MUTE|SUPPRESS)_?(?:TELEMETRY|DECISIONS|OUTCOMES)\b/i,
		detail: "introduce a telemetry kill switch",
	},
];

/**
 * Scan proposal text for instrument suppression. Returns every finding; an
 * empty array means the proposal may proceed to the normal gates.
 */
export function scanInstrumentSuppression(text: string): AntiCheatFinding[] {
	if (!text.trim()) return [];
	const findings: AntiCheatFinding[] = [];
	for (const pattern of PATTERNS) {
		const re = new RegExp(pattern.re.source, pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`);
		for (const match of text.matchAll(re)) {
			const index = match.index ?? 0;
			const before = text.slice(Math.max(0, index - 40), index);
			if (NEGATION.test(before)) continue;
			findings.push({
				pattern: pattern.name,
				detail: pattern.detail,
				match: match[0].replace(/\s+/g, " ").trim().slice(0, 160),
			});
		}
	}
	return findings;
}

/** One-line blocker for validation, or null when the text is clean. */
export function instrumentSuppressionError(text: string): string | null {
	const finding = scanInstrumentSuppression(text)[0];
	return finding ? `anti-cheat: proposal tries to ${finding.detail} (${finding.match})` : null;
}
