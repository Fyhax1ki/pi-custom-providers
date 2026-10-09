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

import { rm } from "node:fs/promises";
import { atomicWrite, readText, withFileLock } from "./file-io.ts";
import { join } from "node:path";
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
		throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
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
	const out: Record<string, unknown> = Object.create(null);
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
	const providers: Record<string, unknown> = Object.create(null);
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
	const rest: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(file)) {
		if (key !== "providers" && value !== undefined) rest[key] = value;
	}
	return `${JSON.stringify({ providers, ...rest }, null, 2)}\n`;
}

const revisions = new WeakMap<object, string | undefined>();

export async function readModelsFile(paths: Paths): Promise<ModelsFile> {
	const raw = await readText(paths.modelsPath);
	const parsed = raw === undefined || raw.trim() === "" ? { providers: {} } : parseJson(raw, "models.json");
	if (!isObject(parsed)) throw new Error("models.json 必须是一个 JSON 对象");
	if (parsed.providers === undefined) parsed.providers = {};
	if (!isObject(parsed.providers)) throw new Error("models.json 的 providers 必须是对象");
	revisions.set(parsed, raw);
	return parsed as ModelsFile;
}

export async function readModelsFileRaw(paths: Paths): Promise<string | undefined> {
	return readText(paths.modelsPath);
}

