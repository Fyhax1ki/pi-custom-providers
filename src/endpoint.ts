/**
 * Model discovery against a relay endpoint's `GET /models`.
 *
 * Authentication is resolved by Pi's own model registry (stored credential,
 * `models.json` apiKey with env/command interpolation, configured headers), so
 * the manager never reimplements key resolution.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagedProvider } from "./types.ts";
import { isObject } from "./store.ts";

const REQUEST_TIMEOUT_MS = 20_000;

export interface DiscoveredModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface DiscoveryResult {
	models: DiscoveredModel[];
	url: string;
	complete: boolean;
	warnings: string[];
}

type RegistryModelArg = Parameters<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>[0];
type AuthResolution = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

function candidateUrls(baseUrl: string, api: string | undefined): string[] {
	const base = baseUrl.replace(/\/+$/, "");
	const urls = [`${base}/models`];
	if (!/\/v1$/.test(base)) urls.push(`${base}/v1/models`);
	return [...new Set(urls)];
}

function buildHeaders(auth: AuthResolution, api: string | undefined): { headers: Record<string, string>; note?: string } {
	const headers: Record<string, string> = { Accept: "application/json" };
	let note: string | undefined;
	if (auth.ok) {
		for (const [key, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headers[key] = value;
		}
	} else {
		note = auth.error;
	}
	const hasHeader = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
	if (auth.ok && auth.apiKey && auth.apiKey !== "") {
		if (api === "anthropic-messages") {
			if (!hasHeader("x-api-key")) headers["x-api-key"] = auth.apiKey;
			if (!hasHeader("anthropic-version")) headers["anthropic-version"] = "2023-06-01";
		} else if (!hasHeader("authorization")) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
	}
	return { headers, ...(note === undefined ? {} : { note }) };
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelFromEntry(entry: unknown): DiscoveredModel | undefined {
	if (typeof entry === "string") {
		return entry.trim() === "" ? undefined : { id: entry.trim() };
	}
	if (!isObject(entry)) return undefined;
	const id =
		(typeof entry.id === "string" && entry.id) ||
		(typeof entry.model === "string" && entry.model) ||
		(typeof entry.name === "string" && entry.name) ||
		undefined;
	if (!id || id.trim() === "") return undefined;
	const name =
		(typeof entry.display_name === "string" && entry.display_name) ||
		(typeof entry.name === "string" && entry.name) ||
		undefined;
	const contextWindow =
		positive(entry.context_length) ??
		positive(entry.context_window) ??
		positive(entry.max_context_length) ??
		positive(entry.contextWindow) ??
		positive(isObject(entry.limit) ? entry.limit.context : undefined);
	const maxTokens =
		positive(entry.max_output_tokens) ??
		positive(entry.max_completion_tokens) ??
		positive(entry.maxTokens) ??
		positive(isObject(entry.limit) ? entry.limit.output : undefined);
	return {
		id: id.trim(),
		...(name !== undefined && name !== id ? { name } : {}),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
}

/** Accepts OpenAI, Anthropic, `{models:[...]}` and bare-array responses. */
export function extractModels(body: unknown): DiscoveredModel[] {
	let entries: unknown;
	if (Array.isArray(body)) entries = body;
	else if (isObject(body)) {
		if (Array.isArray(body.data)) entries = body.data;
		else if (Array.isArray(body.models)) entries = body.models;
	}
	if (!Array.isArray(entries)) return [];
	const seen = new Set<string>();
	const models: DiscoveredModel[] = [];
	for (const entry of entries) {
		const model = modelFromEntry(entry);
		if (model === undefined || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export async function discoverModels(
	ctx: ExtensionContext,
	providerId: string,
	provider: ManagedProvider,
	signal?: AbortSignal,
): Promise<DiscoveryResult> {
	signal?.throwIfAborted();
	const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	if (baseUrl === "") throw new Error(`Provider "${providerId}" 没有配置 baseUrl`);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders({
		provider: providerId,
		id: `${providerId}/__discovery__`,
		api: provider.api,
		baseUrl,
	} as unknown as RegistryModelArg);
	const { headers, note } = buildHeaders(auth, provider.api);

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

	const problems: string[] = [];
	for (const url of candidateUrls(baseUrl, provider.api)) {
		let current = url;
		const visited = new Set<string>();
		const collected = new Map<string, DiscoveredModel>();
		const warnings: string[] = [];
		for (let page = 0; page < 100; page++) {
			combined.throwIfAborted();
			if (visited.has(current)) { warnings.push("分页游标重复，列表可能不完整"); break; }
			visited.add(current);
			try {
				// Never forward credentials to an endpoint supplied by a redirect.
				const response = await fetch(current, { method: "GET", headers, signal: combined, redirect: "error" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body: unknown = await response.json();
				const entries = Array.isArray(body) ? body : isObject(body) ? body.data ?? body.models : undefined;
				if (!Array.isArray(entries)) throw new Error("没有可识别的模型列表");
				if (entries.some(entry => modelFromEntry(entry) === undefined)) warnings.push("部分模型条目无效，禁止据此删除本地模型");
				for (const model of extractModels(body)) collected.set(model.id, model);
				const pagination = nextPage(body, current, provider.api, collected.size, response.headers.get("link"));
				if (pagination.warning) warnings.push(pagination.warning);
				if (!pagination.url) return { models: [...collected.values()], url, complete: warnings.length === 0, warnings };
				current = pagination.url;
				if (page === 99) warnings.push("分页数量超过安全上限，列表可能不完整");
			} catch (error) {
				signal?.throwIfAborted();
				const message = error instanceof Error ? error.message : String(error);
				if (visited.size > 1 || collected.size) warnings.push(`后续分页获取失败：${message}`);
				else problems.push(`${url}：${message}`);
				break;
			}
		}
		if (warnings.length) return { models: [...collected.values()], url, complete: false, warnings };
	}
	throw new Error(`无法获取 "${providerId}" 的模型列表。${note ? `\n认证：${note}` : ""}\n${problems.join("\n")}`);
}

/** Only follow recognized cursors or same-origin links. Unknown pagination is add-only. */
function nextPage(body: unknown, current: string, api: string | undefined, count: number, linkHeader: string | null): { url?: string; warning?: string } {
	const data = isObject(body) ? body : {};
	const paging = isObject(data.pagination) ? data.pagination : data;
	const headerLink = linkHeader?.split(/,(?=\s*<)/).find(part => /rel\s*=\s*"?next"?/i.test(part));
	const link = paging.next ?? (isObject(data.links) ? data.links.next : undefined) ?? headerLink?.match(/<([^>]+)>/)?.[1];
	const cursor = paging.next_cursor;
	const hasMore = paging.has_more === true || data.has_more === true || paging.has_next_page === true || paging.hasMore === true;
	if (typeof link === "string" && link) {
		const next = new URL(link, current);
		if (next.origin !== new URL(current).origin || next.username || next.password) return { warning: "分页链接不安全，未继续获取" };
		return { url: next.href };
	}
	if (typeof cursor === "string" && cursor) {
		const next = new URL(current); next.searchParams.set("cursor", cursor); return { url: next.href };
	}
	if (hasMore && typeof data.last_id === "string" && data.last_id) {
		const next = new URL(current);
		next.searchParams.set(api === "anthropic-messages" ? "after_id" : "after", data.last_id);
		return { url: next.href };
	}
	const page = paging.page ?? paging.current_page;
	const pages = paging.total_pages;
	const nextNumber = paging.next_page ?? (typeof page === "number" && typeof pages === "number" && page < pages ? page + 1 : undefined);
	if (typeof nextNumber === "number" && Number.isSafeInteger(nextNumber) && nextNumber > 0) {
		const next = new URL(current); next.searchParams.set("page", String(nextNumber)); return { url: next.href };
	}
	const total = paging.total ?? data.total ?? paging.total_count;
	if (hasMore || (typeof pages === "number" && pages > 1 && typeof page !== "number") || Boolean(paging.next_page_token) || Boolean(headerLink && !link) || (typeof total === "number" && count < total) || (link !== undefined && link !== null && link !== "") || (cursor !== undefined && cursor !== null && cursor !== "")) {
		return { warning: "端点提示还有分页，但未提供可识别的下一页信息" };
	}
	return {};
}
