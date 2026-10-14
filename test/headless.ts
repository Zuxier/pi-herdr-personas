/**
 * Headless test for the pure logic of extensions/pi-herdr-personas.ts.
 *
 * No TUI, no extension runtime: only the exported pure functions are imported
 * (the factory `default` export is never called). Config tests point at a temp
 * dir; the catalog test uses the real `modelsCatalogPath()` file and skips
 * gracefully if it is missing. No bundled model defaults exist: personas are
 * unconfigured until the host user sets them via `/personas`.
 *
 * Run: cd <repo> && npx -y tsx test/headless.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatRef,
	loadConfig,
	listCatalogModels,
	modelsCatalogPath,
	PERSONA_NAMES,
	resolveAssignments,
	saveConfig,
} from "../extensions/pi-herdr-personas";

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (err) {
		failures += 1;
		console.error(`FAIL ${name}`);
		console.error(err instanceof Error ? err.stack ?? err.message : String(err));
	}
}

const realCatalog = modelsCatalogPath();

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-personas-test-"));
	const cfg = path.join(tmp, "pi-herdr-personas.json");
	const nestedCfg = path.join(tmp, "nested", "dir", "cfg.json");

	try {
	await test("loadConfig: no file → empty config (no personas, localProviders [])", () => {
		const config = loadConfig(cfg); // cfg does not exist yet
		assert.deepEqual(config.personas, {});
		assert.deepEqual(config.localProviders, []);
	});

	await test("resolveAssignments: no config → all 7 personas unconfigured (no bundled defaults)", () => {
		const resolved = resolveAssignments(cfg);
		assert.deepEqual(Object.keys(resolved.personas).sort(), [...PERSONA_NAMES].sort());
		for (const name of PERSONA_NAMES) {
			const a = resolved.personas[name];
			assert.equal(a.configured, false, `${name} must start unconfigured`);
			assert.equal(a.ref, "");
			assert.equal(a.model, "");
			assert.equal(a.local, false);
			assert.ok(a.role.length > 0);
		}
		assert.deepEqual(resolved.localProviders, []);
		assert.deepEqual(resolved.constraints, { maxLocalChildren: 1, maxTotalChildren: 3 });
	});

	await test("saveConfig + loadConfig round-trip (only changed keys written, file created in new dir)", async () => {
		await saveConfig({ personas: { scout: { model: "x/y", thinking: "low" } } }, nestedCfg);
		const config = loadConfig(nestedCfg);
		assert.equal(config.personas.scout?.model, "x/y");
		assert.equal(config.personas.scout?.thinking, "low");
		assert.deepEqual(config.localProviders, []); // untouched key → empty default, not written

		const raw = JSON.parse(fs.readFileSync(nestedCfg, "utf8")) as { personas?: Record<string, unknown>; localProviders?: unknown };
		assert.ok(!("localProviders" in raw), "saveConfig must write only the keys the user changed");
		assert.deepEqual(Object.keys(raw.personas ?? {}), ["scout"]);

		const resolved = resolveAssignments(nestedCfg);
		assert.equal(resolved.personas.scout.ref, "x/y:low");
		assert.equal(resolved.personas.scout.configured, true);
		assert.equal(resolved.personas.scout.local, false); // provider "x" not in localProviders
		assert.equal(resolved.personas.builder.configured, false); // other personas stay unconfigured
	});

	await test("saveConfig merge preserves unrelated user keys; localProviders override", async () => {
		const file = path.join(tmp, "merge.json");
		fs.writeFileSync(file, JSON.stringify({ personas: {}, localProviders: ["acme"], keepMe: 42 }), "utf8");
		await saveConfig({ personas: { reviewer: { model: "p/m", thinking: "high" } } }, file);
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(raw.keepMe, 42, "unknown user keys must survive a merge");
		const config = loadConfig(file);
		assert.equal(config.personas.reviewer?.model, "p/m");
		assert.deepEqual(config.localProviders, ["acme"]);

		await saveConfig({ localProviders: ["foo"] }, file);
		const after = loadConfig(file);
		assert.deepEqual(after.localProviders, ["foo"]);
		assert.equal(after.personas.reviewer?.model, "p/m"); // earlier merge survives
		const rawAfter = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(rawAfter.keepMe, 42);
	});

	await test("formatRef: appends :thinking, plain ref without, empty stays empty", () => {
		assert.equal(formatRef("a/b", "high"), "a/b:high");
		assert.equal(formatRef("a/b", undefined), "a/b");
		assert.equal(formatRef("a/b", ""), "a/b");
		assert.equal(formatRef(""), "");
	});

	if (fs.existsSync(realCatalog)) {
		await test(`listCatalogModels: real catalog at ${realCatalog} (≥1 provider/model model, refs well-formed)`, () => {
			const models = listCatalogModels();
			assert.ok(models.length >= 1, "expected at least one catalog model");
			for (const m of models) {
				assert.match(m.ref, /^[^/]+\/[^/]+$/, `ref "${m.ref}" must be provider/model`);
				assert.equal(m.provider, m.ref.split("/")[0]);
				assert.ok(m.name.length > 0);
			}
		});
	} else {
		console.log(`SKIP listCatalogModels: no catalog file at ${realCatalog}`);
	}

	await test("listCatalogModels: missing file → [] (does not throw)", () => {
		assert.deepEqual(listCatalogModels(path.join(tmp, "nope.json")), []);
	});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} test(s) FAILED`);
		process.exit(1);
	}
	console.log("\nall tests passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
