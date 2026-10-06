/**
 * Paths and runtime configuration for the Observatory server.
 * Everything is derived from the pi agent dir; no machine-specific paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { log } from "./log";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

export function observatoryDir(): string {
	const dir = path.join(agentDir(), "observatory");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function serverRoot(): string {
	return path.dirname(new URL(import.meta.url).pathname);
}

export function webDir(): string {
	return path.join(serverRoot(), "..", "web");
}

export interface ObservatoryConfig {
	port: number;
	host: string;
	openBrowser: boolean;
}

const DEFAULTS: ObservatoryConfig = { port: 4747, host: "127.0.0.1", openBrowser: true };

export function loadConfig(): ObservatoryConfig {
	const file = path.join(observatoryDir(), "config.json");
	let disk: Partial<ObservatoryConfig> = {};
	if (existsSync(file)) {
		try {
			disk = JSON.parse(readFileSync(file, "utf8")) as Partial<ObservatoryConfig>;
		} catch (err) {
			log.error(`ignoring malformed ${file}: ${err instanceof Error ? err.message : String(err)}`);
			disk = {};
		}
	} else {
		try {
			writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
		} catch (err) {
			// A read-only agent dir is legal; env vars still configure the server.
			log.error(`could not write default config: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const port = Number(process.env.OBSERVATORY_PORT ?? disk.port ?? DEFAULTS.port);
	const host = String(process.env.OBSERVATORY_HOST ?? disk.host ?? DEFAULTS.host);
	const openBrowser = disk.openBrowser ?? DEFAULTS.openBrowser;
	return {
		port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULTS.port,
		host,
		openBrowser,
	};
}

export function dbPath(): string {
	return path.join(observatoryDir(), "observatory.db");
}

export function sessionsRoot(): string {
	return path.join(agentDir(), "sessions");
}

export function decisionsDir(): string {
	return path.join(agentDir(), "jev-decisions");
}

export function modelsStorePath(): string {
	return path.join(agentDir(), "models-store.json");
}

export function refineDir(): string {
	return path.join(decisionsDir(), "refine");
}

export function tunerDir(): string {
	return path.join(decisionsDir(), "decision-tuner");
}

export function extensionsDir(): string {
	return path.join(agentDir(), "extensions");
}

export function rulesDir(): string {
	return path.join(agentDir(), "rules");
}
