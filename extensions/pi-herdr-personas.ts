/**
 * pi-herdr-personas — per-host persona → model assignments for herdr subagent dispatch.
 *
 * Registers:
 *   - tool `herdr_personas` (read-only, no parameters): resolves persona →
 *     provider/model:thinking refs so the coordinator can pass `--model "<ref>"`
 *     to `herdr agent start … --` for any persona.
 *   - command `/personas`: interactive keyboard wizard for humans to configure
 *     persona → model (and thinking level) assignments, persisted to
 *     `<agentDir>/pi-herdr-personas.json` (per-host; missing keys fall back to
 *     the bundled defaults below).
 *
 * The pure logic (config load/save/merge, ref formatting, catalog parsing,
 * assignment resolution) lives in the exported plain functions below. They take
 * an optional explicit path argument and otherwise resolve paths lazily
 * (env `PI_CODING_AGENT_DIR` → `~/.pi/agent`, mirroring pi's `getAgentDir()` /
 * `getModelsPath()`), so a headless test can import them without the pi runtime
 * and point them at a temp dir. The extension factory at the bottom only runs
 * inside pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Persona roster. No model defaults are bundled: every persona starts unset
// until the host user configures it with `/personas` (per-host config file
// `pi-herdr-personas.json`). `skills/herdr-personas/SKILL.md` documents the
// model *classes*; exact refs are resolved at dispatch time from the
// per-host config.
// ---------------------------------------------------------------------------

export const PERSONAS = {
	scout: { role: "read-only exploration, locating code, repo mapping" },
	specifier: { role: "fuzzy request → written spec" },
	planner: { role: "spec → ordered build plan" },
	builder: { role: "implementation, test/fix loops" },
	reviewer: { role: "independent diff review" },
	deployer: { role: "releases/deploy (production gated on approval)" },
	oracle: { role: "hard architecture/security decisions" },
} as const;

export const PERSONA_NAMES: string[] = Object.keys(PERSONAS);

export const LOCAL_PROVIDERS_DEFAULT: string[] = [];
const CONFIG_FILE_NAME = "pi-herdr-personas.json";
const SHOW = "show";
const CANCEL = "cancel";
const TYPE_CUSTOM = "type custom…";

export interface PersonaDef {
	model: string;
	thinking?: string;
}

export interface PersonaConfig {
	personas: Record<string, PersonaDef>;
	localProviders: string[];
}

export interface PersonaConfigPatch {
	personas?: Record<string, PersonaDef>;
	localProviders?: string[];
}

// Type alias (not interface) so instances satisfy the implicit index signature
// required for `structuredContent` (JsonValue) conformance.
export type PersonaAssignment = {
	model: string;
	thinking?: string;
	ref: string;
	configured: boolean;
	local: boolean;
	role: string;
};

export interface ResolvedAssignments {
	personas: Record<string, PersonaAssignment>;
	localProviders: string[];
	constraints: { maxLocalChildren: number; maxTotalChildren: number };
}

export interface CatalogModel {
	provider: string;
	id: string;
	ref: string;
	name: string;
	thinkingLevels: string[];
}

// ---------------------------------------------------------------------------
// Pure logic (importable by the headless test without the pi runtime)
// ---------------------------------------------------------------------------

/** `ref = thinking ? `${model}:${thinking}` : model`. */
export function formatRef(model: string, thinking?: string): string {
	const m = (model ?? "").trim();
	const t = (thinking ?? "").trim();
	return t ? `${m}:${t}` : m;
}

function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * pi's agent dir, mirroring `getAgentDir()` in @earendil-works/pi-coding-agent
 * (env `PI_CODING_AGENT_DIR` tilde-expanded, else `~/.pi/agent`) without
 * importing the pi package, so pure functions stay importable headless.
 */
export function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir && envDir.trim() !== "") return expandTilde(envDir.trim());
	return path.join(os.homedir(), ".pi", "agent");
}

/** Config file path: explicit arg wins, else `<agentDir>/pi-herdr-personas.json`. */
export function configPath(explicit?: string): string {
	return explicit ? path.resolve(explicit) : path.join(resolveAgentDir(), CONFIG_FILE_NAME);
}

/** pi's `getModelsPath()`: `<agentDir>/models.json`. */
export function modelsCatalogPath(): string {
	return path.join(resolveAgentDir(), "models.json");
}

function readRawConfig(file: string): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	} catch {
		// missing or unparseable → start from defaults
	}
	return {};
}

