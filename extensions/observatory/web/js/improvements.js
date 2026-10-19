// Improvements — the single monitoring surface for the self-improvement loop.
//
// It answers three questions in order:
//   1. What needs me now?      → attention queue (staged edits, probe issues, prunes)
//   2. Did the harness improve? → today vs yesterday + day-over-day comparison
//   3. What happened, exactly?  → day strip, ledger, staged detail, raw drill-through
//
// The operational depth that used to live on the Refine page (run mixes, gate
// calibration, recent decisions) stays here, collapsed under "Loop diagnostics"
// so the default view is a morning glance, not a log viewer.
import { api, clear, fmtInt, h, openDrawer, timeAgo } from "./util.js";
import { spark } from "./charts.js";
import { bars, banner, card, chip, emptyState, helpButton, kpi, pill, table } from "./ui.js";
import { state } from "./pages.js";

const HELP = {
	title: "Improvements",
	what: "The self-improvement loop in one place: what it staged and armed, whether the change held (probe, rule survival, extension adoption), the lessons it distilled, and what needs your review right now.",
	formula: "Daily snapshots are materialized from refine's audit/history, TTSR outcomes, the tuner's proposal log, probe records and session tool calls. Rates compare as percentage points. The review queue and diagnostics read the live refine/tuner state, not the snapshot.",
	source: "~/.pi/agent/observatory/snapshots/YYYY-MM-DD.json plus ~/.pi/agent/jev-decisions/{refine,probe,lessons}.jsonl and the tuner's proposals.jsonl.",
	action: "Start at the attention row: arm/reject staged edits with /refine-review, measure with /refine-probe, apply or dismiss prunes with /decision-tuner list. Then read the day-over-day delta for whether the last change held.",
	queue: {
		title: "Review queue",
		what: "Behavioural proposals the auto loop staged but did not arm. Nothing here is live; each item waits for your Enter in /refine-review.",
		formula: "Items under ~/.pi/agent/jev-decisions/refine/staging/<kind>/<name>/, split by Jev tier: ready clears every per-part floor; near-miss failed a floor but stays reviewable.",
		source: "~/.pi/agent/jev-decisions/refine/staging/**/manifest.json.",
		action: "Arm what the evidence supports, reject what it does not (d d), or close the overlay to leave it staged for the next probe sweep.",
	},
	probe: {
		title: "Probe issues",
		what: "Staged rules/contexts whose trigger measured badly on the fixture corpus, plus extensions whose validation gate failed.",
		formula: "false-positive = the trigger fired on benign fixtures; gate fail = compile/fake-pi/safety rejected the extension. 'unmeasured' means the corpus has no fixture for that trigger — not a failure.",
		source: "manifest.probe.rules and manifest.probe.gate in each staged bundle.",
		action: "Narrow the trigger (or add a verify gate) and re-stage; for extensions fix the gate reason. /refine-probe re-measures on demand.",
	},
	prunes: {
		title: "Open prunes",
		what: "Tuner proposals to disable something that is not earning its keep: a rule that never fired, or an extension armed 14+ days with no observed use. This is a proposal count in the selected window, not prunes already applied; older still-open proposals are noted separately.",
		formula: "Open (status=open) prune proposals created inside the selected window. Rule prune: ≥20 evaluations with 0 delivered fires. Extension prune: armed ≥14 days with no tool:/command: call in the 30-day session window.",
		source: "~/.pi/agent/jev-decisions/decision-tuner/proposals.jsonl.",
		action: "Review with /decision-tuner list, then apply <id> (renames to .disabled; rename back to re-enable) or dismiss <id> (30-day cooldown).",
	},
	snapshot: {
		title: "Last snapshot",
		what: "The most recent daily snapshot — the materialized view behind the day strip and the N vs N−1 comparison.",
		formula: "Written once per UTC day on the first refine turn or observatory start, from refine audit/history, TTSR outcomes, probe records, the lesson library and session tool calls. Never rewritten; raw logs stay the source of truth.",
		source: "~/.pi/agent/observatory/snapshots/YYYY-MM-DD.json.",
		action: "If it looks stale, open a pi session (refine writes it on turn end) or restart the observatory. '0 probe runs' means no stage-write/sweep/command probe ran that day.",
	},
	staged: {
		title: "Staged now",
		what: "Every proposal waiting for review, across all kinds: rules, notes, memory entries, context entries, subagents, skills, settings patches and new extensions. The auto loop writes them here; /refine applies manual proposals directly.",
		formula: "Read from staging/<kind>/<name>/manifest.json. Sorted by risk: false-positive/gate-fail first, then near-miss, then unmeasured, then ready. Kind chips filter without changing the sort.",
		source: "~/.pi/agent/jev-decisions/refine/staging/.",
		action: "View opens the primary file, Meta the manifest (Jev parts, probe details, arm targets). Arm with /refine-review; nothing is live until then.",
	},
	armed: {
		title: "Armed",
		what: "Harness edits that became live on this snapshot's day. Grouped by kind; hover the summary for names.",
		formula: "Distinct items recorded in refine/history.jsonl with a timestamp that day and no rollback.",
		source: "~/.pi/agent/jev-decisions/refine/history.jsonl.",
		action: "If an armed item was wrong, /refine-history rolls it back from the pre-arm backup.",
	},
	stagedKpi: {
		title: "Staged",
		what: "Behavioural proposals written to staging that day. They are inert — the number is a queue, not a live change.",
		formula: "Distinct staged bundles with a stagedAt date that day, by kind.",
		source: "~/.pi/agent/jev-decisions/refine/staging/**/manifest.json.",
		action: "Clear the queue in /refine-review; near-miss items usually need a narrower trigger.",
	},
	ruleProbe: {
		title: "Rule probe",
		what: "How staged rules/contexts did on the fixture corpus that day: the share of expected hits that actually fired.",
		formula: "hits ÷ expected over probe records in the day. False positives are trigger hits on benign fixtures; 'unmeasured' means the corpus has no fixture for that trigger.",
		source: "~/.pi/agent/jev-decisions/probe.jsonl.",
		action: "Below 100% means a trigger missed a planted trap; false positives mean it is too broad. Re-measure with /refine-probe.",
	},
	survival: {
		title: "Rule survival",
		what: "Of the armed TTSR rules that fired and got a resolved outcome, the share the agent did not repeat or get corrected on. This is behaviour change, not firing frequency.",
		formula: "survived ÷ total resolved outcomes (survived + retried + user_corrected + repeated + unresolved). Each fire is observed for 3 turns; an unresolved fire counts against survival.",
		source: "~/.pi/agent/jev-decisions/ttsr-jev.jsonl outcome records.",
		action: "A low rate means rules fire but do not stick — reword the body/trigger or prune. A high rate on few outcomes is a small sample, not proof.",
	},
	lessons: {
		title: "Lessons",
		what: "Durable lessons distilled from outcomes (rollback, gate-block, probe false-positive, prune), grouped by proposal domain and fed back into the planner prompt. Most days add zero — that is NO_ENTRY by design.",
		formula: "added = library entries created that day; recalled = distinct lesson ids injected into proposals that day; library present = ~/.pi/agent/harness-library exists.",
		source: "~/.pi/agent/harness-library/**/entries/*.md plus history/audit 'recalled' fields.",
		action: "Read the domain INDEX.md; a lesson that keeps being recalled but no longer applies can be deleted.",
	},
	extensions: {
		title: "Extensions used",
		what: "Adoption of armed extensions, not extension proposals: how many armed extensions were actually called, versus armed extensions with no observed call.",
		formula: "used = the expectation (tool:<name> or command:<name>) appears in session tool calls/mentions; silent = armed with no observed use. 'armed' is the denominator.",
		source: "refine/history.jsonl extension entries plus session logs.",
		action: "A silent extension is the failure this page exists to catch; the tuner proposes a prune after 14 silent days.",
	},
	tuning: {
		title: "Tuning proposals",
		what: "The decision-tuner's weekly pass: rules to prune, triggers to reword, and config knobs to review, each with the evidence behind it. Prunes are applyable; the rest are advisory.",
		formula: "Runs, proposals and statuses come from the tuner's audit and proposal logs, filtered to the selected window. Open prunes are also surfaced in the attention row.",
		source: "~/.pi/agent/jev-decisions/decision-tuner/{proposals,tuner}.jsonl.",
		action: "Apply a prune (renames to .disabled; rename back to re-enable) or dismiss it for a 30-day cooldown. Advisory proposals explain why nothing is applied automatically.",
	},
	diagnostics: {
		title: "Loop diagnostics",
		what: "The refinement loop's own behaviour in the selected window: what it concluded each run, where it spent effort, how close rule proposals came to the Jev floors, and the recent audit trail.",
		formula: "Counts come from refine/auto-refine.jsonl; gate calibration re-derives bands from the logged part scores and the current floors.",
		source: "~/.pi/agent/jev-decisions/refine/auto-refine.jsonl.",
		action: "A part whose max never reaches its floor means the floor is unreachable; near-miss filling while ready stays empty means the trigger requirement is the binding constraint.",
	},
};

