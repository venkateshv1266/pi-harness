// Page renderers. Each page builds its structure once, then registers an
// in-place refresher (`ctx.onAutoRefresh`) that re-fetches and patches only the
// regions whose data changed — no page rebuilds, no scroll jumps.
import { api, post, h, clear, fmtCompact, fmtCost, fmtInt, fmtPct, fmtMs, fmtClock, fmtDateTime, timeAgo, toneForSeverity, toneForVerdict, openDrawer, toast, seriesColor, debounce } from "./util.js";
import { areaChart, barChart, lineChart, spark, histogram, sankey } from "./charts.js";
import { card, kpi, meter, pill, countPill, chip, qualityTone, table, bars, shareLabel, banner, emptyState, lanes, feed, kv, legend, skeletonRows, helpButton, modelPicker, collapsible } from "./ui.js";

export const state = {
	range: localStorage.getItem("observatory-range") || "7d",
	dailyMetric: localStorage.getItem("observatory-daily-metric") || "cost",
	ledgerSystem: null,
	ledgerFocus: null,
	ledgerSeverity: null,
	ledgerQuery: "",
	ledgerOffset: 0,
	ledgerEffectTab: "ttsr",
	curatorSession: null,
	sessionId: null,
	sessionSort: "recent",
	sessionQuery: "",
	impactModel: null,
	liveSystem: null,
};

const RANGE_LABEL = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

// In-app explanations: every metric can say what it means, how it is computed,
// where the raw data lives, and which lever changes it.
const HELP = {
	impactLedger: {
		title: "Impact ledger",
		what: "One row per mechanism, each with the exact basis used. Rows showing a dash are counted but deliberately not priced, because the logs carry no dollar figure for them.",
		formula: "Per row, see the Basis column: curator saves source-minus-extract chars, counted again on every call that followed; cache saves the read-rate delta; the router row shows the price delta of the model it switched to.",
		source: "Sessions (model calls, curator ledgers) plus every decision log.",
		action: "Work top-down: make the biggest positive row bigger, the biggest negative row smaller.",
	},
	verifierAgreement: {
		title: "Verifier agreement",
		what: "How often the local Jev verifier matched an independent frontier model's verdict on a sampled curator proposal. Low agreement means one of the two is miscalibrated.",
		formula: "agree ÷ samples, from verifier-ab records.",
		source: "~/.pi/agent/jev-decisions/jev-curator.jsonl, decision=verifier-ab.",
		action: "The sharpest signal on this page. Inspect the disagreements in the Ledger, then either tighten Jev's gate criteria or stop paying for frontier checks that keep overruling it.",
	},
	rulePrecision: {
		title: "Rule precision",
		what: "Of the rule firings that were later judged, how many were rated good. Catches rules that fire when they should not.",
		formula: "good ÷ (good + bad) over TTSR outcome verdicts.",
		source: "~/.pi/agent/jev-decisions/ttsr-jev.jsonl, kind=outcome.",
		action: "Outcomes are only recorded when something observable happened, so read this as a sample. Reword rules with bad verdicts — usually the trigger is too broad.",
	},
	routerVerdicts: {
		title: "Router outcome verdicts",
		what: "Judged outcomes of routing decisions (a correction, a test result). A low ratio means routing is not landing — or that its failures are the ones being noticed.",
		formula: "good ÷ (good + bad) over router outcome records; the tooltip shows how many decisions carried a verdict at all.",
		source: "~/.pi/agent/jev-decisions/model-router.jsonl.",
		action: "Open the tagged bad cases first. If they cluster on deep-tier escalations, the escalation threshold is the thing to move.",
	},
	escalations: {
		title: "Frontier escalations",
		what: "How often the curator's verifier was unsure enough to pay for a frontier-model check, and how many goal-relevant lines the repair pass recovered before emitting.",
		formula: "escalations ÷ curator candidates; repairs = repaired ÷ verified.",
		source: "jev-curator.jsonl (verifierModel containing frontier; jev-verify records with repaired and lostLines).",
		action: "High escalation with high agreement means the frontier check earns its keep. High escalation with low agreement means it second-guesses without improving — reconsider the verifier protocol.",
	},
	userCorrections: {
		title: "User corrections",
		what: "Times you corrected the agent after a rule fired or a routing decision was made. The most direct quality signal you have, because you are the ground truth.",
		formula: "count of outcome=user_corrected across TTSR and router logs.",
		source: "ttsr-jev.jsonl and model-router.jsonl.",
		action: "Open each tagged case in the Ledger and rewrite whatever rule or tier setting preceded it. Two or three usually point at one recurring cause.",
	},
	callErrors: {
		title: "Call error rate",
		what: "Share of model calls that ended in an error. Failures produce no work but are still billed.",
		formula: "errors ÷ calls, where stopReason = error.",
		source: "model_calls (from session logs).",
		action: "If one model dominates the errors, add or adjust a fallback for it — reliability failures cost tokens twice.",
	},
	curatorSources: {
		title: "Curator savings by source",
		what: "Which kinds of tool output the curator is condensing and how many chars it removed from each. Shows where the easy wins live.",
		formula: "Sum of chars saved per source type (code, doc, log, listing, search).",
		source: "Curator ledger items in session logs.",
		action: "If logs or listings dominate, cap those commands at the source (head, tail, grep) — cheaper than condensing after the fact.",
	},
	ruleQuality: {
		title: "Rule quality",
		what: "Every rule that produced a judged outcome, with how often it fired and how often it was rated good.",
		formula: "good ÷ (good + bad) per rule.",
		source: "ttsr-jev.jsonl, joined to the rule files in ~/.pi/agent/rules/.",
		action: "Rules with no verdicts but heavy gating are prune candidates; rules with bad verdicts need rewording.",
	},
	guardCatches: {
		title: "Guard catches",
		what: "Commands the guard blocked or flagged before they ran, ranked by its destructive-intent score. This is the harness preventing damage — the clearest qualitative win it produces.",
		formula: "verdict in (blocked, flagged), sorted by the destructive score.",
		source: "~/.pi/agent/jev-decisions/jev-guard.jsonl.",
		action: "No lever needed — if this list is empty for a long stretch, that is either good luck or a gate that is too permissive.",
	},
	memoryRates: {
		title: "Memory & rates",
		what: "The inputs behind the estimates on this page: what the memory worker admitted or rejected, and the blended price used to convert tokens into dollars.",
		formula: "Blended input rate = priced input cost ÷ priced input tokens across models in range; coverage = share of tokens whose model has a known price.",
		source: "jev-decisions/jev-memory.jsonl + model_calls + models-store.json.",
		action: "If priced coverage is below 100%, the dollar estimates are conservative — add prices for the missing models in models-store.json.",
	},
	levers: {
		title: "Levers",
		what: "The knobs that actually change the numbers on this page, and where each one lives. This is the \"what do I edit\" list.",
		formula: "Static reference, not computed.",
		source: "Harness configuration: env vars, /setup, ~/.pi/agent/rules/, ~/.pi/agent/jev-memory-config.json.",
		action: "Change one lever at a time and watch the corresponding meter for the next few sessions — that is how you attribute an improvement.",
	},
	benefits: {
		title: "Benefit ledger",
		what: "Cost-benefit for the whole harness, mechanism by mechanism: what it costs you now (measured from logs) versus what the alternative would have cost (an explicit counterfactual, with its formula stated).",
		formula: "Each row states its own basis. Shared currency: chars ÷ 4 tokens, priced at your observed cache-aware rate.",
		source: "Rules sized from ~/.pi/agent/rules/*.md; the always-on prompt replayed from session system messages (sections + tool declarations); deliveries from ttsr-jev.jsonl; guard from jev-guard.jsonl; goal loop from course-check.jsonl; judgment from ask-jev.jsonl; memory from ~/.pi/agent/jev-memory/*.md.",
		action: "Rows marked 'count only' are mechanisms whose value the logs cannot express in money — treat them as quality wins, not savings. The rows carrying dollars are the ones a lever can move.",
	},
	benefitRules: {
		title: "Rules: injection vs resident",
		what: "TTSR rules are injected only when their trigger matches. The counterfactual is the alternative: every rule sitting in the always-on prompt, re-sent and re-billed on every call.",
		formula: "always-on = rule tokens × calls × cache-aware rate. Injected = sum of delivered rule tokens × rate. Net = always-on − injected.",
		source: "~/.pi/agent/rules/*.md for sizes, ttsr-jev.jsonl for deliveries, model_calls for the call count.",
		action: "This grows with rule count and call count — the strongest argument for keeping rules narrow and triggers precise instead of hoisting them into AGENTS.md.",
	},
	benefitCurator: {
		title: "Context curator — tokens condensed",
		what: "How much text the curator kept out of context, reported two ways: the tokens removed at each trim, and that same saving counted again on every model call that followed it — the figure the Curator page leads with.",
		formula: "(source chars − extract chars) ÷ 4 for items delivered as an extract or index only: condensed, counted once — a size. Not re-read counts each trim's saving again on every model call that followed, summed over trims — a flow, where one token can appear many times. Prompts ran smaller is that flow over itself plus the prompt tokens actually sent. Money prices the flow at the rate each call was billed at, not today's sheet. Items kept in full are counted, never priced.",
		source: "~/.pi/agent/jev-decisions curator ledger items (chars, extractChars, verdict, turn) joined to each session's turn count, priced at the blended input rate.",
		action: "If most items are kept in full, the curator is not the lever — cap the tool output at the source (head/tail/filter) so the bulk never enters context in the first place.",
	},
	benefitBaseline: {
		title: "Always-on prompt cost",
		what: "What every call pays before the harness adds anything: system sections plus tool declarations. The floor your spend sits on.",
		formula: "Average replayed prompt size per session (chars ÷ 4) × calls × cache-aware rate.",
		source: "Session system messages persist sections and patch them by name; the tool loadout is stored as declarations. Sizes are recorded per session at ingest.",
		action: "If this is large relative to spend, trim it: fewer tools loaded, shorter skills/docs sections. Rules are only a fraction of it — check the share before moving them.",
	},
	benefitGuard: {
		title: "Guard cost per block",
		what: "The guard's own cost and what it costs per dangerous command it stops. The damage it prevents is real but unpriced.",
		formula: "Sum of logged cost_usd over guard events ÷ blocked count.",
		source: "~/.pi/agent/jev-decisions/jev-guard.jsonl.",
		action: "A low cost-per-block means the harness pays cents for a safety net. If blocks stay at zero for a long stretch, confirm the gate is still screening rather than silently permissive.",
	},
	benefitGoal: {
		title: "Rework avoided (goal loop)",
		what: "Off-track verdicts are the moments the goal loop caught drift. Each probably saved at least a corrective turn.",
		formula: "off-track verdicts × average call cost in range.",
		source: "course-check.jsonl for verdicts, model_calls for the average call cost.",
		action: "An estimate, not a measurement — read it as 'at least this much'. A high count usually points at the first prompt, not the loop.",
	},
	benefitJev: {
		title: "Jev request spend (all subsystems)",
		what: "What the harness's intelligence layer costs: every decision logged in the range — curator classification and verification, guard screens, rule gates, memory admission and consolidation, router decisions, course checks, ask-jev judgments, refine and tuner passes.",
		formula: "Requests = decision events from the adapter logs. Cost = logged cost_usd where the subsystem writes one, plus curator verifier batches priced from their logged model and token usage. Requests whose subsystem logs neither are counted but not priced; the coverage figure says how much of the total is measured.",
		source: "All ~/.pi/agent/jev-decisions/*.jsonl, priced with ~/.pi/agent/models-store.json rates.",
		action: "Compare this spend against the benefit rows it drives. A low cost per request with high value above is the harness earning its keep; a subsystem consuming many requests for little value is a candidate for retuning or pruning.",
	},
	trends: {
		title: "Trends — am I improving?",
		what: "Per-day series for the harness's own numbers, plus the same headline figures for this window and the identical window before it, so a change has a baseline.",
		formula: "Deltas compare RATIOS, never totals: cost per call, prompt tokens per call, condensed tokens per call, rules avoided per call, cache discount per call, error rate, precision, corrections per 100 calls. A busy window has bigger totals by definition, so totals would always read as a regression. Metrics that are already rates (cache rate, error rate, rule precision, verifier agreement) report their change in percentage POINTS, with the sample size and the previous value beside them — 13% agreement from 32 samples is a different claim from 13% from 3,000.",
		source: "Daily buckets from model_calls, curator ledger items, ttsr, guard, course-check and curator verifier-ab records; rules sized from ~/.pi/agent/rules/*.md.",
		action: "Read direction, not magnitude: rising rules-tokens-avoided with flat cost means context discipline is improving; rising corrections or error rate is the signal to retune. One week is noise — watch two or three.",
	},
	sessionImpact: {
		title: "Session impact",
		what: "One session's harness benefit, its quality signals and the specific things worth improving — the per-session view of what the Impact tab shows in aggregate.",
		formula: "Tokens condensed = Σ (source chars − extract chars) ÷ 4 at each trim: the text the curator replaced with an extract, counted once — this is the headline. Not re-read = each trim's saving counted again on every model call that followed it, summed over trims, so it is a flow rather than a size: one token can appear in it many times. Prompts ran smaller = that flow over itself plus the prompt tokens actually sent; the peak is the largest single prompt, with and without the trims. Worth ≈ the flow priced at the cache-read rate (input rate is the ceiling) — cents here, because a cached prefix is cheap to re-read. The carry assumes an extract stays in context, so a compaction that dropped it would end its carry.",
		source: "This session's entries in ~/.pi/agent/sessions, plus decision records that carry its session id (curator ledgers, ttsr, router, course-check). Guard screens have no session id, so they are excluded here.",
		action: "The hints are the actionable part: repeated reads, oversized items kept in full, model switches, corrections and drift each point at a different fix.",
	},
	sessionItems: {
		title: "Biggest context items",
		what: "The largest single things that entered this session's context, with what the curator decided about each.",
		formula: "Source size in chars reported by the curator ledger; 'retainFull' means it stayed in context whole, condensed verdicts replaced it with an extract.",
		source: "Curator ledger items stored in this session's log.",
		action: "A big item marked retainFull is the clearest avoidable cost in the session — cap that command at the source, or check why the verifier refused the extract.",
	},
	ledgerVolume: {
		title: "Decision volume per system",
		what: "Every subsystem's decisions as one line per system over the days in range, each in its own colour. Click a system to isolate it.",
		formula: "each line is that subsystem's decisions per day; isolating one rescales the axis to it, so its own shape is readable instead of flattened by the busiest line. The subtitle then reports that system's range total, share of all logged decisions, and busiest day.",
		source: "observatory.db — events grouped by system and day (localtime).",
		action: "A line that climbs while the others stay flat is a subsystem doing more work than it used to. Isolate it and read the count before calling that progress — volume is not value.",
	},
	perDay: {
		title: "Per day",
		what: "Daily volume, read three ways — what it cost, how many tokens it burned, and how many requests it took. Switch the reading before explaining a shape.",
		formula: "cost = model cost from the session logs + harness cost where a subsystem logs its own price; tokens = model tokens only (the harness logs none); requests = model calls + harness decisions.",
		source: "observatory.db — model_calls (cost, tokens, calls) joined to decision events by day.",
		action: "Cost up without requests up is a price or model change; requests up without cost is volume. A gap in the bars is a day with no logged calls.",
	},
	routerOutcomes: {
		title: "Outcome quality by tier",
		what: "Verdicts tagged to routing decisions, grouped by the tier that was chosen. Volume per tier says nothing about value; this is the other half.",
		formula: "good = verdict good or outcome tests_passed; bad = verdict bad, tests_failed or user_corrected; overridden = the routed model was replaced (model_override), which model-router itself classes as bad and which counts in precision's denominator; precision = good ÷ (good + bad + overridden). Unjudged decisions carry no verdict record at all; unclassified is a verdict this dashboard does not map.",
		source: "~/.pi/agent/jev-decisions/model-router.jsonl outcome records, which carry the tier they judged.",
		action: "A tier with bad or overridden verdicts is escalating when it should not — move the threshold. Read precision as a sample, not a score: most decisions never get a verdict, so one correction moves it by several points.",
	},
	modelsUnit: {
		title: "Model unit economics",
		what: "Per-call cost and tokens are what actually change when you switch models; totals mostly track how much you used each one.",
		formula: "cost ÷ calls and tokens ÷ calls from the logged calls. The trend sparkline is that model's daily cost across the range.",
		source: "model_calls grouped by model and day; prices (when used) from ~/.pi/agent/models-store.json.",
		action: "Compare cost per call against tokens per call and cache rate: a model that looks cheap on totals can be the expensive one per call. A high tokens-per-call with a low cache rate is the signature of context that is not being reused.",
	},
	healthStreak: {
		title: "Memory degraded streak",
		what: "Consecutive days ending with the most recent degraded consolidation. Memory hygiene is a background job: when it silently falls back, entries stop being merged and retired and nothing else tells you.",
		formula: "Consecutive calendar days (from the latest degraded day backwards) that had a memory warning event. 'Degraded days on record' counts all such days, not just the streak.",
		source: "~/.pi/agent/jev-decisions/jev-memory.jsonl (outcome degraded, or a warn severity).",
		action: "A streak above zero means consolidation is unavailable or timing out — check the memory worker config. Not urgent, but it compounds.",
	},
	healthDaily: {
		title: "Warnings per day",
		what: "Warn and error events per day across every subsystem. A flat line is healthy; a step up is a change worth explaining.",
		formula: "Events grouped by day and severity. Exact counts, no estimation.",
		source: "The events table (all decision logs plus bridge events).",
		action: "Correlate a rise with what you changed that day — a rule, a curator setting, a model switch. One day is noise; three in a row is a regression.",
	},
	healthQuiet: {
		title: "Quiet subsystems",
		what: "Subsystems with events on record but nothing in the last 7 days. One that used to log and stopped is usually broken, not idle.",
		formula: "Per system: total events on record and days since the most recent one; listed when that gap is 7 days or more.",
		source: "The events table, all-time.",
		action: "Check whether the extension still runs or a config change disabled it. The shadow comparison arm (curator-v3-shadow) is expected here — it only logs in shadow mode.",
	},
	curatorRange: {
		title: "Curator — all sessions in range",
		what: "The curation pipeline aggregated over every session in the window: how many candidates were classified, how many became emits, how often the verifier escalated or repaired, and what all of it cost.",
		formula: "Counts come from the curator decision log (shadow classifications, verifier batches, jev-verify, verifier-ab, emissions); condensed tokens come from ledger items (source chars − extract chars) ÷ 4, and the flow they avoid from counting each trim again on every call that followed.",
		source: "~/.pi/agent/jev-decisions/jev-curator.jsonl plus curator ledger items in each session's log.",
		action: "A low emit rate with heavy frontier escalation means verification is the bottleneck, not curation. A high repair rate means proposals are losing goal-relevant lines — watch that the repair pass stays a safety net rather than the norm.",
	},
	refine: {
		title: "Refine — the self-improvement loop",
		what: "Every run of the background refinement loop: what it proposed, what it suppressed because the evidence was weak, what it wrote as a rule or a note, and what is staged waiting for you to arm it. Rules and notes are segregated because only rules have a lifecycle.",
		formula: "Counts come from the loop's own audit log (refine/auto-refine.jsonl); artifacts come from its apply log (refine/history.jsonl); staging and notes are read from disk. A rule's state is derived: armed when a rule of that name exists in ~/.pi/agent/rules/, staged when it sits in the staging directory, rolled back when the apply log says so, otherwise proposed. Notes are written records.",
		source: "~/.pi/agent/jev-decisions/refine/{auto-refine,history}.jsonl, ~/.pi/agent/jev-decisions/refine/{rules-staging,notes}/, ~/.pi/agent/rules/.",
		action: "This is where new rules and notes are born. Read a staged rule before arming it (Meta shows the part scores), and check the suppressed count — a high suppression rate with few applies means the evidence bar is doing its job, not that the loop is broken. The gate calibration card below shows which proposals land in which band.",
	},
	refineStaging: {
		title: "Staged rules",
		what: "Rules the loop wrote but did not arm. Staging exists so a rule can be reviewed once and armed deliberately rather than appearing live unannounced.",
		formula: "Markdown files in the refine staging directory, with size and a preview; nothing here is active until armed.",
		source: "~/.pi/agent/jev-decisions/refine/rules-staging/.",
		action: "Open each one, read the trigger and the instruction, and arm what you agree with. An empty staging area means nothing is waiting on you.",
	},
	tuner: {
		title: "Decision Tuner",
		what: "The weekly tuning pass: it reads decision-outcome telemetry and proposes small changes — prune a rule that never fires, or adjust a curator policy knob — each with the evidence that justified it and its review status.",
		formula: "Runs and proposals come from the tuner's audit and proposal logs; statuses (open/dismissed/applied) are the review decisions recorded with each proposal. The state panel shows its last run and config.",
		source: "~/.pi/agent/jev-decisions/decision-tuner/{tuner,proposals}.jsonl plus state.json / config.json.",
		action: "Work the open proposals: each one names its target and the evidence, and View opens the rule or file it wants to change. Dismissed proposals stay visible so you can see what you have already considered.",
	},
	refineGate: {
		title: "Refine gate calibration",
		what: "The rule gate scores every proposal on three parts and stages it in one of two bands. This shows how close proposals actually come to those floors — the measurement that justified replacing a single weakest-link threshold with per-part floors.",
		formula: "Bands are re-derived from the part scores logged with each rule proposal: ready when evidence ≥ 0.6, novelty ≥ 0.6 and trigger ≥ 0.5; near-miss when min(evidence, novelty) ≥ 0.4; otherwise below. Max and headroom show how the best-scoring proposal compares with its floor.",
		source: "refine/auto-refine.jsonl — the jev and apply stage lines carry evidence, novelty and trigger scores.",
		action: "If a part's max never reaches its floor, that floor is unreachable and the band is decorative — lower it or stop staging that class of proposal. If near-miss keeps filling while ready stays empty, the trigger requirement is the binding constraint.",
	},
	findings: {
		title: "Findings",
		what: "Diagnostics computed from your logs: each one states the rule that fired, the evidence behind it, the size of the prize where it can be measured, and the specific lever that changes it.",
		formula: "Twelve fixed detectors, each with a threshold: oversized outputs (5+ tool results at 25k+ chars), repeated reads (one file read 3+ times in a session), low cache (a 10+ call session under 50% cache reuse), model switches (2+ in one session), deep thinking on small turns (20+ high/xhigh/max calls under 20k tokens), dead rules (3+ rules that never fired or gate-checked), noisy rules (50+ gate checks with no recorded outcome), bad rules (judged to have made things worse at least once), model errors (2%+ of calls, over 20+ calls), off-track sessions (flagged by the goal loop), degraded memory consolidation, and missing adapter logs. Findings are ordered sharpest first — error, then warn, then info — and each is re-checked against the identical previous window, so a 'recurring' badge means the same detector fired in the previous window too.",
		source: "All ingested pi data.",
		action: "Work the list top-down — red first, then amber. Each card links to the page where you can see the underlying rows.",
	},
	scope: {
		title: "Scoping the impact view",
		what: "Pick a model to see what the harness saved or cost while that model was in use. The picker is searchable, and the choice is kept in the URL (#/impact?model=…) so a scoped view can be bookmarked or shared.",
		formula: "Cache and call figures are exact per model (each call stores its model). Curator savings are attributed by the model in use at the same session+turn — the note beside the picker reports what share could be attributed.",
		source: "model_calls.model joined to curator ledger items by session+turn; prices from ~/.pi/agent/models-store.json.",
		action: "Compare two models over the same range: a model with heavy cache savings is cheaper than its sticker price, and a model with a high error rate is costing you twice. Overhead and the non-model meters intentionally stay global.",
	},
};

