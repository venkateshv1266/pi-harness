// Reusable UI components. Tables and feeds support in-place, keyed patching:
// the container is built once and updates only touch added/changed/removed
// rows, with scroll anchoring so a reader's position never jumps.
import { clear, esc, fmtCompact, h, openDrawer } from "./util.js";

// ------------------------------------------------------------------ anchoring

function scrollParentOf(node) {
	let current = node.parentElement;
	while (current) {
		const style = getComputedStyle(current);
		if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) return current;
		current = current.parentElement;
	}
	return null;
}

/**
 * Run `mutate` and keep the reading position: when content is added above a
 * scrolled viewport, shift scrollTop by the height delta. At the top, content
 * simply grows downward.
 */
function withScrollAnchor(node, mutate) {
	const parent = scrollParentOf(node);
	if (parent) {
		const top = parent.scrollTop;
		const height = parent.scrollHeight;
		mutate();
		if (top > 4) parent.scrollTop = top + (parent.scrollHeight - height);
		return;
	}
	const doc = document.scrollingElement;
	const top = window.scrollY;
	const height = doc ? doc.scrollHeight : 0;
	mutate();
	if (doc && top > 4) window.scrollTo(0, top + (doc.scrollHeight - height));
}

const keyOfRow = (row, index) =>
	String(row?.key ?? row?.id ?? row?.msg_id ?? row?.sessionId ?? row?.session_id ?? `${row?.ts ?? ""}|${row?.title ?? index}`);

// ------------------------------------------------------------------ cards

export function card({ title, sub, actions, body, flush = false, tight = false, id = null, help = null }) {
	const head =
		title === undefined && !actions && !help
			? null
			: h(
					"div",
					{ class: "cardhead" },
					title ? h("h3", {}, title) : null,
					sub ? h("span", { class: "sub" }, sub) : null,
					h("div", { class: "grow" }),
					h("div", { class: "actions" }, help ? helpButton(help) : null, actions ?? null),
				);
	return h("div", { class: "card", id }, head, h("div", { class: `cardbody${flush ? " flush" : tight ? " tight" : ""}` }, body));
}

export function kpi({ label, value, sub, valueClass = "", sparkHtml = null, tip = null, help = null }) {
	const node = h(
		"div",
		{ class: "card kpi" },
		h("div", { class: "kpi-head" }, h("div", { class: "label" }, label), help ? helpButton(help) : null),
		h("div", { class: `value ${valueClass}` }, value),
		sub ? h("div", { class: "sub" }, sub) : null,
		sparkHtml ? h("div", { class: "spark", html: sparkHtml }) : null,
	);
	if (tip) node.dataset.tip = tip;
	return node;
}

export function pill(text, tone = "neutral", tip = null) {
	const node = h("span", { class: `pill ${tone}` }, text);
	if (tip) node.dataset.tip = tip;
	return node;
}

/**
 * A count badge that keeps its shape at zero. A bare `0` next to a column of
 * pills reads as mis-aligned, because the pill's padding pushes its digit
 * inboard while the bare digit sits flush against the cell edge.
 */
export function countPill(value, tone) {
	return value ? pill(String(value), tone) : pill("0", "neutral");
}

export function chip(text, count, { active = false, onClick = null, tip = null } = {}) {
	const node = h("button", { class: `chip${active ? " active" : ""}`, onclick: onClick }, text, count !== null && count !== undefined ? h("span", { class: "n" }, fmtCompact(count)) : null);
	if (tip) node.dataset.tip = tip;
	return node;
}

export function banner(tone, text) {
	return h("div", { class: `banner ${tone}` }, text);
}

export function emptyState(text) {
	return h("div", { class: "empty" }, text);
}

export function skeletonRows(count = 6) {
	return h(
		"div",
		{ class: "skeleton" },
		...Array.from({ length: count }, (_, index) => h("div", { class: "skel-row", style: { width: `${96 - index * 4}%` } })),
	);
}

export function legend(series) {
	return h(
		"div",
		{ class: "legend" },
		...series.map((s, index) => h("span", { html: `<i style="background:var(--s${(index % 8) + 1})"></i>${esc(s.name)}` })),
	);
}

export function kv(entries) {
	return h(
		"dl",
		{ class: "kv" },
		...entries.flatMap(([key, value]) => [h("dt", {}, key), h("dd", {}, value)]),
	);
}