const pct = (rate) => (typeof rate === "number" ? `${Math.round(rate * 100)}%` : "—");

const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: Number.POSITIVE_INFINITY };
const rangeMs = () => RANGE_MS[state.range] ?? RANGE_MS["7d"];
const rangeLabel = () => (state.range && RANGE_MS[state.range] ? state.range : "7d");
const inWindow = (ts) => {
	const ms = rangeMs();
	if (!Number.isFinite(ms)) return true;
	const value = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
	return Number.isFinite(value) && value >= Date.now() - ms;
};
const daysInWindow = (days) => days.filter((day) => inWindow(`${day.date}T23:59:59.999Z`));

const METRIC_SPECS = [
	{ key: "ruleProbeRate", label: "Rule probe hit rate", unit: "pp", good: "up", get: (s) => s.probe?.rules?.passRate ?? null },
	{ key: "ruleSurvival", label: "Rule survival", unit: "pp", good: "up", get: (s) => s.ruleOutcomes?.survivalRate ?? null },
	{ key: "probeRate", label: "Extension gate pass", unit: "pp", good: "up", get: (s) => s.probe?.rate ?? null },
	{ key: "armed", label: "Armed", unit: "count", good: "neutral", get: (s) => s.counts?.armed ?? null },
	{ key: "staged", label: "Staged", unit: "count", good: "neutral", get: (s) => s.staged?.total ?? null },
	{ key: "rolledBack", label: "Rolled back", unit: "count", good: "down", get: (s) => s.counts?.rolledBack ?? null },
	{ key: "pruned", label: "Pruned", unit: "count", good: "neutral", get: (s) => s.counts?.pruned ?? null },
	{ key: "lessonsAdded", label: "Lessons added", unit: "count", good: "neutral", get: (s) => s.lessons?.added ?? null },
	{ key: "lessonsRecalled", label: "Lessons recalled", unit: "count", good: "up", get: (s) => s.lessons?.recalled ?? null },
	{ key: "extensionsUsed", label: "Extensions used", unit: "count", good: "up", get: (s) => s.extensions?.used?.length ?? null },
	{ key: "extensionsSilent", label: "Extensions silent", unit: "count", good: "down", get: (s) => s.extensions?.silent?.length ?? null },
];

