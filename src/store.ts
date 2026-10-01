/**
 * Durable storage for the provider manager.
 *
 * - `models.json` is the only place provider/model definitions live. Pi already
 *   loads, validates and streams those definitions, so the manager just edits
 *   the file and asks the model registry to reload it.
 * - `auth.json` holds a stored API key the same way `/login` does.
 * - `provider-manager.json` is a sidecar for informational metadata (tool
 *   calling, family, release dates, ...) that models.json has no field for.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ManagedModel, ManagedProvider, ManagerMeta, ModelsFile } from "./types.ts";

export interface Paths {
	agentDir: string;
	modelsPath: string;
	authPath: string;
	metaPath: string;
	modelsDevCachePath: string;
}

export function getPaths(): Paths {
	const agentDir = getAgentDir();
	return {
		agentDir,
		modelsPath: join(agentDir, "models.json"),
		authPath: join(agentDir, "auth.json"),
		metaPath: join(agentDir, "provider-manager.json"),
		modelsDevCachePath: join(agentDir, "provider-manager-modelsdev.json"),
	};
}

/** Minimal shape of `ctx.modelRegistry` needed to apply a saved models.json. */
export interface RegistryLike {
	getError(): string | undefined;
	refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove `//` and `/* *\/` comments outside of strings, matching Pi's own
 * tolerance for commented models.json files.
 */
export function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		const next = text[index + 1];
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				out += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index++;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				index++;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			index++;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index++;
			continue;
		}
		out += char;
	}
	return out;
}

function parseJson(raw: string, label: string): unknown {
	const text = stripJsonComments(raw.replace(/^\uFEFF/, ""));
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicWrite(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

// ---------------------------------------------------------------------------
// models.json
// ---------------------------------------------------------------------------

const PROVIDER_KEY_ORDER = [
	"name",
	"baseUrl",
	"api",
	"apiKey",
	"headers",
	"authHeader",
	"models",
	"modelOverrides",
] as const;
const MODEL_KEY_ORDER = ["id", "name", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"] as const;
const COST_KEY_ORDER = ["input", "output", "cacheRead", "cacheWrite"] as const;

function orderKeys(record: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of order) {
		if (record[key] !== undefined) out[key] = record[key];
	}
	for (const [key, value] of Object.entries(record)) {
		if (!(key in out) && value !== undefined) out[key] = value;
	}
	return out;
}

/** Stable key order so saved files produce readable diffs. */
export function serializeModelsFile(file: ModelsFile): string {
	const providers: Record<string, unknown> = {};
	for (const [id, provider] of Object.entries(file.providers)) {
		const raw = provider as Record<string, unknown>;
		const models = Array.isArray(raw.models)
			? raw.models.map((model) => {
					if (!isObject(model)) return model;
					const normalized = isObject(model.cost) ? { ...model, cost: orderKeys(model.cost, COST_KEY_ORDER) } : model;
					return orderKeys(normalized, MODEL_KEY_ORDER);
				})
			: raw.models;
		const withModels = models === undefined ? raw : { ...raw, models };
		providers[id] = orderKeys(withModels, PROVIDER_KEY_ORDER);
	}
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(file)) {
		if (key !== "providers" && value !== undefined) rest[key] = value;
	}
	return `${JSON.stringify({ providers, ...rest }, null, 2)}\n`;
}

export async function readModelsFile(paths: Paths): Promise<ModelsFile> {
	const raw = await readText(paths.modelsPath);
	if (raw === undefined || raw.trim() === "") return { providers: {} };
	const parsed = parseJson(raw, "models.json");
	if (!isObject(parsed)) throw new Error("models.json must contain a JSON object");
	if (parsed.providers === undefined) return { providers: {}, ...parsed } as ModelsFile;
	if (!isObject(parsed.providers)) throw new Error('models.json: "providers" must be an object');
	return parsed as ModelsFile;
}

export async function readModelsFileRaw(paths: Paths): Promise<string | undefined> {
	return readText(paths.modelsPath);
}

/** Structural checks that mirror what Pi needs to compose a provider. */
export function validateModelsFile(file: ModelsFile): string[] {
	const errors: string[] = [];
	const providers = file.providers;
	if (!isObject(providers)) return ['"providers" must be an object'];
	for (const [id, rawProvider] of Object.entries(providers)) {
		if (!isObject(rawProvider)) {
			errors.push(`providers.${id}: must be an object`);
			continue;
		}
		if (rawProvider.api !== undefined && typeof rawProvider.api !== "string") {
			errors.push(`providers.${id}.api: must be a string`);
		}
		if (rawProvider.baseUrl !== undefined && typeof rawProvider.baseUrl !== "string") {
			errors.push(`providers.${id}.baseUrl: must be a string`);
		}
		const models = rawProvider.models;
		if (models === undefined) continue;
		if (!Array.isArray(models)) {
			errors.push(`providers.${id}.models: must be an array`);
			continue;
		}
		const seen = new Set<string>();
		for (const [index, rawModel] of models.entries()) {
			const where = `providers.${id}.models[${index}]`;
			if (!isObject(rawModel) || typeof rawModel.id !== "string" || rawModel.id.length === 0) {
				errors.push(`${where}.id: required and must be a non-empty string`);
				continue;
			}
			if (seen.has(rawModel.id)) errors.push(`${where}: duplicate model id "${rawModel.id}"`);
			seen.add(rawModel.id);
			const api = rawModel.api ?? rawProvider.api;
			const baseUrl = rawModel.baseUrl ?? rawProvider.baseUrl;
			if (typeof api !== "string" || api.length === 0) {
				errors.push(`${where} (${rawModel.id}): needs "api" at model or provider level`);
			}
			if (typeof baseUrl !== "string" || baseUrl.length === 0) {
				errors.push(`${where} (${rawModel.id}): needs "baseUrl" at model or provider level`);
			}
			for (const field of ["contextWindow", "maxTokens"] as const) {
				const value = rawModel[field];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
					errors.push(`${where}.${field}: must be a positive number`);
				}
			}
		}
	}
	return errors;
}