/** Horizontal bar list. items: [{ label, value, color?, tip? }] */
export function bars(items, { valueFmt = fmtCompact, max = null } = {}) {
	if (!items.length) return emptyState("No data");
	const top = max ?? Math.max(...items.map((i) => i.value), 1e-9);
	return h(
		"div",
		{ class: "bar-list" },
		...items.map((item, index) =>
			h(
				"div",
				{ class: "bar-row" },
				h("div", { class: "name", title: item.label }, item.label),
				h("div", { class: "track" }, h("div", { class: "fill", style: { width: `${Math.max(1.5, (item.value / top) * 100)}%`, background: item.color ?? `var(--s${(index % 8) + 1})` } })),
				h("div", { class: "val" }, valueFmt(item.value)),
			),
		),
	);
}

/** Rounded shares must not print a 0% row: a subsystem with four decisions is <1%, not nothing. */
export const shareLabel = (part, whole) => {
	const share = part / whole;
	return share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
};

/** Lane strip: rows = [{ label, ticks: [{ start, end, color, tip }] }], bounds in ms. */
export function lanes(rows, { from, to }) {
	const span = Math.max(1, to - from);
	return h(
		"div",
		{ class: "lanes" },
		...rows.map((row) =>
			h(
				"div",
				{ class: "lane" },
				h("div", { class: "lane-label" }, row.label),
				h(
					"div",
					{ class: "track" },
					...row.ticks.map((tick) => {
						const start = Math.max(0, ((tick.start - from) / span) * 100);
						const width = Math.max(0.25, ((tick.end - tick.start) / span) * 100);
						const node = h("div", { class: "tick", style: { left: `${start}%`, width: `${width}%`, background: tick.color } });
						if (tick.tip) node.dataset.tip = tick.tip;
						return node;
					}),
				),
			),
		),
	);
}

// ------------------------------------------------------------------ picker

/**
 * Searchable single-select. Filter-as-you-type, arrow keys, Enter to pick,
 * Escape to close, click-outside to dismiss.
 * options: [{ value, label, meta }]
 */
