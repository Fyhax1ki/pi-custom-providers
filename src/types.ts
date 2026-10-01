/**
 * Shared types for the provider manager.
 *
 * The manager treats `~/.pi/agent/models.json` as the single source of truth so
 * that Pi itself loads, validates and streams the configured providers. Nothing
 * here re-implements a provider protocol.
 */

/** API protocols Pi already implements for chat completions. */
export const API_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export function isApiProtocol(value: unknown): value is ApiProtocol {
	return typeof value === "string" && (API_PROTOCOLS as readonly string[]).includes(value);
}

export type ModelInput = "text" | "image";

/** One `models[]` entry inside a models.json provider, plus unknown keys we round-trip. */
export interface ManagedModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: ModelInput[];
	cost?: Record<string, unknown>;
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

/** One `providers{}` entry in models.json, plus unknown keys we round-trip. */
export interface ManagedProvider {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ManagedModel[];
	modelOverrides?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

/** The whole models.json document. */
export interface ModelsFile {
	providers: Record<string, ManagedProvider>;
	[key: string]: unknown;
}

/** Informational metadata that Pi has no field for, kept in a sidecar file. */
export interface ModelMeta {
	toolCall?: boolean;
	structuredOutput?: boolean;
	attachment?: boolean;
	openWeights?: boolean;
	family?: string;
	knowledge?: string;
	releaseDate?: string;
	lastUpdated?: string;
	modelsDevProvider?: string;
	modelsDevModelId?: string;
	/** Where the metadata came from. */
	source?: "models.dev" | "endpoint" | "manual";
	updatedAt?: number;
}

export interface ManagerMeta {
	version: 1;
	models: Record<string, ModelMeta>;
}

/** Both `ctx.ui.select` and `ctx.ui.input` resolve `undefined` when the user cancels. */
export const CANCELLED = Symbol("cancelled");

export type Answer<T> = T | typeof CANCELLED;

export function isCancelled<T>(answer: Answer<T>): answer is typeof CANCELLED {
	return answer === CANCELLED;
}

export function modelMetaKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}