/**
 * Write models.json and reload it into Pi. When Pi rejects the file (bad
 * schema, provider that cannot be composed) the previous content is restored so
 * the user never loses a working configuration.
 */
export async function saveModelsFile(paths: Paths, registry: RegistryLike, file: ModelsFile): Promise<void> {
	const errors = validateModelsFile(file);
	if (errors.length > 0) throw new Error(`models.json validation failed:\n${errors.join("\n")}`);

	const previousRaw = await readModelsFileRaw(paths);
	const previousError = registry.getError();

	await atomicWrite(paths.modelsPath, serializeModelsFile(file));
	await registry.refresh({ allowNetwork: false });

	const error = registry.getError();
	if (error !== undefined && error !== previousError) {
		if (previousRaw === undefined) await rm(paths.modelsPath, { force: true });
		else await atomicWrite(paths.modelsPath, previousRaw);
		await registry.refresh({ allowNetwork: false });
		throw new Error(`Pi rejected the saved models.json; changes were rolled back.\n${error}`);
	}
}

// ---------------------------------------------------------------------------
// provider-manager.json (sidecar)
// ---------------------------------------------------------------------------

export async function readManagerMeta(paths: Paths): Promise<ManagerMeta> {
	const raw = await readText(paths.metaPath);
	if (raw === undefined || raw.trim() === "") return { version: 1, models: {} };
	const parsed = parseJson(raw, "provider-manager.json");
	if (!isObject(parsed) || !isObject(parsed.models)) return { version: 1, models: {} };
	return { version: 1, models: parsed.models as ManagerMeta["models"] };
}

export async function writeManagerMeta(paths: Paths, meta: ManagerMeta): Promise<void> {
	await atomicWrite(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

export function renameManagerMeta(meta: ManagerMeta, fromKey: string, toKey: string): void {
	const record = meta.models[fromKey];
	if (record === undefined) return;
	delete meta.models[fromKey];
	meta.models[toKey] = record;
}

export function dropManagerMetaPrefix(meta: ManagerMeta, prefix: string): void {
	for (const key of Object.keys(meta.models)) {
		if (key === prefix || key.startsWith(`${prefix}/`)) delete meta.models[key];
	}
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

export type StoredCredentialKind = "api_key" | "oauth";

export async function getStoredCredentialKind(paths: Paths, providerId: string): Promise<StoredCredentialKind | undefined> {
	const raw = await readText(paths.authPath);
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = parseJson(raw, "auth.json");
	if (!isObject(parsed)) return undefined;
	const entry = parsed[providerId];
	if (!isObject(entry)) return undefined;
	return entry.type === "oauth" ? "oauth" : "api_key";
}

/**
 * Store an API key the way `/login` does. Existing entries and credential
 * fields such as `env` are preserved.
 */
export async function setStoredApiKey(paths: Paths, providerId: string, key: string): Promise<void> {
	const raw = await readText(paths.authPath);
	const parsed = raw === undefined || raw.trim() === "" ? {} : parseJson(raw, "auth.json");
	if (!isObject(parsed)) throw new Error("auth.json must contain a JSON object");
	const existing = parsed[providerId];
	const entry: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
	entry.type = "api_key";
	entry.key = key;
	parsed[providerId] = entry;
	const existed = raw !== undefined;
	await atomicWrite(paths.authPath, `${JSON.stringify(parsed, null, 2)}\n`, existed ? undefined : 0o600);
}

export async function deleteStoredCredential(paths: Paths, providerId: string): Promise<boolean> {
	const raw = await readText(paths.authPath);
	if (raw === undefined || raw.trim() === "") return false;
	const parsed = parseJson(raw, "auth.json");
	if (!isObject(parsed) || !(providerId in parsed)) return false;
	delete parsed[providerId];
	await atomicWrite(paths.authPath, `${JSON.stringify(parsed, null, 2)}\n`);
	return true;
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function findProvider(file: ModelsFile, providerId: string): ManagedProvider | undefined {
	const provider = file.providers[providerId];
	return isObject(provider) ? (provider as ManagedProvider) : undefined;
}

export function findModel(provider: ManagedProvider, modelId: string): ManagedModel | undefined {
	if (!Array.isArray(provider.models)) return undefined;
	return provider.models.find((model) => isObject(model) && model.id === modelId);
}

/** Escape a literal so Pi does not treat `$`/`!` in an apiKey as interpolation. */
export function escapeConfigValue(value: string): string {
	return value.replace(/^\$/, "$$$$").replace(/^!/, "$!");
}

export function describeApiKeySource(apiKey: string | undefined): string {
	if (apiKey === undefined || apiKey === "") return "none";
	if (apiKey.startsWith("!")) return "command";
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) return `env ${apiKey}`;
	return "literal in models.json";
}
