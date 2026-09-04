import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const getSettings = (): Record<string, any> => {
	try {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		if (fs.existsSync(settingsPath)) {
			return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		}
	} catch (err) {
		// expected: settings.json may be absent or unreadable; role resolution falls back to defaults
		process.stderr.write(`[model-role] failed to read settings.json: ${err}\n`);
	}
	return {};
};

export function resolveModelRole(modelSpec?: string): { resolvedModel?: string; role?: string } {
	if (!modelSpec) return {};
	const clean = modelSpec.trim();
	if (!clean) return {};

	const isRole = clean.startsWith("@");
	const roleName = isRole ? clean.slice(1).toLowerCase() : null;

	if (roleName) {
		const settings = getSettings();
		let resolved: string | undefined;
		if (roleName === "smol" || roleName === "fast") {
			resolved =
				process.env.PI_SMOL_MODEL ||
				process.env.PI_FAST_MODEL ||
				settings.smolModel ||
				settings.fastModel ||
				settings.modelRoles?.smol ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "slow" || roleName === "reasoning") {
			resolved =
				process.env.PI_SLOW_MODEL ||
				process.env.PI_REASONING_MODEL ||
				settings.slowModel ||
				settings.reasoningModel ||
				settings.modelRoles?.slow ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "plan") {
			resolved =
				process.env.PI_PLAN_MODEL ||
				process.env.PI_SLOW_MODEL ||
				settings.planModel ||
				settings.slowModel ||
				settings.modelRoles?.plan ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "task") {
			resolved =
				process.env.PI_TASK_MODEL ||
				settings.taskModel ||
				settings.modelRoles?.task ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else if (roleName === "designer") {
			resolved =
				process.env.PI_DESIGNER_MODEL ||
				settings.designerModel ||
				settings.modelRoles?.designer ||
				process.env.PI_MODEL ||
				settings.defaultModel;
		} else {
			resolved = process.env.PI_MODEL || settings.defaultModel;
		}
		return { resolvedModel: resolved, role: `@${roleName}` };
	}

	return { resolvedModel: clean };
}

/** Splits "provider/model:thinking" → provider + id + optional thinking level. */
export const parseModelRef = (ref: string): { provider?: string; modelId: string; thinking?: string } => {
	const colon = ref.lastIndexOf(":");
	const thinking = colon > 0 ? ref.slice(colon + 1) : undefined;
	const base = thinking !== undefined ? ref.slice(0, colon) : ref;
	const slash = base.indexOf("/");
	if (slash > 0) {
		return { provider: base.slice(0, slash), modelId: base.slice(slash + 1), thinking };
	}
	return { modelId: base, thinking };
};
