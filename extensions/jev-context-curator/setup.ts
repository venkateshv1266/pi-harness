/**
 * /setup → "Jev curator": the master switch, mode, and verifier model,
 * persisted to settings.json `jevCurator`. All other knobs stay
 * env/defaults-only and are documented in the extension README.
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
			const parsed: boolean | string = spec.kind === "toggle" ? value === "on" : value;
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
			"Master switch, mode, and verifier model, saved to settings.json (jevCurator). JEVCURATOR=0 in the environment forces curation off; the other tuning knobs stay env-only.",
		items: CURATOR_SETTING_SPECS.map(item),
	};
}
