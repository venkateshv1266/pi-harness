import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearJevCache, jevCall } from "../src/jev/client.ts";
import { resetJevKeyCache } from "../../../utils/jev-client.ts";

type Auth = { openrouter?: { key?: string; access?: string; type?: string } };

const MANAGED = [
	"HOME",
	"USERPROFILE",
	"JEVM_API_KEY",
	"JEV_API_KEY",
	"OPENROUTER_API_KEY",
	"JEVM_JEV",
	"JEVM_MOCK",
] as const;

async function authorizationFor(
	auth: Auth | undefined,
	env: Partial<Record<(typeof MANAGED)[number], string>> = {},
): Promise<string | null> {
	const home = mkdtempSync(join(tmpdir(), "jevm-key-"));
	const saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
	const originalFetch = globalThis.fetch;
	let seen: string | null = null;

	process.env.HOME = home;
	for (const name of MANAGED) delete process.env[name];
	process.env.HOME = home;
	Object.assign(process.env, { HOME: home, ...env });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	if (auth) writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify(auth));

	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		seen = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
		return new Response(JSON.stringify({ answers: { probe: { type: "noul", noul: 0.9 } } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	clearJevCache();
	resetJevKeyCache();

	try {
		await jevCall({ probe: true }, { probe: { type: "noul", instructions: "probe" } });
		return seen;
	} finally {
		globalThis.fetch = originalFetch;
		clearJevCache();
		resetJevKeyCache();
		for (const name of MANAGED) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		rmSync(home, { recursive: true, force: true });
	}
}

test("uses a static openrouter.key", async () => {
	assert.equal(await authorizationFor({ openrouter: { key: "sk-or-static" } }), "Bearer sk-or-static");
});

test("falls back to the OAuth access token", async () => {
	assert.equal(
		await authorizationFor({ openrouter: { type: "oauth", access: "sk-or-access" } }),
		"Bearer sk-or-access",
	);
});

test("environment key wins over auth.json", async () => {
	assert.equal(
		await authorizationFor({ openrouter: { access: "sk-or-access" } }, { JEVM_API_KEY: "env-key" }),
		"Bearer env-key",
	);
});

test("returns no answers when nothing is configured", async () => {
	assert.equal(await authorizationFor(undefined), null);
});
