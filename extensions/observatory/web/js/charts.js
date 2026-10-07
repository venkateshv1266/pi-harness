// SVG chart primitives. Theme-aware via CSS variables; tooltips via data-tip.
import { esc, fmtCompact, seriesColor, shortDate } from "./util.js";

const VIEW_W = 1000;

export function areaChart({ labels, series, height = 190, stacked = false, valueFmt = fmtCompact }) {
	const n = labels.length;
	if (!n || !series.length) return '<div class="empty">No data in range</div>';
	const padL = 48;
	const padR = 14;
	const padT = 12;
	const padB = 24;
	const iw = VIEW_W - padL - padR;
	const ih = height - padT - padB;
	const x = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
	const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
	const max = Math.max(...(stacked ? totals : series.flatMap((s) => s.values)), 1e-9);
	const y = (v) => padT + ih - (v / max) * ih;

	const grid = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const yy = padT + ih * (1 - f);
			return `<line class="gridline" x1="${padL}" x2="${VIEW_W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" /><text x="${padL - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${esc(valueFmt(max * f))}</text>`;
		})
		.join("");

	const cum = new Array(n).fill(0);
	const paths = series
		.map((s, si) => {
			const top = [];
			let bottom = [];
			for (let i = 0; i < n; i += 1) {
				const base = stacked ? cum[i] : 0;
				const v = s.values[i] ?? 0;
				top.push([x(i), y(base + v)]);
				bottom.push([x(i), y(base)]);
				if (stacked) cum[i] += v;
			}
			const dTop = top.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
			const dBottom = bottom
				.reverse()
				.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)
				.join("");
			const color = seriesColor(si);
			return `<path d="${dTop}${dBottom}Z" fill="${color}" fill-opacity="${stacked ? 0.5 : 0.15}" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" />`;
		})
		.join("");

	const sliceW = n > 1 ? iw / (n - 1) : iw;
	const slices = labels
		.map((label, i) => {
			const tip = [label, ...series.map((s) => `${s.name}: ${valueFmt(s.values[i] ?? 0)}`)].join("\n");
			const start = Math.max(padL, x(i) - sliceW / 2);
			const width = Math.min(sliceW, VIEW_W - padR - start);
			return `<rect x="${start.toFixed(1)}" y="${padT}" width="${width.toFixed(1)}" height="${ih}" fill="transparent" data-tip="${esc(tip)}" />`;
		})
		.join("");

	const ticks = labels
		.map((label, i) => (i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2) ? `<text x="${x(i).toFixed(1)}" y="${height - 7}" text-anchor="middle">${esc(shortDate(label))}</text>` : ""))
		.join("");

	return `<svg class="chart" viewBox="0 0 ${VIEW_W} ${height}" style="width:100%;height:auto" role="img">${grid}${paths}${slices}${ticks}</svg>`;
}

/**
 * Vertical bars, optionally stacked. Same frame as areaChart, for a daily volume
 * where the total for a day is the reading rather than the shape between days.
 */