const LEVERS = [
	{ lever: "Context cap", where: "JEVCURATOR_INGEST_CAP · default 25,000 chars", effect: "How big a tool result may be before the curator condenses it. Lower = less context burn, more condensing." },
	{ lever: "Verifier protocol", where: "JEVCURATOR_VERIFIER · /setup → curator", effect: "hybrid escalates uncertain approvals to a frontier model; jev keeps verification local; frontier uses only the holistic gate." },
	{ lever: "Thinking level", where: "per session (thinking toggle / model switch)", effect: "Reasoning tokens are billed every turn. Reserve high/xhigh/max for genuinely hard work." },
	{ lever: "Model & tier", where: "router tiers via /setup, or pin a model per session", effect: "Switching model mid-session re-bills the whole prompt prefix uncached. Decide once, or let the router own it." },
	{ lever: "Rules", where: "~/.pi/agent/rules/*.md", effect: "Armed rules shape every turn. Prune rules that never fire; reword rules with bad outcomes." },
	{ lever: "Memory worker", where: "~/.pi/agent/jev-memory-config.json", effect: "Timeout and model for consolidation. Degraded runs silently skip merging and retiring entries." },
	{ lever: "Goal framing", where: "the first prompt of a session", effect: "The curator's GoalSpec comes from it and course-check judges against it — say what done looks like." },
];

// ------------------------------------------------------------------ small helpers

/**
 * A finding, rendered identically wherever it appears: one row in a single
 * column, so a long list keeps one left edge to scan down. Severity is a left
 * stripe and a dot rather than a tinted box, the impact figure sits right-aligned
 * instead of competing with the title, and the evidence is folded into a
 * disclosure because it is the noisiest part of a finding and the least
 * actionable. Rows without a field simply skip it, which lets the Session view
 * reuse this for its short improvement hints.
 */
function findingItem(finding) {
	const tone = finding.tone === "error" ? "error" : finding.tone === "warn" ? "warn" : finding.tone === "ok" ? "ok" : "info";
	return h(
		"article",
		{ class: `finding ${tone}`, key: String(finding.id ?? finding.label ?? finding.title) },
		h(
			"header",
			{ class: "finding-top" },
			h("span", { class: `dot ${tone}` }),
			h("h3", {}, finding.title ?? finding.label),
			finding.isNew === true
				? h("span", { class: "finding-flag is-new", "data-tip": "did not fire in the previous window" }, "new")
				: finding.persistent === true
					? h("span", { class: "finding-flag is-recurring", "data-tip": "also fired in the previous window" }, "recurring")
					: null,
			finding.impact ? h("span", { class: "finding-impact", "data-tip": "the size of the prize, where it can be measured" }, finding.impact) : null,
		),
		finding.trigger ? h("p", { class: "finding-rule" }, finding.trigger) : null,
		finding.summary || finding.detail ? h("p", { class: "finding-why" }, finding.summary ?? finding.detail) : null,
		finding.evidence?.length
			? h(
					"details",
					{ class: "finding-evidence" },
					h("summary", {}, `evidence · ${finding.evidence.length}`),
					h("ul", { class: "evidence" }, ...finding.evidence.map((line) => h("li", {}, line))),
				)
			: null,
		finding.action || finding.links?.length
			? h(
					"p",
					{ class: "finding-fix" },
					finding.action ? h("span", { class: "arrow" }, "→") : null,
					finding.action ? h("span", {}, finding.action) : null,
					...(finding.links ?? []).map((link) => h("a", { class: "finding-link", href: link.hash }, link.label)),
				)
			: null,
	);
}

function shortModel(model) {
	if (!model) return "—";
	const parts = String(model).split("/");
	return parts[parts.length - 1];
}

function modelCell(model) {
	return h("span", { class: "mono", title: model ?? "" }, shortModel(model));
}

function severityPill(severity) {
	return pill(severity, toneForSeverity(severity));
}

function verdictPill(verdict) {
	if (!verdict) return h("span", { class: "faint" }, "—");
	return pill(verdict, toneForVerdict(verdict));
}

function shortTitle(title) {
	if (!title) return null;
	return title.length > 52 ? `${title.slice(0, 51)}…` : title;
}

/** A region whose single child is rebuilt from data. */
function nodeRegion(build) {
	const node = h("div");
	return { node, render: (data) => node.replaceChildren(build(data)) };
}

/** A region whose innerHTML is rebuilt from data (charts). */
function htmlRegion(build) {
	const node = h("div");
	return { node, render: (data) => { node.innerHTML = build(data); } };
}

/** A KPI grid region. */
function gridRegion(build) {
	const node = h("div", { class: "grid kpis" });
	return { node, render: (data) => node.replaceChildren(...build(data)) };
}

const DAILY_METRICS = [
	{ id: "cost", label: "Cost", fmt: fmtCost },
	{ id: "tokens", label: "Tokens", fmt: fmtCompact },
	{ id: "requests", label: "Requests", fmt: fmtCompact },
];

const dailyMetric = () => DAILY_METRICS.find((m) => m.id === state.dailyMetric) ?? DAILY_METRICS[0];

/** The Cost / Tokens / Requests switch. Redraws from the data already fetched. */
function metricChips(redraw) {
	return h(
		"div",
		{ class: "chiprow" },
		...DAILY_METRICS.map((m) =>
			chip(m.label, null, {
				active: dailyMetric().id === m.id,
				onClick: () => {
					state.dailyMetric = m.id;
					localStorage.setItem("observatory-daily-metric", m.id);
					redraw();
				},
			}),
		),
	);
}

/** Markdown drawer: the digest is meant to be copied out, not read only here. */
/** Fetch a harness file and show it for review, with a copy button. */
async function openFileDrawer(file, title) {
	try {
		const result = await api("/api/file", { path: file });
		if (result.error) {
			toast(`Cannot read ${file}: ${result.error}`, "error");
			return;
		}
		openMarkdownDrawer(title ?? file.split("/").pop(), result.content);
	} catch (err) {
		toast(`Cannot read ${file}: ${err.message}`, "error");
	}
}

function openMarkdownDrawer(title, markdown) {
	const body = h(
		"div",
		{},
		h(
			"div",
			{ class: "page-toolbar", style: { marginBottom: "10px" } },
			h(
				"button",
				{
					class: "btn",
					onclick: async (event) => {
						try {
							await navigator.clipboard.writeText(markdown);
							event.currentTarget.textContent = "Copied";
						} catch (err) {
							toast(`Clipboard blocked (${err instanceof Error ? err.message : String(err)}) — select and copy manually`, "error");
						}
					},
				},
				"Copy markdown",
			),
			h("span", { class: "small muted" }, `${markdown.split("\n").length} lines · generated locally`),
		),
		h("pre", { class: "json", style: { whiteSpace: "pre-wrap" } }, markdown),
	);
	openDrawer({ title, sub: "weekly record", body });
}

function openEventDrawer(row) {
	const body = h("div", {}, skeletonRows(5));
	openDrawer({ title: row.title ?? row.kind, sub: `${row.system} · ${fmtDateTime(row.ts)}`, body });
	api("/api/event", { id: row.id })
		.then(({ event }) => {
			clear(body);
			body.appendChild(
				kv([
					["System", event.system],
					["Kind", h("span", { class: "mono" }, event.kind)],
					["Severity", severityPill(event.severity)],
					["When", `${fmtDateTime(event.ts)} · ${timeAgo(event.ts)}`],
					["Session", event.sessionId ? h("a", { href: `#/session?id=${event.sessionId}` }, h("span", { class: "mono" }, event.sessionId)) : "—"],
					["Turn", event.turn ?? "—"],
					["Cost", event.costUsd != null ? fmtCost(event.costUsd) : "not logged"],
					["Latency", event.latencyMs != null ? fmtMs(event.latencyMs) : "—"],
					["Ref", event.ref ?? "—"],
					["Summary", event.summary ?? "—"],
				]),
			);
			body.appendChild(h("pre", { class: "json" }, JSON.stringify(event.data, null, 2)));
		})
		.catch((err) => {
			clear(body);
			body.appendChild(banner("error", err.message));
		});
}

// ------------------------------------------------------------------ overview