const metricValue = (value, unit) => (value === null || value === undefined ? "—" : unit === "pp" ? pct(value) : fmtInt(value));
const metricDelta = (delta, unit) => {
	if (delta === null || delta === undefined) return "—";
	const sign = delta > 0 ? "+" : "";
	return unit === "pp" ? `${sign}${delta.toFixed(1)} pp` : `${sign}${fmtInt(delta)}`;
};
const deltaTone = (spec, delta) => {
	if (delta === null || delta === undefined || delta === 0 || spec.good === "neutral") return "neutral";
	if (spec.good === "up") return delta > 0 ? "ok" : "warn";
	return delta > 0 ? "warn" : "ok";
};

function metricsBetween(from, to) {
	return METRIC_SPECS.map((spec) => {
		const a = from ? spec.get(from) : null;
		const b = to ? spec.get(to) : null;
		const delta = a === null || b === null ? null : spec.unit === "pp" ? (b - a) * 100 : b - a;
		return { ...spec, from: a, to: b, delta };
	});
}

const changedLabel = (snapshot) => {
	const parts = [];
	const armed = Object.values(snapshot.armed ?? {}).flat();
	if (armed.length) parts.push(`armed ${armed.length}`);
	if (snapshot.rolledBack?.length) parts.push(`rolled back ${snapshot.rolledBack.length}`);
	if (snapshot.pruned?.length) parts.push(`pruned ${snapshot.pruned.length}`);
	return parts.length ? parts.join(" · ") : "no change";
};

const changedTooltip = (snapshot) => {
	const parts = [];
	for (const [kind, names] of Object.entries(snapshot.armed ?? {})) if (names.length) parts.push(`armed ${kind}: ${names.join(", ")}`);
	if (snapshot.rolledBack?.length) parts.push(`rolled back ${snapshot.rolledBack.join(", ")}`);
	if (snapshot.pruned?.length) parts.push(`pruned ${snapshot.pruned.join(", ")}`);
	return parts.length ? parts.join("\n") : "no change";
};

const armedSummary = (snapshot) => {
	const parts = Object.entries(snapshot.armed ?? {})
		.filter(([, names]) => names.length)
		.map(([kind, names]) => `${names.length} ${kind}`);
	return parts.length ? parts.join(" · ") : "nothing armed";
};

const armedTooltip = (snapshot) =>
	Object.entries(snapshot.armed ?? {})
		.filter(([, names]) => names.length)
		.map(([kind, names]) => `${kind}: ${names.join(", ")}`)
		.join("\n");

const digestLabel = (snapshot) =>
	snapshot.digestChanged ? `Δ ${(snapshot.digestFrom ?? "?").slice(0, 8)} → ${(snapshot.digest ?? "?").slice(0, 8)}` : (snapshot.digest ?? "—").slice(0, 8);

const probeCell = (snapshot) => {
	const probe = snapshot.probe?.rules;
	if (!probe || probe.passRate === null) return h("span", { class: "small faint" }, "—");
	return h(
		"span",
		{ "data-tip": `${probe.hits}/${probe.expected} expected hit · ${probe.falsePositives} false positive(s) · ${probe.runs} run(s)` },
		pill(pct(probe.passRate), probe.passRate >= 0.8 ? "ok" : probe.passRate >= 0.5 ? "warn" : "error"),
		h("span", { class: "small faint" }, ` ${probe.hits}/${probe.expected}`),
	);
};

const survivalCell = (snapshot) => {
	const mix = snapshot.ruleOutcomes ?? {};
	if (!mix.total) return h("span", { class: "small faint" }, "—");
	return h(
		"span",
		{ "data-tip": `${mix.survived} survived · ${mix.retried} retried · ${mix.user_corrected} corrected · ${mix.repeated} repeated` },
		pill(pct(mix.survivalRate), mix.survivalRate >= 0.7 ? "ok" : mix.survivalRate >= 0.4 ? "warn" : "error"),
		h("span", { class: "small faint" }, ` ${mix.total}`),
	);
};

const lessonCell = (snapshot) => {
	const lessons = snapshot.lessons ?? {};
	if (!lessons.added && !lessons.recalled) return h("span", { class: "small faint" }, "—");
	return h("span", { class: "small" }, `+${fmtInt(lessons.added)}`, h("span", { class: "faint" }, ` / ${fmtInt(lessons.recalled)} recalled`));
};

async function openRaw(path, title) {
	if (!path) return;
	try {
		const result = await api("/api/file", { path });
		if (result.error) {
			openDrawer({ title, body: h("div", { class: "small muted" }, result.error) });
			return;
		}
		openDrawer({
			title,
			sub: path,
			body: h("pre", { class: "mono small", style: { whiteSpace: "pre-wrap", margin: 0 } }, result.content ?? ""),
		});
	} catch (error) {
		openDrawer({ title, body: h("div", { class: "small muted" }, String(error)) });
	}
}