/** Structural checks that mirror what Pi needs to compose a provider. */
export function validateModelsFile(file: ModelsFile): string[] {
	const errors: string[] = [];
	const providers = file.providers;
	if (!isObject(providers)) return ['"providers" 必须是对象'];
	for (const [id, rawProvider] of Object.entries(providers)) {
		if (!isObject(rawProvider)) {
			errors.push(`providers.${id}：必须是对象`);
			continue;
		}
		if (rawProvider.api !== undefined && typeof rawProvider.api !== "string") {
			errors.push(`providers.${id}.api：必须是字符串`);
		}
		if (rawProvider.baseUrl !== undefined && typeof rawProvider.baseUrl !== "string") {
			errors.push(`providers.${id}.baseUrl：必须是字符串`);
		}
		const models = rawProvider.models;
		if (models === undefined) continue;
		if (!Array.isArray(models)) {
			errors.push(`providers.${id}.models：必须是数组`);
			continue;
		}
		const seen = new Set<string>();
		for (const [index, rawModel] of models.entries()) {
			const where = `providers.${id}.models[${index}]`;
			if (!isObject(rawModel) || typeof rawModel.id !== "string" || rawModel.id.length === 0) {
				errors.push(`${where}.id：必填，且必须是非空字符串`);
				continue;
			}
			if (seen.has(rawModel.id)) errors.push(`${where}：重复的模型 id "${rawModel.id}"`);
			seen.add(rawModel.id);
			const api = rawModel.api ?? rawProvider.api;
			const baseUrl = rawModel.baseUrl ?? rawProvider.baseUrl;
			if (typeof api !== "string" || api.length === 0) {
				errors.push(`${where} (${rawModel.id})：需要在模型或 provider 层级指定 "api"`);
			}
			if (typeof baseUrl !== "string" || baseUrl.length === 0) {
				errors.push(`${where} (${rawModel.id})：需要在模型或 provider 层级指定 "baseUrl"`);
			}
			if (rawModel.reasoning !== undefined && typeof rawModel.reasoning !== "boolean") errors.push(`${where}.reasoning：必须是布尔值`);
			if (rawModel.input !== undefined && (!Array.isArray(rawModel.input) || rawModel.input.some(value => value !== "text" && value !== "image"))) errors.push(`${where}.input：仅支持 text 和 image`);
			if (rawModel.cost !== undefined) {
				if (!isObject(rawModel.cost)) errors.push(`${where}.cost：必须是对象`);
				else for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
					const value = rawModel.cost[key];
					if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) errors.push(`${where}.cost.${key}：必须是非负数`);
				}
			}
			for (const field of ["contextWindow", "maxTokens"] as const) {
				const value = rawModel[field];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
					errors.push(`${where}.${field}：必须是正整数`);
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
export interface SaveOptions {
	credential?: { providerId: string; key?: string };
	meta?: ManagerMeta;
}

type Undo = () => Promise<void>;

/** A failed rollback must never overwrite a newer edit made by another program. */
async function restoreFile(path: string, previous: string | undefined, written: string): Promise<void> {
	if (await readText(path) !== written) throw new Error(`${path} 已被其他会话修改，未覆盖该文件`);
	if (previous === undefined) await rm(path, { force: true });
	else await atomicWrite(path, previous);
}

export async function saveModelsFile(paths: Paths, registry: RegistryLike, file: ModelsFile, options: SaveOptions = {}): Promise<void> {
	const errors = validateModelsFile(file);
	if (errors.length > 0) throw new Error(`models.json 校验未通过：\n${errors.join("\n")}`);
	await withFileLock(paths.modelsPath, async assertOwned => {
		const previous = await readText(paths.modelsPath);
		if (revisions.has(file) && previous !== revisions.get(file)) {
			throw new Error("配置已被其他会话修改，请重新打开菜单后重试");
		}
		const next = serializeModelsFile(file);
		const undo: Undo[] = [];
		try {
			if (options.credential) undo.push(await changeCredential(paths, options.credential));
			if (options.meta) {
				const meta = options.meta;
				await withFileLock(paths.metaPath, async () => {
					const oldMeta = await readText(paths.metaPath);
					if (revisions.has(meta) && oldMeta !== revisions.get(meta)) throw new Error("模型元数据已被其他会话修改，请重试");
					const newMeta = `${JSON.stringify(meta, null, 2)}\n`;
					await atomicWrite(paths.metaPath, newMeta);
					undo.push(() => withFileLock(paths.metaPath, () => restoreFile(paths.metaPath, oldMeta, newMeta)));
				});
			}
			await assertOwned();
			if (await readText(paths.modelsPath) !== previous) throw new Error("配置在保存期间已被其他程序修改，请重试");
			await atomicWrite(paths.modelsPath, next);
			undo.push(() => restoreFile(paths.modelsPath, previous, next));
			await registry.refresh({ allowNetwork: false });
			await assertOwned();
			const error = registry.getError();
			if (error !== undefined) throw new Error(error);
			revisions.set(file, next);
			if (options.meta) revisions.set(options.meta, `${JSON.stringify(options.meta, null, 2)}\n`);
		} catch (error) {
			const failures: string[] = [];
			for (const restore of undo.reverse()) {
				try { await restore(); } catch (rollbackError) { failures.push(String(rollbackError)); }
			}
			try { await registry.refresh({ allowNetwork: false }); }
			catch (reloadError) { failures.push(`重新加载失败：${String(reloadError)}`); }
			throw new Error(`保存失败，${failures.length ? "回滚或重新加载未完全成功" : "已恢复修改前的配置"}。\n${String(error)}${failures.length ? `\n${failures.join("\n")}` : ""}`);
		}
	});
}

// ---------------------------------------------------------------------------
// provider-manager.json (sidecar)
// ---------------------------------------------------------------------------

export async function readManagerMeta(paths: Paths): Promise<ManagerMeta> {
	const raw = await readText(paths.metaPath);
	const parsed = raw === undefined || raw.trim() === "" ? { version: 1, models: {} } : parseJson(raw, "provider-manager.json");
	if (!isObject(parsed) || !isObject(parsed.models)) throw new Error("provider-manager.json 格式无效");
	const meta: ManagerMeta = { version: 1, models: parsed.models as ManagerMeta["models"] };
	revisions.set(meta, raw);
	return meta;
}

export async function writeManagerMeta(paths: Paths, meta: ManagerMeta): Promise<void> {
	await withFileLock(paths.metaPath, async () => {
		if (revisions.has(meta) && await readText(paths.metaPath) !== revisions.get(meta)) throw new Error("模型元数据已被其他会话修改，请重试");
		const next = `${JSON.stringify(meta, null, 2)}\n`;
		await atomicWrite(paths.metaPath, next);
		revisions.set(meta, next);
	});
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

function parseAuth(raw: string | undefined): Record<string, unknown> {
	const parsed = raw === undefined || raw.trim() === "" ? {} : parseJson(raw, "auth.json");
	if (!isObject(parsed)) throw new Error("auth.json 必须是一个 JSON 对象");
	return Object.assign(Object.create(null), parsed);
}

/** Hold the auth lock only while editing; Pi also acquires it during refresh. */
async function changeCredential(paths: Paths, change: NonNullable<SaveOptions["credential"]>): Promise<Undo> {
	return withFileLock(paths.authPath, async () => {
		const parsed = parseAuth(await readText(paths.authPath));
		const previous = parsed[change.providerId];
		const next = change.key === undefined ? undefined : {
			...(isObject(previous) && previous.type === "api_key" ? previous : {}),
			type: "api_key", key: change.key,
		};
		if (next === undefined) delete parsed[change.providerId];
		else parsed[change.providerId] = next;
		await atomicWrite(paths.authPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
		return () => withFileLock(paths.authPath, async () => {
			const latest = parseAuth(await readText(paths.authPath));
			if (JSON.stringify(latest[change.providerId]) !== JSON.stringify(next)) throw new Error("凭据已被其他会话修改，未覆盖新凭据");
			if (previous === undefined) delete latest[change.providerId];
			else latest[change.providerId] = previous;
			await atomicWrite(paths.authPath, `${JSON.stringify(latest, null, 2)}\n`, 0o600);
		});
	});
}

export async function setStoredApiKey(paths: Paths, providerId: string, key: string): Promise<void> {
	await changeCredential(paths, { providerId, key });
}

export async function deleteStoredCredential(paths: Paths, providerId: string): Promise<boolean> {
	const existed = await getStoredCredentialKind(paths, providerId) !== undefined;
	await changeCredential(paths, { providerId });
	return existed;
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
	if (apiKey === undefined || apiKey === "") return "无";
	if (apiKey.startsWith("!")) return "命令";
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) return `环境变量 ${apiKey}`;
	return "models.json 中的字面量";
}