async function overview(view, ctx) {
	const [data, findingsData] = await Promise.all([api("/api/overview", { from: state.range }), api("/api/findings", { from: state.range })]);
	clear(view);

	// The landing page should say what to fix, not only what happened.
	const topFindings = nodeRegion((d) => {
		const list = (d.findings ?? []).slice(0, 3);
		if (!list.length) return emptyState("No findings in this range — nothing to fix.");
		return h("div", { class: "findings" }, ...list.map((finding) => findingItem(finding)));
	});

	const kpis = gridRegion((d) => {
		const t = d.totals;
		return [
			kpi({ label: "Model cost", value: fmtCost(t.costModel), sub: `${fmtInt(t.calls)} calls · ${fmtInt(t.sessions)} sessions` }),
			kpi({ label: "Harness cost (logged)", value: fmtCost(t.costHarness), sub: `${fmtInt(t.events)} decisions`, tip: "Only subsystems that log a per-call cost (guard, router, ask-jev). Others are not priced in the log — shown as-is rather than estimated." }),
			kpi({ label: "Tokens", value: fmtCompact(t.totalTokens), sub: `${fmtCompact(t.input)} in · ${fmtCompact(t.output)} out · ${fmtCompact(t.cacheRead)} cached` }),
			kpi({ label: "Cache rate", value: fmtPct(t.cacheRate, 1), sub: `${fmtCompact(t.cacheRead)} of ${fmtCompact(t.cacheRead + t.input)} prompt tokens`, sparkHtml: spark(d.daily.map((x) => x.cacheRead ?? 0), { height: 26 }) }),
			kpi({ label: "Turns", value: fmtInt(t.turns), sub: `${fmtInt(t.errors)} errored calls` }),
			kpi({ label: "Reasoning tokens", value: fmtCompact(t.reasoning), sub: "thinking / reasoning output" }),
		];
	});
	// One payload, three readings — each broken out per model (top 5 + other), with
	// harness overhead as its own segment where a subsystem logs a price.
	const dailyNote = { cost: "per model (top 5 + other) vs harness overhead", tokens: "per model (top 5 + other) — the harness logs none", requests: "calls per model (top 5 + other) vs harness decisions" };
	let dailyData = null;
	let dailySub = null;
	const chart = nodeRegion((d) => {
		dailyData = d;
		const metric = dailyMetric();
		const series = d.dailyMetrics?.[metric.id] ?? [];
		if (dailySub) dailySub.textContent = dailyNote[metric.id];
		return h(
			"div",
			{},
			h("div", { class: "chartctl" }, metricChips(() => chart.render(dailyData))),
			h("div", { html: barChart({ labels: d.daily.map((x) => x.date), series, stacked: true, height: 200, valueFmt: metric.fmt }) }),
			h("div", { class: "legendrow" }, legend(series.map((s) => ({ name: s.name })))),
		);
	});
	const dailyCard = card({ title: "Per day", sub: dailyNote[dailyMetric().id], body: chart.node, help: HELP.perDay });
	dailySub = dailyCard.querySelector(".cardhead .sub");
	const leverage = nodeRegion((d) => {
		const lev = d.leverage;
		const curatorVerdicts = Object.entries(lev.curator.verdicts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
		return h(
			"div",
			{ class: "grid cols-3" },
			card({
				title: "Curator leverage",
				sub: "context condensation",
				body: h(
					"div",
					{},
					kv([
						["Classified", fmtInt(lev.curator.candidates)],
						["Emits", fmtInt(lev.curator.emits)],
						["Chars condensed", lev.curator.savedChars !== null ? fmtCompact(lev.curator.savedChars) : h("span", { class: "faint" }, "not logged per emit")],
						["Retain full", fmtInt(lev.curator.retainFull)],
					]),
					curatorVerdicts.length ? h("div", { class: "chiprow", style: { marginTop: "10px" } }, ...curatorVerdicts.map(([v, n]) => pill(`${v} ${n}`, toneForVerdict(v)))) : null,
				),
			}),
			card({
				title: "Router leverage",
				sub: "tier decisions",
				body: h(
					"div",
					{},
					bars(Object.entries(lev.router.tiers ?? {}).map(([tier, count]) => ({ label: tier, value: count })), { valueFmt: fmtInt }),
					h("div", { class: "small muted", style: { marginTop: "9px" } }, `${fmtPct(lev.router.actedPct, 0)} acted on · ${fmtInt(lev.router.total)} decisions`),
				),
			}),
			card({
				title: "Rules & guard",
				sub: "TTSR + pre-tool screening",
				body: h(
					"div",
					{},
					kv([
						["TTSR fired", fmtInt(lev.ttsr.fired)],
						["Outcomes", `${fmtInt(lev.ttsr.good)} good · ${fmtInt(lev.ttsr.bad)} bad`],
						["TTSR blocks", fmtInt(lev.ttsr.blocked)],
						["Guard screens", fmtInt(lev.guard.total)],
						["Guard cost", fmtCost(lev.guard.cost)],
					]),
					h("div", { class: "chiprow", style: { marginTop: "10px" } }, ...Object.entries(lev.guard.verdicts ?? {}).map(([v, n]) => pill(`${v} ${n}`, toneForVerdict(v)))),
				),
			}),
		);
	});
	const topModels = nodeRegion((d) => bars((d.topModels ?? []).map((m) => ({ label: shortModel(m.model), value: m.cost, tip: `${m.model}\n${fmtCompact(m.tokens)} tokens` })), { valueFmt: fmtCost }));
	const watchlist = feed([], { clock: fmtClock });

	view.append(
		kpis.node,
		card({ title: "Top findings", sub: "the sharpest things to fix right now — full list on Impact", body: topFindings.node, help: HELP.findings }),
		dailyCard,
		leverage.node,
		h("div", { class: "split" }, card({ title: "Top models", sub: "by cost in range", body: topModels.node }), card({ title: "Watchlist", sub: "warnings and errors", flush: true, body: watchlist })),
	);

	const render = (d) => {
		kpis.render(d);
		chart.render(d);
		leverage.render(d);
		topModels.render(d);
		watchlist.patch((d.watchlist ?? []).map((row) => ({ key: row.id, ts: row.ts, tone: row.severity, title: `${row.system} · ${row.title ?? row.kind}`, sub: row.summary ?? "", onClick: () => openEventDrawer(row) })));
		topFindings.render(d);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(d.totals.calls)} model calls · ${fmtInt(d.totals.events)} harness events · ${(d.findings ?? []).length} findings`);
	};
	render({ ...data, findings: findingsData.findings });
	ctx.onAutoRefresh(async () => {
		const [next, nextFindings] = await Promise.all([api("/api/overview", { from: state.range }), api("/api/findings", { from: state.range })]);
		render({ ...next, findings: nextFindings.findings });
	});
}

// ------------------------------------------------------------------ impact

async function impactPage(view, ctx) {
	const [data, findingData, modelData, benefitsData, trendsData] = await Promise.all([
		api("/api/impact", { from: state.range, model: state.impactModel }),
		api("/api/findings", { from: state.range }),
		api("/api/models", { from: state.range }),
		api("/api/benefits", { from: state.range }),
		api("/api/trends", { from: state.range }),
	]);
	clear(view);

	const scopeNote = h("span", { class: "small muted" }, "");
	const picker = modelPicker({
		options: [
			{ value: null, label: "All models", meta: `${fmtInt(modelData.byModel.reduce((a, m) => a + m.calls, 0))} calls` },
			...modelData.byModel.map((m) => ({ value: m.model, label: shortModel(m.model), meta: `${fmtInt(m.calls)} calls · ${fmtCost(m.cost)}` })),
		],
		value: state.impactModel,
		onChange: (next) => {
			state.impactModel = next;
			// Shareable URL without a full page rebuild.
			history.replaceState(null, "", next ? `#/impact?model=${encodeURIComponent(next)}` : "#/impact");
			void refreshAll();
		},
	});
	const toolbar = h(
		"div",
		{ class: "page-toolbar" },
		h("span", { class: "small muted" }, "Impact for"),
		picker,
		helpButton(HELP.scope),
		h(
			"button",
			{
				class: "btn",
				title: "Markdown summary of this window — copy it into a note or keep it as a record",
				onclick: async () => {
					try {
						const result = await api("/api/digest", { from: state.range, label: RANGE_LABEL[state.range] });
						openMarkdownDrawer(`Digest — ${RANGE_LABEL[state.range]}`, result.markdown);
					} catch (err) {
						toast(`Digest failed: ${err.message}`, "error");
					}
				},
			},
			"Digest",
		),
		scopeNote,
	);

	const netOf = (d) => (d.curator.savedUsdEst ?? 0) + d.cache.savingsUsd - (d.scope?.model ? 0 : d.overhead.cost);

	const ledgerRows = (d) => [
		{
			key: "curator",
			mechanism: "Curator condensation",
			trendKey: "curatorTokens",
			volume: `${fmtInt(d.curator.emits)} emits · ${fmtInt(d.curator.retainFull)} retained full`,
			tokens: `${fmtCompact(d.curator.savedTokensEst)} not re-read`,
			usd: d.curator.savedUsdEst != null ? fmtCost(d.curator.savedUsdEst) : "—",
			basis: "(source chars − extract chars) ÷ 4 at each trim, counted again on every call that followed, priced at the rate each call was billed at",
		},
		{
			key: "cache",
			mechanism: "Provider cache reuse",
			trendKey: "cacheDiscount",
			volume: `${fmtInt(d.cache.pricedCalls)} priced calls · ${fmtInt(d.cache.unpricedCalls)} unpriced`,
			tokens: fmtCompact(d.cache.cacheReadTokens),
			usd: fmtCost(d.cache.savingsUsd),
			basis: "cache_read × (input rate − cache_read rate)",
		},
		{
			key: "router",
			mechanism: "Router escalations",
			volume: `${fmtInt(d.router.escalations)} acted · ${fmtInt(d.router.matched)} joined to calls`,
			tokens: fmtCompact(d.router.tokens),
			usd: `${d.router.usd >= 0 ? "+" : "−"}${fmtCost(Math.abs(d.router.usd))}`,
			basis: "same session+turn call tokens × model price delta (positive = cost more, negative = saved)",
		},
		{
			key: "guard",
			mechanism: "Guard blocks & flags",
			volume: `${fmtInt(d.guard.blocked)} blocked · ${fmtInt(d.guard.flagged)} flagged · ${fmtInt(d.guard.screens)} screens`,
			tokens: "—",
			usd: "—",
			basis: "count only — avoided damage is not priced in the logs",
		},
		{
			key: "ttsr",
			mechanism: "Rules fired",
			volume: `${fmtInt(d.ttsr.fired)} fired · ${fmtInt(d.ttsr.delivered)} delivered · ${fmtInt(d.ttsr.blocked)} blocks`,
			tokens: "—",
			usd: "—",
			basis: `outcomes ${fmtInt(d.ttsr.good)} good · ${fmtInt(d.ttsr.bad)} bad · ${fmtInt(d.ttsr.unresolved)} unresolved`,
		},
		{
			key: "memory",
			mechanism: "Memory hygiene",
			volume: `${fmtInt(d.memory.consolidations)} consolidations · ${fmtInt(d.memory.admissions)} admissions · ${fmtInt(d.memory.rejected)} rejected`,
			tokens: `${fmtCompact(d.memory.shrinkBytes)}B shrunk`,
			usd: "—",
			basis: "consolidation shrink_bytes recorded by the memory worker",
		},
		{
			key: "course",
			mechanism: "Course checks",
			volume: `${fmtInt(Object.values(d.course).reduce((a, b) => a + b, 0))} checks`,
			tokens: "—",
			usd: "—",
			basis: Object.entries(d.course)
				.map(([k, v]) => `${k} ${v}`)
				.join(" · ") || "no verdicts in range",
		},
	];
	let trendSeriesCache = null;
	const ledger = table({
		columns: [
			{ label: "Mechanism", width: "18%", render: (row) => h("span", { class: "rowtitle" }, row.mechanism) },
			{ label: "Volume", width: "26%", render: (row) => h("span", { class: "small muted" }, row.volume) },
			{ label: "Tokens", right: true, width: "88px", render: (row) => row.tokens },
			{ label: "Est. $", right: true, width: "84px", render: (row) => row.usd },
			{
				label: "Trend",
				width: "104px",
				render: (row) => {
					const series = row.trendKey ? (trendSeriesCache?.[row.trendKey] ?? []) : [];
					if (!series.length) return h("span", { class: "faint" }, "—");
					return h("div", { style: { width: "80px" }, "data-tip": `${row.mechanism} by day` }, h("span", { html: spark(series.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0)), { height: 18, color: "var(--s1)" }) }));
				},
			},
			{ label: "Basis", render: (row) => h("span", { class: "small faint" }, row.basis) },
		],
		rows: [],
	});

	const findingsRegion = nodeRegion((d) => {
		const list = d.findings ?? [];
		if (!list.length) {
			return card({ flush: true, body: h("p", { class: "findings-empty" }, "Nothing in this range crossed a diagnostic threshold. These checks re-run on every refresh.") });
		}
		return h("div", { class: "findings" }, ...list.map((finding) => findingItem(finding)));
	});
	const leversTable = table({
		columns: [
			{ label: "Lever", render: (row) => h("span", { class: "rowtitle" }, row.lever) },
			{ label: "Where to change it", render: (row) => h("span", { class: "mono", style: { fontSize: "11.5px" } }, row.where) },
			{ label: "What it affects", render: (row) => h("span", { class: "muted" }, row.effect) },
		],
		rows: LEVERS,
	});


	// --- harness benefit: every mechanism, measured cost vs counterfactual
	const benefitKpis = gridRegion((d) => {
		const b = d.benefits;
		return [
			kpi({
				label: "Rules: injection vs resident",
				value: b.rules.net == null ? "—" : fmtCost(b.rules.net),
				sub: `${fmtInt(b.rules.deliveries)} deliveries ≈ ${fmtCost(b.rules.injectedCost ?? 0)} vs ${fmtCost(b.rules.alwaysOnCost ?? 0)} if always-on`,
				valueClass: "good",
				help: HELP.benefitRules,
			}),
			kpi({
				label: "Tokens condensed (curator)",
				value: fmtCompact(d.curator.savedTokensEst),
				sub: `${fmtCompact(d.curator.savedTokensOneTime)} one-time · ${fmtInt(d.curator.retainFull)} items kept in full`,
				valueClass: "good",
				help: HELP.benefitCurator,
			}),
			kpi({
				label: "Always-on prompt cost",
				value: b.baseline.cost == null ? "—" : fmtCost(b.baseline.cost),
				sub: `${fmtCompact(b.baseline.tokens)} tok/call × ${fmtInt(b.baseline.calls)} calls`,
				help: HELP.benefitBaseline,
			}),
			kpi({
				label: "Rework avoided (est.)",
				value: b.goalLoop.reworkEstimate == null ? "—" : fmtCost(b.goalLoop.reworkEstimate),
				sub: `${fmtInt(b.goalLoop.offTrack)} off-track × avg call ${fmtCost(b.avgCallCost ?? 0)}`,
				help: HELP.benefitGoal,
			}),
			kpi({
				label: "Guard cost per block",
				value: b.guard.costPerBlock == null ? "—" : fmtCost(b.guard.costPerBlock),
				sub: `${fmtInt(b.guard.blocked)} blocked · ${fmtInt(b.guard.flagged)} flagged of ${fmtInt(b.guard.screens)}`,
				help: HELP.benefitGuard,
			}),
			kpi({
				label: "Jev request spend (all subsystems)",
				value: fmtCost(b.jev?.cost ?? 0),
				sub: `${fmtInt(b.jev?.requests ?? 0)} requests · ${fmtPct((b.jev?.pricedRequests ?? 0) / Math.max(1, b.jev?.requests ?? 1), 0)} costed · ${fmtCost(b.jev?.costPerRequest ?? 0)}/request`,
				help: HELP.benefitJev,
			}),
		];
	});
	const benefitTable = nodeRegion((d) => {
		const b = d.benefits;
		const c = d.curator;
		const toolMix = Object.entries(b.judgment.tools)
			.sort((a, z) => z[1] - a[1])
			.slice(0, 4)
			.map(([name, count]) => `${name} ${count}`)
			.join(" · ");
		return table({
			columns: [
				{ label: "Mechanism", width: "16%", render: (row) => h("span", { class: "rowtitle" }, row.mechanism) },
				{ label: "Costs you now", width: "18%", render: (row) => h("span", { class: "small muted" }, row.now) },
				{ label: "The alternative", width: "22%", render: (row) => h("span", { class: "small muted" }, row.alternative) },
				{ label: "Net", right: true, width: "104px", render: (row) => row.net },
				{
					label: "Trend",
					width: "104px",
					render: (row) => {
						const series = row.trendKey ? (d.trends?.series?.[row.trendKey] ?? []) : [];
						if (!series.length) return h("span", { class: "faint" }, "—");
						return h("div", { style: { width: "80px" }, "data-tip": `${row.mechanism} by day` }, h("span", { html: spark(series.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0)), { height: 18, color: "var(--s2)" }) }));
					},
				},
				{ label: "Basis", render: (row) => h("span", { class: "small faint" }, row.basis) },
			],
			rows: [
				{
					key: "rules",
					mechanism: "Rule delivery (TTSR)",
					trendKey: "rulesTokensAvoided",
					now: `${fmtInt(b.rules.deliveries)} deliveries · ${fmtCompact(b.rules.deliveredTokens)} tok · ${fmtCost(b.rules.injectedCost ?? 0)}`,
					alternative: `all ${fmtInt(b.rules.ruleCount)} rules resident: ${fmtCompact(b.rules.tokens)} tok × ${fmtInt(b.baseline.calls)} calls = ${fmtCost(b.rules.alwaysOnCost ?? 0)}`,
					net: h("span", { style: { color: "var(--ok)", fontWeight: "650" } }, `${fmtCost(b.rules.net ?? 0)} saved`),
					basis: `Rule text ÷ 4, priced at ${fmtCost((b.rates.effectivePerToken ?? 0) * 1_000_000)}/M. Resident rules would add ${fmtPct(b.rules.shareOfBaseline ?? 0, 1)} to the always-on prompt.`,
				},
				{
					key: "curator",
					mechanism: "Context curator",
					trendKey: "curatorTokens",
					now: `${fmtInt(c.emits)} condensed of ${fmtInt(c.candidates)} candidates · ${fmtInt(c.retainFull)} kept in full · verifier spend sits in the Jev row`,
					alternative: `kept in context instead: ${fmtCompact(c.savedTokensOneTime)} tok condensed + ${fmtCompact(c.savedTokensEst)} tok not re-read across later calls ≈ ${fmtCost(c.savedUsdEst ?? 0)}`,
					net:
						c.savedUsdEst == null
							? h("span", { class: "faint" }, "no rate")
							: h("span", { style: { color: "var(--ok)", fontWeight: "650" } }, `${fmtCost(c.savedUsdEst)} saved`),
					basis: `(source chars − extract chars) ÷ 4 for every item delivered as an extract or index only, counted again on each model call that followed it, priced at the rate those calls were billed at (${fmtCost((b.rates.effectivePerToken ?? 0) * 1_000_000)}/M is the range average) — exact for the chars condensed, an estimate for what they would have cost on later calls. Items kept in full are counted, not priced. The curator's own verifier calls are counted in the Jev row, not here.`,
				},
				{
					key: "baseline",
					mechanism: "Always-on prompt",
					now: `${fmtCompact(b.baseline.tokens)} tok/call (${fmtCompact(b.baseline.chars)} chars) × ${fmtInt(b.baseline.calls)} calls = ${fmtCost(b.baseline.cost ?? 0)}`,
					alternative: "—",
					net: h("span", { class: "faint" }, "the floor"),
					basis: `Replayed system sections + tool declarations, averaged over ${fmtInt(b.baseline.sessions)} sessions. Everything the harness adds sits on top of this.`,
				},
				{
					key: "guard",
					mechanism: "Guard (pre-tool screening)",
					trendKey: "guardBlocks",
					now: `${fmtInt(b.guard.screens)} screens · ${fmtCost(b.guard.cost)}`,
					alternative: `${fmtInt(b.guard.blocked)} blocked · ${fmtInt(b.guard.flagged)} flagged before running`,
					net: h("span", { class: "faint" }, "count only"),
					basis: "A destructive command that never ran has no logged dollar value — reported as a count, never priced.",
				},
				{
					key: "goal",
					mechanism: "Goal loop (course-check)",
					now: `${fmtInt(b.goalLoop.checks)} checks · cost not logged`,
					alternative: `${fmtInt(b.goalLoop.offTrack)} off-track × avg call ${fmtCost(b.avgCallCost ?? 0)} ≈ ${fmtCost(b.goalLoop.reworkEstimate ?? 0)}`,
					net:
						b.goalLoop.reworkEstimate == null ? h("span", { class: "faint" }, "—") : h("span", { style: { color: "var(--ok)" } }, `${fmtCost(b.goalLoop.reworkEstimate)} est.`),
					basis: "Estimate: drift caught usually costs at least one corrective turn. It counts the turn you did not spend, not any quality difference.",
				},
				{
					key: "jev",
					mechanism: "Jev request spend (all subsystems)",
					trendKey: "jevSpend",
					now: `${fmtInt(b.jev?.requests ?? 0)} requests · ${fmtCost(b.jev?.cost ?? 0)} (${fmtCost(b.jev?.costLogged ?? 0)} logged + ${fmtCost(b.jev?.costDerived ?? 0)} derived)`,
					alternative: `${(b.jev?.bySystem ?? []).slice(0, 4).map((s) => `${s.system} ${fmtInt(s.requests)}`).join(" · ")} · ask-jev reads avoided ≈ ${fmtCost(b.judgment.avoidedUsd ?? 0)}`,
					net: h("span", { class: "faint" }, `${fmtCost(b.jev?.costPerRequest ?? 0)}/request`),
					basis: `Every harness decision is a Jev call. Guard and ask-jev log cost directly; curator verifier batches are priced from their logged model+usage; the rest (ttsr gates, memory, router, course-check) record latency but no cost — counted, not priced. Ask-jev mix: ${toolMix || "none"}.`,
				},
				{
					key: "memory",
					mechanism: "Memory store",
					now: `${fmtCompact(b.memory.chars)} chars on disk (${fmtInt(b.memory.files)} files) · ${fmtInt(b.memory.consolidations)} consolidations`,
					alternative: `shrink recorded by consolidation: ${fmtCompact(b.memory.shrinkBytes)} bytes`,
					net: h("span", { class: "faint" }, "not priced"),
					basis: "Only part of the store is injected per turn and that selection is not logged — residency is shown, not costed.",
				},
			],
		});
	});

	const curatorSources = nodeRegion((d) => bars(Object.entries(d.curator.savedBySource).map(([label, value]) => ({ label, value })), { valueFmt: fmtCompact }));
	const ruleSummary = h("div", { class: "small muted", style: { padding: "10px 14px 2px" } }, "");
	const ruleQuality = table({
		columns: [
			{ label: "Rule", render: (row) => h("span", { class: "rowtitle" }, row.rule) },
			{ label: "Fired", right: true, render: (row) => fmtInt(row.fired) },
			{ label: "Good", right: true, render: (row) => countPill(row.good, "ok") },
			{ label: "Bad", right: true, render: (row) => countPill(row.bad, "error") },
			{
				label: "Precision",
				right: true,
				render: (row) => (row.precision == null ? h("span", { class: "faint" }, "no verdicts") : pill(`${Math.round(row.precision * 100)}%`, qualityTone(row.precision))),
			},
		],
		rows: [],
		maxHeight: "380px",
	});
	const qualityMeters = gridRegion((d) => {
		const q = d.quality;
		const escalationRate = d.curator.candidates ? q.verifierEscalations / d.curator.candidates : null;
		return [
			meter({
				label: "Verifier agreement",
				value: q.verifierAgreement,
				tone: qualityTone(q.verifierAgreement),
				detail: q.verifierAbTotal ? `${fmtInt(q.verifierAbAgree)} of ${fmtInt(q.verifierAbTotal)} frontier samples agreed` : "no A/B samples in range",
				tip: "Jev's approval vs an independent frontier check on sampled curator proposals.",
				help: HELP.verifierAgreement,
			}),
			meter({
				label: "Rule precision",
				value: q.rulePrecision.rate,
				tone: qualityTone(q.rulePrecision.rate),
				detail: `${fmtInt(q.rulePrecision.good)} good · ${fmtInt(q.rulePrecision.bad)} bad outcomes`,
				tip: "Outcome verdicts are only logged when a signal is observed (a correction, a test result), so this is precision over judged cases — not every rule fire.",
				help: HELP.rulePrecision,
			}),
			meter({
				label: "Router outcome verdicts",
				value: q.routerVerdicts.good + q.routerVerdicts.bad > 0 ? q.routerVerdicts.good / (q.routerVerdicts.good + q.routerVerdicts.bad) : null,
				tone: qualityTone(q.routerVerdicts.good + q.routerVerdicts.bad > 0 ? q.routerVerdicts.good / (q.routerVerdicts.good + q.routerVerdicts.bad) : null),
				detail: `${fmtInt(q.routerVerdicts.good)} good · ${fmtInt(q.routerVerdicts.bad)} bad tagged outcomes`,
				tip: `Only ${fmtInt(d.router.judged)} of ${fmtInt(d.router.total)} router decisions in range carried an outcome verdict — treat the ratio as a sample of judged cases, not a score of all routing.`,
				help: HELP.routerVerdicts,
			}),
			meter({
				label: "Guard clean rate",
				value: q.guardClean.rate,
				tone: qualityTone(q.guardClean.rate),
				detail: `${fmtInt(q.guardClean.blocked)} blocked · ${fmtInt(q.guardClean.flagged)} flagged of ${fmtInt(q.guardClean.screens)}`,
			}),
			meter({
				label: "Goal health",
				value: q.goalHealth.rate,
				tone: qualityTone(q.goalHealth.rate),
				detail: `${fmtInt(q.goalHealth.onTrack)} on track · ${fmtInt(q.goalHealth.goalMet)} met · ${fmtInt(q.goalHealth.offTrack)} off`,
			}),
			meter({
				label: "Call error rate",
				value: q.callErrors.rate,
				tone: qualityTone(q.callErrors.rate, { invert: true }),
				detail: `${fmtInt(q.callErrors.errors)} errors of ${fmtInt(q.callErrors.calls)} calls`,
				tip: "Lower is better — the colour is inverted for this metric.",
				help: HELP.callErrors,
			}),
			meter({
				label: "Frontier escalations",
				value: escalationRate,
				tone: qualityTone(escalationRate, { invert: true }),
				detail: `${fmtInt(q.verifierEscalations)} of ${fmtInt(d.curator.candidates)} candidates · ${fmtInt(q.repairs.repaired)}/${fmtInt(q.repairs.verified)} repairs · ${fmtInt(q.repairs.lostLines)} lines recovered`,
				tip: "How often the Jev verifier needed a frontier check, and how many goal-relevant lines the repair pass recovered before emitting.",
				help: HELP.escalations,
			}),
			meter({
				label: "User corrections",
				value: null,
				display: fmtInt(q.userCorrections),
				tone: q.userCorrections === 0 ? "ok" : q.userCorrections <= 5 ? "warn" : "error",
				detail: "times you corrected the agent after a rule or routing decision",
				tip: "Counted from TTSR and router outcome records with outcome=user_corrected.",
				help: HELP.userCorrections,
			}),
		];
	});
	const catches = feed([], { clock: fmtClock });
	const facts = nodeRegion((d) =>
		h(
			"div",
			{},
			kv([
				["Memory admissions", fmtInt(d.memory.admissions)],
				["Memory rejected", fmtInt(d.memory.rejected)],
				["Memory degraded", countPill(d.memory.degraded, "warn")],
				["Consolidations", fmtInt(d.memory.consolidations)],
				["Blended input rate", d.rates.blendedInputPerToken != null ? `${fmtCost(d.rates.blendedInputPerToken * 1_000_000)}/M` : "—"],
				["Priced coverage", d.rates.pricedCoverage != null ? fmtPct(d.rates.pricedCoverage, 1) : "—"],
			]),
		),
	);

	// Trends: this window against the identical window before it, plus per-day
	// series — the "am I improving?" view a snapshot cannot answer.
	const trendsBadge = h("span", { class: "pill neutral" }, "…");
	const trendsRegion = nodeRegion((t) => {
		const current = t.current ?? {};
		const previous = t.previous ?? {};
		const delta = t.delta ?? {};
		const sanitize = (values) => (values ?? []).map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0));
		// `points` switches the delta to percentage points, which is the only honest
		// way to express a change in a rate (a relative % of a ratio misleads).
		const cell = (label, value, change, direction, sub = null, points = null) => {
			let tone = "flat";
			if (change != null && change !== 0) {
				if (direction === "up-good") tone = change > 0 ? "up" : "down";
				else if (direction === "down-good") tone = change < 0 ? "up" : "down";
			}
			const deltaText =
				change == null
					? null
					: points != null
						? `${points > 0 ? "+" : ""}${points.toFixed(1)}pp vs prev`
						: `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}% vs prev`;
			return h(
				"div",
				{ class: "delta-cell" },
				h("div", { class: "delta-label" }, label),
				h("div", { class: "delta-value" }, value),
				sub ? h("div", { class: "delta-sub" }, sub) : null,
				deltaText == null ? h("div", { class: "delta-delta flat" }, "no prior data") : h("div", { class: `delta-delta ${tone}` }, deltaText),
			);
		};
		return h(
			"div",
			{ class: "grid" },
			h(
				"div",
				{ class: "delta-grid" },
				cell("Cost per call", fmtCost(current.costPerCall ?? 0), delta.costPerCall, "down-good", `total ${fmtCost(current.cost ?? 0)} over ${fmtInt(current.calls ?? 0)} calls`),
				cell("Prompt tokens per call", fmtCompact(current.promptTokensPerCall ?? 0), delta.promptTokensPerCall, "down-good", "the context every call sends"),
				cell("Context condensed per call", fmtCompact(current.curatorTokensPerCall ?? 0), delta.curatorTokensPerCall, "up-good", `${fmtCompact(current.curatorTokens ?? 0)} tok total`),
				cell("Rules avoided per call", fmtCompact(current.rulesTokensAvoidedPerCall ?? 0), delta.rulesTokensAvoidedPerCall, "up-good", "stable = rule set unchanged"),
				cell("Cache discount per call", fmtCost(current.cacheDiscountPerCall ?? 0), delta.cacheDiscountPerCall, "up-good", `${fmtCost(current.cacheDiscount ?? 0)} total`),
				cell("Cache rate", fmtPct(current.cacheRate, 0), delta.cacheRate, "up-good", `was ${fmtPct(previous.cacheRate, 0)}`, ((current.cacheRate ?? 0) - (previous.cacheRate ?? 0)) * 100),
				cell("Error rate", fmtPct(current.errorRate, 1), delta.errorRate, "down-good", `was ${fmtPct(previous.errorRate, 1)}`, ((current.errorRate ?? 0) - (previous.errorRate ?? 0)) * 100),
				cell("Rule precision", fmtPct(current.rulePrecision, 0), delta.rulePrecision, "up-good", `${fmtInt(current.judgedOutcomes ?? 0)} judged · was ${fmtPct(previous.rulePrecision, 0)}`, ((current.rulePrecision ?? 0) - (previous.rulePrecision ?? 0)) * 100),
				cell(
					"Verifier agreement",
					fmtPct(current.verifierAgreement, 0),
					delta.verifierAgreement,
					"up-good",
					`${fmtInt(current.verifierHits ?? 0)}/${fmtInt(current.verifierSamples ?? 0)} samples · was ${fmtPct(previous.verifierAgreement, 0)} (${fmtInt(previous.verifierSamples ?? 0)} samples)`,
					((current.verifierAgreement ?? 0) - (previous.verifierAgreement ?? 0)) * 100,
				),
				cell("Corrections per 100 calls", (current.correctionsPer100Calls ?? 0).toFixed(2), delta.correctionsPer100Calls, "down-good", `${fmtInt(current.corrections ?? 0)} total`),
				cell("Jev spend per call", fmtCost(current.jevSpendPerCall ?? 0), delta.jevSpendPerCall, "neutral", `${fmtCost(current.jevSpend ?? 0)} total`),
			),
			h(
				"div",
				{ class: "grid cols-2" },
				card({
					title: "Cost per call vs cache discount",
					sub: "per-call economics in $ — how much of each call caching gives back",
					body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "cost per call", values: sanitize(t.series.costPerCall) }, { name: "cache discount per call", values: sanitize(t.series.cacheDiscountPerCall) }], height: 170, valueFmt: (value) => `$${value.toFixed(4)}` }) }),
				}),
				card({ title: "Prompt tokens per call", sub: "context sent per call — the denominator behind every other number", body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "tokens per call", values: sanitize(t.series.promptTokensPerCall) }], height: 170, valueFmt: fmtCompact }) }) }),
				card({ title: "Context condensed per call", sub: "curator tokens kept out per call — context discipline", body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "tokens per call", values: sanitize(t.series.curatorTokensPerCall) }], height: 170, valueFmt: fmtCompact }) }) }),
				card({ title: "Quality per day", sub: "error rate · rule precision · verifier agreement", body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "error rate", values: sanitize(t.series.errorRate) }, { name: "rule precision", values: sanitize(t.series.rulePrecision) }, { name: "verifier agreement", values: sanitize(t.series.verifierAgreement) }], height: 170, valueFmt: (value) => `${(value * 100).toFixed(0)}%` }) }) }),
			),
			h(
				"div",
				{ class: "grid cols-2" },
				card({
					title: "Quality per day",
					sub: "error rate · rule precision · verifier agreement",
					body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "error rate", values: sanitize(t.series.errorRate) }, { name: "rule precision", values: sanitize(t.series.rulePrecision) }, { name: "verifier agreement", values: sanitize(t.series.verifierAgreement) }], height: 170, valueFmt: (value) => `${(value * 100).toFixed(0)}%` }) }),
				}),
				card({ title: "Cache discount per day", sub: "provider caching, priced from your rates", body: h("div", { html: areaChart({ labels: t.labels, series: [{ name: "discount", values: sanitize(t.series.cacheDiscount) }], height: 170, valueFmt: fmtCost }) }) }),
			),
		);
	});
	const trendsSection = collapsible({
		id: "trends",
		title: "Trends",
		sub: "this window against the one before it · per-day series for the harness's own numbers",
		badge: trendsBadge,
		body: trendsRegion.node,
	});

	// Collapsible dropdowns. Header badges summarise the contents
	// so a collapsed section still reports whether it is worth opening.
	const benefitBadge = h("span", { class: "pill accent" }, "…");
	const qualityBadge = h("span", { class: "pill neutral" }, "…");
	const findingsBadge = h("span", { class: "pill neutral" }, "…");
	const benefitSection = collapsible({
		id: "benefit",
		title: "Harness benefit",
		sub: "what each mechanism costs you now versus what the alternative would cost",
		badge: benefitBadge,
		open: true,
		body: h(
			"div",
			{ class: "grid" },
			benefitKpis.node,
			card({ title: "Benefit ledger", sub: "measured costs, explicit counterfactuals, and what cannot be priced", flush: true, body: benefitTable.node, help: HELP.benefits }),
		),
	});
	const qualitySection = collapsible({
		id: "quality",
		title: "Quality signals",
		sub: "how healthy the harness's own judgments are · green ≥90% · amber ≥70% · red below",
		badge: qualityBadge,
		body: qualityMeters.node,
	});
	const findingsSection = collapsible({
		id: "findings",
		title: "Where to improve",
		sub: "diagnostics from this range, sharpest first — each states its evidence and the lever",
		badge: findingsBadge,
		body: findingsRegion.node,
	});

	view.append(
		toolbar,
		trendsSection,
		benefitSection,
		qualitySection,
		findingsSection,
		card({ title: "Impact ledger", sub: "what each mechanism did, and how it was measured", flush: true, body: ledger, help: HELP.impactLedger }),
		h(
			"div",
			{ class: "split" },
			card({ title: "Curator savings by source", sub: "chars condensed per source type", body: curatorSources.node, help: HELP.curatorSources }),
			card({ title: "Rule quality", sub: "outcomes per rule · precision where verdicts exist", body: h("div", {}, ruleSummary, ruleQuality), help: HELP.ruleQuality }),
		),
		h(
			"div",
			{ class: "split" },
			card({ title: "Guard catches", sub: "blocked or flagged commands, highest destructive score first", flush: true, body: catches, help: HELP.guardCatches }),
			card({ title: "Memory & rates", sub: "the inputs behind the estimates", body: facts.node, help: HELP.memoryRates }),
		),
		card({ title: "Levers", sub: "what to change in the harness, and where", flush: true, body: leversTable, help: HELP.levers }),
		banner(
			"info",
			"How to read this — curator savings are counted per remaining turn in the session they happened in (condensed text is re-billed every turn it stays out of context); cache savings come from live model prices; guard/TTSR/memory counts are exact but their value is not priced (avoided damage has no logged dollar figure); curator verifier calls (Jev + frontier) are not metered, so true overhead is somewhat higher than the logged-cost column. Verdict-based quality figures cover only cases where an outcome was observed, so read them as a sample of judged decisions rather than all of them.",
		),
	);

	const render = (d) => {
		findingsRegion.render(d);
		trendSeriesCache = d.trends?.series ?? null;
		ledger.patch(ledgerRows(d));
		qualityMeters.render(d);
		benefitKpis.render(d);
		benefitTable.render(d);
		trendsRegion.render(d.trends ?? { labels: [], series: {} });
		const trendDelta = d.trends?.delta ?? {};
		const fmtDeltaPct = (value) => (value == null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(0)}%`);
		trendsBadge.textContent = `cost/call ${fmtDeltaPct(trendDelta.costPerCall)} · errors ${fmtDeltaPct(trendDelta.errorRate)} · corrections/100 ${fmtDeltaPct(trendDelta.correctionsPer100Calls)}`;
		curatorSources.render(d);
		ruleSummary.textContent = `${fmtInt(d.ttsr.fired)} fired · ${fmtInt(d.ttsr.delivered)} delivered · ${fmtInt(d.ttsr.blocked)} blocks · ${fmtInt(d.ttsr.suppressed)} gate-suppressed · ${fmtInt(d.ttsr.unresolved)} unresolved`;
		ruleQuality.patch(d.ttsr.topRules.map((rule) => ({ ...rule, key: rule.rule, precision: rule.good + rule.bad > 0 ? rule.good / (rule.good + rule.bad) : null })));
		facts.render(d);
		catches.patch(
			d.guard.destructive.map((row, index) => ({
				key: `${row.ts}|${index}`,
				ts: row.ts,
				tone: "warn",
				title: row.command,
				sub: `destructive ${row.destructive.toFixed(2)}`,
			})),
		);
		// Header badges for the collapsed sections.
		const benefitModel = d.benefits;
		const grossBenefit = (benefitModel.rules.net ?? 0) + (benefitModel.goalLoop.reworkEstimate ?? 0) + (d.curator.savedUsdEst ?? 0) + (benefitModel.judgment.avoidedUsd ?? 0);
		benefitBadge.textContent = `net ≈ ${fmtCost(grossBenefit - (benefitModel.jev?.cost ?? 0))}`;
		const q = d.quality;
		const tones = [
			qualityTone(q.verifierAgreement),
			qualityTone(q.rulePrecision.rate),
			qualityTone(q.routerVerdicts.good + q.routerVerdicts.bad > 0 ? q.routerVerdicts.good / (q.routerVerdicts.good + q.routerVerdicts.bad) : null),
			qualityTone(q.guardClean.rate),
			qualityTone(q.goalHealth.rate),
			qualityTone(q.callErrors.rate, { invert: true }),
			qualityTone(d.curator.candidates ? q.verifierEscalations / d.curator.candidates : null, { invert: true }),
		];
		const needAttention = tones.filter((tone) => tone === "error").length;
		const watch = tones.filter((tone) => tone === "warn").length;
		qualityBadge.className = `pill ${needAttention ? "error" : watch ? "warn" : "ok"}`;
		qualityBadge.textContent = needAttention ? `${needAttention} need attention${watch ? ` · ${watch} watch` : ""}` : watch ? `${watch} to watch` : "all green";
		const findingList = d.findings ?? [];
		const worstTone = findingList.some((f) => f.tone === "error") ? "error" : findingList.some((f) => f.tone === "warn") ? "warn" : findingList.length ? "info" : "ok";
		findingsBadge.className = `pill ${worstTone === "error" ? "error" : worstTone === "warn" ? "warn" : worstTone === "ok" ? "ok" : "neutral"}`;
		findingsBadge.textContent = `${findingList.length} finding${findingList.length === 1 ? "" : "s"}`;
		ctx.setStatus(`${RANGE_LABEL[state.range]} · net ${fmtCost(netOf(d))} (est.) · ${findingList.length} findings`);
		scopeNote.textContent = d.scope?.model
			? `scoped to ${d.scope.model} · curator savings attributed by the model in use at that turn (${d.scope.curatorItemsTotal ? Math.round((d.scope.curatorItemsAttributed / d.scope.curatorItemsTotal) * 100) : 0}% attributable) · overhead and non-model meters stay global`
			: "all models in range";
	};
	async function refreshAll() {
		const [next, nextFindings, nextBenefits, nextTrends] = await Promise.all([
			api("/api/impact", { from: state.range, model: state.impactModel }),
			api("/api/findings", { from: state.range }),
			api("/api/benefits", { from: state.range }),
			api("/api/trends", { from: state.range }),
		]);
		render({ ...next, findings: nextFindings.findings, benefits: nextBenefits, trends: nextTrends });
	}
	render({ ...data, findings: findingData.findings, benefits: benefitsData, trends: trendsData });
	ctx.onAutoRefresh(refreshAll);
}

// ------------------------------------------------------------------ models

async function models(view, ctx) {
	const data = await api("/api/models", { from: state.range });
	clear(view);
	const totalCostOf = (d) => d.byModel.reduce((a, m) => a + m.cost, 0);
	const totalCallsOf = (d) => d.byModel.reduce((a, m) => a + m.calls, 0);

	const kpis = gridRegion((d) => [
		kpi({ label: "Cost", value: fmtCost(totalCostOf(d)), sub: `${d.byModel.length} models` }),
		kpi({ label: "Calls", value: fmtInt(totalCallsOf(d)) }),
		kpi({ label: "Cache savings", value: fmtCost(d.cache.savingsUsd), sub: `${fmtInt(d.cache.pricedCalls)} priced · ${fmtInt(d.cache.unpricedCalls)} unpriced`, tip: "Estimated from live model prices (cache read rate vs input rate) for calls whose model has a known price." }),
		kpi({ label: "Unpriced calls", value: fmtInt(d.cache.unpricedCalls), sub: "no matching price in models-store" }),
	]);
	let dailyData = null;
	let dailySub = null;
	const chart = nodeRegion((d) => {
		dailyData = d;
		const metric = dailyMetric();
		const series = d.daily.byMetric?.[metric.id] ?? d.daily.series;
		if (dailySub) dailySub.textContent = `top 5 + other · ${metric.label.toLowerCase()}`;
		return h(
			"div",
			{},
			h("div", { class: "chartctl" }, metricChips(() => chart.render(dailyData))),
			h("div", { html: barChart({ labels: d.daily.labels, series, stacked: true, height: 210, valueFmt: metric.fmt }) }),
		);
	});
	const dailyCard = card({ title: "Per day by model", sub: "top 5 + other", actions: legend(data.daily.series.slice(0, 6).map((s) => ({ name: s.name }))), body: chart.node });
	dailySub = dailyCard.querySelector(".cardhead .sub");
	const byModel = table({
		columns: [
			{ label: "Model", width: "18%", render: (row) => modelCell(row.model) },
			{ label: "Calls", right: true, width: "60px", render: (row) => fmtInt(row.calls) },
			{ label: "Tokens", right: true, width: "74px", render: (row) => fmtCompact(row.tokens) },
			{ label: "Cache rate", right: true, width: "78px", render: (row) => fmtPct(row.cacheRate, 0) },
			{ label: "Tokens / call", right: true, width: "88px", render: (row) => fmtCompact(row.tokensPerCall) },
			{ label: "Cost / call", right: true, width: "80px", render: (row) => (row.costPerCall == null ? "—" : fmtCost(row.costPerCall)) },
			{
				label: "Trend",
				width: "96px",
				render: (row) => h("div", { style: { width: "84px" }, "data-tip": `daily cost across ${(row.trend ?? []).length} day(s)` }, h("span", { html: (row.trend ?? []).length ? spark(row.trend, { height: 20 }) : "" })),
			},
			{ label: "Errors", right: true, width: "62px", render: (row) => countPill(row.errors, "warn") },
			{ label: "Cost", right: true, width: "72px", render: (row) => fmtCost(row.cost) },
			{ label: "Last used", right: true, width: "78px", render: (row) => timeAgo(row.lastTs) },
		],
		rows: data.byModel.map((m) => ({ ...m, key: m.model })),
	});
	const thinking = nodeRegion((d) => bars(d.thinking.map((row) => ({ label: row.level, value: row.calls, tip: `${row.level}: ${fmtInt(row.calls)} calls · ${fmtCost(row.cost)}` })), { valueFmt: fmtInt }));
	const cache = nodeRegion((d) =>
		h(
			"div",
			{},
			kv([
				["Savings (est.)", fmtCost(d.cache.savingsUsd)],
				["Priced calls", fmtInt(d.cache.pricedCalls)],
				["Unpriced calls", fmtInt(d.cache.unpricedCalls)],
			]),
			h("div", { class: "small muted", style: { marginTop: "8px" } }, "Unpriced calls still show exact logged cost — only savings estimation is skipped."),
		),
	);

	view.append(
		kpis.node,
		dailyCard,
		card({ title: "Model breakdown", sub: "unit economics first — cost and tokens per call are what a switch actually changes", flush: true, body: byModel, help: HELP.modelsUnit }),
		h("div", { class: "split" }, card({ title: "Thinking levels", sub: "calls per requested level", body: thinking.node }), card({ title: "Cache", sub: "prompt token reuse", body: cache.node })),
	);
	const render = (d) => {
		kpis.render(d);
		chart.render(d);
		byModel.patch(d.byModel.map((m) => ({ ...m, key: m.model })));
		thinking.render(d);
		cache.render(d);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(totalCallsOf(d))} calls · ${fmtCost(totalCostOf(d))}`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/models", { from: state.range })));
}