export function modelPicker({ options, value = null, onChange }) {
	const root = h("div", { class: "picker" });
	const pop = h("div", { class: "picker-pop", hidden: true });
	const search = h("input", { class: "input picker-search", placeholder: "Search models…", "aria-label": "Search models" });
	const list = h("div", { class: "picker-list", role: "listbox" });
	const button = h("button", { class: "picker-button", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" });
	let filtered = options;
	let activeIndex = 0;

	const renderButton = () => {
		clear(button);
		button.append(h("span", { class: "picker-value", title: value ?? "All models" }, value ? value.split("/").pop() : "All models"), h("span", { class: "picker-caret" }, "▾"));
	};

	const renderList = () => {
		clear(list);
		const query = search.value.trim().toLowerCase();
		filtered = options.filter((option) => !query || option.label.toLowerCase().includes(query) || String(option.value ?? "").toLowerCase().includes(query));
		if (!filtered.length) {
			list.append(h("div", { class: "picker-empty" }, "No models match"));
			return;
		}
		activeIndex = Math.max(0, Math.min(activeIndex, filtered.length - 1));
		filtered.forEach((option, index) => {
			list.append(
				h(
					"button",
					{
						class: `picker-item${index === activeIndex ? " active" : ""}${option.value === value ? " selected" : ""}`,
						type: "button",
						role: "option",
						onclick: () => choose(option.value),
					},
					h("span", { class: "picker-item-name", title: option.value ?? "" }, option.label),
					option.meta ? h("span", { class: "picker-item-meta" }, option.meta) : null,
				),
			);
		});
	};

	const onDocClick = (event) => {
		if (!root.contains(event.target)) close();
	};
	const open = () => {
		pop.hidden = false;
		button.setAttribute("aria-expanded", "true");
		search.value = "";
		activeIndex = Math.max(0, options.findIndex((option) => option.value === value));
		renderList();
		search.focus();
		document.addEventListener("click", onDocClick);
	};
	const close = () => {
		pop.hidden = true;
		button.setAttribute("aria-expanded", "false");
		document.removeEventListener("click", onDocClick);
	};
	const choose = (next) => {
		close();
		if (next !== value) {
			value = next;
			renderButton();
			onChange(next);
		}
	};

	button.onclick = () => (pop.hidden ? open() : close());
	search.oninput = () => {
		activeIndex = 0;
		renderList();
	};
	pop.onkeydown = (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
			renderList();
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			renderList();
		} else if (event.key === "Enter") {
			event.preventDefault();
			const option = filtered[activeIndex];
			if (option) choose(option.value);
		} else if (event.key === "Escape") {
			event.preventDefault();
			close();
			button.focus();
		}
	};

	pop.append(search, list);
	root.append(button, pop);
	renderButton();
	return root;
}

// ------------------------------------------------------------------ collapsible

/**
 * Collapsible section. The header stays visible (with an optional badge that
 * summarises its contents, so a collapsed section still tells you whether it is
 * worth opening); the body toggles and the state persists per section.
 */
export function collapsible({ id, title, sub = null, badge = null, open = false, body }) {
	const key = `observatory-collapse-${id}`;
	let expanded = open;
	try {
		const stored = localStorage.getItem(key);
		if (stored != null) expanded = stored === "1";
	} catch (err) {
		// Private mode or storage disabled: fall back to the default state.
		console.error("cannot read collapse state", err);
	}
	const bodyNode = h("div", { class: "collapse-body", hidden: !expanded }, body);
	const caret = h("span", { class: "collapse-caret", "aria-hidden": "true" }, "\u25b8");
	const head = h(
		"button",
		{ class: "collapse-head", type: "button", "aria-expanded": String(expanded) },
		h("h3", {}, title),
		badge,
		sub ? h("span", { class: "sub" }, sub) : null,
		caret,
	);
	const root = h("section", { class: `collapse${expanded ? " open" : ""}` }, head, bodyNode);
	head.onclick = () => {
		expanded = !expanded;
		bodyNode.hidden = !expanded;
		root.classList.toggle("open", expanded);
		head.setAttribute("aria-expanded", String(expanded));
		try {
			localStorage.setItem(key, expanded ? "1" : "0");
		} catch (err) {
			console.error("cannot persist collapse state", err);
		}
	};
	return root;
}

// ------------------------------------------------------------------ help

/**
 * "What is this?" drawer. Every metric can carry `help` so the dashboard
 * explains itself: meaning, formula, where the raw data lives, what to do.
 */
export function openHelpDrawer({ title, what, formula, source, action }) {
	const body = h(
		"div",
		{},
		h("p", { style: { marginTop: 0, lineHeight: "1.6" } }, what),
		kv([
			["Computed from", formula],
			["Raw data", source],
			["Lever", action],
		]),
	);
	openDrawer({ title, sub: "metric guide", body });
}

export function helpButton(help) {
	return h(
		"button",
		{
			class: "btn icon help",
			"aria-label": `About ${help.title ?? "this metric"}`,
			title: "What is this?",
			onclick: (event) => {
				event.stopPropagation();
				openHelpDrawer(help);
			},
		},
		"?",
	);
}

// ------------------------------------------------------------------ table

/**
 * Table with keyed in-place patching. `node.patch(rows)` reconciles by key:
 * existing rows keep their DOM (hover, focus), new rows animate in, gone rows
 * are removed — no full rebuild, no scroll jump.
 */
export function table({ columns, rows = [], onRowClick = null, empty = "No rows", maxHeight = null }) {
	const tbody = h("tbody");
	const tableEl = h(
		"table",
		{ class: "tbl" },
		h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", { class: c.right ? "right" : null, style: c.width ? { width: c.width } : null }, c.label)))),
		tbody,
	);
	const wrap = h("div", { class: "tablewrap", style: maxHeight ? { maxHeight } : null }, tableEl);
	let emptyMode = false;

	function buildCells(row) {
		return columns.map((column) => {
			const cell = h("td", { class: column.right ? "right" : null });
			const value = column.render ? column.render(row) : row[column.key];
			if (value instanceof Node) cell.appendChild(value);
			else if (value !== undefined && value !== null && value !== "") cell.textContent = String(value);
			else cell.textContent = "—";
			return cell;
		});
	}

	function bindRow(tr, row) {
		if (!onRowClick) return;
		// Keyboard parity: rows are reachable and activatable, not just clickable.
		tr.tabIndex = 0;
		tr.setAttribute("role", "button");
		tr.onclick = () => onRowClick(row);
		tr.onkeydown = (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				onRowClick(row);
			}
		};
	}

	function buildRow(row, key, isNew) {
		const tr = h("tr", { class: `${onRowClick ? "clickable" : ""}${isNew ? " row-new" : ""}`.trim() || null, dataset: { key } });
		bindRow(tr, row);
		tr.append(...buildCells(row));
		return tr;
	}

	function patch(nextRows) {
		withScrollAnchor(tbody, () => {
			if (!nextRows.length) {
				if (!emptyMode) {
					emptyMode = true;
					wrap.replaceChildren(emptyState(empty));
				}
				return;
			}
			if (emptyMode) {
				emptyMode = false;
				wrap.replaceChildren(tableEl);
			}
			const existing = new Map();
			for (const tr of [...tbody.children]) existing.set(tr.dataset.key, tr);
			const seen = new Set();
			let anchor = null;
			for (const [index, row] of nextRows.entries()) {
				const key = keyOfRow(row, index);
				seen.add(key);
				let tr = existing.get(key);
				if (tr) {
					tr.replaceChildren(...buildCells(row));
					bindRow(tr, row);
				} else {
					tr = buildRow(row, key, true);
				}
				if (anchor === null) {
					if (tbody.firstChild !== tr) tbody.insertBefore(tr, tbody.firstChild);
				} else if (anchor.nextSibling !== tr) {
					tbody.insertBefore(tr, anchor.nextSibling);
				}
				anchor = tr;
			}
			for (const [key, tr] of existing) if (!seen.has(key)) tr.remove();
		});
	}

	patch(rows);
	wrap.patch = patch;
	return wrap;
}