function normalizePersonaDef(v: unknown): PersonaDef | undefined {
	const d = v as Partial<PersonaDef> | null;
	if (!d || typeof d.model !== "string" || d.model.trim() === "") return undefined;
	const def: PersonaDef = { model: d.model.trim() };
	if (typeof d.thinking === "string" && d.thinking.trim() !== "") def.thinking = d.thinking.trim();
	return def;
}

/**
 * Load the per-host config. Missing file → no assignments (every persona
 * unset) and empty `localProviders`.
 */
export function loadConfig(explicitPath?: string): PersonaConfig {
	const raw = readRawConfig(configPath(explicitPath));
	const personas: Record<string, PersonaDef> = {};
	if (raw.personas && typeof raw.personas === "object" && !Array.isArray(raw.personas)) {
		for (const [name, v] of Object.entries(raw.personas as Record<string, unknown>)) {
			const def = normalizePersonaDef(v);
			if (def) personas[name] = def;
		}
	}
	let localProviders: string[];
	if (Array.isArray(raw.localProviders)) {
		localProviders = raw.localProviders.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
	} else {
		localProviders = [...LOCAL_PROVIDERS_DEFAULT];
	}
	return { personas, localProviders };
}

/**
 * Merge-only save: writes to the config file only the keys present in `patch`
 * (per-persona entries replaced, file-level merge over existing content), so
 * unrelated user keys survive. Serialized through pi's file mutation queue
 * when the pi package is resolvable, else a local promise-chain mutex.
 * Returns the resulting config.
 */
export async function saveConfig(patch: PersonaConfigPatch, explicitPath?: string): Promise<PersonaConfig> {
	const file = configPath(explicitPath);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const existing = readRawConfig(file);
	if (patch.personas) {
		const merged: Record<string, unknown> =
			existing.personas && typeof existing.personas === "object" && !Array.isArray(existing.personas)
				? { ...(existing.personas as Record<string, unknown>) }
				: {};
		for (const [name, v] of Object.entries(patch.personas)) {
			const def = normalizePersonaDef(v);
			if (def) merged[name] = def;
		}
		existing.personas = merged;
	}
	if (patch.localProviders) existing.localProviders = [...patch.localProviders];
	const write = async () => {
		await fs.promises.writeFile(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
	};
	try {
		const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
		await withFileMutationQueue(file, write);
	} catch {
		await localMutationQueue(file, write);
	}
	return loadConfig(explicitPath);
}

const localQueues = new Map<string, Promise<void>>();
function localMutationQueue(file: string, write: () => Promise<void>): Promise<void> {
	const prev = localQueues.get(file) ?? Promise.resolve();
	const next = prev.then(write, write);
	localQueues.set(file, next.catch(() => undefined));
	return next;
}

/**
 * Resolve persona → model assignments from the per-host config. A persona
 * without an assignment is `configured: false` with empty model/ref — the
 * host user must set it with `/personas` before dispatching it. `local` =
 * the model's provider (`<provider>` in `provider/model`) is in
 * `localProviders`.
 */
export function resolveAssignments(explicitPath?: string): ResolvedAssignments {
	const config = loadConfig(explicitPath);
	const personas: Record<string, PersonaAssignment> = {};
	for (const name of PERSONA_NAMES) {
		const role = PERSONAS[name as keyof typeof PERSONAS].role;
		const def = config.personas[name];
		const provider = def?.model.split("/")[0] ?? "";
		const assignment: PersonaAssignment = {
			model: def?.model ?? "",
			ref: def ? formatRef(def.model, def.thinking) : "",
			configured: Boolean(def),
			local: config.localProviders.includes(provider),
			role,
		};
		if (def?.thinking) assignment.thinking = def.thinking;
		personas[name] = assignment;
	}
	return { personas, localProviders: config.localProviders, constraints: { maxLocalChildren: 1, maxTotalChildren: 3 } };
}

/** Parse pi's model catalog (`getModelsPath()` JSON) into flat `provider/model` entries. */
export function listCatalogModels(explicitPath?: string): CatalogModel[] {
	return readCatalog(explicitPath).models;
}

function readCatalog(explicitPath?: string): { models: CatalogModel[]; ok: boolean } {
	const file = explicitPath ? path.resolve(explicitPath) : modelsCatalogPath();
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { models: [], ok: false };
	}
	const providers = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { providers?: unknown }).providers : undefined;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { models: [], ok: false };
	const models: CatalogModel[] = [];
	for (const [providerId, p] of Object.entries(providers as Record<string, unknown>)) {
		if (!p || typeof p !== "object" || !Array.isArray((p as { models?: unknown }).models)) continue;
		for (const m of (p as { models: unknown[] }).models) {
			if (!m || typeof m !== "object" || typeof (m as { id?: unknown }).id !== "string") continue;
			const model = m as { id: string; name?: unknown; thinkingLevelMap?: unknown };
			const map = model.thinkingLevelMap;
			let levels: string[] = [];
			if (map && typeof map === "object" && !Array.isArray(map)) levels = Object.keys(map as object);
			else if (Array.isArray(map)) levels = map.filter((x): x is string => typeof x === "string");
			models.push({
				provider: providerId,
				id: model.id,
				ref: `${providerId}/${model.id}`,
				name: typeof model.name === "string" && model.name.trim() !== "" ? model.name : model.id,
				thinkingLevels: levels,
			});
		}
	}
	return { models, ok: models.length > 0 };
}

