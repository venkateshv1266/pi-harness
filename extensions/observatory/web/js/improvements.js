// Improvements page: one row per day of harness change, an N vs N−1 comparison
// with percentage-point deltas for rates, and the derived improvement ledger.
// Read-only over the materialized snapshots; every row drills through to the
// raw day view.
import { api, h, clear, fmtInt, openDrawer } from "./util.js";
import { spark } from "./charts.js";
import { card, kpi, pill, table, emptyState, banner } from "./ui.js";

const HELP = {
	title: "Improvements",
	what: "What changed in the harness each day, and whether the change held: armed items per kind, rollbacks and prunes, gate pass rate, the mix of rule-fire outcomes, extension adoption, and the harness digest delta.",
	formula: "One snapshot per day materialized from refine's audit/history logs, TTSR outcome records, the decision-tuner proposal log and session tool calls. Rates are compared as percentage points, never as relative percentages.",
	source: "~/.pi/agent/observatory/snapshots/YYYY-MM-DD.json (recomputable from ~/.pi/agent/jev-decisions/**, refine/history.jsonl, refine/auto-refine.jsonl and sessions/**).",
	action: "Read the digest row first: a day with no digest change and no ledger line means nothing armed. Then check silent extensions — a tool armed without adoption is the failure this page exists to catch.",
};

const rateText = (rate) => (typeof rate === "number" ? `${(rate * 100).toFixed(0)}%` : "—");
const valueText = (value, unit) => (unit === "pp" ? rateText(value) : value === null || value === undefined ? "—" : fmtInt(value));
const deltaText = (metric) => {
	if (metric.delta === null || metric.delta === undefined) return "—";
	const sign = metric.delta > 0 ? "+" : "";
	return metric.unit === "pp" ? `${sign}${metric.delta.toFixed(1)} pp` : `${sign}${fmtInt(metric.delta)}`;
};
const GOOD_UP = new Set(["armed", "staged", "probeRate", "ruleSurvival", "extensionsUsed"]);
const GOOD_DOWN = new Set(["rolledBack", "extensionsSilent"]);
const toneFor = (metric) => {
	if (metric.delta === null || metric.delta === undefined || metric.delta === 0) return "neutral";
	if (GOOD_UP.has(metric.key)) return metric.delta > 0 ? "ok" : "warn";
	if (GOOD_DOWN.has(metric.key)) return metric.delta > 0 ? "warn" : "ok";
	return "neutral";
};

const metric = (key, label, from, to, unit = "count") => ({
	key,
	label,
	from,
	to,
	unit,
	delta: from === null || to === null || from === undefined || to === undefined ? null : unit === "pp" ? (to - from) * 100 : to - from,
});

function metricsFor(from, to) {
	if (!from || !to) return [];
	return [
		metric("armed", "Armed", from.counts.armed, to.counts.armed),
		metric("rolledBack", "Rolled back", from.counts.rolledBack, to.counts.rolledBack),
		metric("pruned", "Pruned", from.counts.pruned, to.counts.pruned),
		metric("staged", "Staged", from.staged.total, to.staged.total),
		metric("probeRate", "Gate pass rate", from.probe.rate, to.probe.rate, "pp"),
		metric("ruleSurvival", "Rule survival", from.ruleOutcomes.survivalRate, to.ruleOutcomes.survivalRate, "pp"),
		metric("extensionsUsed", "Extensions used", from.extensions.used.length, to.extensions.used.length),
		metric("extensionsSilent", "Extensions silent", from.extensions.silent.length, to.extensions.silent.length),
	];
}

const armedLabel = (snapshot) => {
	const entries = Object.entries(snapshot.armed ?? {}).filter(([, names]) => names.length > 0);
	return entries.length === 0 ? "—" : entries.map(([kind, names]) => `${kind}: ${names.join(", ")}`).join(" · ");
};

const ruleMixLabel = (snapshot) => {
	const mix = snapshot.ruleOutcomes ?? {};
	if (!mix.total) return "—";
	return `${mix.survived} survived · ${mix.retried} retried · ${mix.user_corrected} corrected · ${mix.repeated} repeated`;
};

const extensionLabel = (snapshot) => {
	const ext = snapshot.extensions ?? {};
	if (!ext.armed) return "—";
	const used = ext.used.length ? `used ${ext.used.join(", ")}` : "none used";
	const silent = ext.silent.length ? ` · silent ${ext.silent.join(", ")}` : "";
	return `${used}${silent}`;
};

