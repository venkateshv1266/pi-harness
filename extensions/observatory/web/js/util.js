// Shared helpers: DOM building, formatting, API access, overlays.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Hyperscript: h("div", {class: "x"}, "text", childNode) */
export function h(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value === null || value === undefined || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key === "html") node.innerHTML = value;
		else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
		else if (key in node) node[key] = value;
		else node.setAttribute(key, value);
	}
	append(node, children);
	return node;
}

function append(node, children) {
	for (const child of children.flat(4)) {
		if (child === null || child === undefined || child === false) continue;
		node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

export function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
	return node;
}

// ------------------------------------------------------------------ formatting

export function fmtInt(value) {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	return Number(value).toLocaleString("en-US");
}

export function fmtCompact(value) {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(Math.round(value));
}

export function fmtCost(value) {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	if (value === 0) return "$0";
	if (Math.abs(value) >= 100) return `$${value.toFixed(0)}`;
	if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
	if (Math.abs(value) >= 0.01) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(5)}`;
}

export function fmtPct(value, digits = 0) {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	return `${(value * 100).toFixed(digits)}%`;
}

export function fmtMs(value) {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
	return `${Math.round(value)}ms`;
}

export function fmtClock(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDateTime(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	return d.toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeAgo(iso) {
	if (!iso) return "—";
	const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
	if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
}

export function shortDate(label) {
	if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
		const [, month, day] = label.split("-");
		return `${month}/${day}`;
	}
	return label;
}

const SERIES = [
	"var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)",
	"var(--s9)", "var(--s10)", "var(--s11)", "var(--s12)", "var(--s13)", "var(--s14)", "var(--s15)", "var(--s16)",
];
export function seriesColor(index) {
	return SERIES[index % SERIES.length];
}

export function toneForSeverity(severity) {
	if (severity === "error") return "error";
	if (severity === "warn") return "warn";
	if (severity === "ok") return "ok";
	return "neutral";
}

export function toneForVerdict(verdict) {
	if (!verdict) return "neutral";
	if (["good", "allowed", "on_track", "goal_met", "useExtract", "indexOnly", "applied", "armned", "armed"].includes(verdict)) return "ok";
	if (["bad", "blocked", "off_track", "degraded", "user_corrected", "repeated"].includes(verdict)) return "error";
	if (["flagged", "confirmed", "retainFull", "unresolved", "retried", "suppressed"].includes(verdict)) return "warn";
	return "neutral";
}

// ------------------------------------------------------------------ api

export async function api(path, params = {}) {
	const url = new URL(path, window.location.origin);
	for (const [key, value] of Object.entries(params)) {
		if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
	}
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
	return res.json();
}

export async function post(path) {
	const res = await fetch(new URL(path, window.location.origin), { method: "POST" });
	if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
	return res.json();
}

// ------------------------------------------------------------------ overlays

let toastTimer = null;
export function toast(message, tone = "neutral") {
	const node = document.getElementById("toast");
	if (!node) return;
	node.textContent = message;
	node.className = `toast ${tone}`;
	node.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		node.hidden = true;
	}, 3800);
}

let activeDrawerClose = null;

export function openDrawer({ title, sub, body }) {
	const overlay = document.getElementById("overlay");
	if (!overlay) return;
	clear(overlay);

	const onKeyDown = (event) => {
		if (event.key === "Escape") close();
	};
	const close = () => {
		overlay.hidden = true;
		clear(overlay);
		document.removeEventListener("keydown", onKeyDown);
		if (activeDrawerClose === close) activeDrawerClose = null;
	};

	const panel = h(
		"div",
		{ class: "drawer-panel", role: "dialog", "aria-modal": "true", "aria-label": title ?? "Details" },
		h(
			"div",
			{ class: "dhead" },
			h("h3", {}, title),
			sub ? h("span", { class: "small muted" }, sub) : null,
			h("div", { class: "grow" }),
			h("button", { class: "btn icon", "aria-label": "Close", onclick: close }, "✕"),
		),
		h("div", { class: "dbody" }, body),
	);

	// append() accepts multiple nodes; appendChild() silently ignores all but the first.
	overlay.append(h("div", { class: "scrim", onclick: close }), panel);
	overlay.hidden = false;
	activeDrawerClose = close;
	panel.querySelector("button")?.focus();
	document.addEventListener("keydown", onKeyDown);
}

export function closeDrawer() {
	if (activeDrawerClose) activeDrawerClose();
}

export function debounce(fn, ms = 250) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

// Global tooltip for [data-tip] elements.
export function wireTooltips() {
	const tip = document.getElementById("tooltip");
	let raf = 0;
	document.addEventListener("mousemove", (event) => {
		const target = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
		if (!target) {
			tip.hidden = true;
			return;
		}
		tip.textContent = target.getAttribute("data-tip");
		tip.hidden = false;
		const pad = 14;
		const rect = tip.getBoundingClientRect();
		const x = Math.min(event.clientX + pad, window.innerWidth - rect.width - 8);
		const y = Math.max(8, event.clientY - rect.height - 10);
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(() => {
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		});
	});
	document.addEventListener("mouseleave", () => {
		tip.hidden = true;
	});
}