// ------------------------------------------------------------------ router

async function routerPage(view, ctx) {
	const data = await api("/api/router", { from: state.range, limit: 200 });
	clear(view);

	const kpis = gridRegion((d) => [
		kpi({ label: "Decisions", value: fmtInt(d.stats.total), sub: "keep / mid / deep / fast" }),
		kpi({ label: "Latency p50", value: fmtMs(d.stats.latencyP50), sub: `p90 ${fmtMs(d.stats.latencyP90)}` }),
		kpi({ label: "Outcomes logged", value: fmtInt(d.stats.outcomes.reduce((a, o) => a + o.count, 0)), sub: d.stats.outcomes.map((o) => `${o.label} ${o.count}`).join(" · ") || "—" }),
	]);
	const tiers = nodeRegion((d) => bars(d.stats.byTier.map((row) => ({ label: row.tier, value: row.count, tip: `${row.tier}: ${fmtInt(row.count)} decisions · p50 ${fmtMs(row.p50)} · p90 ${fmtMs(row.p90)}` })), { valueFmt: fmtInt }));
	const pHist = htmlRegion((d) => histogram({ bins: d.stats.pHist, height: 132 }));
	const decisions = table({
		columns: [
			{ label: "Time", right: true, render: (row) => fmtClock(row.ts) },
			{ label: "Tier", render: (row) => pill(row.tier ?? "—", row.acted ? "accent" : "neutral") },
			{ label: "From", render: (row) => modelCell(row.from) },
			{ label: "To", render: (row) => modelCell(row.to) },
			{ label: "p", right: true, render: (row) => (row.p == null ? "—" : row.p.toFixed(2)) },
			{ label: "conf", right: true, render: (row) => (row.confidence == null ? "—" : row.confidence.toFixed(2)) },
			{ label: "Reason", render: (row) => h("span", { class: "muted" }, row.reason ?? "—") },
			{ label: "Latency", right: true, render: (row) => fmtMs(row.latencyMs) },
			{ label: "Session", render: (row) => (row.session ? h("a", { href: `#/session?id=${row.session}` }, h("span", { class: "mono" }, row.session.slice(0, 8))) : "—") },
		],
		rows: data.decisions,
		onRowClick: (row) => openEventDrawer(row),
	});

	const tierOutcomes = nodeRegion((d) => {
		const rows = d.stats.outcomesByTier ?? [];
		if (!rows.length) return emptyState("No routing decisions in this range.");
		return table({
			columns: [
				{ label: "Tier", render: (row) => pill(row.tier, row.tier === "deep" ? "accent" : "neutral") },
				{ label: "Good", right: true, render: (row) => countPill(row.good, "ok") },
				{ label: "Bad", right: true, render: (row) => countPill(row.bad, "error") },
				{ label: "Overridden", right: true, render: (row) => countPill(row.override, "warn") },
				{ label: "Unjudged", right: true, render: (row) => countPill(row.unjudged, "neutral") },
				{ label: "Unclassified", right: true, render: (row) => countPill(row.other, "neutral") },
				{ label: "Precision", right: true, render: (row) => (row.precision == null ? h("span", { class: "faint" }, "no verdicts") : pill(`${Math.round(row.precision * 100)}%`, qualityTone(row.precision))) },
			],
			rows: rows.map((row) => ({ ...row, key: row.tier })),
		});
	});
	const outcomesCard = card({ title: "Outcome quality by tier", sub: "verdicts tagged to decisions", body: tierOutcomes.node, help: HELP.routerOutcomes });
	const outcomesSub = outcomesCard.querySelector(".cardhead .sub");
	view.append(
		kpis.node,
		h("div", { class: "split" }, card({ title: "Tier mix", sub: "which tier each decision picked", body: tiers.node }), card({ title: "Route probability", sub: "p distribution (decides tier escalation)", body: pHist.node })),
		outcomesCard,
		card({ title: "Decisions", sub: "newest first · click for the raw record", flush: true, body: decisions }),
	);
	const render = (d) => {
		kpis.render(d);
		tiers.render(d);
		pHist.render(d);
		tierOutcomes.render(d);
		const coverage = d.stats.outcomeCoverage;
		if (coverage) {
			outcomesSub.textContent = `verdicts tagged to decisions — ${fmtInt(coverage.judged)} of ${fmtInt(coverage.total)} judged (${Math.round((coverage.judged / Math.max(1, coverage.total)) * 100)}%)`;
		}
		decisions.patch(d.decisions);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(d.stats.total)} router decisions`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/router", { from: state.range, limit: 200 })));
}

// ------------------------------------------------------------------ ledger

async function ledgerPage(view, ctx) {
	const [ledger, stats] = await Promise.all([
		api("/api/ledger", { from: state.range, system: state.ledgerSystem, severity: state.ledgerSeverity, q: state.ledgerQuery, limit: 200, offset: state.ledgerOffset }),
		api("/api/ledger/stats", { from: state.range }),
	]);
	clear(view);

	const chipsRow = nodeRegion((data) =>
		h(
			"div",
			{ class: "chiprow" },
			chip("all systems", data.systems.reduce((a, s) => a + s.count, 0), { active: !state.ledgerSystem, onClick: () => { state.ledgerSystem = null; state.ledgerOffset = 0; void refresh(); } }),
			...data.systems.map((row) =>
				chip(row.system, row.count, {
					active: state.ledgerSystem === row.system,
					onClick: () => {
						state.ledgerSystem = state.ledgerSystem === row.system ? null : row.system;
						state.ledgerOffset = 0;
						void refresh();
					},
					tip: `${row.warn} warn · ${row.error} error · ${fmtCost(row.cost)} logged cost`,
				}),
			),
		),
	);
	const rows = table({
		columns: [
			{ label: "Time", right: true, width: "74px", render: (row) => fmtClock(row.ts) },
			{ label: "System", width: "92px", render: (row) => h("span", { class: "rowtitle" }, row.system) },
			{ label: "Severity", width: "80px", render: (row) => severityPill(row.severity) },
			{ label: "Event", width: "30%", render: (row) => h("div", {}, h("div", { class: "rowtitle" }, row.title ?? row.kind), row.summary ? h("div", { class: "rowsub truncate" }, row.summary) : null) },
			{
				label: "Fate",
				width: "116px",
				render: (row) =>
					row.fate
						? pill(
								`${row.fate.outcome}${row.fate.verdict ? ` · ${row.fate.verdict}` : ""}`,
								toneForVerdict(row.fate.verdict ?? row.fate.outcome),
								row.fate.turnsAfter != null ? `${row.fate.turnsAfter} turns after this decision` : "outcome recorded for this decision",
							)
						: h("span", { class: "faint" }, "—"),
			},
			{ label: "Cost", right: true, width: "76px", render: (row) => (row.costUsd != null ? fmtCost(row.costUsd) : "—") },
			{ label: "Latency", right: true, width: "76px", render: (row) => fmtMs(row.latencyMs) },
			{ label: "Session", width: "92px", render: (row) => (row.sessionId ? h("a", { href: `#/session?id=${row.sessionId}` }, h("span", { class: "mono" }, row.sessionId.slice(0, 8))) : "—") },
		],
		rows: ledger.rows,
		onRowClick: (row) => openEventDrawer(row),
		maxHeight: "560px",
	});
	let volumeData = null;
	let volumeSub = null;
	const volumeBySystem = nodeRegion((data) => {
		volumeData = data;
		const labels = data.daily?.labels ?? [];
		const systems = (data.daily?.bySystem ?? []).filter((entry) => entry.values.some((value) => value > 0));
		if (!systems.length) {
			if (volumeSub) volumeSub.textContent = "one line per subsystem — click one to isolate it";
			return emptyState("No decisions in this range.");
		}
		const grand = systems.reduce((a, entry) => a + entry.total, 0);
		const focus = systems.findIndex((entry) => entry.system === state.ledgerFocus);
		const focused = focus >= 0 ? systems[focus] : null;
		if (volumeSub) {
			if (focused) {
				const peak = focused.values.reduce((best, value, i) => (value > best.value ? { value, day: labels[i] } : best), { value: 0, day: null });
				volumeSub.textContent = `${focused.system} — ${fmtCompact(focused.total)} decisions · ${shareLabel(focused.total, grand)} of logged · busiest ${peak.day} (${fmtCompact(peak.value)})`;
			} else {
				volumeSub.textContent = "one line per subsystem — click one to isolate it";
			}
		}
		return h(
			"div",
			{},
			h(
				"div",
				{ class: "chiprow systems-row" },
				h("button", { class: `chip${focused ? "" : " active"}`, onclick: () => { state.ledgerFocus = null; volumeBySystem.render(volumeData); } }, "all systems"),
				...systems.map((entry, i) =>
					h(
						"button",
						{
							class: `chip${focused?.system === entry.system ? " active" : ""}`,
							onclick: () => {
								state.ledgerFocus = focused?.system === entry.system ? null : entry.system;
								volumeBySystem.render(volumeData);
							},
						},
						h("i", { class: "dot", style: { background: seriesColor(i) } }),
						entry.system,
						h("span", { class: "n" }, fmtCompact(entry.total)),
					),
				),
			),
			h("div", { html: lineChart({ labels, series: systems.map((entry) => ({ name: entry.system, values: entry.values })), height: 240, valueFmt: fmtCompact, focusIndex: focused ? focus : null }) }),
		);
	});
	const volumeCard = card({ title: "Decision volume per system", sub: "one line per subsystem — click one to isolate it", body: volumeBySystem.node, help: HELP.ledgerVolume });
	volumeSub = volumeCard.querySelector(".cardhead .sub");
	const pager = nodeRegion((data) =>
		h(
			"div",
			{ style: { display: "flex", gap: "8px", alignItems: "center" } },
			h("span", { class: "small muted" }, `showing ${data.rows.length} of ${fmtInt(data.total)}`),
			h("div", { class: "grow" }),
			state.ledgerOffset > 0 ? h("button", { class: "btn", onclick: () => { state.ledgerOffset = Math.max(0, state.ledgerOffset - 200); void refresh(); } }, "← Newer") : null,
			state.ledgerOffset + data.rows.length < data.total ? h("button", { class: "btn", onclick: () => { state.ledgerOffset += 200; void refresh(); } }, "Older →") : null,
		),
	);

	const searchInput = h("input", {
		class: "input",
		placeholder: "Search title / summary / session…",
		value: state.ledgerQuery,
		style: { width: "240px" },
		oninput: debounce((event) => {
			state.ledgerQuery = event.target.value;
			state.ledgerOffset = 0;
			void refresh();
		}, 300),
	});
	const severitySelect = h(
		"select",
		{
			class: "select",
			onchange: (event) => {
				state.ledgerSeverity = event.target.value || null;
				state.ledgerOffset = 0;
				void refresh();
			},
		},
		...["all", "warn", "error", "ok", "info"].map((value) => h("option", { value: value === "all" ? "" : value, selected: (state.ledgerSeverity ?? "") === (value === "all" ? "" : value) }, value)),
	);

	const tabs = [
		["ttsr", "TTSR rules"],
		["curator", "Curator"],
		["guard", "Guard"],
		["memory", "Memory"],
		["course", "Course"],
		["refine", "Refine"],
	];
	const effectPanel = h("div", { class: "cardbody flush" });
	const segButtons = tabs.map(([id, label]) =>
		h(
			"button",
			{
				class: state.ledgerEffectTab === id ? "active" : "",
				onclick: () => {
					state.ledgerEffectTab = id;
					for (const button of segButtons) button.classList.remove("active");
					segButtons[tabs.findIndex(([tid]) => tid === id)]?.classList.add("active");
					renderEffectPanel();
				},
			},
			label,
		),
	);
	let latestStats = stats;
	function renderEffectPanel() {
		clear(effectPanel);
		const active = state.ledgerEffectTab;
		if (active === "ttsr") {
			effectPanel.appendChild(
				table({
					columns: [
						{ label: "Rule", render: (row) => h("span", { class: "rowtitle" }, row.rule) },
						{ label: "Fired", right: true, render: (row) => fmtInt(row.fired) },
						{ label: "Suppressed", right: true, render: (row) => fmtInt(row.suppressed) },
						{ label: "Good", right: true, render: (row) => countPill(row.good, "ok") },
						{ label: "Bad", right: true, render: (row) => countPill(row.bad, "error") },
						{ label: "Blocks", right: true, render: (row) => fmtInt(row.blocked) },
					],
					rows: latestStats.ttsrRules,
					maxHeight: "420px",
				}),
			);
			return;
		}
		const block =
			active === "curator"
				? [
						["Verifier verdicts", latestStats.curatorVerdicts],
						["Roles", latestStats.curatorRoles],
						["Source types", latestStats.curatorSourceTypes],
					]
				: active === "guard"
					? [
							["Verdicts", latestStats.guardVerdicts],
							["Hooks", latestStats.guardHooks],
						]
					: active === "memory"
						? [
								["Decisions", latestStats.memoryDecisions],
								["Outcomes", latestStats.memoryOutcomes],
							]
						: active === "course"
							? [["Verdicts", latestStats.courseVerdicts]]
							: [["Decisions", latestStats.refineDecisions]];
		effectPanel.appendChild(
			h(
				"div",
				{ class: "cardbody grid cols-2" },
				...block.map(([title, record]) =>
					card({
						title,
						body: bars(Object.entries(record ?? {}).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }),
					}),
				),
			),
		);
	}
	renderEffectPanel();

	view.append(
		h(
			"div",
			{ class: "card" },
			h("div", { class: "cardhead" }, h("h3", {}, "All harness decisions"), h("span", { class: "sub" }, `${fmtInt(ledger.total)} in range`), h("div", { class: "grow" }), searchInput, severitySelect),
			h("div", { class: "cardbody tight" }, chipsRow.node),
			h("div", { class: "cardbody flush" }, rows),
			h("div", { class: "cardbody" }, pager.node),
		),
		volumeCard,
		h("div", { class: "card" }, h("div", { class: "cardhead" }, h("h3", {}, "Effectiveness"), h("div", { class: "grow" }), h("div", { class: "seg" }, ...segButtons)), effectPanel),
	);

	async function refresh() {
		const [next, nextStats] = await Promise.all([
			api("/api/ledger", { from: state.range, system: state.ledgerSystem, severity: state.ledgerSeverity, q: state.ledgerQuery, limit: 200, offset: state.ledgerOffset }),
			api("/api/ledger/stats", { from: state.range }),
		]);
		latestStats = nextStats;
		chipsRow.render(next);
		volumeBySystem.render(next);
		rows.patch(next.rows);
		pager.render(next);
		renderEffectPanel();
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(next.total)} decisions`);
		ledger.total = next.total;
	}
	// These regions are data-driven, so seed them from the initial fetch —
	// otherwise the system chips and pager stay empty until the first ingest.
	chipsRow.render(ledger);
	pager.render(ledger);
	volumeBySystem.render(ledger);
	ctx.onAutoRefresh(refresh);
	ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(ledger.total)} decisions`);
}