// ---------------------------------------------------------------------------
// Extension factory (runs inside pi only)
// ---------------------------------------------------------------------------

const PERSONAS_OUTPUT_SCHEMA = Type.Object({
	personas: Type.Record(Type.String(), Type.Object({
		model: Type.String(),
		thinking: Type.Optional(Type.String()),
		ref: Type.String(),
		configured: Type.Boolean(),
		local: Type.Boolean(),
		role: Type.String(),
	})),
	localProviders: Type.Array(Type.String()),
	constraints: Type.Object({ maxLocalChildren: Type.Number(), maxTotalChildren: Type.Number() }),
});

function registerPersonasTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_personas",
		label: "herdr_personas",
		description:
			"Resolve persona → model assignments for herdr subagent dispatch (per-host config; personas start unset until configured with /personas). Call before `herdr agent start` to get the exact `--model` string for a persona. Never dispatch a persona whose configured flag is false — tell the user to run /personas first.",
		parameters: Type.Object({}),
		outputSchema: PERSONAS_OUTPUT_SCHEMA,
		execute: async () => {
			const resolved = resolveAssignments();
			const catalog = readCatalog();
			const lines: string[] = [
				"persona → model ref (pass as `--model \"<ref>\"` after `--` to `herdr agent start`):",
			];
			for (const name of PERSONA_NAMES) {
				const a = resolved.personas[name];
				lines.push(`${name} → ${a.configured ? a.ref : "(not set — run /personas)"}${a.local ? " (local)" : ""} — ${a.role}`);
			}
			lines.push(
				`localProviders: ${resolved.localProviders.length > 0 ? resolved.localProviders.join(", ") : "(none)"}; ` +
				`constraints: max ${resolved.constraints.maxLocalChildren} local child at a time, max ${resolved.constraints.maxTotalChildren} total children`,
			);
			if (!catalog.ok) {
				lines.push(
					`note: model catalog at ${modelsCatalogPath()} is missing or unparseable — in /personas use "type custom…" to pick models not in the catalog.`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: undefined,
				structuredContent: {
					personas: resolved.personas,
					localProviders: resolved.localProviders,
					constraints: resolved.constraints,
				},
			};
		},
	});
}

function summaryLine(resolved: ResolvedAssignments): string {
	return PERSONA_NAMES.map((n) => `${n}→${resolved.personas[n].ref}${resolved.personas[n].local ? " (local)" : ""}`).join(" · ");
}

function modelLabel(m: CatalogModel): string {
	return `${m.ref} — ${m.name}`;
}