export function barChart({ labels, series, height = 190, stacked = true, valueFmt = fmtCompact }) {
	const n = labels.length;
	if (!n || !series.length) return '<div class="empty">No data in range</div>';
	const padL = 48;
	const padR = 14;
	const padT = 12;
	const padB = 24;
	const iw = VIEW_W - padL - padR;
	const ih = height - padT - padB;
	const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
	const max = Math.max(...(stacked ? totals : series.flatMap((s) => s.values)), 1e-9);
	const y = (v) => padT + ih - (v / max) * ih;
	const slot = iw / n;
	const barW = Math.max(1.5, Math.min(28, slot * 0.6));

	const grid = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const yy = padT + ih * (1 - f);
			return `<line class="gridline" x1="${padL}" x2="${VIEW_W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" /><text x="${padL - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${esc(valueFmt(max * f))}</text>`;
		})
		.join("");

	const bars = labels
		.map((_, i) => {
			const cx = padL + slot * i + slot / 2;
			let base = 0;
			return series
				.map((s, si) => {
					const v = Math.max(0, s.values[i] ?? 0);
					if (v === 0) return "";
					const yTop = y(stacked ? base + v : v);
					const yBase = y(stacked ? base : 0);
					if (stacked) base += v;
					return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.8, yBase - yTop).toFixed(1)}" rx="1.5" fill="${seriesColor(si)}" fill-opacity="0.8" />`;
				})
				.join("");
		})
		.join("");

	const slices = labels
		.map((label, i) => {
			const tip = [label, ...series.map((s) => `${s.name}: ${valueFmt(s.values[i] ?? 0)}`)].join("\n");
			return `<rect x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${ih}" fill="transparent" data-tip="${esc(tip)}" />`;
		})
		.join("");

	const ticks = labels
		.map((label, i) => (i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2) ? `<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${height - 7}" text-anchor="middle">${esc(shortDate(label))}</text>` : ""))
		.join("");

	return `<svg class="chart" viewBox="0 0 ${VIEW_W} ${height}" style="width:100%;height:auto" role="img">${grid}${bars}${slices}${ticks}</svg>`;
}

export function spark(values, { color = "var(--accent)", height = 30 } = {}) {
	const n = values.length;
	if (!n) return "";
	const max = Math.max(...values, 1e-9);
	const points = values.map((v, i) => `${n === 1 ? 50 : (i / (n - 1)) * 100},${height - 3 - (v / max) * (height - 6)}`).join(" ");
	return `<svg class="chart" viewBox="0 0 100 ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

export function donut({ items, size = 152, thickness = 16, centerLabel = null, valueFmt = fmtCompact }) {
	const total = items.reduce((a, i) => a + i.value, 0);
	if (!total) return '<div class="empty">No data</div>';
	const radius = (size - thickness) / 2;
	const circumference = 2 * Math.PI * radius;
	let offset = 0;
	const arcs = items
		.map((item, index) => {
			const fraction = item.value / total;
			const dash = fraction * circumference;
			const color = item.color ?? seriesColor(index);
			const arc = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})" data-tip="${esc(`${item.label}: ${valueFmt(item.value)} (${(fraction * 100).toFixed(1)}%)`)}" />`;
			offset += dash;
			return arc;
		})
		.join("");
	const center = centerLabel
		? `<text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" style="font-size:16px;font-weight:700;fill:var(--text)">${esc(centerLabel)}</text><text x="${size / 2}" y="${size / 2 + 15}" text-anchor="middle" style="font-size:9px;fill:var(--muted)">total</text>`
		: "";
	return `<svg class="chart" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">${arcs}${center}</svg>`;
}

export function histogram({ bins, height = 120, color = "var(--s5)" }) {
	if (!bins.length) return '<div class="empty">No data</div>';
	const max = Math.max(...bins.map((b) => b.count), 1);
	const barW = VIEW_W / bins.length;
	const bars = bins
		.map((bin, i) => {
			const h = (bin.count / max) * (height - 26);
			return `<rect x="${(i * barW + 6).toFixed(1)}" y="${(height - 22 - h).toFixed(1)}" width="${(barW - 12).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}" fill-opacity="0.75" data-tip="${esc(`${bin.label}: ${bin.count}`)}" /><text x="${(i * barW + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(bin.label)}</text>`;
		})
		.join("");
	return `<svg class="chart" viewBox="0 0 ${VIEW_W} ${height}" style="width:100%;height:auto">${bars}</svg>`;
}

/**
 * Sankey for category→category flows. `nodes` is keyed `column:value` → count,
 * `links` keyed `leftColumn|from|rightColumn|to` → count.
 */
