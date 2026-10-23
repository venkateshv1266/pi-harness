import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type Auth = { openrouter?: { key?: string; access?: string } };

async function resolveWith(
	auth: Auth | undefined,
	env: { JEV_API_KEY?: string; OPENROUTER_API_KEY?: string } = {},
): Promise<string | null> {
	const home = mkdtempSync(join(tmpdir(), "jev-key-"));
	const saved = {
		HOME: process.env.HOME,
		JEV_API_KEY: process.env.JEV_API_KEY,
		OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
	};

	process.env.HOME = home;
	delete process.env.JEV_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	Object.assign(process.env, env);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	if (auth) writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify(auth));

	try {
		const fresh = await import(`./jev-client.ts?case=${Math.floor(Math.random() * 1e9)}`);
		return fresh.jevKey();
	} finally {
		process.env.HOME = saved.HOME;
		if (saved.JEV_API_KEY === undefined) delete process.env.JEV_API_KEY;
		else process.env.JEV_API_KEY = saved.JEV_API_KEY;
		if (saved.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = saved.OPENROUTER_API_KEY;
		rmSync(home, { recursive: true, force: true });
	}
}

test("reads a static openrouter.key", async () => {
	assert.equal(await resolveWith({ openrouter: { key: "sk-or-static" } }), "sk-or-static");
});

test("falls back to the OAuth access token", async () => {
	assert.equal(
		await resolveWith({ openrouter: { type: "oauth", access: "sk-or-access" } } as Auth),
		"sk-or-access",
	);
});

test("environment wins over auth.json", async () => {
	assert.equal(
		await resolveWith({ openrouter: { access: "sk-or-access" } }, { JEV_API_KEY: "env-key" }),
		"env-key",
	);
});

test("returns null when nothing is configured", async () => {
	assert.equal(await resolveWith(undefined), null);
});