async function openDay(date) {
	try {
		const snapshot = await api("/api/improvements/day", { date });
		openDrawer({
			title: `Snapshot ${date}`,
			sub: "raw materialized view — recomputable from the decision logs",
			body: h("pre", { class: "mono small", style: { whiteSpace: "pre-wrap", margin: 0 } }, JSON.stringify(snapshot, null, 2)),
		});
	} catch (error) {
		openDrawer({ title: `Snapshot ${date}`, body: h("div", { class: "small muted" }, String(error)) });
	}
}

const region = (build) => {
	const node = h("div");
	return { node, render: (data) => node.replaceChildren(...build(data)) };
};

let compareTo = null;
let compareFrom = null;
let kindFilter = "all";

const probeTone = (row) => {
	if (row.gateOk === false || row.probe?.verdict === "false-positive") return "error";
	if (row.tier === "near-miss" || row.probe?.verdict === "weak") return "warn";
	if (row.probe?.verdict === "pass") return "ok";
	return "neutral";
};

const probeText = (row) => {
	const probe = row.probe;
	if (!probe) return "not measured";
	if (probe.expected > 0) return `${probe.hits}/${probe.expected} hit · ${probe.falsePositives} false-pos`;
	if (probe.verdict === "unmeasured") return "unmeasured";
	return `${probe.verdict} · ${probe.falsePositives} false-pos`;
};

