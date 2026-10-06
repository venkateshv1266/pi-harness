/**
 * Tiered pressure response for the context curator. Pure functions, no pi
 * imports — node --test exercises them without the extension runtime.
 *
 * Pressure tiers (evaluated high to low, first match wins; assumes
 * softFloorPct < contextFloorPct < criticalPct):
 *   >= criticalPct      critical — stub gate 0.7, truncate 0.5, batch floor 0
 *   >= contextFloorPct  floor    — truncate gate 0.5
 *   >= softFloorPct     soft     — truncate 0.5, batch floor / 3
 *   else                normal   — defaults
 *
 * Auto-compact concurrency contract:
 * - turn_end runs once per turn and pi awaits it: one decision per boundary,
 *   no concurrent callers of the trigger site.
 * - `inFlight` is the only waiter state; ctx.compact() is fire-and-forget and
 *   no promise is shared. session_before_compact also raises inFlight so a
 *   pi-initiated compaction (threshold/overflow/manual) blocks a stacked
 *   extension trigger.
 * - failed attempt (session_compact_failed) lowers inFlight and starts a
 *   cooldown of N turns relative to the last boundary; a later retry is a
 *   fresh boundary decision, never a shared rejected promise.
 * - success (session_compact) lowers inFlight, clears the cooldown, and
 *   resets pct history — post-compaction usage is incomparable and stale
 *   samples would fake a rising slope.
 * - JEVCURATOR=0 or autoCompactPct<=0 disables triggering entirely.
 */

export type PressureTier = "normal" | "soft" | "floor" | "critical";

export interface PressureThresholds {
	stubProb: number;
	truncProb: number;
	minBatchSaved: number;
	softFloorPct: number;
	contextFloorPct: number;
	criticalPct: number;
}

export interface Gates {
	stub: number;
	trunc: number;
	floor: number;
	tier: PressureTier;
}

export function resolveGates(pct: number, t: PressureThresholds): Gates {
	const gates: Gates = { stub: t.stubProb, trunc: t.truncProb, floor: t.minBatchSaved, tier: "normal" };
	if (pct >= t.criticalPct) {
		// critical: selective truncation beats a lossy full compaction
		gates.tier = "critical";
		gates.stub = Math.min(gates.stub, 0.7);
		gates.trunc = Math.min(gates.trunc, 0.5);
		gates.floor = 0;
	} else if (pct >= t.contextFloorPct) {
		gates.tier = "floor";
		gates.trunc = Math.min(gates.trunc, 0.5);
	} else if (pct >= t.softFloorPct) {
		// soft: prune early, but keep some emission batching — a 1/3 floor
		// avoids one-item emits whose cache-reset cost outweighs the savings
		gates.tier = "soft";
		gates.trunc = Math.min(gates.trunc, 0.5);
		gates.floor = Math.ceil(t.minBatchSaved / 3);
	}
	return gates;
}

export type AutoCompactReason = "level" | "slope";

export interface AutoCompactState {
	inFlight: boolean;
	cooldownUntilTurn: number;
	turnIndex: number;
}

export interface AutoCompactThresholds {
	autoCompactPct: number;
	autoCompactRiseTurns: number;
	criticalPct: number;
}

// minimum per-boundary rise (percentage points) that counts as climbing
const MIN_RISE_PCT = 0.5;

/**
 * Decide whether this boundary should auto-trigger compaction. `history` must
 * already include the current pct as its newest sample.
 */
export function autoCompactDecision(
	pct: number,
	history: number[],
	state: AutoCompactState,
	t: AutoCompactThresholds,
): AutoCompactReason | null {
	if (t.autoCompactPct <= 0) return null;
	if (state.inFlight) return null;
	if (state.turnIndex < state.cooldownUntilTurn) return null;
	if (pct >= t.autoCompactPct) return "level";
	// slope: still climbing after riseTurns consecutive boundaries in the
	// critical tier — selective pruning cannot keep pace
	if (pct < t.criticalPct) return null;
	const need = t.autoCompactRiseTurns + 1;
	if (history.length < need) return null;
	const recent = history.slice(history.length - need);
	for (let i = 1; i < recent.length; i++) {
		if (recent[i] - recent[i - 1] < MIN_RISE_PCT) return null;
	}
	return "slope";
}

/** Append a usage sample, keeping the array capped at `cap` entries. */
export function pushPctSample(history: number[], pct: number, cap: number): number[] {
	const next = [...history, pct];
	return next.length > cap ? next.slice(next.length - cap) : next;
}
