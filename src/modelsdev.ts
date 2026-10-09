/**
 * models.dev catalog access.
 *
 * models.dev publishes provider-agnostic model facts (context window, output
 * limit, reasoning, tool calling, modalities, pricing). The manager only reads
 * it to fill metadata that neither the relay endpoint nor models.json already
 * provides.
 *
 * The catalog is cached under the agent directory so enrichment keeps working
 * offline once it has been downloaded.
 */

import { readFile, stat } from "node:fs/promises";
import { atomicWrite } from "./file-io.ts";
import type { ManagedModel, ModelInput, ModelMeta } from "./types.ts";
import type { Paths } from "./store.ts";
import { isObject } from "./store.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export interface ModelsDevModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	attachment?: boolean;
	open_weights?: boolean;
	family?: string;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number; input?: number; output?: number };
	cost?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache_read?: number;
		cache_write?: number;
	};
	canonical_model_id?: string;
}

export interface ModelsDevProvider {
	id?: string;
	name?: string;
	npm?: string;
	api?: string;
	env?: string[];
	doc?: string;
	models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface LookupResult {
	providerId: string;
	model: ModelsDevModel;
}

export interface CatalogIndex {
	exact: Map<string, LookupResult[]>;
	byKey: Map<string, LookupResult[]>;
}

export interface CatalogHandle {
	catalog: ModelsDevCatalog;
	index: CatalogIndex;
	fetchedAt?: number;
	source: "network" | "cache";
	stale: boolean;
	error?: string;
}

interface CacheFile {
	fetchedAt: number;
	catalog: ModelsDevCatalog;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function normalizeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\./g, "-")
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.replace(/-latest$/, "");
}

function bareId(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function isCatalog(value: unknown): value is ModelsDevCatalog {
	if (!isObject(value)) return false;
	const entries = Object.values(value);
	if (entries.length === 0) return false;
	return entries.some((entry) => isObject(entry) && isObject(entry.models));
}

async function readCache(paths: Paths): Promise<CacheFile | undefined> {
	try {
		const raw = await readFile(paths.modelsDevCachePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed) || typeof parsed.fetchedAt !== "number" || !isCatalog(parsed.catalog)) return undefined;
		return { fetchedAt: parsed.fetchedAt, catalog: parsed.catalog };
	} catch {
		return undefined;
	}
}

async function writeCache(paths: Paths, cache: CacheFile): Promise<void> {
	try {
		await atomicWrite(paths.modelsDevCachePath, `${JSON.stringify(cache)}\n`);
	} catch {
		// A cache write failure must never break enrichment.
	}
}