// ------------------------------------------------------------------ curator

async function curatorPage(view, ctx) {
	let list = await api("/api/curator/sessions");
	const overviewData = await api("/api/curator/overview", { from: state.range });
	clear(view);

	// Range-level pipeline first: the per-session view below answers "what did it
	// do here", this answers "is the pipeline healthy overall".
	const overviewBadge = h("span", { class: "pill accent" }, "…");
	const overviewKpis = gridRegion((d) => [
		kpi({ label: "Candidates", value: fmtInt(d.candidates), sub: `${fmtInt(d.emittedItems)} condensed items` }),
		kpi({ label: "Emits", value: fmtInt(d.emits), sub: `${fmtPct(d.emitRate, 0)} of candidates`, help: HELP.curatorRange }),
		kpi({ label: "Retained full", value: fmtInt(d.retainFull), sub: `${fmtPct(d.retainShare, 0)} of candidates kept whole` }),
		kpi({ label: "Tokens condensed", value: fmtCompact(d.tokensOneTime), sub: `≈${fmtCompact(d.tokensCarried)} not re-read over later calls${d.tokensPromptPct != null ? ` · prompts ${fmtPct(d.tokensPromptPct, 1)} smaller` : ""}`, valueClass: "good" }),
		kpi({ label: "Frontier escalations", value: fmtInt(d.escalations), sub: `${fmtPct(d.escalationRate, 1)} of candidates needed a frontier check` }),
		kpi({ label: "Repairs", value: `${fmtInt(d.repairs.repaired)}/${fmtInt(d.repairs.verified)}`, sub: `${fmtInt(d.repairs.lostLines)} goal-relevant lines recovered` }),
		kpi({ label: "Verifier agreement", value: fmtPct(d.agreement.rate, 0), sub: `${fmtInt(d.agreement.hits)}/${fmtInt(d.agreement.samples)} frontier samples agreed` }),
		kpi({ label: "Verifier cost / emit", value: fmtCost(d.costPerEmit ?? 0), sub: `${fmtCost(d.verifierCost)} priced from logged usage`, help: HELP.curatorRange }),
	]);
	const overviewSankey = htmlRegion((d) => (Object.keys(d.fates.nodes ?? {}).length ? sankey({ columns: d.fates.columns, nodes: d.fates.nodes, links: d.fates.links, height: 250 }) : '<div class="empty">No classified candidates in this range.</div>'));
	const overviewMix = nodeRegion((d) =>
		h(
			"div",
			{ class: "grid cols-2" },
			card({ title: "Roles", sub: "how candidates were classified", body: bars(Object.entries(d.roles).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }) }),
			card({ title: "Verifier verdicts", sub: "what the verifier decided", body: bars(Object.entries(d.verdicts).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }) }),
		),
	);
	const overviewSection = collapsible({
		id: "curator-range",
		title: "Curator — all sessions in range",
		sub: "the pipeline across every session: candidates, verdicts, repairs and verifier spend",
		badge: overviewBadge,
		open: true,
		body: h("div", { class: "grid" }, overviewKpis.node, card({ title: "Candidate flow", sub: "source type → role → verifier verdict across the range", body: overviewSankey.node }), overviewMix.node),
	});
	function renderOverview(d) {
		overviewKpis.render(d);
		overviewSankey.render(d);
		overviewMix.render(d);
		overviewBadge.textContent = `${fmtInt(d.emits)} emits · ${fmtPct(d.emitRate, 0)} of ${fmtInt(d.candidates)}`;
	}
	renderOverview(overviewData);
	if (!list.sessions.length) {
		view.appendChild(card({ title: "Context curator", body: emptyState("No curator ledger entries yet. They appear when sessions run with the curator active.") }));
		return;
	}
	if (!state.curatorSession || !list.sessions.some((s) => s.sessionId === state.curatorSession)) state.curatorSession = list.sessions[0].sessionId;

	const sessionList = table({
		columns: [
			{
				label: "Session",
				render: (row) =>
					h(
						"div",
						{},
						h("div", { class: "rowtitle" }, shortTitle(row.title) ?? row.project ?? row.sessionId.slice(0, 8)),
						h("div", { class: "rowsub" }, `${row.project ?? "—"} · ${fmtInt(row.candidates)} candidates · ${fmtInt(row.emits)} emits · ${timeAgo(row.lastTs)}${row.specSnapshots ? ` · GoalSpec v${row.specVersion}${row.specSeeded ? " seeded" : " (pre-seed)"}` : row.goalPins ? " · goal pinned" : ""}`),
					),
			},
		],
		rows: list.sessions,
		onRowClick: (row) => {
			state.curatorSession = row.sessionId;
			void loadDetail();
		},
		maxHeight: "640px",
	});

	const detail = h("div", { class: "grid" });
	view.append(overviewSection, h("div", { class: "split-list" }, card({ title: "Sessions", sub: `${list.sessions.length} with curator activity`, flush: true, body: sessionList }), detail));

	const kpis = gridRegion((d) => [
		kpi({ label: "Candidates", value: fmtInt(d.stats.candidates), sub: `${fmtInt(d.stats.events)} curator events` }),
		kpi({ label: "Emits", value: fmtInt(d.stats.emits), sub: `${fmtInt(Math.max(0, d.stats.candidates - d.stats.emits))} retained` }),
		kpi({ label: "Chars condensed", value: fmtCompact(d.stats.chars), sub: "sum of candidate sizes" }),
		kpi({ label: "Context edits", value: fmtInt(d.timeline.filter((r) => r.kind === "curator.context_edit").length), sub: "rewrites in transcript" }),
	]);
	const sankeyRegion = htmlRegion((d) => {
		const hasFates = Object.keys(d.fates.nodes ?? {}).length > 0;
		return hasFates ? sankey({ columns: d.fates.columns, nodes: d.fates.nodes, links: d.fates.links, height: 260 }) : "";
	});
	const itemsTable = table({
		columns: [
			{ label: "Turn", right: true, render: (row) => fmtInt(row.turn) },
			{ label: "Tool", render: (row) => h("span", { class: "mono" }, row.tool ?? "—") },
			{ label: "Source", render: (row) => row.sourceType ?? "—" },
			{ label: "Role", render: (row) => pill(row.role ?? "—", row.role === "evidence" ? "info" : row.role === "irrelevant" ? "warn" : "neutral") },
			{ label: "Verdict", render: (row) => verdictPill(row.verdict) },
			{ label: "Chars", right: true, render: (row) => (row.chars != null ? fmtCompact(row.chars) : "—") },
			{ label: "Entry", render: (row) => h("span", { class: "mono faint" }, row.entryId ?? "—") },
		],
		rows: [],
		maxHeight: "420px",
	});
	const goalspec = feed([], { clock: fmtClock });

	// Built once; refreshes only patch these regions. Rebuilding the detail on
	// every ingest would reset inner scroll and flicker.
	const sankeyCard = card({ title: "Candidate flow", sub: "source type → role → verifier verdict", body: sankeyRegion.node });
	const itemsCard = card({ title: "Ledger items", flush: true, body: itemsTable });
	const goalspecCard = card({ title: "GoalSpec", sub: "seeded from the session's first prompt, then every amendment", flush: true, body: goalspec });
	const emptyNote = emptyState("No curator activity in this session.");
	detail.append(kpis.node, sankeyCard, itemsCard, goalspecCard, emptyNote);

	async function loadDetail() {
		const d = await api("/api/curator", { session: state.curatorSession });
		const has = Boolean(d.hasData);
		const hasSpec = Boolean(d.goalspec?.timeline?.length);
		for (const node of [kpis.node, sankeyCard, itemsCard]) node.hidden = !has;
		goalspecCard.hidden = !hasSpec;
		emptyNote.hidden = has || hasSpec;
		if (!has && !hasSpec) {
			ctx.setStatus(`Curator · ${state.curatorSession.slice(0, 8)} · no activity`);
			return;
		}
		if (has) {
			kpis.render(d);
			sankeyRegion.render(d);
			itemsTable.patch((d.items ?? []).slice().reverse().map((item, index) => ({ ...item, key: item.entryId ?? `${item.ts}-${item.tool ?? ""}-${index}` })));
		}
		goalspec.patch(goalspecFeedItems(d.goalspec?.timeline));
		ctx.setStatus(`Curator · ${state.curatorSession.slice(0, 8)} · ${fmtInt(d.stats.candidates)} candidates`);
	}
	await loadDetail();

	ctx.onAutoRefresh(async () => {
		const [nextList, nextOverview] = await Promise.all([api("/api/curator/sessions"), api("/api/curator/overview", { from: state.range })]);
		list = nextList;
		sessionList.patch(list.sessions);
		renderOverview(nextOverview);
		if (state.curatorSession) await loadDetail();
	});
}