// ------------------------------------------------------------------ feed

/** Activity feed with keyed in-place patching. `node.patch(items)` reconciles. */
export function feed(items = [], { clock, keyOf = keyOfRow } = {}) {
	const container = h("div", { class: "feed" });
	let emptyMode = false;

	function bindItem(node, item) {
		if (!item.onClick) return;
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.style.cursor = "pointer";
		node.onclick = () => item.onClick(item);
		node.onkeydown = (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				item.onClick(item);
			}
		};
	}

	function buildItem(item, key, isNew) {
		const node = h(
			"div",
			{ class: `item${isNew ? " row-new" : ""}`, dataset: { key } },
			h("div", { class: "t" }, clock(item.ts)),
			h("div", { class: `dot ${item.tone ?? "info"}` }),
			h("div", {}, h("div", { class: "title" }, item.title), item.sub ? h("div", { class: "sub" }, item.sub) : null),
			item.right ?? h("div"),
		);
		bindItem(node, item);
		return node;
	}

	function patch(nextItems) {
		withScrollAnchor(container, () => {
			if (!nextItems.length) {
				if (!emptyMode) {
					emptyMode = true;
					container.replaceChildren(emptyState("Nothing here yet"));
				}
				return;
			}
			if (emptyMode) {
				emptyMode = false;
				container.replaceChildren();
			}
			const existing = new Map();
			for (const node of [...container.children]) {
				if (node instanceof HTMLElement && node.dataset.key) existing.set(node.dataset.key, node);
			}
			for (const node of [...container.children]) if (node instanceof HTMLElement && !node.dataset.key) node.remove();
			const seen = new Set();
			let anchor = null;
			for (const [index, item] of nextItems.entries()) {
				const key = String(keyOf(item, index));
				seen.add(key);
				let node = existing.get(key);
				if (node) {
					node.replaceChildren(h("div", { class: "t" }, clock(item.ts)), h("div", { class: `dot ${item.tone ?? "info"}` }), h("div", {}, h("div", { class: "title" }, item.title), item.sub ? h("div", { class: "sub" }, item.sub) : null), item.right ?? h("div"));
					bindItem(node, item);
				} else {
					node = buildItem(item, key, true);
				}
				if (anchor === null) {
					if (container.firstChild !== node) container.insertBefore(node, container.firstChild);
				} else if (anchor.nextSibling !== node) {
					container.insertBefore(node, anchor.nextSibling);
				}
				anchor = node;
			}
			for (const [key, node] of existing) if (!seen.has(key)) node.remove();
		});
	}

	patch(items);
	container.patch = patch;
	return container;
}

// ------------------------------------------------------------------ quality

/**
 * Colour-coded quality scorecard. `value` is a 0..1 ratio (null → unknown);
 * `display` overrides the big number for counts.
 */
export function meter({ label, value, display = null, tone = "neutral", detail = null, tip = null, help = null }) {
	const ratio = value == null ? null : Math.max(0, Math.min(1, value));
	const node = h(
		"div",
		{ class: `card meter ${tone}` },
		h("div", { class: "meter-head" }, h("div", { class: "meter-label" }, label), help ? helpButton(help) : null),
		h("div", { class: "meter-value" }, display ?? (ratio == null ? "—" : `${Math.round(ratio * 100)}%`)),
		h("div", { class: "meter-track" }, h("div", { class: "meter-fill", style: { width: `${ratio == null ? 0 : ratio * 100}%` } })),
		detail ? h("div", { class: "meter-detail" }, detail) : null,
	);
	if (tip) node.dataset.tip = tip;
	return node;
}

/** Green ≥ `good`, amber ≥ `watch`, red below. `invert` for rates where lower is better. */
export function qualityTone(rate, { good = 0.9, watch = 0.7, invert = false } = {}) {
	if (rate == null) return "neutral";
	const value = invert ? 1 - rate : rate;
	if (value >= good) return "ok";
	if (value >= watch) return "warn";
	return "error";
}
