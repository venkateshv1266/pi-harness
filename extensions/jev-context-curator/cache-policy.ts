export type Representation = "retainFull" | "useExtract" | "indexOnly" | "cap";

export interface EmissionCandidate {
	entryId: string;
	currentChars?: number;
	replacementChars: number;
	fresh: boolean;
	turn: number;
}

export interface EmissionPolicy {
	percent?: number;
	softFloorPct: number;
	batchFloor: number;
	maxHoldTurns: number;
	turnIndex: number;
}

export type EmissionAction = "emit" | "not-visible" | "not-smaller" | "defer-pressure" | "defer-batch";

export interface EmissionDecision {
	entryId: string;
	action: EmissionAction;
	saved: number;
}

export function planEmissions(candidates: readonly EmissionCandidate[], policy: EmissionPolicy): EmissionDecision[] {
	const decisions = candidates.map((c): EmissionDecision => {
		if (c.currentChars === undefined || !Number.isFinite(c.currentChars) || c.currentChars < 0) {
			return { entryId: c.entryId, action: "not-visible", saved: 0 };
		}
		const saved = c.currentChars - c.replacementChars;
		if (!Number.isFinite(saved) || c.replacementChars < 0 || saved < Math.max(500, c.currentChars * 0.2)) {
			return { entryId: c.entryId, action: "not-smaller", saved: 0 };
		}
		return { entryId: c.entryId, action: "emit", saved };
	});
	const historical = decisions.filter((d, i) => d.action === "emit" && !candidates[i].fresh);
	const underPressure = policy.percent !== undefined && Number.isFinite(policy.percent) && policy.percent >= policy.softFloorPct;
	const saved = historical.reduce((sum, d) => sum + d.saved, 0);
	const aged = candidates.some((c, i) => !c.fresh && decisions[i].action === "emit" && policy.turnIndex - c.turn >= policy.maxHoldTurns);
	for (let i = 0; i < decisions.length; i++) {
		const d = decisions[i];
		if (d.action !== "emit" || candidates[i].fresh) continue;
		if (!underPressure) d.action = "defer-pressure";
		else if (saved < policy.batchFloor && !aged) d.action = "defer-batch";
	}
	return decisions;
}

export function representationAfterEmission(
	previous: Representation | null,
	proposed: Exclude<Representation, "cap">,
	emitted: boolean,
	capped: boolean,
): Representation {
	if (capped) return "cap";
	return emitted ? proposed : previous ?? "retainFull";
}
