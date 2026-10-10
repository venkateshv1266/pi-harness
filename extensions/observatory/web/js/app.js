// App shell: hash router, nav rail, topbar, theme, in-place live updates.
//
// Refresh model: pages build their DOM once and register an in-place refresher
// via `ctx.onAutoRefresh`. Ingest events call that refresher — never a page
// rebuild — so nothing flashes, jumps, or loses focus. Tables/feeds patch rows
// by key with scroll anchoring (see ui.js).
import { $, clear, closeDrawer, debounce, fmtInt, h, post, timeAgo, toast, wireTooltips } from "./util.js";
import { PAGES, state } from "./pages.js";

const NAV = [
	{ id: "overview", label: "Overview", icon: "grid" },
	{ id: "impact", label: "Impact", icon: "target" },
	{ id: "models", label: "Models", icon: "cpu" },
	{ id: "router", label: "Router", icon: "split" },
	{ id: "ledger", label: "Jev Ledger", icon: "list" },
	{ id: "curator", label: "Curator", icon: "scissors" },
	{ id: "refine", label: "Refine", icon: "wand" },
	{ id: "tuner", label: "Tuner", icon: "sliders" },
	{ id: "sessions", label: "Sessions", icon: "chat" },
	{ id: "extensions", label: "Extensions", icon: "puzzle" },
	{ id: "health", label: "Health", icon: "pulse" },
];

const ICONS = {
	grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
	target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
	cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
	split: '<path d="M6 4v16M18 4v16M6 12h12"/><circle cx="12" cy="12" r="2.4"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
	scissors: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M20 4 8.6 16.4M20 20 8.6 7.6"/>',
	chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.6A8 8 0 1 1 21 12z"/>',
	puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-6v-3a2 2 0 1 0-4 0v3H5v-7h3a2 2 0 1 0 0-4H5V3h5z"/>',
	pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
	wand: '<path d="M4 20 14 10"/><path d="M15 4l1 2.2 2.2 1-2.2 1L15 10.4l-1-2.2-2.2-1 2.2-1zM19 12l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7zM7 4l.8 1.7L9.5 6.5 7.8 7.3 7 9 6.2 7.3 4.5 6.5l1.7-.8z"/>',
	sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
};

function iconHTML(name) {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.grid}</svg>`;
}

function parseHash() {
	const raw = window.location.hash.replace(/^#\/?/, "") || "overview";
	const [pathPart, queryPart] = raw.split("?");
	const params = Object.fromEntries(new URLSearchParams(queryPart ?? ""));
	return { id: pathPart || "overview", params };
}

let titleNode = null;
let subNode = null;
let liveDot = null;
let livePill = null;
let liveAgo = null;
let chip = null;

let liveEnabled = true;
let pageRefresher = null;
let rendering = false;
let pendingRefresh = false;
let pendingUpdates = 0;
let lastIngestAt = 0;
let lastRoute = null;

const routeScroll = new Map();
const SCROLL_SELECTOR = ".view .tablewrap, .view .feed, .drawer-panel .dbody";

// ------------------------------------------------------------------ nav / topbar

function buildNav() {
	const nav = $("#nav");
	clear(nav);
	nav.appendChild(
		h(
			"div",
			{ class: "brand" },
			h("span", { class: "dot" }),
			h("div", {}, h("h1", {}, "Observatory"), h("span", { class: "tag" }, "pi harness telemetry")),
		),
	);
	for (const item of NAV) {
		nav.appendChild(
			h("a", { class: "navitem", href: `#/${item.id}`, dataset: { route: item.id } }, h("span", { class: "navicon", html: iconHTML(item.icon) }), h("span", { class: "label" }, item.label)),
		);
	}
	nav.appendChild(
		h(
			"div",
			{ class: "navfoot" },
			h("div", {}, h("span", { class: "live-dot" }), "live stream"),
			h("div", { class: "faint" }, "local · read-only"),
			h("div", { class: "faint", style: { marginTop: "6px" } }, "1–9 pages · / search · r refresh"),
		),
	);
	liveDot = nav.querySelector(".live-dot");
}

function setActiveNav(route) {
	for (const link of document.querySelectorAll(".navitem")) {
		link.classList.toggle("active", link.dataset.route === route || (route === "session" && link.dataset.route === "sessions"));
	}
}

function toggleLive() {
	liveEnabled = !liveEnabled;
	pendingRefresh = false;
	hideChip();
	updateLivePill();
	if (liveEnabled) void applyPageRefresh();
}

