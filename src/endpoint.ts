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
}

type RegistryModelArg = Parameters<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>[0];
type AuthResolution = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

function candidateUrls(baseUrl: string, api: string | undefined): string[] {
	const base = baseUrl.replace(/\/+$/, "");
	const urls = [`${base}/models`];
	if (!/\/v1$/.test(base)) urls.push(`${base}/v1/models`);
	if (api === "anthropic-messages" && !/\/v1$/.test(base)) urls.push(`${base}/v1/models`);
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

function truncate(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export async function discoverModels(
	ctx: ExtensionContext,
	providerId: string,
	provider: ManagedProvider,
	signal?: AbortSignal,
): Promise<DiscoveryResult> {
	const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	if (baseUrl === "") throw new Error(`Provider "${providerId}" has no baseUrl`);

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
		let response: Response;
		try {
			response = await fetch(url, { method: "GET", headers, signal: combined });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			problems.push(`${url} → ${message}`);
			continue;
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			problems.push(`${url} → HTTP ${response.status}${body ? `: ${truncate(body, 180)}` : ""}`);
			continue;
		}
		const body: unknown = await response.json().catch(() => undefined);
		const models = extractModels(body);
		if (models.length === 0) {
			problems.push(`${url} → HTTP 200 but no recognizable model list`);
			continue;
		}
		return { models, url };
	}

	const detail = problems.join("\n");
	throw new Error(`Could not list models for "${providerId}".${note ? `\nAuth: ${note}` : ""}${detail ? `\n${detail}` : ""}`);
}