// ------------------------------------------------------------------ sessions

async function sessionsPage(view, ctx) {
	const data = await api("/api/sessions", { q: state.sessionQuery, sort: state.sessionSort, limit: 500 });
	clear(view);

	const rows = table({
		columns: [
			{
				label: "Session",
				width: "26%",
				render: (row) =>
					h("div", {}, h("div", { class: "rowtitle" }, shortTitle(row.title) ?? row.sessionId.slice(0, 8)), h("div", { class: "rowsub" }, `${row.project ?? "—"} · ${row.sessionId.slice(0, 8)}`)),
			},
			{ label: "Calls", right: true, width: "60px", render: (row) => fmtInt(row.calls) },
			{ label: "$ / call", right: true, width: "74px", render: (row) => (row.costPerCall == null ? "—" : fmtCost(row.costPerCall)) },
			{ label: "Cost", right: true, width: "74px", render: (row) => fmtCost(row.cost) },
				{ label: "Condensed", right: true, width: "86px", render: (row) => h("span", { "data-tip": `${fmtCompact(row.curatorTokens)} tokens condensed away at each trim — open the session for the flow they avoided on later calls` }, fmtCompact(row.curatorTokens)) },
			{ label: "Cache saved", right: true, width: "92px", render: (row) => h("span", { "data-tip": "provider cache discount on this session's cached prompt tokens" }, fmtCost(row.cacheDiscount)) },
			{
				label: "Problems",
				right: true,
				width: "86px",
				render: (row) =>
					row.problems > 0
						? pill(String(row.problems), "warn", `${fmtInt(row.corrections)} correction(s) · ${fmtInt(row.offTrack)} off-track · ${fmtInt(row.errors)} error(s)`)
						: h("span", { class: "faint" }, "0"),
			},
			{ label: "Last", right: true, render: (row) => timeAgo(row.lastTs) },
		],
		rows: data.sessions,
		onRowClick: (row) => {
			window.location.hash = `#/session?id=${row.sessionId}`;
		},
		maxHeight: "660px",
	});

	const countLabel = h("span", { class: "sub" }, `${data.sessions.length} shown`);
	const searchInput = h("input", {
		class: "input",
		placeholder: "Search sessions…",
		value: state.sessionQuery,
		style: { width: "220px" },
		oninput: debounce((event) => {
			state.sessionQuery = event.target.value;
			void refresh();
		}, 300),
	});
	const sortButtons = [
		["recent", "Recent"],
		["impact", "Harness impact"],
		["condensed", "Condensed"],
		["problems", "Problems"],
		["cost", "Cost"],
		["tokens", "Tokens"],
	].map(([id, label]) =>
		h(
			"button",
			{
				class: state.sessionSort === id ? "active" : "",
				onclick: () => {
					state.sessionSort = id;
					for (const button of sortButtons) button.classList.remove("active");
					sortButtons.find((b) => b.textContent === label)?.classList.add("active");
					void refresh();
				},
			},
			label,
		),
	);

	view.appendChild(
		h(
			"div",
			{ class: "card" },
			h("div", { class: "cardhead" }, h("h3", {}, "Sessions"), countLabel, h("div", { class: "grow" }), searchInput, h("div", { class: "seg" }, ...sortButtons)),
			h("div", { class: "cardbody flush" }, rows),
		),
	);

	async function refresh() {
		const next = await api("/api/sessions", { q: state.sessionQuery, sort: state.sessionSort, limit: 500 });
		rows.patch(next.sessions);
		countLabel.textContent = `${next.sessions.length} shown`;
		ctx.setStatus(`${next.sessions.length} sessions`);
	}
	ctx.onAutoRefresh(refresh);
	ctx.setStatus(`${data.sessions.length} sessions`);
}

// ------------------------------------------------------------------ session detail

/** One line describing what a GoalSpec entry changed. */
function goalspecChangeText(entry) {
	if (entry.kind === "pin") return "objective pinned";
	const d = entry.delta;
	if (!d) return entry.version === 1 ? "seeded from first prompt" : "initial snapshot";
	const parts = [];
	if (d.refinements.length) parts.push(`+${d.refinements.length} refinement${d.refinements.length === 1 ? "" : "s"}`);
	if (d.criteria.length) parts.push(`+${d.criteria.length} criteri${d.criteria.length === 1 ? "on" : "a"}`);
	if (d.constraints.length) parts.push(`+${d.constraints.length} constraint${d.constraints.length === 1 ? "" : "s"}`);
	if (d.planReplaced) parts.push(`plan set · ${d.plan.length} step${d.plan.length === 1 ? "" : "s"}`);
	else if (d.plan.length) parts.push(`+${d.plan.length} plan step${d.plan.length === 1 ? "" : "s"}`);
	if (d.facts.length) parts.push(`+${d.facts.length} fact${d.facts.length === 1 ? "" : "s"}`);
	if (d.questions.length) parts.push(`+${d.questions.length} question${d.questions.length === 1 ? "" : "s"}`);
	if (d.resolved.length) parts.push(`−${d.resolved.length} resolved`);
	return parts.join(" · ");
}

/** The added items themselves, capped, so the feed shows what actually changed. */
function goalspecDetailText(entry) {
	if (entry.kind === "pin") return entry.goal ? `“${entry.goal}”` : "";
	if (!entry.delta) {
		const counts = entry.counts ?? {};
		const labels = { refinements: "refinements", criteria: "success criteria", constraints: "constraints", plan: "plan steps", facts: "known facts", questions: "open questions" };
		const summary = Object.entries(labels).map(([key, label]) => (counts[key] ? `${counts[key]} ${label}` : "")).filter(Boolean).join(" · ");
		return summary || "objective recorded; no criteria, constraints, plan, facts or questions yet";
	}
	const d = entry.delta;
	const items = [
		...d.criteria.map((text) => `c: ${text}`),
		...d.constraints.map((text) => `k: ${text}`),
		...d.plan.map((text) => `p: ${text}`),
		...d.facts.map((text) => `f: ${text}`),
		...d.questions.map((text) => `q: ${text}`),
		...d.resolved.map((text) => `resolved: ${text}`),
		...d.refinements.map((text) => `refined: ${text}`),
	];
	if (!items.length) return "no list changes";
	const shown = items.slice(0, 3).map((text) => (text.length > 200 ? `${text.slice(0, 199)}…` : text));
	return shown.join("  ·  ") + (items.length > shown.length ? `  ·  +${items.length - shown.length} more` : "");
}