export async function improvementsPage(view, ctx) {
	const load = async () => {
		const results = await Promise.allSettled([
			api("/api/improvements"),
			api("/api/refine", { from: rangeLabel() }),
			api("/api/tuner", { from: rangeLabel() }),
		]);
		const [snapshots, refine, tuner] = results.map((result) => (result.status === "fulfilled" ? result.value : null));
		return {
			snapshots: snapshots ?? { days: [], latest: null, previous: null, compare: { from: null, to: null, metrics: [] } },
			refine: refine ?? { staging: [], proposals: [], byDecision: {}, byStage: {}, artifacts: [], gate: null, runs: 0 },
			tuner: tuner ?? { proposals: [] },
			partial: results.some((result) => result.status === "rejected"),
		};
	};

	let data = await load();
	compareTo = compareTo ?? data.snapshots.compare.to;
	compareFrom = compareFrom ?? data.snapshots.compare.from;
	clear(view);

	// ── 1. Attention: what needs you now ─────────────────────────────────
	const attention = region((d) => {
		const staged = d.refine.staging ?? [];
		const ready = staged.filter((row) => row.tier === "ready").length;
		const near = staged.filter((row) => row.tier === "near-miss").length;
		const probeIssues = staged.filter((row) => row.probe?.verdict === "false-positive").length;
		const unmeasured = staged.filter((row) => row.probe?.verdict === "unmeasured").length;
		const gateFails = staged.filter((row) => row.gateOk === false).length;
		const allOpenPrunes = (d.tuner.proposals ?? []).filter((proposal) => proposal.status === "open" && proposal.kind === "prune");
		const prunes = allOpenPrunes.filter((proposal) => inWindow(proposal.createdAt ?? proposal.ts));
		const olderOpen = allOpenPrunes.length - prunes.length;
		const rulePrunes = prunes.filter((proposal) => proposal.system !== "extensions").length;
		const extPrunes = prunes.filter((proposal) => proposal.system === "extensions").length;
		const latest = d.snapshots.latest;
		const runs = latest?.probe?.rules?.runs ?? 0;
		return [
			h(
				"div",
				{ class: "grid kpis" },
				kpi({
					label: "Review queue",
					value: fmtInt(staged.length),
					sub: staged.length ? `${ready} ready · ${near} near-miss` : "nothing waiting on you",
					valueClass: staged.length ? "accent" : "good",
					help: HELP.queue,
				}),
				kpi({
					label: "Probe issues",
					value: fmtInt(probeIssues + gateFails),
					sub: `${unmeasured} unmeasured · ${gateFails} gate fail`,
					valueClass: probeIssues + gateFails > 0 ? "warn" : "good",
					help: HELP.probe,
				}),
				kpi({
					label: "Open prunes",
					value: fmtInt(prunes.length),
					sub: `${rulePrunes} rule · ${extPrunes} extension${olderOpen > 0 ? ` · ${olderOpen} older` : ""}`,
					valueClass: prunes.length ? "warn" : "good",
					help: HELP.prunes,
				}),
				kpi({
					label: "Last snapshot",
					value: latest?.date ?? "—",
					sub: latest ? `written ${timeAgo(latest.generatedAt)} · ${fmtInt(runs)} probe run(s)` : "written at the next session or launch",
					help: HELP.snapshot,
				}),
			),
			h(
				"div",
				{ class: "attn-hint small muted" },
				h("span", { class: "mono" }, "/refine-review"),
				"arm or reject staged edits · ",
				h("span", { class: "mono" }, "/refine-probe"),
				"measure now · ",
				h("span", { class: "mono" }, "/decision-tuner list"),
				"apply or dismiss prunes",
			),
		];
	});

	// ── 2. Today: did the last change hold? ──────────────────────────────
	const today = region((d) => {
		const latest = d.snapshots.latest;
		if (!latest) return [emptyState("No snapshots yet — the first one is written at the next session start or observatory launch.")];
		const days = daysInWindow(d.snapshots.days);
		const previous = days.length >= 2 ? days[days.length - 2] : null;
		const deltaFor = (key) => {
			const spec = METRIC_SPECS.find((entry) => entry.key === key);
			if (!spec || !previous) return null;
			const a = spec.get(previous);
			const b = spec.get(latest);
			if (a === null || b === null) return null;
			return spec.unit === "pp" ? (b - a) * 100 : b - a;
		};
		const deltaPill = (key) => {
			const spec = METRIC_SPECS.find((entry) => entry.key === key);
			const delta = deltaFor(key);
			if (!spec || delta === null) return null;
			return h("span", { style: { marginLeft: "6px" } }, pill(metricDelta(delta, spec.unit), deltaTone(spec, delta), `vs ${previous.date}`));
		};
		return [
			h(
				"div",
				{ class: "grid kpis" },
				kpi({ label: "Armed", value: fmtInt(latest.counts.armed), sub: h("span", { "data-tip": armedTooltip(latest) }, armedSummary(latest), deltaPill("armed")), sparkHtml: spark(days.map((day) => day.counts.armed)), help: HELP.armed }),
				kpi({ label: "Staged", value: fmtInt(latest.staged.total), sub: h("span", {}, Object.entries(latest.staged.byKind ?? {}).map(([kind, n]) => `${kind} ${n}`).join(" · ") || "none", deltaPill("staged")), help: HELP.stagedKpi }),
				kpi({
					label: "Rule probe",
					value: pct(latest.probe?.rules?.passRate ?? null),
					sub: h("span", {}, `${latest.probe?.rules?.hits ?? 0}/${latest.probe?.rules?.expected ?? 0} hit · ${latest.probe?.rules?.falsePositives ?? 0} false-pos`, deltaPill("ruleProbeRate")),
					sparkHtml: spark(days.map((day) => day.probe?.rules?.passRate ?? 0)),
					valueClass: (latest.probe?.rules?.falsePositives ?? 0) > 0 ? "warn" : "",
					help: HELP.ruleProbe,
				}),
				kpi({
					label: "Rule survival",
					value: pct(latest.ruleOutcomes?.survivalRate ?? null),
					sub: h("span", {}, latest.ruleOutcomes?.total ? `${latest.ruleOutcomes.survived}/${latest.ruleOutcomes.total} survived · ${latest.ruleOutcomes.unresolved} unresolved` : "no resolved outcomes yet", deltaPill("ruleSurvival")),
					sparkHtml: spark(days.map((day) => day.ruleOutcomes?.survivalRate ?? 0)),
					help: HELP.survival,
				}),
				kpi({
					label: "Lessons",
					value: fmtInt(latest.lessons?.added ?? 0),
					sub: h("span", {}, `${latest.lessons?.recalled ?? 0} recalled · library ${latest.lessons?.libraryPresent ? "present" : "absent"}`, deltaPill("lessonsAdded")),
					help: HELP.lessons,
				}),
				kpi({
					label: "Extensions used",
					value: fmtInt(latest.extensions?.used?.length ?? 0),
					sub: h("span", {}, `${latest.extensions?.armed ?? 0} armed · ${latest.extensions?.silent?.length ?? 0} silent`, deltaPill("extensionsUsed")),
					valueClass: (latest.extensions?.silent?.length ?? 0) > 0 ? "warn" : "good",
					help: HELP.extensions,
				}),
			),
		];
	});

	// ── 3. Compare: pick two days ────────────────────────────────────────
	const toSelect = h("select", { class: "btn", "aria-label": "Compare to day" });
	const fromSelect = h("select", { class: "btn", "aria-label": "Compare from day" });
	const syncSelect = (select, value, days) => {
		clear(select);
		for (const day of days.slice().reverse()) select.append(h("option", { value: day.date, selected: day.date === value }, day.date));
	};
	toSelect.addEventListener("change", () => {
		compareTo = toSelect.value;
		renderAll(data);
	});
	fromSelect.addEventListener("change", () => {
		compareFrom = fromSelect.value;
		renderAll(data);
	});

	const compare = region((d) => {
		const days = daysInWindow(d.snapshots.days);
		if (days.length === 0) return [emptyState(`No snapshots in the ${rangeLabel()} window`)];
		syncSelect(toSelect, compareTo, days);
		syncSelect(fromSelect, compareFrom, days);
		const byDate = new Map(days.map((day) => [day.date, day]));
		const to = byDate.get(compareTo) ?? days[days.length - 1];
		const from = compareFrom ? byDate.get(compareFrom) ?? null : days.length >= 2 ? days[days.length - 2] : null;
		const single = days.length < 2;
		fromSelect.disabled = single;
		toSelect.disabled = single;
		const body = [
			table({
				columns: [
					{ label: "Metric", render: (row) => row.label },
					{ label: from?.date ?? "from", right: true, render: (row) => metricValue(row.from, row.unit) },
					{ label: to?.date ?? "to", right: true, render: (row) => metricValue(row.to, row.unit) },
					{ label: "Δ", right: true, render: (row) => (row.delta === null ? "—" : pill(metricDelta(row.delta, row.unit), deltaTone(row, row.delta))) },
				],
				rows: metricsBetween(from, to).map((row) => ({ ...row, key: row.key })),
				empty: "Pick two days with data",
			}),
		];
		if (single) body.unshift(banner("info", "Only one snapshot so far — day-over-day comparison starts with the next day."));
		if (to?.digestChanged) body.unshift(banner("info", `Harness changed on ${to.date}: ${to.digestFrom ?? "?"} → ${to.digest ?? "?"}`));
		return body;
	});

	// ── 4. Day strip ─────────────────────────────────────────────────────
	const dayStrip = region((d) => [
		table({
			columns: [
				{ label: "Day", width: "92px", render: (row) => h("span", { class: "mono nowrap", style: { fontSize: "11.5px" } }, row.date) },
				{ label: "What changed", width: "300px", render: (row) => h("span", { class: "small truncate", "data-tip": changedTooltip(row) }, changedLabel(row)) },
				{ label: "Staged", right: true, render: (row) => h("span", { "data-tip": `${row.staged.gatePass} gate pass · ${row.staged.gateFail} fail` }, fmtInt(row.staged.total)) },
				{ label: "Probe", right: true, render: probeCell },
				{ label: "Survival", right: true, render: survivalCell },
				{ label: "Lessons", right: true, render: lessonCell },
				{ label: "Digest", render: (row) => h("span", { class: "small mono", "data-tip": row.digestChanged ? "the armed harness changed that day" : "no harness change recorded" }, digestLabel(row)) },
				{
					label: "",
					width: "118px",
					render: (row) =>
						h(
							"div",
							{ style: { display: "flex", gap: "6px" } },
							h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); compareTo = row.date; compareFrom = daysInWindow(d.snapshots.days).filter((day) => day.date < row.date).slice(-1)[0]?.date ?? null; renderAll(d); } }, "Compare"),
							h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); void openDay(row.date); } }, "Raw"),
						),
				},
			],
			rows: daysInWindow(d.snapshots.days).slice().reverse().map((day) => ({ ...day, key: day.date })),
			onRowClick: (row) => {
				compareTo = row.date;
				compareFrom = daysInWindow(d.snapshots.days).filter((day) => day.date < row.date).slice(-1)[0]?.date ?? null;
				renderAll(d);
			},
			maxHeight: "420px",
			empty: `No snapshots in the ${rangeLabel()} window`,
		}),
	]);

	// ── 5. Staged now: the review queue in detail ────────────────────────
	const staged = region((d) => {
		const rows = d.refine.staging ?? [];
		const kinds = [...new Set(rows.map((row) => row.kind))].sort();
		const intro = h(
			"div",
			{ class: "small muted", style: { padding: "0 0 8px", lineHeight: "1.5" } },
			"Inert proposals from the auto loop — rules, notes, memory/context entries, subagents, skills, settings patches and new extensions. Rules/contexts are probe-measured; extensions need compile + fake-pi + safety. Nothing is live until you arm it in /refine-review.",
		);
		const chips = h("div", { class: "chiprow" });
		chips.append(chip("All", rows.length, { active: kindFilter === "all", onClick: () => { kindFilter = "all"; renderAll(d); } }));
		for (const kind of kinds) {
			const n = rows.filter((row) => row.kind === kind).length;
			chips.append(chip(kind, n, { active: kindFilter === kind, onClick: () => { kindFilter = kind; renderAll(d); } }));
		}
		const filtered = kindFilter === "all" ? rows : rows.filter((row) => row.kind === kindFilter);
		const priority = (row) => {
			if (row.gateOk === false || row.probe?.verdict === "false-positive") return 0;
			if (row.tier === "near-miss") return 1;
			if (row.probe?.verdict === "unmeasured") return 2;
			return 3;
		};
		const sorted = filtered.slice().sort((a, b) => priority(a) - priority(b) || String(b.stagedAt ?? "").localeCompare(String(a.stagedAt ?? "")));
		const body = sorted.length
			? table({
					columns: [
						{
							label: "Item",
							render: (row) =>
								h(
									"div",
									{},
									h("div", { class: "mono", style: { fontSize: "12px" } }, `${row.kind} · ${row.name}`),
									h("div", { class: "small muted truncate", "data-tip": row.evidence ?? row.preview ?? "" }, row.title ?? row.evidence ?? row.preview ?? ""),
								),
						},
						{ label: "Tier", render: (row) => (row.tier ? pill(row.tier, row.tier === "ready" ? "ok" : "warn") : "—") },
						{
							label: "Jev",
							render: (row) =>
								row.parts && typeof row.parts === "object"
									? h("span", { class: "small mono", "data-tip": `weakest-link ${typeof row.score === "number" ? row.score.toFixed(2) : "—"}` }, ["evidence", "trigger", "novelty"].map((part) => `${part[0]} ${typeof row.parts[part] === "number" ? row.parts[part].toFixed(2) : "—"}`).join(" · "))
									: "—",
						},
						{
							label: "Probe",
							render: (row) =>
								row.probe
									? h("span", { "data-tip": [row.probe.missedOn?.length ? `missed ${row.probe.missedOn.join(", ")}` : null, row.probe.falseOn?.length ? `false on ${row.probe.falseOn.join(", ")}` : null].filter(Boolean).join(" · ") || probeText(row) }, pill(probeText(row), probeTone(row)))
									: h("span", { class: "small faint" }, "not measured"),
						},
						{ label: "Gate", render: (row) => (row.gateOk === null || row.gateOk === undefined ? "—" : pill(row.gateOk ? "pass" : "fail", row.gateOk ? "ok" : "error", row.gateReasons?.join("; "))) },
						{ label: "Age", right: true, render: (row) => h("span", { class: "small muted", "data-tip": row.stagedAt ?? "" }, row.stagedAt ? timeAgo(row.stagedAt) : "—") },
						{
							label: "",
							width: "112px",
							render: (row) =>
								h(
									"div",
									{ style: { display: "flex", gap: "6px" } },
									row.path ? h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); void openRaw(row.path, row.name); } }, "View") : null,
									row.metaPath ? h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); void openRaw(row.metaPath, `${row.name} — meta`); } }, "Meta") : null,
								),
						},
					],
					rows: sorted.map((row) => ({ ...row, key: `${row.kind}:${row.name}` })),
					maxHeight: "460px",
					empty: "Nothing staged in this filter",
				})
			: emptyState("Nothing staged. The auto loop writes here when it finds a correction or a repeated failure; run /refine-probe to measure on demand.");
		return [intro, chips, body];
	});

	// ── 6. Ledger ────────────────────────────────────────────────────────
	const ledger = region((d) => {
		const days = daysInWindow(d.snapshots.days);
		if (days.length === 0) return [emptyState(`No ledger entries in the ${rangeLabel()} window`)];
		return [
			h(
				"div",
				{ class: "feed" },
				...days
					.slice()
					.reverse()
					.map((day) =>
						h(
							"div",
							{ class: "item" },
							h("div", { class: "t mono" }, day.date),
							h("div", { class: `dot ${day.digestChanged ? "ok" : "info"}` }),
							h(
								"div",
								{},
								...day.ledger.map((line) => h("div", { class: "title", style: { whiteSpace: "normal", lineHeight: "1.45" } }, line)),
								h("div", { class: "sub" }, `${day.counts.armed} armed · ${day.counts.rolledBack} rolled back · ${day.counts.pruned} pruned · ${day.counts.rejected} rejected`),
							),
							h("div", {}, h("button", { class: "btn", onclick: () => void openDay(day.date) }, "Raw")),
						),
					),
			),
		];
	});

	// ── 7. Diagnostics: depth without noise ──────────────────────────────
	const diagnostics = region((d) => {
		const refine = d.refine;
		const gate = refine.gate;
		const parts = Object.entries(gate?.parts ?? {}).map(([part, stats]) => ({ key: part, part, ...stats }));
		const proposals = (refine.proposals ?? []).slice(0, 12).map((row) => ({ ...row, key: `${row.ts}-${row.kind}-${row.name}` }));
		return [
			h(
				"details",
			{ class: "details" },
			h("summary", {}, `Loop diagnostics — ${fmtInt(refine.runs ?? 0)} run(s) in ${rangeLabel()}, gate calibration, recent decisions`, helpButton(HELP.diagnostics)),
			h(
				"div",
				{ class: "grid cols-2" },
				card({ title: "Loop decisions", sub: "what the auto loop concluded each run", body: bars(Object.entries(refine.byDecision ?? {}).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }) }),
				card({ title: "Stages", sub: "where runs spent their effort", body: bars(Object.entries(refine.byStage ?? {}).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }) }),
			),
			card({
				title: "Gate calibration",
				sub: "rule proposals: how close each part came to its floor, and which band it landed in",
				body: gate
					? h(
							"div",
							{ class: "grid cols-2" },
							table({
								columns: [
									{ label: "Part", render: (row) => h("span", { class: "mono" }, row.part) },
									{ label: "Avg", right: true, render: (row) => (row.avg === null || row.avg === undefined ? "—" : row.avg.toFixed(2)) },
									{ label: "Max", right: true, render: (row) => (row.max === null || row.max === undefined ? "—" : row.max.toFixed(2)) },
									{ label: "Floor", right: true, render: (row) => (row.floor === null || row.floor === undefined ? "—" : row.floor.toFixed(2)) },
									{ label: "Headroom", right: true, render: (row) => (row.max === null || row.max === undefined || row.floor === null || row.floor === undefined ? "—" : h("span", { style: { color: row.max - row.floor >= 0 ? "var(--ok)" : "var(--err)" } }, (row.max - row.floor).toFixed(2))) },
								],
								rows: parts,
							}),
							bars(Object.entries(gate.bands ?? {}).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }),
						)
					: emptyState(`No gate data in the ${rangeLabel()} window.`),
			}),
			card({
				title: "Recent loop decisions",
				sub: "the audit trail behind the numbers — staged, armed, suppressed, rejected",
				flush: true,
				body: proposals.length
					? table({
							columns: [
								{ label: "When", render: (row) => h("span", { class: "small muted" }, timeAgo(row.ts)) },
								{ label: "Decision", render: (row) => pill(row.decision ?? "?", row.decision === "armed" || row.decision === "applied" ? "ok" : row.decision === "staged" ? "accent" : row.decision === "suppressed" ? "neutral" : row.decision === "gate-blocked" ? "error" : "warn") },
								{ label: "Item", render: (row) => h("span", { class: "mono", style: { fontSize: "11.5px" } }, `${row.kind ?? "rule"} · ${row.name ?? "—"}`) },
								{ label: "Tier", render: (row) => (row.tier ? pill(row.tier, row.tier === "ready" ? "ok" : "warn") : "—") },
								{ label: "Score", right: true, render: (row) => (typeof row.score === "number" ? row.score.toFixed(2) : "—") },
							],
							rows: proposals,
							maxHeight: "320px",
						})
					: emptyState(`No loop decisions in the ${rangeLabel()} window.`),
			}),
		),
	];
	});

	// ── 8. Tuning: the old Tuner page, folded in and collapsed ───────────
	const tuning = region((d) => {
		const proposals = (d.tuner.proposals ?? []).filter((proposal) => inWindow(proposal.createdAt ?? proposal.ts));
		const counts = proposals.reduce((acc, proposal) => {
			const status = proposal.status ?? "open";
			acc[status] = (acc[status] ?? 0) + 1;
			return acc;
		}, {});
		const runs = Array.isArray(d.tuner.runs) ? d.tuner.runs.length : 0;
		const lastRun = d.tuner.state?.lastRun;
		const open = counts.open ?? 0;
		const applied = counts.applied ?? 0;
		const dismissed = counts.dismissed ?? 0;
		const fileButton = (row) => {
			if (!row.file || row.fileExists === false) {
				return h("span", { class: "small faint nowrap", "data-tip": row.file ? `recorded at ${row.file} — not on disk` : "no file recorded for this proposal" }, "no file");
			}
			const label = row.fileKind === "record" ? "Log" : "View";
			return h(
				"button",
				{ class: "btn", onclick: (event) => { event.stopPropagation(); void openRaw(row.file, row.fileKind === "record" ? `${row.target} — proposal record` : row.target); } },
				label,
			);
		};
		return [
			h(
				"details",
				{ class: "details" },
				h("summary", {}, `Tuning proposals — ${open} open in ${rangeLabel()}`, helpButton(HELP.tuning)),
				h(
					"div",
					{ class: "grid kpis" },
					kpi({ label: "Tuner runs", value: fmtInt(runs), sub: lastRun ? `last ${timeAgo(lastRun)}` : "never run", help: HELP.tuning }),
					kpi({ label: "Proposals", value: fmtInt(proposals.length), sub: Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(" · ") || "none yet" }),
					kpi({ label: "Open", value: fmtInt(open), sub: "awaiting your review", valueClass: open ? "warn" : "good" }),
					kpi({ label: "Applied / dismissed", value: fmtInt(applied + dismissed), sub: `${applied} applied · ${dismissed} dismissed` }),
				),
				proposals.length
					? table({
							columns: [
								{ label: "Kind", render: (row) => pill(row.kind ?? "?", row.kind === "prune" ? "warn" : "info") },
								{ label: "System", render: (row) => h("span", { class: "mono" }, row.system ?? "—") },
								{ label: "Target", render: (row) => h("span", { class: "mono", style: { fontSize: "11.5px" } }, row.target ?? "—") },
								{ label: "Evidence", render: (row) => h("span", { class: "small muted truncate", "data-tip": row.evidence ?? "" }, row.evidence ?? "—") },
								{ label: "Status", render: (row) => pill(row.status ?? "open", row.status === "applied" ? "ok" : row.status === "dismissed" ? "neutral" : "warn") },
								{ label: "When", right: true, render: (row) => h("span", { class: "small muted" }, timeAgo(row.decidedAt ?? row.createdAt ?? row.ts)) },
								{ label: "", width: "78px", render: fileButton },
							],
							rows: proposals.map((row) => ({ ...row, key: row.id ?? `${row.ts}-${row.target}` })),
							maxHeight: "360px",
						})
					: emptyState(`No tuner proposals in the ${rangeLabel()} window.`),
			),
		];
	});

	view.append(
		h(
			"div",
			{ class: "stack" },
			attention.node,
			today.node,
			card({ title: "Day-over-day", sub: "default N vs N−1 — rates compare as percentage points", actions: h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, fromSelect, h("span", { class: "small faint" }, "→"), toSelect), body: compare.node, help: HELP }),
			card({ title: "Day strip", sub: "one row per day: what changed, what it did, whether the harness digest moved", body: dayStrip.node, help: HELP }),
			card({ title: "Staged now", sub: "the review queue — every kind, sorted by risk; arm with /refine-review", body: staged.node, help: HELP.staged }),
			card({ title: "Improvement ledger", sub: "the human-readable one-liner per day, newest first", body: ledger.node, help: HELP }),
			tuning.node,
			diagnostics.node,
		),
	);

	if (data.partial) view.prepend(banner("warn", "One or more loop data sources are unavailable — the page shows what it could load."));

	const renderAll = (next) => {
		data = next;
		attention.render(data);
		today.render(data);
		compare.render(data);
		dayStrip.render(data);
		staged.render(data);
		ledger.render(data);
		tuning.render(data);
		diagnostics.render(data);
		const latest = data.snapshots.latest;
		const stagedCount = (data.refine.staging ?? []).length;
		const pruneCount = (data.tuner.proposals ?? []).filter((proposal) => proposal.status === "open" && proposal.kind === "prune" && inWindow(proposal.createdAt ?? proposal.ts)).length;
		ctx.setStatus(`${rangeLabel()} · ${stagedCount} staged · ${pruneCount} open prune(s) · ${latest ? `snapshot ${latest.date}` : "no snapshot yet"}`);
	};

	renderAll(data);
	ctx.onAutoRefresh(async () => renderAll(await load()));
}
