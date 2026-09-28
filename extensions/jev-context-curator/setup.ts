/**
 * /setup → "Jev curator": every curator knob, persisted to settings.json
 * `jevCurator` so it can be edited without touching the environment.
 */
import type { SetupItem, SetupSection } from "../setup/types.ts";
import {
	CURATOR_SETTING_SPECS,
	curatorEnabled,
	resolveCuratorConfig,
	updateCuratorSettings,
	type CuratorSettingSpec,
} from "./settings.ts";

const CLEAR = "__remove";

function display(spec: CuratorSettingSpec): string {
	const config = resolveCuratorConfig();
	const value = config[spec.key];
	if (spec.kind === "toggle") return curatorEnabled(config) ? "on" : "off";
	if (spec.kind === "model") return typeof value === "string" && value ? value : "(session model)";
	return String(value);
}

function item(spec: CuratorSettingSpec): SetupItem {
	return {
		id: `curator:${spec.key}`,
		label: spec.label,
		detail: spec.detail,
		effect: spec.key === "verifierModel" ? "immediately" : "next /reload or session",
		owner: `jev-context-curator · env ${spec.env}`,
		kind: spec.kind,
		options: spec.options,
		min: spec.min,
		max: spec.max,
		withThinking: spec.kind === "model",
		removable: spec.kind === "model",
		get: () => display(spec),
		apply: (_ctx, value) => {
			if (value === CLEAR) {
				updateCuratorSettings((settings) => {
					delete settings[spec.key];
				});
				return `${spec.label} cleared — env/default applies`;
			}
			let parsed: number | boolean | string = value;
			if (spec.kind === "number") {
				const n = Number(value);
				if (!Number.isFinite(n)) return `✗ not a number: ${value}`;
				parsed = n;
			} else if (spec.kind === "toggle") {
				parsed = value === "on";
			}
			updateCuratorSettings((settings) => {
				settings[spec.key] = parsed;
			});
			return `${spec.label} → ${value}`;
		},
	};
}

export default function curatorSetup(): SetupSection {
	return {
		id: "jev-curator",
		title: "Jev curator",
		detail:
			"Context-curation gates and the verifier model. Saved to settings.json (jevCurator); JEVCURATOR_* env vars act as fallbacks and JEVCURATOR=0 forces curation off.",
		items: CURATOR_SETTING_SPECS.map(item),
	};
}