function updateLivePill() {
	if (!livePill) return;
	clear(livePill);
	livePill.className = `pill live${liveEnabled ? "" : " paused"}`;
	livePill.appendChild(h("span", { class: "beat" }));
	livePill.appendChild(h("span", {}, liveEnabled ? "live" : "paused"));
	livePill.dataset.tip = liveEnabled ? "Auto-updating on every ingest — click to pause" : "Auto-update paused — click to resume";
	livePill.onclick = () => toggleLive();
}

function updateLiveAgo() {
	if (!liveAgo) return;
	liveAgo.textContent = lastIngestAt ? `updated ${timeAgo(new Date(lastIngestAt).toISOString())}` : "waiting for changes";
}

function buildTopbar() {
	const bar = $("#topbar");
	clear(bar);
	titleNode = h("h2", {}, "Overview");
	subNode = h("span", { class: "sub" }, "");
	const rangeSeg = h(
		"div",
		{ class: "seg" },
		...["24h", "7d", "30d", "all"].map((value) =>
			h(
				"button",
				{
					class: state.range === value ? "active" : "",
					onclick: () => {
						state.range = value;
						localStorage.setItem("observatory-range", value);
						for (const button of rangeSeg.querySelectorAll("button")) button.classList.toggle("active", button.textContent === value);
						void render();
					},
				},
				value,
			),
		),
	);
	livePill = h("span", { class: "pill live" });
	liveAgo = h("span", { class: "small faint", style: { minWidth: "118px" } });
	updateLivePill();
	updateLiveAgo();
	bar.append(
		titleNode,
		subNode,
		h("div", { class: "grow" }),
		livePill,
		liveAgo,
		rangeSeg,
		h("button", { class: "btn", onclick: () => void applyPageRefresh(), title: "Reload this page's data" }, "Refresh"),
		h("button", { class: "btn", onclick: () => sync(), title: "Force a full rescan of all pi logs" }, "Rescan"),
		h(
			"button",
			{
				class: "btn icon",
				title: "Toggle theme",
				onclick: () => {
					const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
					document.documentElement.dataset.theme = next;
					localStorage.setItem("observatory-theme", next);
				},
			},
			"◐",
		),
	);
	setInterval(updateLiveAgo, 1000);
}

// ------------------------------------------------------------------ scroll

function isEditing() {
	const active = document.activeElement;
	return active instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
}

function drawerOpen() {
	const overlay = document.getElementById("overlay");
	return overlay instanceof HTMLElement && !overlay.hidden;
}

function scrolledAway() {
	if (window.scrollY > 8) return true;
	for (const element of document.querySelectorAll(SCROLL_SELECTOR)) {
		if (element.scrollTop > 8) return true;
	}
	return false;
}

function captureScroll() {
	const containers = [...document.querySelectorAll(SCROLL_SELECTOR)];
	return { windowY: window.scrollY, inner: containers.map((element, index) => ({ index, top: element.scrollTop })).filter((entry) => entry.top > 0) };
}

function restoreScroll(snapshot) {
	if (!snapshot) return;
	const containers = [...document.querySelectorAll(SCROLL_SELECTOR)];
	for (const entry of snapshot.inner) {
		const element = containers[entry.index];
		if (element) element.scrollTop = entry.top;
	}
	window.scrollTo(0, snapshot.windowY);
}

// ------------------------------------------------------------------ chip

function ensureChip() {
	if (chip) return chip;
	chip = h("button", {
		class: "newdata",
		hidden: true,
		onclick: () => {
			hideChip();
			// Data is already patched in place; this only reveals the newest rows.
			window.scrollTo({ top: 0, behavior: "smooth" });
		},
	});
	document.body.appendChild(chip);
	return chip;
}

function showChip() {
	const node = ensureChip();
	node.hidden = false;
	node.textContent = pendingUpdates > 1 ? `↑ ${pendingUpdates} new — jump to latest` : "↑ new — jump to latest";
}

function hideChip() {
	if (chip) chip.hidden = true;
	pendingUpdates = 0;
}

// ------------------------------------------------------------------ refresh

async function applyPageRefresh() {
	if (!pageRefresher) {
		await render({ preserveScroll: true });
		return;
	}
	try {
		await pageRefresher();
	} catch (err) {
		console.error("in-place refresh failed; falling back to a rebuild", err);
		await render({ preserveScroll: true });
	}
}

const scheduleAutoRefresh = debounce(() => {
	if (!liveEnabled) return;
	if (isEditing() || drawerOpen()) {
		pendingRefresh = true;
		return;
	}
	pendingRefresh = false;
	void applyPageRefresh();
}, 900);

// ------------------------------------------------------------------ render

function replayTransition(view) {
	view.classList.remove("view-enter");
	void view.offsetWidth;
	view.classList.add("view-enter");
}

