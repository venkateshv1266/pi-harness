import * as fs from "node:fs";
import { DEFAULT_CONFIG_PATH } from "../config.js";

export const FREESTYLE_FALLBACK_MAX_CHARS = 50_000;

export interface JevStaleConfig {
	enabled: boolean;
	ageDays: number;
	referencedDays: number;
	threshold: number;
}

export interface JevConfig {
	enabled: boolean;
	admission: { enabled: boolean; threshold: number };
	admissionWeights: [number, number, number, number];
	pregate: { enabled: boolean; threshold: number };
	correction: { enabled: boolean };
	rerank: { enabled: boolean; topK: number; floor: number };
	consolidation: { enabled: boolean; intervalWrites: number; freestyleFallbackMaxChars: number; stale: JevStaleConfig };
	audit: { enabled: boolean };
}

export const DEFAULT_JEV_STALE_CONFIG: JevStaleConfig = { enabled: true, ageDays: 30, referencedDays: 30, threshold: 0.85 };

export const DEFAULT_JEV_CONFIG: JevConfig = {
	enabled: true,
	admission: { enabled: true, threshold: 0.6 },
	admissionWeights: [0.4, 0.3, 0.3, 0.2],
	pregate: { enabled: true, threshold: 0.55 },
	correction: { enabled: true },
	rerank: { enabled: true, topK: 30, floor: 0.35 },
	consolidation: { enabled: true, intervalWrites: 20, freestyleFallbackMaxChars: FREESTYLE_FALLBACK_MAX_CHARS, stale: DEFAULT_JEV_STALE_CONFIG },
	audit: { enabled: true },
};

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

/** Resolves the optional `jev` section of ~/.pi/agent/jev-memory-config.json.
 * Missing file or section = defaults = enabled. Unknown fields are ignored;
 * invalid values keep the default for that field. JEVM_JEV=0 stays a
 * client-side kill switch (jevCall returns null → all gates fail open). */
export function resolveJevConfig(configPath = DEFAULT_CONFIG_PATH): JevConfig {
	const config: JevConfig = {
		enabled: DEFAULT_JEV_CONFIG.enabled,
		admission: { ...DEFAULT_JEV_CONFIG.admission },
		admissionWeights: [...DEFAULT_JEV_CONFIG.admissionWeights],
		pregate: { ...DEFAULT_JEV_CONFIG.pregate },
		correction: { ...DEFAULT_JEV_CONFIG.correction },
		rerank: { ...DEFAULT_JEV_CONFIG.rerank },
		consolidation: { ...DEFAULT_JEV_CONFIG.consolidation, stale: { ...DEFAULT_JEV_CONFIG.consolidation.stale } },
		audit: { ...DEFAULT_JEV_CONFIG.audit },
	};
	try {
		if (!fs.existsSync(configPath)) return config;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		const section = parsed.jev;
		if (typeof section !== "object" || section === null) return config;
		const jev = section as Record<string, unknown>;

		if (isBoolean(jev.enabled)) config.enabled = jev.enabled;

		if (typeof jev.admission === "object" && jev.admission !== null) {
			const admission = jev.admission as Record<string, unknown>;
			if (isBoolean(admission.enabled)) config.admission.enabled = admission.enabled;
			if (isFiniteNumber(admission.threshold)) config.admission.threshold = admission.threshold;
		}
		if (
			Array.isArray(jev.admissionWeights)
			&& jev.admissionWeights.length === 4
			&& jev.admissionWeights.every(isFiniteNumber)
			// The score divides by w0+w1+w2; a zero sum would turn every answer into NaN.
			&& (jev.admissionWeights[0]! + jev.admissionWeights[1]! + jev.admissionWeights[2]!) > 0
		) {
			config.admissionWeights = [...jev.admissionWeights] as [number, number, number, number];
		}

		if (typeof jev.pregate === "object" && jev.pregate !== null) {
			const pregate = jev.pregate as Record<string, unknown>;
			if (isBoolean(pregate.enabled)) config.pregate.enabled = pregate.enabled;
			if (isFiniteNumber(pregate.threshold)) config.pregate.threshold = pregate.threshold;
		}

		if (typeof jev.correction === "object" && jev.correction !== null) {
			const correction = jev.correction as Record<string, unknown>;
			if (isBoolean(correction.enabled)) config.correction.enabled = correction.enabled;
		}

		if (typeof jev.rerank === "object" && jev.rerank !== null) {
			const rerank = jev.rerank as Record<string, unknown>;
			if (isBoolean(rerank.enabled)) config.rerank.enabled = rerank.enabled;
			if (isFiniteNumber(rerank.topK) && rerank.topK >= 1) config.rerank.topK = Math.floor(rerank.topK);
			if (isFiniteNumber(rerank.floor)) config.rerank.floor = rerank.floor;
		}

		if (typeof jev.consolidation === "object" && jev.consolidation !== null) {
			const consolidation = jev.consolidation as Record<string, unknown>;
			if (isBoolean(consolidation.enabled)) config.consolidation.enabled = consolidation.enabled;
			if (isFiniteNumber(consolidation.intervalWrites) && consolidation.intervalWrites >= 1) {
				config.consolidation.intervalWrites = Math.floor(consolidation.intervalWrites);
			}
			if (isFiniteNumber(consolidation.freestyleFallbackMaxChars) && consolidation.freestyleFallbackMaxChars >= 0) {
				config.consolidation.freestyleFallbackMaxChars = Math.floor(consolidation.freestyleFallbackMaxChars);
			}
			if (typeof consolidation.stale === "object" && consolidation.stale !== null) {
				const stale = consolidation.stale as Record<string, unknown>;
				if (isBoolean(stale.enabled)) config.consolidation.stale.enabled = stale.enabled;
				if (isFiniteNumber(stale.ageDays) && stale.ageDays >= 0) config.consolidation.stale.ageDays = Math.floor(stale.ageDays);
				if (isFiniteNumber(stale.referencedDays) && stale.referencedDays >= 0) config.consolidation.stale.referencedDays = Math.floor(stale.referencedDays);
				if (isFiniteNumber(stale.threshold)) config.consolidation.stale.threshold = stale.threshold;
			}
		}

		if (typeof jev.audit === "object" && jev.audit !== null) {
			const audit = jev.audit as Record<string, unknown>;
			if (isBoolean(audit.enabled)) config.audit.enabled = audit.enabled;
		}
	} catch {
		// Fall back to defaults on read or parse errors.
		return config;
	}
	return config;
}