function goalspecGap(ms) {
	if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
	if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Feed items for a GoalSpec timeline; shared by the session and curator pages. */
function goalspecFeedItems(timeline) {
	return (timeline ?? []).map((entry, index, all) => {
		const gap = index > 0 && entry.ts_ms && all[index - 1].ts_ms ? entry.ts_ms - all[index - 1].ts_ms : null;
		const change = goalspecChangeText(entry);
		return {
			key: `${entry.ts_ms}|${entry.kind}|${entry.version}`,
			ts: entry.ts,
			tone: entry.kind === "pin" ? "warn" : "info",
			title: entry.kind === "pin" ? "objective pinned" : `v${entry.version}${change ? ` · ${change}` : ""}`,
			sub: goalspecDetailText(entry),
			right: h("span", { class: "small faint" }, `${entry.turn != null ? `turn ${entry.turn}` : ""}${gap != null ? `${entry.turn != null ? " · " : ""}+${goalspecGap(gap)}` : ""}`),
		};
	});
}

async function sessionPage(view, ctx) {
	clear(view);
	if (!state.sessionId) {
		view.appendChild(emptyState("No session selected. Open one from Sessions."));
		return;
	}

	const kpis = gridRegion((d) => [
		kpi({ label: "Cost", value: fmtCost(d.session.cost), sub: `${fmtInt(d.session.calls)} model calls` }),
		kpi({ label: "Tokens", value: fmtCompact(d.session.total_tokens), sub: `${fmtCompact(d.session.cache_read)} cached · ${fmtCompact(d.session.reasoning)} reasoning` }),
		kpi({ label: "Turns", value: fmtInt(d.session.turns), sub: `${fmtInt(d.session.user_messages)} user messages` }),
		kpi({ label: "Harness events", value: fmtInt(d.session.harness_events), sub: `${fmtInt(d.session.errors)} errored calls` }),
		kpi({ label: "Started", value: fmtDateTime(d.session.started_ts), sub: `${d.session.project ?? "—"}`, valueClass: "small" }),
	]);
	const lanesRegion = nodeRegion((d) => {
		const calls = d.calls ?? [];
		const first = calls.length ? calls[0].ts_ms : Date.now();
		const last = calls.length ? calls[calls.length - 1].ts_ms : first + 1;
		const msgLane = (d.messages ?? []).map((m) => ({ start: m.ts_ms - 60_000, end: m.ts_ms + 60_000, color: m.role === "user" ? "var(--accent)" : "var(--s2)", tip: `${m.role} · turn ${m.turn}\n${m.preview?.slice(0, 160) ?? ""}` }));
		const eventLane = (d.events ?? []).map((e) => ({ start: e.ts_ms - 60_000, end: e.ts_ms + 60_000, color: e.severity === "error" ? "var(--err)" : e.severity === "warn" ? "var(--warn)" : e.system === "curator" ? "var(--s5)" : "var(--s6)", tip: `${e.system} · ${e.kind}\n${e.title ?? ""}${e.summary ? `\n${e.summary}` : ""}` }));
		const modelLane = calls.map((call, index) => ({ start: call.ts_ms - 60_000, end: call.ts_ms + 60_000, color: seriesColor(index % 8), tip: `${shortModel(call.model)} · turn ${call.turn}\n${fmtCompact(call.total_tokens)} tokens · ${fmtCost(call.cost)}` }));
		const goalLane = (d.goalspec?.timeline ?? []).map((entry) => ({ start: entry.ts_ms - 60_000, end: entry.ts_ms + 60_000, color: entry.kind === "pin" ? "var(--s3)" : "var(--s10)", tip: `GoalSpec · ${goalspecChangeText(entry)}\nturn ${entry.turn ?? "—"}${entry.goal ? `\n${entry.goal.slice(0, 200)}` : ""}` }));
		return h(
			"div",
			{},
			h("div", { class: "small muted", style: { marginBottom: "8px" } }, `${fmtClock(new Date(first).toISOString())} → ${fmtClock(new Date(last).toISOString())}`),
			lanes(
				[
					{ label: "messages", ticks: msgLane },
					{ label: "harness", ticks: eventLane },
					{ label: "goalspec", ticks: goalLane },
					{ label: "models", ticks: modelLane },
				],
				{ from: first - 90_000, to: last + 90_000 },
			),
		);
	});
	const callsTable = table({
		columns: [
			{ label: "Time", right: true, render: (row) => fmtClock(row.ts) },
			{ label: "Turn", right: true, render: (row) => fmtInt(row.turn) },
			{ label: "Model", render: (row) => modelCell(row.model) },
			{ label: "In", right: true, render: (row) => fmtCompact(row.input) },
			{ label: "Out", right: true, render: (row) => fmtCompact(row.output) },
			{ label: "Cache", right: true, render: (row) => fmtCompact(row.cache_read) },
			{ label: "Cost", right: true, render: (row) => fmtCost(row.cost) },
			{ label: "Tools", render: (row) => h("span", { class: "small muted" }, (row.tools ?? []).join(", ") || "—") },
			{ label: "Stop", render: (row) => (row.stop_reason === "error" ? pill("error", "error") : h("span", { class: "faint" }, row.stop_reason ?? "—")) },
		],
		rows: [],
		maxHeight: "420px",
	});
	const modelsBars = nodeRegion((d) => bars((d.models ?? []).map((row) => ({ label: shortModel(row.model), value: row.cost, tip: `${row.model}\n${fmtInt(row.calls)} calls · ${fmtCompact(row.tokens)} tokens` })), { valueFmt: fmtCost }));
	const eventsFeed = feed([], { clock: fmtClock });
	const messagesFeed = feed([], { clock: fmtClock });

	// GoalSpec: the spec the curator judged evidence against at each point, and
	// what each amendment added — the per-session record of how the goal moved.
	const goalspecBadge = h("span", { class: "pill" }, "…");
	const goalspecFeed = feed([], { clock: fmtClock });
	const goalspecCurrent = nodeRegion((d) => {
		const spec = d.goalspec?.current;
		if (!spec) return emptyState("No GoalSpec snapshot yet — the curator records one per turn once it runs.");
		const list = (items, prefix) =>
			items.length
				? h(
						"div",
						{ class: "spec-list" },
						...items.map((text, index) => h("div", { class: "spec-item" }, h("span", { class: "spec-n" }, `${prefix}${index + 1}.`), h("span", {}, text))),
					)
				: h("span", { class: "faint" }, "—");
		return kv([
			["Objective", h("div", {}, spec.objective || "—")],
			["Refinements", list(spec.refinements, "r")],
			["Success criteria", list(spec.criteria, "c")],
			["Constraints", list(spec.constraints, "k")],
			["Plan", list(spec.plan, "p")],
			["Known facts", list((spec.facts ?? []).map((fact) => fact.fact), "f")],
			["Open questions", list(spec.questions, "q")],
		]);
	});
	const goalspecSection = collapsible({
		id: "session-goalspec",
		title: "GoalSpec",
		sub: "what this session was asked to do, and how the spec changed as the agent learned",
		badge: goalspecBadge,
		open: true,
		body: h(
			"div",
			{ class: "split" },
			card({ title: "Current spec", sub: "the state evidence relevance is judged against", body: goalspecCurrent.node }),
			card({ title: "Evolution", sub: "each snapshot after an amendment, with the time and turn it landed", flush: true, body: goalspecFeed }),
		),
	});

	// Session impact: benefit, quality and improvement hints for one session.
	const impactBadge = h("span", { class: "pill accent" }, "…");
	const impactKpis = gridRegion((si) => {
		const b = si.benefit;
		return [
			kpi({
				label: "Tokens condensed",
				value: fmtCompact(b.curatorTokensCondensed),
				sub: `${fmtInt(b.emits)} trims · prompts ~${fmtPct(b.curatorPromptSavedPct, 1)} smaller (median ${fmtCompact(b.curatorOffsetMedian)}) · ≈${fmtCompact(b.curatorTokensNotResent)} not re-read · ≈${fmtCost(b.curatorUsdCached)} (${fmtPct(b.curatorUsdShare, 0)} of spend)`,
				valueClass: "good",
				help: HELP.sessionImpact,
			}),
			kpi({ label: "Cache discount", value: fmtCost(b.cacheDiscount), sub: b.cacheRate == null ? "no prompt tokens" : `${fmtPct(b.cacheRate, 0)} of prompt tokens cached` }),
			kpi({ label: "Rule deliveries", value: fmtInt(b.rulesDelivered), sub: `${fmtCompact(b.rulesTokens)} tok injected · ${fmtInt(b.contextEdits)} context edits` }),
			kpi({ label: "Cost per turn", value: b.costPerTurn == null ? "—" : fmtCost(b.costPerTurn), sub: `${fmtCost(si.session.cost)} over ${fmtInt(si.session.turns)} turns` }),
		];
	});
	const impactQuality = nodeRegion((si) => {
		const q = si.quality;
		return h(
			"div",
			{ class: "grid kpis" },
			meter({ label: "Rule precision", value: q.rulePrecision, tone: qualityTone(q.rulePrecision), detail: `${fmtInt(q.ruleGood)} good · ${fmtInt(q.ruleBad)} bad` }),
			meter({ label: "Call error rate", value: q.errorRate, tone: qualityTone(q.errorRate, { invert: true }), detail: `${fmtInt(q.errors)} of ${fmtInt(si.session.calls)} calls` }),
			meter({ label: "Corrections", value: null, display: fmtInt(q.corrections), tone: q.corrections === 0 ? "ok" : "warn", detail: "times you stepped in", help: HELP.sessionImpact }),
			meter({ label: "Off-track verdicts", value: null, display: fmtInt(q.offTrack), tone: q.offTrack === 0 ? "ok" : "warn", detail: "goal drift the loop caught" }),
		);
	});
	const impactFindings = nodeRegion((si) => h("div", { class: "findings" }, ...(si.findings ?? []).map((finding) => findingItem(finding))));
	const impactItems = table({
		columns: [
			{ label: "Tool", render: (row) => h("span", { class: "mono" }, row.tool) },
			{ label: "Source", render: (row) => row.sourceType },
			{ label: "Role", render: (row) => pill(row.role, row.role === "evidence" ? "info" : "neutral") },
			{ label: "Verdict", render: (row) => verdictPill(row.verdict) },
			{ label: "Chars", right: true, render: (row) => fmtCompact(row.chars) },
			{ label: "Turn", right: true, render: (row) => (row.turn == null ? "—" : fmtInt(row.turn)) },
		],
		rows: [],
		maxHeight: "320px",
	});
	const impactSection = collapsible({
		id: "session-impact",
		title: "Session impact",
		sub: "what this session's harness earned, its quality signals, and where it could improve",
		badge: impactBadge,
		open: true,
		body: h(
			"div",
			{ class: "grid" },
			impactKpis.node,
			impactQuality.node,
			impactFindings.node,
			card({ title: "Biggest context items", sub: "the largest things that entered context, and what the curator decided", flush: true, body: impactItems, help: HELP.sessionItems }),
		),
	});
	function renderSessionImpact(si) {
		if (!si?.session) return;
		impactKpis.render(si);
		impactQuality.render(si);
		impactFindings.render(si);
		impactItems.patch((si.items ?? []).map((item, index) => ({ ...item, key: `${item.tool}|${item.turn ?? ""}|${index}` })));
		const flags = (si.quality?.corrections ?? 0) + (si.quality?.errors ?? 0) + (si.quality?.offTrack ?? 0);
		impactBadge.className = `pill ${(si.findings ?? []).some((f) => f.tone === "warn") ? "warn" : "accent"}`;
		impactBadge.textContent = `${fmtCompact(si.benefit?.curatorTokensCondensed ?? 0)} tok condensed${flags ? ` · ${fmtInt(flags)} flags` : ""}`;
	}

	function renderGoalspec(d) {
		const timeline = d.goalspec?.timeline ?? [];
		goalspecSection.hidden = timeline.length === 0;
		goalspecCurrent.render(d);
		goalspecFeed.patch(goalspecFeedItems(timeline));
		const current = d.goalspec?.current;
		const seeded = timeline.some((entry) => entry.kind === "spec" && entry.version === 1);
		const updates = timeline.filter((entry) => entry.kind === "spec" && entry.version !== 1).length;
		goalspecBadge.className = `pill ${current ? "accent" : "neutral"}`;
		goalspecBadge.textContent = current ? `v${current.version} · ${seeded ? "seeded" : "no seed"} · ${updates} update${updates === 1 ? "" : "s"}` : `${timeline.length} pins`;
	}

	// --- compare with another session (same numbers, side by side)
	const compareOptions = (await api("/api/sessions?limit=30")).sessions.filter((session) => session.sessionId !== state.sessionId);
	const compareState = { thisImpact: null, otherImpact: null };
	const compareTable = nodeRegion(() => {
		const a = compareState.thisImpact;
		const b = compareState.otherImpact;
		if (!a?.session || !b?.session) return emptyState("Pick a session above to compare the two side by side.");
		const row = (label, left, right) => ({ key: label, label, left, right });
		return table({
			columns: [
				{ label: "Metric", render: (r) => r.label },
				{ label: "This session", right: true, render: (r) => r.left },
				{ label: "Compared", right: true, render: (r) => r.right },
			],
			rows: [
				row("Cost", fmtCost(a.session.cost), fmtCost(b.session.cost)),
				row("Calls", fmtInt(a.session.calls), fmtInt(b.session.calls)),
				row("Turns", fmtInt(a.session.turns), fmtInt(b.session.turns)),
				row("Cost / turn", fmtCost(a.benefit.costPerTurn ?? 0), fmtCost(b.benefit.costPerTurn ?? 0)),
				row("Tokens kept out", fmtCompact(a.benefit.curatorTokensKeptOut), fmtCompact(b.benefit.curatorTokensKeptOut)),
				row("Tokens condensed", fmtCompact(a.benefit.curatorTokensCondensed), fmtCompact(b.benefit.curatorTokensCondensed)),
				row("Not re-read over the session", fmtCompact(a.benefit.curatorTokensNotResent), fmtCompact(b.benefit.curatorTokensNotResent)),
				row("…worth at cache rates", fmtCost(a.benefit.curatorUsdCached), fmtCost(b.benefit.curatorUsdCached)),
				row("Cache discount", fmtCost(a.benefit.cacheDiscount), fmtCost(b.benefit.cacheDiscount)),
				row("Context edits", fmtInt(a.benefit.contextEdits), fmtInt(b.benefit.contextEdits)),
				row("Rule deliveries", fmtInt(a.benefit.rulesDelivered), fmtInt(b.benefit.rulesDelivered)),
				row("Corrections", fmtInt(a.quality.corrections), fmtInt(b.quality.corrections)),
				row("Errored calls", fmtInt(a.quality.errors), fmtInt(b.quality.errors)),
				row("Off-track", fmtInt(a.quality.offTrack), fmtInt(b.quality.offTrack)),
				row("Rule precision", fmtPct(a.quality.rulePrecision, 0), fmtPct(b.quality.rulePrecision, 0)),
			],
		});
	});
	const comparePicker = modelPicker({
		options: compareOptions.map((session) => ({
			value: session.sessionId,
			label: shortTitle(session.title) ?? session.sessionId.slice(0, 8),
			meta: `${fmtInt(session.calls)} calls · ${fmtCost(session.cost)}`,
		})),
		value: null,
		onChange: async (next) => {
			compareState.otherImpact = next ? await api("/api/session/impact", { id: next }) : null;
			compareTable.render();
		},
	});
	const compareCard = card({
		title: "Compare",
		sub: "same harness numbers, side by side — useful for A/B on similar tasks",
		body: h("div", { class: "grid" }, h("div", { class: "page-toolbar" }, h("span", { class: "small muted" }, "Compare with"), comparePicker), compareTable.node),
	});

	const callsCard = card({ title: "Model calls", flush: true, body: callsTable });
	const modelsCard = card({ title: "Models used", body: modelsBars.node });
	const eventsCard = card({ title: "Harness events", sub: "curator, model switches, custom entries", flush: true, body: eventsFeed });
	const messagesCard = card({ title: "Messages", flush: true, body: messagesFeed });
	const lanesCard = card({ title: "Timeline", body: lanesRegion.node });
	view.append(kpis.node, goalspecSection, impactSection, lanesCard, h("div", { class: "split" }, callsCard, modelsCard), h("div", { class: "split" }, eventsCard, messagesCard), compareCard);

	async function refresh() {
		const [d, si] = await Promise.all([api("/api/session", { id: state.sessionId }), api("/api/session/impact", { id: state.sessionId })]);
		if (!d.session) {
			clear(view);
			view.appendChild(banner("warn", `Session ${state.sessionId} not found.`));
			return;
		}
		kpis.render(d);
		renderGoalspec(d);
		renderSessionImpact(si);
		compareState.thisImpact = si;
		compareTable.render();
		lanesRegion.render(d);
		callsTable.patch(d.calls ?? []);
		modelsBars.render(d);
		eventsFeed.patch(
			(d.events ?? []).map((event) => ({
				key: `${event.ts}|${event.kind}|${event.turn ?? ""}`,
				ts: event.ts,
				tone: event.severity === "error" ? "error" : event.severity === "warn" ? "warn" : "info",
				title: `${event.system} · ${event.title ?? event.kind}`,
				sub: event.summary ?? "",
				right: h("span", { class: "small faint" }, event.turn != null ? `turn ${event.turn}` : ""),
			})),
		);
		messagesFeed.patch(
			(d.messages ?? []).map((message) => ({
				key: message.msg_id,
				ts: new Date(message.ts_ms).toISOString(),
				tone: message.role === "user" ? "info" : "ok",
				title: `${message.role} · turn ${message.turn} · ${fmtCompact(message.chars)} chars`,
				sub: message.preview ?? "",
			})),
		);
		ctx.setStatus(`${state.sessionId.slice(0, 8)} · ${d.session.project ?? ""} · ${fmtCost(d.session.cost)}`);
	}
	await refresh();
	ctx.onAutoRefresh(refresh);
}

// ------------------------------------------------------------------ extensions

async function extensionsPage(view, ctx) {
	const data = await api("/api/extensions");
	clear(view);
	const kpis = gridRegion((d) => {
		const active = d.extensions.filter((e) => e.events > 0);
		return [
			kpi({ label: "Installed", value: fmtInt(d.extensions.length), sub: `${active.length} with recorded activity` }),
			kpi({ label: "Adapter coverage", value: `${active.filter((e) => e.adapter).length}/${active.length}`, sub: "active extensions with an adapter", tip: "An extension is covered when the system id in its log maps to an adapter in server/adapters/." }),
			kpi({ label: "Adapters", value: fmtInt(d.adapters.length), sub: `${d.adapters.filter((a) => a.exists).length} log files present` }),
			kpi({
				label: "Silent 7d+",
				value: fmtInt(d.extensions.filter((e) => e.silent).length),
				sub: "covered but quiet — possibly broken or unused",
				valueClass: d.extensions.some((e) => e.silent) ? "bad" : "good",
			}),
			kpi({ label: "Idle", value: fmtInt(d.extensions.filter((e) => e.events === 0).length), sub: "no events logged yet" }),
		];
	});
	const cardsRegion = nodeRegion((d) =>
		h(
			"div",
			{ class: "grid cols-2" },
			...d.extensions
				.filter((e) => e.events > 0)
				.map((extension) =>
					card({
						title: extension.name,
						sub: `${fmtInt(extension.events)} events · ${fmtCost(extension.cost)} logged`,
						body: h(
							"div",
							{},
							h("div", { class: "small muted", style: { minHeight: "32px" } }, extension.description ?? "No README description."),
							h(
								"div",
								{ class: "chiprow", style: { marginTop: "10px" } },
								extension.adapter ? pill(`adapter · ${extension.adapter.id}`, "accent") : pill("no adapter", "warn"),
								extension.silent ? pill(extension.silentDays == null ? "never ran" : `silent ${fmtInt(extension.silentDays)}d`, "warn") : null,
								extension.lastEvent ? pill(`last ${timeAgo(extension.lastEvent)}`, "neutral") : null,
							),
						),
					}),
				),
		),
	);
	const adaptersTable = table({
		columns: [
			{ label: "Adapter", render: (row) => h("span", { class: "rowtitle" }, row.title) },
			{ label: "Id", render: (row) => h("span", { class: "mono" }, row.id) },
			{
				label: "Log",
				render: (row) => {
					// Show the resolved path, not the declared name: `refine/auto-refine.jsonl`
					// alone reads like the pre-move location it is not.
					const shown = row.resolved ?? row.file;
					if (!shown) return h("span", { class: "mono faint" }, "—");
					if (!row.file || row.file === shown) return h("span", { class: "mono faint" }, shown);
					return h("span", { class: "mono faint", "data-tip": `declared as ${row.file} — resolved against ~/.pi/agent/jev-decisions` }, shown);
				},
			},
			{ label: "Status", render: (row) => (row.exists ? pill("reading", "ok") : pill("missing", "warn")) },
			{ label: "Panels", render: (row) => h("span", { class: "small muted" }, (row.panels ?? []).map((p) => p.kind).join(", ")) },
		],
		rows: data.adapters,
	});

	view.append(kpis.node, cardsRegion.node, card({ title: "Adapter manifests", sub: "the extensibility surface — one file per subsystem", flush: true, body: adaptersTable }));
	const render = (d) => {
		kpis.render(d);
		cardsRegion.render(d);
		adaptersTable.patch(d.adapters);
		ctx.setStatus(`${d.extensions.length} extensions · ${d.adapters.length} adapters`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/extensions")));
}

// ------------------------------------------------------------------ health

async function healthPage(view, ctx) {
	const data = await api("/api/health", { from: state.range });
	clear(view);
	const kpis = gridRegion((d) => [
		kpi({ label: "Events stored", value: fmtCompact(d.counts.events), sub: `${fmtCompact(d.counts.calls)} model calls` }),
		kpi({ label: "Sessions indexed", value: fmtInt(d.counts.sessions), sub: `${fmtInt(d.counts.messages)} messages` }),
		kpi({ label: "Files tracked", value: fmtInt(d.counts.files), sub: `last ingest ${timeAgo(d.lastIngest)}` }),
		kpi({ label: "Warn + error", value: fmtInt(d.bySystem.reduce((a, s) => a + s.warn + s.error, 0)), sub: `${d.bySystem.filter((s) => s.warn + s.error > 0).length} subsystems affected` }),
		kpi({
			label: "Memory degraded streak",
			value: `${fmtInt(d.degradedStreak)}d`,
			sub: d.degradedStreak > 0 ? `${fmtInt(d.degradedDays.length)} degraded day(s) on record` : "consolidation healthy",
			valueClass: d.degradedStreak > 0 ? "bad" : "good",
			help: HELP.healthStreak,
		}),
	]);
	const healthDaily = htmlRegion((d) => areaChart({ labels: (d.daily ?? []).map((day) => day.day), series: [{ name: "warn", values: (d.daily ?? []).map((day) => day.warn) }, { name: "error", values: (d.daily ?? []).map((day) => day.error) }], stacked: true, height: 170, valueFmt: fmtInt }));
	const quietRegion = nodeRegion((d) =>
		(d.quiet ?? []).length
			? h(
					"div",
					{ class: "feed" },
					...d.quiet.map((entry) =>
						h(
							"div",
							{ class: "item" },
							h("div", { class: "t" }, `${fmtInt(entry.daysSinceLast)}d`),
							h("div", { class: "dot warn" }),
							h("div", {}, h("div", { class: "title" }, entry.system), h("div", { class: "sub" }, `${fmtInt(entry.count)} events on record, silent since`)),
							h("div"),
						),
					),
				)
			: emptyState("Every subsystem with recorded activity has logged in the last 7 days."),
	);
	const systems = table({
		columns: [
			{ label: "System", render: (row) => h("span", { class: "rowtitle" }, row.system) },
			{ label: "Events", right: true, render: (row) => fmtInt(row.count) },
			{ label: "Warn", right: true, render: (row) => countPill(row.warn, "warn") },
			{ label: "Error", right: true, render: (row) => countPill(row.error, "error") },
			{ label: "Last", right: true, render: (row) => timeAgo(row.lastTs) },
		],
		rows: data.bySystem,
	});
	const recent = feed([], { clock: fmtClock });

	view.append(
		kpis.node,
		card({ title: "Warnings per day", sub: "warn and error events — a flat line is healthy, a rise is the thing to chase", body: healthDaily.node, help: HELP.healthDaily }),
		h("div", { class: "split" }, card({ title: "Subsystems", sub: "severity mix per system in range", flush: true, body: systems }), card({ title: "Quiet subsystems", sub: "used to log, now silent 7d+ — usually broken, not idle", flush: true, body: quietRegion.node, help: HELP.healthQuiet })),
		card({ title: "Recent warnings & errors", flush: true, body: recent }),
	);
	const render = (d) => {
		kpis.render(d);
		healthDaily.render(d);
		quietRegion.render(d);
		systems.patch(d.bySystem);
		recent.patch(
			d.recent.map((row) => ({
				key: row.id,
				ts: row.ts,
				tone: row.severity,
				title: `${row.system} · ${row.title ?? row.kind}`,
				sub: row.summary ?? "",
				right: row.sessionId ? h("span", { class: "small mono faint" }, row.sessionId.slice(0, 8)) : null,
				onClick: () => openEventDrawer(row),
			})),
		);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(d.recent.length)} recent issues`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/health", { from: state.range })));
}

// ------------------------------------------------------------------ live

async function livePage(view, ctx) {
	const [live, overview] = await Promise.all([api("/api/live", { limit: 120 }), api("/api/overview", { from: "24h" })]);
	clear(view);
	const kpis = gridRegion((d) => [
		kpi({ label: "Last 24h cost", value: fmtCost(d.overview.totals.costModel), sub: `${fmtInt(d.overview.totals.calls)} calls` }),
		kpi({ label: "Last 24h events", value: fmtInt(d.overview.totals.events), sub: "harness decisions" }),
		kpi({ label: "Cache rate", value: fmtPct(d.overview.totals.cacheRate, 1), sub: "prompt token reuse" }),
		kpi({ label: "Stream", value: "live", sub: "patches in place on ingest", valueClass: "small" }),
	]);
	const stream = feed([], { clock: fmtClock });
	// Hovering pauses updates so a busy stream does not move while you read it.
	let hovering = false;
	let deferred = false;
	stream.addEventListener("mouseenter", () => {
		hovering = true;
	});
	stream.addEventListener("mouseleave", () => {
		hovering = false;
		if (deferred) {
			deferred = false;
			void refreshLive();
		}
	});
	const systemChips = h("div", { class: "chiprow", style: { padding: "10px 14px 0" } });
	const scopeLabel = h("span", { class: "small muted" }, "all subsystems");

	view.append(
		kpis.node,
		h(
			"div",
			{ class: "card" },
			h("div", { class: "cardhead" }, h("h3", {}, "Event stream"), h("span", { class: "sub" }, "newest first · click for the raw record · hovering pauses updates"), h("div", { class: "grow" }), scopeLabel),
			systemChips,
			h("div", { class: "cardbody flush" }, stream),
		),
	);
	const render = (d) => {
		kpis.render(d);
		const counts = new Map();
		for (const row of d.live.rows) counts.set(row.system, (counts.get(row.system) ?? 0) + 1);
		clear(systemChips);
		systemChips.append(
			chip("all", d.live.rows.length, {
				active: !state.liveSystem,
				onClick: () => {
					state.liveSystem = null;
					void refreshLive();
				},
			}),
			...[...counts.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([system, count]) =>
					chip(system, count, {
						active: state.liveSystem === system,
						onClick: () => {
							state.liveSystem = state.liveSystem === system ? null : system;
							void refreshLive();
						},
					}),
				),
		);
		scopeLabel.textContent = state.liveSystem ? `filtered: ${state.liveSystem}` : "all subsystems";
		stream.patch(
			d.live.rows
				.filter((row) => !state.liveSystem || row.system === state.liveSystem)
				.map((row) => ({
				key: row.id,
				ts: row.ts,
				tone: row.severity === "error" ? "error" : row.severity === "warn" ? "warn" : "info",
				title: `${row.system} · ${row.title ?? row.kind}`,
				sub: row.summary ?? "",
				right: h("span", { class: "small mono faint" }, row.sessionId ? row.sessionId.slice(0, 8) : ""),
				onClick: () => openEventDrawer(row),
			})),
		);
		ctx.setStatus("live stream");
	};
	async function refreshLive() {
		const [nextLive, nextOverview] = await Promise.all([api("/api/live", { limit: 120 }), api("/api/overview", { from: "24h" })]);
		render({ live: nextLive, overview: nextOverview });
	}
	render({ live, overview });
	ctx.onAutoRefresh(async () => {
		if (hovering) {
			deferred = true;
			return;
		}
		await refreshLive();
	});
}

// ------------------------------------------------------------------ refine

async function refinePage(view, ctx) {
	const data = await api("/api/refine", { from: state.range });
	clear(view);

	const kpis = gridRegion((d) => [
		kpi({ label: "Runs audited", value: fmtInt(d.runs), sub: `${fmtInt(d.byKind.rule ?? 0)} rule · ${fmtInt(d.byKind.note ?? 0)} note proposals`, help: HELP.refine }),
		kpi({ label: "Applied", value: fmtInt(d.byDecision.applied ?? 0), sub: `${fmtInt(d.byDecision.armed ?? 0)} armed · ${fmtInt(d.byDecision["kept-staged"] ?? 0)} kept staged` }),
		kpi({ label: "Suppressed", value: fmtInt(d.byDecision.suppressed ?? 0), sub: `${fmtInt(d.byDecision["no-proposals"] ?? 0)} runs found nothing worth proposing` }),
		kpi({ label: "Degraded", value: fmtInt(d.degraded), sub: d.degraded > 0 ? "runs that fell back — check the reason" : "no fallbacks", valueClass: d.degraded > 0 ? "bad" : "good" }),
		kpi({ label: "Rules live", value: fmtInt(d.liveRuleCount), sub: `avg loop latency ${fmtMs(d.avgLatencyMs)}` }),
	]);
	const decisions = nodeRegion((d) => bars(Object.entries(d.byDecision).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }));
	const stages = nodeRegion((d) => bars(Object.entries(d.byStage).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }));
	// Rules and notes are segregated: a rule has a lifecycle (proposed → staged →
	// armed, or rolled back), a note is simply written down.
	const artifactSegSlot = h("div", { class: "seg" });
	const artifactSlot = h("div", { class: "cardbody flush" });
	let artifactTab = "rules";
	const statePill = (state) =>
		pill(state, state === "armed" ? "ok" : state === "staged" ? "accent" : state === "rolled back" ? "warn" : state === "written" ? "ok" : "neutral");
	const viewButton = (row) =>
		row.available
			? h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); void openFileDrawer(row.path, row.name); } }, "View")
			: h("span", { class: "small faint nowrap", "data-tip": row.recordedPath ? `recorded at ${row.recordedPath} — no longer on disk` : "no file path recorded" }, "missing");
	function renderArtifacts(data) {
		const rules = (data.artifacts ?? []).filter((artifact) => artifact.kind === "rule");
		const notes = (data.artifacts ?? []).filter((artifact) => artifact.kind === "note");
		clear(artifactSegSlot);
		for (const [id, label, count] of [["rules", "Rules", rules.length], ["notes", "Notes", notes.length]]) {
			artifactSegSlot.append(h("button", { class: artifactTab === id ? "active" : "", onclick: () => { artifactTab = id; renderArtifacts(data); } }, `${label} (${fmtInt(count)})`));
		}
		clear(artifactSlot);
		const nameColumn = artifactTab === "rules" ? "Rule" : "Note";
		artifactSlot.append(
			table({
				columns: [
					{ label: nameColumn, render: (row) => h("span", { class: "mono", style: { fontSize: "11.5px" } }, row.name) },
					{ label: "State", render: (row) => statePill(row.state) },
					{ label: "Source", render: (row) => h("span", { class: "small muted" }, row.source ?? "—") },
					{ label: "Evidence", render: (row) => h("span", { class: "small muted truncate" }, row.evidence ?? "—") },
					{ label: "When", right: true, render: (row) => timeAgo(row.ts) },
					{ label: "", width: "78px", render: viewButton },
				],
				rows: (artifactTab === "rules" ? rules : notes).map((row) => ({ ...row, key: row.id })),
				maxHeight: "440px",
				empty:
					artifactTab === "rules"
						? "No rules in this range — widen the range in the top bar to include earlier rule applies"
						: "No notes in this range — widen the range in the top bar",
			}),
		);
	}
	const fileList = (entries, withMeta = false) =>
		entries.length
			? h(
					"div",
					{ class: "feed" },
					...entries.map((entry) => {
						const parts = entry.parts && typeof entry.parts === "object"
							? ["evidence", "novelty", "trigger"]
									.filter((part) => typeof entry.parts[part] === "number")
									.map((part) => `${part.slice(0, 2)} ${Number(entry.parts[part]).toFixed(2)}`)
									.join(" · ")
							: null;
						return h(
							"div",
							{ class: "item" },
							h("div", { class: "t" }, entry.tier ? entry.tier.replace("near-miss", "near") : fmtCompact(entry.chars)),
							h("div", { class: `dot ${entry.tier === "near-miss" ? "warn" : entry.tier === "ready" ? "ok" : "info"}` }),
							h("div", {}, h("div", { class: "title mono", style: { fontSize: "12px" } }, entry.name), h("div", { class: "sub" }, [parts, entry.evidence ?? entry.preview].filter(Boolean).join(" — "))),
							h(
								"div",
								{ style: { display: "flex", gap: "6px" } },
								h("button", { class: "btn", onclick: () => void openFileDrawer(entry.path, entry.name) }, "View"),
								withMeta && entry.metaPath ? h("button", { class: "btn", onclick: () => void openFileDrawer(entry.metaPath, `${entry.name} — meta`) }, "Meta") : null,
							),
						);
					}),
				)
			: emptyState("Nothing here right now.");
	const staging = nodeRegion((d) => {
		const ready = (d.staging ?? []).filter((entry) => entry.tier === "ready").length;
		const near = (d.staging ?? []).filter((entry) => entry.tier === "near-miss").length;
		return h(
			"div",
			{},
			(d.staging ?? []).length ? h("div", { class: "small muted", style: { padding: "0 0 6px" } }, `${fmtInt(ready)} ready · ${fmtInt(near)} near-miss — Meta opens the scores behind each one`) : null,
			fileList(d.staging ?? [], true),
		);
	});
	const gateCard = nodeRegion((d) => {
		const gate = d.gate;
		if (!gate) return emptyState("No gate data in this range.");
		const parts = Object.entries(gate.parts).map(([part, stats]) => ({ key: part, part, ...stats }));
		return h(
			"div",
			{ class: "grid" },
			h(
				"div",
				{ class: "grid cols-2" },
				card({ title: "Bands", sub: "rule proposals by gate outcome, re-derived from logged part scores", body: bars(Object.entries(gate.bands).map(([label, value]) => ({ label, value })), { valueFmt: fmtInt }) }),
				card({
					title: "Part scores vs floors",
					sub: "how close proposals come to each floor",
					body: table({
						columns: [
							{ label: "Part", render: (row) => h("span", { class: "mono" }, row.part) },
							{ label: "Avg", right: true, render: (row) => (row.avg == null ? "—" : row.avg.toFixed(2)) },
							{ label: "Max", right: true, render: (row) => (row.max == null ? "—" : row.max.toFixed(2)) },
							{ label: "Floor", right: true, render: (row) => row.floor.toFixed(2) },
							{
								label: "Headroom",
								right: true,
								render: (row) => (row.max == null ? "—" : h("span", { style: { color: row.max - row.floor >= 0 ? "var(--ok)" : "var(--err)" } }, (row.max - row.floor).toFixed(2))),
							},
						],
						rows: parts,
					}),
				}),
			),
			h(
				"div",
				{ class: "small muted" },
				`${fmtInt(gate.nearMissEligibleSuppressed)} suppressed proposal(s) would band as ready or near-miss under these floors — the gap the per-part gate was introduced to close. Floors: evidence ≥ ${gate.floors.evidence}, novelty ≥ ${gate.floors.novelty}, trigger ≥ ${gate.floors.trigger}; near-miss needs min(evidence, novelty) ≥ ${gate.floors.nearMiss}.`,
			),
		);
	});

	view.append(
		kpis.node,
		h("div", { class: "split" }, card({ title: "Loop decisions", sub: "what the auto-loop concluded each run", body: decisions.node }), card({ title: "Stages", sub: "where runs spent their effort", body: stages.node })),
		card({
			title: "Rules & notes",
			sub: "everything the loop has written, segregated by kind — rules carry a lifecycle, notes are records",
			actions: artifactSegSlot,
			flush: true,
			body: artifactSlot,
			help: HELP.refine,
		}),
		card({ title: "Gate calibration", sub: "how close rule proposals come to the gate, and which band they land in", body: gateCard.node, help: HELP.refineGate }),
		card({ title: "Staged rules", sub: "waiting for one-glance arming — Meta opens the scores behind each one", flush: true, body: staging.node, help: HELP.refineStaging }),
	);
	const render = (d) => {
		kpis.render(d);
		decisions.render(d);
		stages.render(d);
		renderArtifacts(d);
		staging.render(d);
		gateCard.render(d);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(d.runs)} loop runs · ${fmtInt(d.artifactCounts?.rules ?? 0)} rules / ${fmtInt(d.artifactCounts?.notes ?? 0)} notes`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/refine", { from: state.range })));
}

// ------------------------------------------------------------------ tuner

async function tunerPage(view, ctx) {
	const data = await api("/api/tuner", { from: state.range });
	clear(view);

	const kpis = gridRegion((d) => [
		kpi({ label: "Runs", value: fmtInt(d.runs.length), sub: d.state?.lastRun ? `last ${timeAgo(d.state.lastRun)}` : "never run", help: HELP.tuner }),
		kpi({ label: "Proposals", value: fmtInt(d.proposals.length), sub: Object.entries(d.statusCounts).map(([status, count]) => `${count} ${status}`).join(" · ") || "none yet" }),
		kpi({ label: "Open", value: fmtInt(d.statusCounts.open ?? 0), sub: "awaiting your review", valueClass: (d.statusCounts.open ?? 0) > 0 ? "bad" : "good" }),
		kpi({ label: "Dismissed", value: fmtInt(d.statusCounts.dismissed ?? 0), sub: "reviewed and rejected" }),
	]);
	const proposals = table({
		columns: [
			{ label: "Kind", render: (row) => pill(row.kind, row.kind === "prune" ? "warn" : "info") },
			{ label: "System", render: (row) => h("span", { class: "mono" }, row.system) },
			{ label: "Target", render: (row) => h("span", { class: "rowtitle mono", style: { fontSize: "11.5px" } }, row.target) },
			{ label: "Evidence", render: (row) => h("span", { class: "small muted truncate" }, row.evidence ?? "—") },
			{ label: "Status", render: (row) => pill(row.status, row.status === "open" ? "warn" : row.status === "applied" ? "ok" : "neutral") },
			{ label: "Decided", right: true, render: (row) => (row.decidedAt ? timeAgo(row.decidedAt) : "—") },
			{
				label: "",
				width: "78px",
				render: (row) => {
					// Never offer a click that can 404: an unresolvable proposal says why.
					if (!row.file || row.fileExists === false) {
						const missing = row.file ? String(row.file).split("/").pop() : null;
						return h(
							"span",
							{
								class: "small faint nowrap",
								"data-tip": missing
									? `recorded at ${missing} — not on disk`
									: row.kind === "config"
										? "a config proposal changes a setting and records no target file"
										: "no file recorded for this proposal",
							},
							"no file",
						);
					}
					// A pruned rule is renamed out of the way rather than deleted, so say which
					// copy is being opened instead of pretending it is the original.
					const variant =
						row.fileKind === "record"
							? { label: "Log", title: `${row.target} — proposal record`, tip: "opens the proposal log this is recorded in" }
							: row.fileKind === "disabled"
								? { label: "View", title: `${row.target} — disabled copy`, tip: "the rule was pruned; opens the renamed .disabled file" }
								: row.fileKind === "dismissed"
									? { label: "View", title: `${row.target} — dismissed copy`, tip: "opens the renamed .dismissed copy" }
									: { label: "View", title: row.target, tip: "opens the target file" };
					return h("button", { class: "btn", "data-tip": variant.tip, onclick: () => void openFileDrawer(row.file, variant.title) }, variant.label);
				},
			},
		],
		rows: [],
		maxHeight: "420px",
	});
	const runs = feed([], { clock: fmtClock });
	const stateCard = nodeRegion((d) =>
		h(
			"div",
			{},
			kv([
				["Last run", d.state?.lastRun ? `${fmtDateTime(d.state.lastRun)} · ${timeAgo(d.state.lastRun)}` : "never"],
				["Last action", d.state?.lastAction ? `${d.state.lastAction.kind} at ${fmtClock(d.state.lastAction.at)}` : "—"],
				["Proposals file", h("span", { class: "mono", style: { fontSize: "11px" } }, d.proposalsFile.replace(/^.*\/agent\//, "~/") )],
				["Config", d.config ? h("span", { class: "mono", style: { fontSize: "11px" } }, JSON.stringify(d.config)) : "none — using defaults"],
			]),
		),
	);

	view.append(
		kpis.node,
		card({ title: "Proposals", sub: "what the tuner suggests changing, with the evidence behind it — view opens the target rule or file", flush: true, body: proposals, help: HELP.tuner }),
		h("div", { class: "split" }, card({ title: "Runs", sub: "each tuning pass", flush: true, body: runs }), card({ title: "Tuner state", body: stateCard.node })),
	);
	const render = (d) => {
		kpis.render(d);
		proposals.patch((d.proposals ?? []).map((row) => ({ ...row, key: row.id })));
		runs.patch(
			(d.runs ?? []).map((row) => ({
				key: `${row.ts}|${row.event}`,
				ts: row.ts,
				tone: row.event === "run" ? "info" : "ok",
				title: row.event === "run" ? `tuning pass${row.days != null ? ` · ${fmtInt(row.days)}d window` : ""}` : `${row.event}${row.target ? ` · ${row.target}` : ""}`,
				sub: row.proposals != null ? `${fmtInt(row.proposals)} proposal(s)` : "",
			})),
		);
		stateCard.render(d);
		ctx.setStatus(`${RANGE_LABEL[state.range]} · ${fmtInt(d.runs.length)} runs · ${fmtInt(d.proposals.length)} proposals`);
	};
	render(data);
	ctx.onAutoRefresh(async () => render(await api("/api/tuner", { from: state.range })));
}

export const PAGES = {
	overview,
	impact: impactPage,
	models,
	router: routerPage,
	ledger: ledgerPage,
	curator: curatorPage,
	refine: refinePage,
	tuner: tunerPage,
	sessions: sessionsPage,
	session: sessionPage,
	extensions: extensionsPage,
	health: healthPage,
	live: livePage,
};