async function render(opts = {}) {
	if (rendering) {
		pendingRefresh = true;
		return;
	}
	rendering = true;
	pageRefresher = null;
	const snapshot = opts.preserveScroll ? captureScroll() : null;
	hideChip();
	const { id, params } = parseHash();
	const navigating = id !== lastRoute;
	if (navigating && lastRoute) routeScroll.set(lastRoute, window.scrollY);
	if (id === "session" && params.id) state.sessionId = params.id;
	// Deep links from findings/quality: #/ledger?system=ttsr (nav clicks clear it).
	if (id === "ledger") state.ledgerSystem = params.system ? String(params.system) : null;
	if (id === "impact") state.impactModel = params.model ? String(params.model) : null;
	const page = PAGES[id] ?? PAGES.overview;
	const navItem = NAV.find((n) => n.id === id) ?? NAV.find((n) => n.id === "overview");
	titleNode.textContent = navItem?.label ?? "Session";
	subNode.textContent = "";
	setActiveNav(id);
	const view = $("#view");
	const ctx = {
		setStatus: (text) => {
			subNode.textContent = text;
		},
		onAutoRefresh: (fn) => {
			pageRefresher = fn;
		},
		reRender: () => {
			rendering = false;
			void render({ preserveScroll: true });
		},
	};
	try {
		await page(view, ctx);
	} catch (err) {
		clear(view);
		view.appendChild(h("div", { class: "banner error" }, `Failed to load ${id}: ${err instanceof Error ? err.message : String(err)}`));
	} finally {
		rendering = false;
		if (navigating) {
			// Browser-like behavior: returning to a page restores where you were.
			window.scrollTo(0, routeScroll.get(id) ?? 0);
			replayTransition(view);
		} else {
			restoreScroll(snapshot);
		}
		lastRoute = id;
		if (pendingRefresh && !isEditing() && !drawerOpen()) {
			pendingRefresh = false;
			scheduleAutoRefresh();
		}
	}
}

async function sync() {
	try {
		const result = await post("/api/sync?force=1");
		toast(`Rescan done: ${fmtInt(result.events)} events, ${fmtInt(result.calls)} calls in ${result.ms}ms`);
		await applyPageRefresh();
	} catch (err) {
		toast(`Rescan failed: ${err.message}`, "error");
	}
}

// ------------------------------------------------------------------ stream

function connectStream() {
	try {
		const source = new EventSource("/api/stream");
		source.addEventListener("message", (event) => {
			try {
				const data = JSON.parse(event.data);
				if (liveDot) liveDot.classList.add("on");
				if (data.type !== "ingest") return;
				lastIngestAt = Date.now();
				pendingUpdates += 1;
				updateLiveAgo();
				if (isEditing() || drawerOpen()) {
					pendingRefresh = true;
					showChip();
					return;
				}
				scheduleAutoRefresh();
				if (scrolledAway()) showChip();
			} catch (err) {
				console.error("stream message parse failed", err);
			}
		});
		source.addEventListener("error", () => {
			const dot = document.querySelector(".live-dot");
			if (dot) dot.classList.remove("on");
		});
	} catch (err) {
		console.error("cannot open event stream", err);
	}
}

const onScroll = debounce(() => {
	if (pendingRefresh) return;
	if (!scrolledAway()) hideChip();
}, 250);
window.addEventListener("scroll", onScroll, { passive: true, capture: true });

const overlay = document.getElementById("overlay");
if (overlay) {
	new MutationObserver(() => {
		if (overlay.hidden && pendingRefresh) scheduleAutoRefresh();
	}).observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
}
document.addEventListener("focusout", () => {
	if (pendingRefresh && !isEditing() && !drawerOpen()) scheduleAutoRefresh();
});

// ------------------------------------------------------------------ keyboard

document.addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey || event.key === "Escape") return;
	if (isEditing()) return;
	if (event.key === "/") {
		const input = document.querySelector("#view input.input");
		if (input) {
			event.preventDefault();
			input.focus();
		}
		return;
	}
	if (event.key === "r") {
		event.preventDefault();
		void applyPageRefresh();
		return;
	}
	if (event.key === "p") {
		event.preventDefault();
		toggleLive();
		return;
	}
	const index = Number(event.key);
	if (Number.isInteger(index) && index >= 1 && index <= Math.min(9, NAV.length)) {
		event.preventDefault();
		window.location.hash = `#/${NAV[index - 1].id}`;
		return;
	}
	if (event.key === "0" && NAV.length >= 10) {
		event.preventDefault();
		window.location.hash = `#/${NAV[9].id}`;
	}
});

window.addEventListener("hashchange", () => {
	// A link inside the drawer (e.g. session) navigates; don't leave it open over the new page.
	closeDrawer();
	void render();
});

wireTooltips();
buildNav();
buildTopbar();
void render();
connectStream();