async function fetchCatalog(signal?: AbortSignal): Promise<ModelsDevCatalog> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	const response = await fetch(MODELS_DEV_URL, {
		method: "GET",
		headers: { accept: "application/json" },
		signal: combined,
	});
	if (!response.ok) throw new Error(`${MODELS_DEV_URL} 返回 HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isCatalog(body)) throw new Error(`${MODELS_DEV_URL} 返回了非预期的内容`);
	return body;
}

/**
 * Load the catalog from cache, the network, or both.
 *
 * `refresh` forces a network fetch. Otherwise a cached copy is used until it
 * expires. A network failure always falls back to the cache when one exists.
 */
async function loadCatalogUncached(
	paths: Paths,
	options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<CatalogHandle> {
	const cached = await readCache(paths);
	const offline = process.env.PI_OFFLINE !== undefined && process.env.PI_OFFLINE !== "";
	const fresh = cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

	if (!options.refresh && cached !== undefined && fresh) {
		return { catalog: cached.catalog, index: buildIndex(cached.catalog), fetchedAt: cached.fetchedAt, source: "cache", stale: false };
	}

	if (offline) {
		if (cached !== undefined) {
			return {
				catalog: cached.catalog,
				index: buildIndex(cached.catalog),
				fetchedAt: cached.fetchedAt,
				source: "cache",
				stale: true,
				error: "已设置 PI_OFFLINE，使用本地缓存的 models.dev 目录",
			};
		}
		return { catalog: {}, index: buildIndex({}), source: "cache", stale: true, error: "已设置 PI_OFFLINE，且没有可用的 models.dev 缓存" };
	}

	try {
		const catalog = await fetchCatalog(options.signal);
		const fetchedAt = Date.now();
		await writeCache(paths, { fetchedAt, catalog });
		return { catalog, index: buildIndex(catalog), fetchedAt, source: "network", stale: false };
	} catch (error) {
		options.signal?.throwIfAborted();
		const message = error instanceof Error ? error.message : String(error);
		if (cached !== undefined) {
			return {
				catalog: cached.catalog,
				index: buildIndex(cached.catalog),
				fetchedAt: cached.fetchedAt,
				source: "cache",
				stale: true,
				error: `models.dev 刷新失败（${message}），改用本地缓存`,
			};
		}
		return { catalog: {}, index: buildIndex({}), source: "cache", stale: true, error: `models.dev 不可用：${message}` };
	}
}

const memoryCache = new Map<string, { signature: string; offline: boolean; retryAt: number; handle: CatalogHandle }>();
const pending = new Map<string, Promise<CatalogHandle>>();

async function cacheSignature(path: string): Promise<string> {
	return stat(path).then(s => `${s.mtimeMs}:${s.size}`, () => "missing");
}

export async function loadCatalog(paths: Paths, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<CatalogHandle> {
	options.signal?.throwIfAborted();
	const path = paths.modelsDevCachePath;
	const offline = Boolean(process.env.PI_OFFLINE);
	const signature = await cacheSignature(path);
	const memory = memoryCache.get(path);
	if (!options.refresh && memory?.signature === signature && memory.offline === offline && Date.now() < memory.retryAt) return memory.handle;
	if (!options.signal && !options.refresh && pending.has(path)) return pending.get(path)!;
	const task = loadCatalogUncached(paths, options).then(async handle => {
		const retryAt = handle.stale ? Date.now() + 60_000 : (handle.fetchedAt ?? Date.now()) + CACHE_TTL_MS;
		memoryCache.set(path, { signature: await cacheSignature(path), offline, retryAt, handle });
		return handle;
	});
	if (!options.signal && !options.refresh) pending.set(path, task);
	try { return await task; }
	finally { if (pending.get(path) === task) pending.delete(path); }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function buildIndex(catalog: ModelsDevCatalog): CatalogIndex {
	const exact = new Map<string, LookupResult[]>();
	const byKey = new Map<string, LookupResult[]>();
	const add = (map: Map<string, LookupResult[]>, key: string, result: LookupResult) => {
		if (!key) return;
		const entries = map.get(key) ?? [];
		if (!entries.includes(result)) entries.push(result);
		map.set(key, entries);
	};
	for (const [providerId, provider] of Object.entries(catalog)) {
		if (!isObject(provider) || !isObject(provider.models)) continue;
		for (const [modelId, rawModel] of Object.entries(provider.models)) {
			if (!isObject(rawModel)) continue;
			const id = typeof rawModel.id === "string" && rawModel.id !== "" ? rawModel.id : modelId;
			const raw: ModelsDevModel = { ...rawModel, id };
			const result = { providerId, model: { ...raw, id } };
			for (const candidate of new Set([id, modelId])) {
				add(exact, `${providerId}/${candidate}`, result);
				add(exact, candidate, result);
			}
			for (const candidate of [id, bareId(id), raw.canonical_model_id, raw.name]) {
				if (typeof candidate !== "string" || candidate === "") continue;
				add(byKey, `${normalizeKey(providerId)}/${normalizeKey(candidate)}`, result);
				add(byKey, normalizeKey(candidate), result);
			}
		}
	}
	return { exact, byKey };
}

/** Exact matches win. Ambiguity is not resolved by catalog insertion order. */
export function lookupModel(index: CatalogIndex, providerId: string | undefined, modelId: string): LookupResult | undefined {
	const exactKeys = providerId ? [`${providerId}/${modelId}`, modelId] : [modelId];
	for (const key of exactKeys) {
		const hits = index.exact.get(key);
		if (hits) return hits.length === 1 ? hits[0] : undefined;
	}
	const keys = providerId ? [`${normalizeKey(providerId)}/${normalizeKey(modelId)}`] : [];
	keys.push(normalizeKey(modelId));
	if (modelId.includes("/")) keys.push(normalizeKey(bareId(modelId)));
	for (const key of keys) {
		const hits = index.byKey.get(key);
		if (hits) return hits.length === 1 ? hits[0] : undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Mapping to Pi model metadata
// ---------------------------------------------------------------------------

function modalityInput(modalities: ModelsDevModel["modalities"]): ModelInput[] | undefined {
	const inputs = modalities?.input;
	if (!Array.isArray(inputs)) return undefined;
	const mapped: ModelInput[] = ["text"];
	if (inputs.includes("image")) mapped.push("image");
	return mapped;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface Enrichment {
	/** Fields to merge into the models.json model entry. */
	patch: Partial<ManagedModel>;
	/** Informational fields for the sidecar. */
	meta: ModelMeta;
	/** Names of model fields that were filled. */
	filled: string[];
	lookup?: LookupResult;
}

/**
 * Metadata for a model, filling only what models.json does not already define
 * unless `overwrite` is set. Relay-provided values therefore always win.
 */
export function enrichFromModelsDev(model: ManagedModel, lookup: LookupResult | undefined, overwrite: boolean): Enrichment {
	if (lookup === undefined) return { patch: {}, meta: {}, filled: [] };
	const source = lookup.model;
	const patch: Partial<ManagedModel> = {};
	const filled: string[] = [];
	const set = <K extends keyof ManagedModel>(key: K, value: ManagedModel[K] | undefined) => {
		if (value === undefined) return;
		if (!overwrite && model[key] !== undefined) return;
		if (model[key] === value) return;
		patch[key] = value;
		filled.push(String(key));
	};

	if (typeof source.name === "string" && source.name !== "") set("name", source.name);
	const contextWindow = positive(source.limit?.context);
	if (contextWindow !== undefined) set("contextWindow", contextWindow);
	const maxTokens = positive(source.limit?.output);
	if (maxTokens !== undefined) set("maxTokens", maxTokens);
	if (typeof source.reasoning === "boolean") set("reasoning", source.reasoning);
	const input = modalityInput(source.modalities);
	if (input !== undefined) set("input", input);
	const cost = source.cost;
	if (isObject(cost)) {
		const input_ = nonnegative(cost.input);
		const output = nonnegative(cost.output);
		const cacheRead = nonnegative(cost.cache_read);
		const cacheWrite = nonnegative(cost.cache_write);
		if (input_ !== undefined && output !== undefined) {
			const existing = isObject(model.cost) ? model.cost : undefined;
			const next = {
				...(existing ?? {}),
				input: overwrite || existing?.input === undefined ? input_ : existing.input,
				output: overwrite || existing?.output === undefined ? output : existing.output,
				cacheRead: overwrite || existing?.cacheRead === undefined ? (cacheRead ?? 0) : existing.cacheRead,
				cacheWrite: overwrite || existing?.cacheWrite === undefined ? (cacheWrite ?? 0) : existing.cacheWrite,
			};
			if (JSON.stringify(next) !== JSON.stringify(existing)) {
				patch.cost = next;
				filled.push("cost");
			}
		}
	}

	const meta: ModelMeta = {
		modelsDevProvider: lookup.providerId,
		modelsDevModelId: source.id,
		source: "models.dev",
		updatedAt: Date.now(),
	};
	if (typeof source.tool_call === "boolean") meta.toolCall = source.tool_call;
	if (typeof source.structured_output === "boolean") meta.structuredOutput = source.structured_output;
	if (typeof source.attachment === "boolean") meta.attachment = source.attachment;
	if (typeof source.open_weights === "boolean") meta.openWeights = source.open_weights;
	if (typeof source.family === "string") meta.family = source.family;
	if (typeof source.knowledge === "string") meta.knowledge = source.knowledge;
	if (typeof source.release_date === "string") meta.releaseDate = source.release_date;
	if (typeof source.last_updated === "string") meta.lastUpdated = source.last_updated;

	return { patch, meta, filled, lookup };
}