export function sankey({ columns, nodes, links, height = 280 }) {
	const colCount = columns.length;
	if (!colCount) return '<div class="empty">No data</div>';
	// Node labels sit outside their node and are right-anchored on the first
	// column, so both edges need the same room reserved. Placing column 0 at a
	// hardcoded left offset while sizing columns from `padX` pushes the outer
	// labels past the viewBox — and with `.chart` overflow visible, past the card.
	const padX = 150;
	const padY = 8;
	const gap = 8;
	const nodeW = 12;
	const colW = (VIEW_W - padX * 2) / Math.max(1, colCount - 1);

	const valuesFor = (columnId) =>
		Object.entries(nodes)
			.filter(([key]) => key.startsWith(`${columnId}:`))
			.map(([key, count]) => ({ value: key.slice(columnId.length + 1), count }))
			.sort((a, b) => b.count - a.count);

	const layout = columns.map((column, ci) => {
		const items = valuesFor(column.id);
		const total = items.reduce((a, i) => a + i.count, 0) || 1;
		const usable = height - padY * 2 - gap * Math.max(0, items.length - 1);
		let cursor = padY;
		const placed = items.map((item) => {
			const h = Math.max(4, (item.count / total) * usable);
			const box = { ...item, y: cursor, h, x: padX + ci * colW };
			cursor += h + gap;
			return box;
		});
		return { column, placed, byValue: new Map(placed.map((p) => [p.value, p])) };
	});

	const ribbons = [];
	for (let ci = 0; ci < colCount - 1; ci += 1) {
		const left = layout[ci];
		const right = layout[ci + 1];
		const leftIndex = new Map(left.placed.map((p) => [p.value, 0]));
		const rightIndex = new Map(right.placed.map((p) => [p.value, 0]));
		const pairKeys = Object.keys(links).filter((key) => key.startsWith(`${left.column.id}|`));
		for (const key of pairKeys) {
			const [, from, rightColumn, to] = key.split("|");
			if (rightColumn !== right.column.id) continue;
			const count = links[key];
			const fromNode = left.byValue.get(from);
			const toNode = right.byValue.get(to);
			if (!fromNode || !toNode) continue;
			const fromTotal = left.placed.reduce((a, p) => a + p.count, 0) || 1;
			const toTotal = right.placed.reduce((a, p) => a + p.count, 0) || 1;
			const h1 = (count / fromTotal) * fromNode.h;
			const h2 = (count / toTotal) * toNode.h;
			const y1 = fromNode.y + leftIndex.get(from);
			const y2 = toNode.y + rightIndex.get(to);
			leftIndex.set(from, leftIndex.get(from) + h1);
			rightIndex.set(to, rightIndex.get(to) + h2);
			const x1 = fromNode.x + nodeW;
			const x2 = toNode.x;
			const mid = (x1 + x2) / 2;
			const color = seriesColor(ci);
			ribbons.push(
				`<path d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2} L${x2},${y2 + h2} C${mid},${y2 + h2} ${mid},${y1 + h1} ${x1},${y1 + h1} Z" fill="${color}" fill-opacity="0.32" stroke="none" data-tip="${esc(`${from} → ${to}: ${count}`)}" />`,
			);
		}
	}

	const boxes = layout
		.map(({ placed }, ci) =>
			placed
				.map(
					(node) =>
						`<rect x="${node.x}" y="${node.y.toFixed(1)}" width="${nodeW}" height="${node.h.toFixed(1)}" rx="3" fill="${seriesColor(ci)}" data-tip="${esc(`${node.value}: ${node.count}`)}" /><text x="${ci === 0 ? node.x - 6 : node.x + nodeW + 6}" y="${(node.y + node.h / 2 + 3).toFixed(1)}" text-anchor="${ci === 0 ? "end" : "start"}">${esc(`${node.value} (${node.count})`)}</text>`,
				)
				.join(""),
		)
		.join("");

	return `<svg class="chart sankey" viewBox="0 0 ${VIEW_W} ${height}" style="width:100%;height:auto">${ribbons}${boxes}</svg>`;
}