async function configurePersona(persona: string, ctx: ExtensionCommandContext): Promise<void> {
	const ui = ctx.ui;
	const resolved = resolveAssignments();
	const current = resolved.personas[persona];
	if (!current) return;

	// Step 2: model picker — current assignment first, then every catalog model
	// (grouped by provider order), plus the "type custom…" escape hatch.
	const catalog = readCatalog();
	const currentMatches = catalog.models.find((m) => m.ref === current.ref || m.ref === current.model);
	const modelOptions: string[] = [];
	if (currentMatches) {
		modelOptions.push(`${modelLabel(currentMatches)} (current)`);
	} else {
		modelOptions.push(`${current.ref} (current)`);
	}
	for (const m of catalog.models) {
		if (m === currentMatches) continue;
		modelOptions.push(modelLabel(m));
	}
	modelOptions.push(TYPE_CUSTOM);

	const chosenModel = await ui.select(`Model for ${persona}?`, modelOptions);
	if (chosenModel === undefined) return; // dismissed (escape)

	let model = "";
	let thinking: string | undefined = current.thinking; // kept until step 3 decides (custom/unknown models keep existing thinking)
	let chosenCatalog: CatalogModel | undefined;
	let custom = false;

	if (chosenModel === TYPE_CUSTOM) {
		const entered = (await ui.input("Model reference (provider/model)", current.ref))?.trim();
		if (!entered) {
			ui.notify(`${persona}: no model entered — not saved.`, "info");
			return;
		}
		if (!entered.includes("/")) {
			ui.notify(`${persona}: "${entered}" is not a model reference (expected provider/model) — not saved.`, "error");
			return;
		}
		model = entered;
		custom = true;
	} else {
		const bare = chosenModel.replace(/\s*\(current\)\s*$/, "").trim();
		const found = catalog.models.find((m) => modelLabel(m) === bare);
		if (found) {
			chosenCatalog = found;
			model = found.ref;
		} else if (chosenModel.startsWith(`${current.ref} (current)`) || chosenModel.startsWith(`${current.model} (current)`)) {
			// current model is not in this host's catalog (e.g. a provider built into pi): keep it
			model = current.model;
			custom = true;
		} else {
			ui.notify(`${persona}: unknown selection "${chosenModel}" — not saved.`, "error");
			return;
		}
	}

	// Step 3: thinking level — only for catalog models that declare a non-empty
	// thinkingLevelMap; skipped (existing thinking kept) for custom/unknown models.
	if (chosenCatalog && chosenCatalog.thinkingLevels.length > 0) {
		const levels = chosenCatalog.thinkingLevels;
		const levelOptions = levels.map((l) => (l === current.thinking ? `${l} (current)` : l));
		levelOptions.push(current.thinking ? "(none)" : "(none) (current)");
		const chosenLevel = await ui.select(`Thinking level for ${persona} (${model})?`, levelOptions);
		if (chosenLevel === undefined) return; // dismissed
		if (chosenLevel.startsWith("(none)")) thinking = undefined;
		else thinking = chosenLevel.replace(/\s*\(current\)\s*$/, "").trim();
	}

	const saved = await saveConfig({ personas: { [persona]: { model, ...(thinking ? { thinking } : {}) } } });
	ui.notify(`${persona} → ${saved.personas[persona] ? formatRef(saved.personas[persona].model, saved.personas[persona].thinking) : formatRef(model, thinking)} saved`, "info");
}

function registerPersonasCommand(pi: ExtensionAPI): void {
	pi.registerCommand("personas", {
		description: "Configure persona → model assignments for herdr subagent delegation",
		getArgumentCompletions: (prefix) => {
			const names = [...PERSONA_NAMES, SHOW];
			const filtered = names.filter((n) => n.startsWith(prefix));
			if (filtered.length === 0) return null;
			return filtered.map((n) =>
				n === SHOW
					? { value: SHOW, label: "show — one-line summary" }
					: { value: n, label: `${n} — ${PERSONAS[n as keyof typeof PERSONAS].role}` },
			);
		},
		handler: async (args, ctx) => {
			const arg = args.trim();

			// Non-interactive (print/JSON modes): summarize as text, never open dialogs.
			if (!ctx.hasUI) {
				const resolved = resolveAssignments();
				const summary = `/personas: ${summaryLine(resolved)} (config: ${configPath()})`;
				try {
					pi.sendUserMessage(summary);
				} catch {
					// sendUserMessage unavailable in this mode — no-op per contract
				}
				return;
			}

			if (arg === SHOW) {
				ctx.ui.notify(summaryLine(resolveAssignments()), "info");
				return;
			}
			if (PERSONA_NAMES.includes(arg)) {
				await configurePersona(arg, ctx);
				return;
			}

			// Step 1: which persona (current assignment appended per option).
			const resolved = resolveAssignments();
			const personaOptions = PERSONA_NAMES.map(
				(n) => `${n} — ${PERSONAS[n as keyof typeof PERSONAS].role}  [${resolved.personas[n].ref}${resolved.personas[n].local ? " (local)" : ""}]`,
			);
			personaOptions.push(SHOW, CANCEL);
			const chosenPersona = await ctx.ui.select("Configure which persona?", personaOptions);
			if (chosenPersona === undefined || chosenPersona === CANCEL) return;
			if (chosenPersona === SHOW) {
				ctx.ui.notify(summaryLine(resolved), "info");
				return;
			}
			const persona = PERSONA_NAMES.find((n) => chosenPersona.startsWith(`${n} — `));
			if (!persona) return;
			await configurePersona(persona, ctx);
		},
	});
}

export default function piHerdrPersonasExtension(pi: ExtensionAPI): void {
	registerPersonasTool(pi);
	registerPersonasCommand(pi);
}