const digestLabel = (snapshot) => (snapshot.digestChanged ? `Δ ${snapshot.digestFrom ?? "?"} → ${snapshot.digest ?? "?"}` : snapshot.digest ?? "—");

function region(build) {
	const node = h("div");
	return { node, render: (data) => node.replaceChildren(...build(data)) };
}

let compareTo = null;
let compareFrom = null;

async function openDay(date) {
	try {
		const snapshot = await api("/api/improvements/day", { date });
		openDrawer({
			title: `Snapshot ${date}`,
			sub: "raw materialized view — recomputable from the decision logs",
			body: h("pre", { class: "mono small", style: { whiteSpace: "pre-wrap" } }, JSON.stringify(snapshot, null, 2)),
		});
	} catch (error) {
		openDrawer({ title: `Snapshot ${date}`, body: h("div", { class: "small muted" }, String(error)) });
	}
}

export async function improvementsPage(view, ctx) {
	const load = async () => api("/api/improvements");
	let data = await load();
	clear(view);

	compareTo = compareTo ?? data.compare.to;
	compareFrom = compareFrom ?? data.compare.from;

	const kpis = region((d) => {
		const latest = d.latest;
		if (!latest) return [emptyState("No snapshots yet — the first one is written at the next session start or observatory launch.")];
		const days = d.days;
		const armedSeries = days.map((day) => day.counts.armed);
		const gateSeries = days.map((day) => day.probe.rate ?? 0);
		return [
			kpi({ label: "Latest day", value: latest.date, sub: latest.digest ? `harness ${latest.digest}${latest.digestChanged ? " (changed)" : ""}` : "no digest", help: HELP }),
			kpi({ label: "Armed", value: fmtInt(latest.counts.armed), sub: Object.keys(latest.armed).length ? Object.keys(latest.armed).join(" · ") : "nothing armed", sparkHtml: spark(armedSeries) }),
			kpi({ label: "Rolled back", value: fmtInt(latest.counts.rolledBack), sub: latest.rolledBack.length ? latest.rolledBack.join(", ") : "no rollbacks", valueClass: latest.counts.rolledBack > 0 ? "warn" : "" }),
			kpi({ label: "Gate pass", value: rateText(latest.probe.rate), sub: `${latest.probe.passed}/${latest.probe.evaluated} extension gate(s)`, sparkHtml: spark(gateSeries) }),
			kpi({ label: "Rule survival", value: rateText(latest.ruleOutcomes.survivalRate), sub: `${latest.ruleOutcomes.total} outcome(s) recorded` }),
			kpi({ label: "Extensions used", value: fmtInt(latest.extensions.used.length), sub: latest.extensions.silent.length ? `${latest.extensions.silent.length} silent` : "no silent extensions", valueClass: latest.extensions.silent.length > 0 ? "warn" : "good" }),
		];
	});
	const dayStrip = region((d) => [
		table({
			columns: [
				{ label: "Day", render: (row) => h("span", { class: "mono", style: { fontSize: "11.5px" } }, row.date) },
				{ label: "Armed", render: (row) => h("span", { class: "small" }, armedLabel(row)) },
				{ label: "Rolled back", render: (row) => h("span", { class: "small muted" }, row.rolledBack.length ? row.rolledBack.join(", ") : "—") },
				{ label: "Pruned", render: (row) => h("span", { class: "small muted" }, row.pruned.length ? row.pruned.join(", ") : "—") },
				{ label: "Staged", right: true, render: (row) => h("span", {}, fmtInt(row.staged.total), h("span", { class: "small faint" }, ` · ${row.staged.gatePass}/${row.staged.gatePass + row.staged.gateFail} gate`)) },
				{ label: "Gate", right: true, render: (row) => (row.probe.rate == null ? "—" : pill(rateText(row.probe.rate), row.probe.rate >= 0.5 ? "ok" : "warn")) },
				{ label: "Rules", render: (row) => h("span", { class: "small muted" }, ruleMixLabel(row)) },
				{ label: "Extensions", render: (row) => h("span", { class: "small muted" }, extensionLabel(row)) },
				{ label: "Digest", render: (row) => h("span", { class: "small mono", "data-tip": row.digestChanged ? "the armed harness changed that day" : "no harness change recorded" }, digestLabel(row)) },
				{ label: "Ledger", render: (row) => h("span", { class: "small muted truncate", "data-tip": row.ledger.join("\n") }, row.ledger.join(" · ")) },
				{
					label: "",
					width: "110px",
					render: (row) =>
						h(
							"div",
							{ style: { display: "flex", gap: "6px" } },
							h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); compareTo = row.date; compareFrom = d.days.filter((day) => day.date < row.date).slice(-1)[0]?.date ?? null; renderCompare(d); } }, "Compare"),
							h("button", { class: "btn", onclick: (event) => { event.stopPropagation(); void openDay(row.date); } }, "Raw"),
						),
				},
			],
			rows: d.days.slice().reverse().map((day) => ({ ...day, key: day.date })),
			onRowClick: (row) => {
				compareTo = row.date;
				compareFrom = d.days.filter((day) => day.date < row.date).slice(-1)[0]?.date ?? null;
				renderCompare(d);
			},
			maxHeight: "460px",
			empty: "No snapshots yet",
		}),
	]);

	const toSelect = h("select", { class: "btn", "aria-label": "Compare to day" });
	const fromSelect = h("select", { class: "btn", "aria-label": "Compare from day" });
	toSelect.addEventListener("change", () => {
		compareTo = toSelect.value;
		renderCompare(data);
	});
	fromSelect.addEventListener("change", () => {
		compareFrom = fromSelect.value;
		renderCompare(data);
	});

	const syncSelect = (select, value, days) => {
		clear(select);
		for (const day of days.slice().reverse()) select.append(h("option", { value: day.date, selected: day.date === value }, day.date));
	};
	const compareBody = region((d) => {
		if (d.days.length === 0) return [emptyState("No snapshots yet")];
		syncSelect(toSelect, compareTo, d.days);
		syncSelect(fromSelect, compareFrom, d.days);
		const byDate = new Map(d.days.map((day) => [day.date, day]));
		const to = byDate.get(compareTo) ?? d.latest;
		const from = compareFrom ? (byDate.get(compareFrom) ?? null) : d.previous;
		const metrics = metricsFor(from, to);
		const body = [
			table({
				columns: [
					{ label: "Metric", render: (row) => row.label },
					{ label: from?.date ?? "from", right: true, render: (row) => valueText(row.from, row.unit) },
					{ label: to?.date ?? "to", right: true, render: (row) => valueText(row.to, row.unit) },
					{ label: "Δ", right: true, render: (row) => (row.delta == null ? "—" : pill(deltaText(row), toneFor(row))) },
				],
				rows: metrics.map((row) => ({ ...row, key: row.key })),
				empty: "Pick two days with data",
			}),
		];
		if (to?.digestChanged) body.unshift(banner("info", `Harness changed on ${to.date}: ${to.digestFrom ?? "?"} → ${to.digest ?? "?"}`));
		return body;
	});

	const ledgerBody = region((d) => {
		if (d.days.length === 0) return [emptyState("No ledger entries yet")];
		return [
			h(
				"div",
				{ class: "feed" },
				...d.days
					.slice()
					.reverse()
					.map((day) =>
						h(
							"div",
							{ class: "item" },
							h("div", { class: "t mono" }, day.date),
							h("div", { class: `dot ${day.digestChanged ? "ok" : "info"}` }),
							h("div", {}, h("div", { class: "title" }, day.ledger.join(" · ")), h("div", { class: "sub" }, `${day.counts.armed} armed · ${day.counts.rolledBack} rolled back · ${day.counts.pruned} pruned · ${day.counts.rejected} rejected`)),
							h("div", {}, h("button", { class: "btn", onclick: () => void openDay(day.date) }, "Raw")),
						),
					),
			),
		];
	});

	view.append(
		kpis.node,
		card({ title: "Day strip", sub: "one row per day: what changed, what it did, whether the harness digest moved", body: dayStrip.node, help: HELP }),
		card({ title: "Day-over-day", sub: "default N vs N−1 — rates compare as percentage points", actions: h("div", { style: { display: "flex", gap: "6px" } }, fromSelect, h("span", { class: "small faint" }, "→"), toSelect), body: compareBody.node, help: HELP }),
		card({ title: "Improvement ledger", sub: "the human-readable one-liner per day, newest first", body: ledgerBody.node, help: HELP }),
	);

	const renderCompare = (d) => {
		data = d;
		compareBody.render(d);
		dayStrip.render(d);
	};
	const render = (d) => {
		kpis.render(d);
		dayStrip.render(d);
		compareBody.render(d);
		ledgerBody.render(d);
		const latest = d.latest;
		ctx.setStatus(latest ? `${latest.date} · ${latest.counts.armed} armed · ${latest.extensions.silent.length} silent extension(s)` : "no snapshots yet");
	};

	render(data);
	ctx.onAutoRefresh(async () => {
		render(await load());
	});
}
