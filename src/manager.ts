/**
 * Interactive provider manager.
 *
 * Every mutation edits `models.json`, then asks Pi's model registry to reload
 * it. Pi validates the file, composes the providers and keeps streaming them;
 * this extension never talks to a provider API except to list `/models` and to
 * run a test request through Pi's own streaming implementation.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverModels, type DiscoveredModel } from "./endpoint.ts";
import { enrichFromModelsDev, loadCatalog, lookupModel, type CatalogHandle } from "./modelsdev.ts";
import {
	deleteStoredCredential,
	describeApiKeySource,
	dropManagerMetaPrefix,
	escapeConfigValue,
	findModel,
	findProvider,
	getPaths,
	getStoredCredentialKind,
	isObject,
	readManagerMeta,
	readModelsFile,
	saveModelsFile,
	setStoredApiKey,
	writeManagerMeta,
	type Paths,
} from "./store.ts";
import { API_PROTOCOLS, CANCELLED, isCancelled, modelMetaKey, type ManagedModel, type ManagedProvider, type ModelInput, type ModelsFile } from "./types.ts";

const BACK = "← Back";
const STATUS_KEY = "provider-manager";

type Answer<T> = T | typeof CANCELLED;

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

interface Choice<T> {
	label: string;
	value: T;
	disabled?: boolean;
}

async function choose<T>(ctx: ExtensionContext, title: string, choices: readonly Choice<T>[]): Promise<Answer<T>> {
	const usable = choices.filter((choice) => choice.disabled !== true);
	if (usable.length === 0) return CANCELLED;
	const labels = usable.map((choice) => choice.label);
	const picked = await ctx.ui.select(title, labels);
	if (picked === undefined) return CANCELLED;
	const index = labels.indexOf(picked);
	return index >= 0 ? usable[index]!.value : CANCELLED;
}

async function askText(ctx: ExtensionContext, title: string, placeholder?: string): Promise<Answer<string>> {
	const raw = await ctx.ui.input(title, placeholder);
	if (raw === undefined) return CANCELLED;
	return raw.trim();
}

type NumberAnswer = { kind: "value"; value: number } | { kind: "clear" } | { kind: "cancel" };

async function askNumber(ctx: ExtensionContext, title: string, current: number | undefined): Promise<NumberAnswer> {
	const shown = current === undefined ? "(unset)" : String(current);
	const raw = await ctx.ui.input(`${title} — current: ${shown}`, "number, empty to unset");
	if (raw === undefined) return { kind: "cancel" };
	const text = raw.trim();
	if (text === "") return { kind: "clear" };
	const value = Number(text);
	if (Number.isFinite(value) && value > 0) return { kind: "value", value };
	ctx.ui.notify(`Not a positive number: ${text}`, "warning");
	return askNumber(ctx, title, current);
}

async function askYesNo(ctx: ExtensionContext, title: string, current?: boolean): Promise<Answer<boolean>> {
	const shown = current === undefined ? "unset" : current ? "yes" : "no";
	const answer = await choose(ctx, `${title} — current: ${shown}`, [
		{ label: "Yes", value: true },
		{ label: "No", value: false },
	]);
	if (isCancelled(answer)) return CANCELLED;
	return answer;
}

async function editJsonObject(
	ctx: ExtensionContext,
	title: string,
	current: Record<string, unknown> | undefined,
): Promise<Answer<Record<string, unknown> | undefined>> {
	const prefill = current === undefined ? "" : JSON.stringify(current, null, 2);
	const raw = await ctx.ui.editor(title, prefill);
	if (raw === undefined) return CANCELLED;
	const text = raw.trim();
	if (text === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) {
			ctx.ui.notify("Expected a JSON object", "warning");
			return editJsonObject(ctx, title, current);
		}
		return parsed;
	} catch (error) {
		ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return editJsonObject(ctx, title, current);
	}
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(truncate(message, 600), "error");
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatTokens(value: number | undefined): string {
	if (value === undefined) return "?";
	if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

function formatNumber(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function providerModels(provider: ManagedProvider): ManagedModel[] {
	return Array.isArray(provider.models) ? provider.models : [];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function authLabel(ctx: ExtensionContext, providerId: string): string {
	const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
	if (!status.configured) return "no key";
	switch (status.source) {
		case "stored":
			return "stored key (auth.json)";
		case "runtime":
			return "runtime key";
		case "environment":
			return `env ${status.label ?? ""}`.trim();
		case "models_json_key":
			return "literal in models.json";
		case "models_json_command":
			return "command in models.json";
		case "fallback":
			return "extension fallback";
		default:
			return status.source ?? "configured";
	}
}

function providerLabel(ctx: ExtensionContext, provider: ManagedProvider, providerId: string): string {
	const api = typeof provider.api === "string" ? provider.api : "no api";
	const count = providerModels(provider).length;
	const name = typeof provider.name === "string" && provider.name !== "" ? provider.name : providerId;
	return `${providerId} — ${name} [${api}] ${count} model(s) · ${authLabel(ctx, providerId)}`;
}

function modelLabel(model: ManagedModel, meta: { toolCall?: boolean } | undefined): string {
	const parts = [`${model.id}`];
	parts.push(`${formatTokens(model.contextWindow)} ctx / ${formatTokens(model.maxTokens)} out`);
	if (model.reasoning === true) parts.push("reasoning");
	const input = Array.isArray(model.input) ? model.input : ["text"];
	if (input.includes("image")) parts.push("+image");
	if (meta?.toolCall === false) parts.push("no tools");
	if (model.contextWindow === undefined || model.maxTokens === undefined) parts.push("⚠ incomplete");
	return parts.join("  ·  ");
}

function costSummary(model: ManagedModel): string {
	if (!isObject(model.cost)) return "unset";
	return `in $${formatNumber(model.cost.input)} / out $${formatNumber(model.cost.output)}`;
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

async function reloadModels(paths: Paths): Promise<ModelsFile> {
	return readModelsFile(paths);
}

async function save(ctx: ExtensionContext, paths: Paths, file: ModelsFile): Promise<boolean> {
	try {
		await saveModelsFile(paths, ctx.modelRegistry, file);
		return true;
	} catch (error) {
		notifyError(ctx, error);
		return false;
	}
}

async function requireProvider(paths: Paths, providerId: string): Promise<ManagedProvider | undefined> {
	const file = await reloadModels(paths);
	return findProvider(file, providerId);
}

async function withCatalog(ctx: ExtensionContext, paths: Paths, refresh: boolean): Promise<CatalogHandle> {
	ctx.ui.setStatus(STATUS_KEY, refresh ? "Refreshing models.dev…" : "Loading models.dev…");
	try {
		return await loadCatalog(paths, { refresh });
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function toManagedModel(discovered: DiscoveredModel): ManagedModel {
	const model: ManagedModel = { id: discovered.id };
	if (discovered.name !== undefined) model.name = discovered.name;
	if (discovered.contextWindow !== undefined) model.contextWindow = discovered.contextWindow;
	if (discovered.maxTokens !== undefined) model.maxTokens = discovered.maxTokens;
	return model;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runManager(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("The provider manager needs an interactive session.", "error");
		return;
	}
	const paths = getPaths();
	try {
		await reloadModels(paths);
	} catch (error) {
		notifyError(ctx, error);
		return;
	}
	await ctx.waitForIdle();
	await mainMenu(ctx, paths);
}

async function mainMenu(ctx: ExtensionContext, paths: Paths): Promise<void> {
	while (true) {
		let file: ModelsFile;
		try {
			file = await reloadModels(paths);
		} catch (error) {
			notifyError(ctx, error);
			return;
		}
		const ids = Object.keys(file.providers);
		const choices: Choice<string>[] = ids.map((id) => {
			const provider = file.providers[id];
			return { label: isObject(provider) ? providerLabel(ctx, provider as ManagedProvider, id) : `${id} (invalid entry)`, value: id };
		});
		choices.push({ label: "＋ Add provider…", value: "+" });
		choices.push({
			label: "✦ Fill missing metadata from models.dev (all providers)…",
			value: "~enrich",
			disabled: ids.length === 0,
		});
		choices.push({ label: "✕ Close", value: "close" });

		const answer = await choose(ctx, `Provider Manager — ${ids.length} provider(s) in models.json`, choices);
		if (isCancelled(answer) || answer === "close") return;
		if (answer === "+") {
			await addProvider(ctx, paths);
			continue;
		}
		if (answer === "~enrich") {
			await enrichAll(ctx, paths, false);
			continue;
		}
		await providerMenu(ctx, paths, answer);
	}
}

// ---------------------------------------------------------------------------
// Provider level
// ---------------------------------------------------------------------------

async function providerMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const models = providerModels(provider);
		const headers = isObject(provider.headers) ? Object.keys(provider.headers).length : 0;

		const answer = await choose<string>(ctx, `Provider "${providerId}" · key: ${authLabel(ctx, providerId)}`, [
			{ label: `Models (${models.length})…`, value: "models" },
			{ label: "Test connection…", value: "test", disabled: models.length === 0 },
			{ label: "Fetch models from endpoint…", value: "fetch" },
			{ label: "Fill missing metadata from models.dev…", value: "enrich", disabled: models.length === 0 },
			{ label: `API key — ${authLabel(ctx, providerId)}…`, value: "key" },
			{ label: `Edit name (${provider.name ?? "unset"})`, value: "name" },
			{ label: `Edit base URL (${provider.baseUrl ?? "unset"})`, value: "baseUrl" },
			{ label: `API protocol (${provider.api ?? "unset"})`, value: "api" },
			{ label: `Extra headers (${headers})…`, value: "headers" },
			{ label: "Delete provider…", value: "delete" },
			{ label: BACK, value: "back" },
		]);

		if (isCancelled(answer) || answer === "back") return;
		try {
			switch (answer) {
				case "models":
					await modelsMenu(ctx, paths, providerId);
					break;
				case "test":
					await testProvider(ctx, paths, providerId);
					break;
				case "fetch":
					await fetchModels(ctx, paths, providerId);
					break;
				case "enrich":
					await enrichProvider(ctx, paths, providerId);
					break;
				case "key":
					await apiKeyMenu(ctx, paths, providerId);
					break;
				case "name":
					await editName(ctx, paths, providerId);
					break;
				case "baseUrl":
					await editBaseUrl(ctx, paths, providerId);
					break;
				case "api":
					await editApi(ctx, paths, providerId);
					break;
				case "headers":
					await editHeaders(ctx, paths, providerId);
					break;
				case "delete":
					if (await deleteProvider(ctx, paths, providerId)) return;
					break;
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	}
}

async function editName(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const answer = await askText(ctx, `Display name for "${providerId}"`, provider.name ?? providerId);
	if (isCancelled(answer)) return;
	if (answer === "") delete provider.name;
	else provider.name = answer;
	if (await save(ctx, paths, file)) ctx.ui.notify(`Name updated`, "info");
}

async function editBaseUrl(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const answer = await askText(ctx, `Base URL for "${providerId}"`, provider.baseUrl ?? "https://api.example.com/v1");
	if (isCancelled(answer)) return;
	if (answer === "") {
		delete provider.baseUrl;
	} else {
		let url: URL;
		try {
			url = new URL(answer);
		} catch {
			ctx.ui.notify(`Not a valid URL: ${answer}`, "warning");
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			ctx.ui.notify("Base URL must use http or https", "warning");
			return;
		}
		provider.baseUrl = answer.replace(/\/+$/, "");
	}
	if (await save(ctx, paths, file)) ctx.ui.notify("Base URL updated", "info");
}

async function editApi(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const answer = await choose(ctx, `API protocol for "${providerId}"`, [
		...API_PROTOCOLS.map((protocol) => ({ label: protocol, value: protocol as string | undefined })),
		{ label: BACK, value: undefined },
	]);
	if (isCancelled(answer) || answer === undefined) return;
	provider.api = answer;
	if (await save(ctx, paths, file)) ctx.ui.notify(`API protocol set to ${answer}`, "info");
}

async function editHeaders(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const current = isObject(provider.headers) ? (provider.headers as Record<string, unknown>) : undefined;
	const answer = await editJsonObject(ctx, `Headers for "${providerId}" (JSON object)`, current);
	if (isCancelled(answer)) return;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(answer ?? {})) {
		if (typeof value !== "string") {
			ctx.ui.notify(`Header "${key}" must have a string value`, "warning");
			return;
		}
		headers[key] = value;
	}
	if (Object.keys(headers).length === 0) delete provider.headers;
	else provider.headers = headers;
	if (await save(ctx, paths, file)) ctx.ui.notify("Headers updated", "info");
}

async function deleteProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<boolean> {
	const stored = await getStoredCredentialKind(paths, providerId);
	const confirmed = await ctx.ui.confirm(
		`Delete provider "${providerId}"?`,
		`This removes it from models.json${stored === undefined ? "" : " and deletes its stored API key in auth.json"}.`,
	);
	if (!confirmed) return false;
	const file = await reloadModels(paths);
	delete file.providers[providerId];
	if (!(await save(ctx, paths, file))) return false;
	if (stored !== undefined) await deleteStoredCredential(paths, providerId);
	const meta = await readManagerMeta(paths);
	dropManagerMetaPrefix(meta, providerId);
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`Deleted provider "${providerId}"`, "info");
	return true;
}

// ---------------------------------------------------------------------------
// Add provider
// ---------------------------------------------------------------------------

async function addProvider(ctx: ExtensionContext, paths: Paths): Promise<void> {
	const idAnswer = await askText(ctx, "New provider id", "e.g. my-relay");
	if (isCancelled(idAnswer)) return;
	const providerId = idAnswer;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
		ctx.ui.notify("Provider id must start alphanumeric and contain only letters, digits, dot, underscore or dash.", "warning");
		return;
	}
	const file = await reloadModels(paths);
	if (file.providers[providerId] !== undefined) {
		ctx.ui.notify(`"${providerId}" already exists in models.json`, "warning");
		return;
	}
	if (ctx.modelRegistry.getProvider(providerId) !== undefined) {
		const ok = await ctx.ui.confirm(
			`"${providerId}" is a built-in provider`,
			"Models defined here are added to the built-in provider instead of creating an independent one. Continue?",
		);
		if (!ok) return;
	}

	const protocol = await choose(ctx, `API protocol for "${providerId}"`, API_PROTOCOLS.map((value) => ({ label: value, value: value as string })));
	if (isCancelled(protocol)) return;

	const baseUrlAnswer = await askText(ctx, "Base URL", "https://api.example.com/v1");
	if (isCancelled(baseUrlAnswer) || baseUrlAnswer === "") return;
	let baseUrl: string;
	try {
		const parsed = new URL(baseUrlAnswer);
		baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
	} catch {
		ctx.ui.notify(`Not a valid URL: ${baseUrlAnswer}`, "warning");
		return;
	}

	const nameAnswer = await askText(ctx, "Display name", providerId);
	if (isCancelled(nameAnswer)) return;

	file.providers[providerId] = {
		name: nameAnswer === "" ? providerId : nameAnswer,
		baseUrl,
		api: protocol,
	};
	if (!(await save(ctx, paths, file))) return;
	ctx.ui.notify(`Added provider "${providerId}"`, "info");

	if (await ctx.ui.confirm("API key", `Configure an API key for "${providerId}" now?`)) {
		await apiKeyMenu(ctx, paths, providerId);
	}
	if (await ctx.ui.confirm("Models", "Fetch the model list from the endpoint now?")) {
		await fetchModels(ctx, paths, providerId);
	}
	await providerMenu(ctx, paths, providerId);
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

function normalizeEnvReference(input: string): string | undefined {
	const trimmed = input.trim();
	const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed) ?? /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
	return match === null ? undefined : `$${match[1]}`;
}

async function clearInlineKey(provider: ManagedProvider): Promise<void> {
	if (provider.apiKey === undefined) return;
	delete provider.apiKey;
}

async function apiKeyMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const stored = await getStoredCredentialKind(paths, providerId);
		const inline = typeof provider.apiKey === "string" ? provider.apiKey : undefined;

		const answer = await choose<string>(
			ctx,
			`API key — ${providerId} · auth.json: ${stored ?? "none"} · models.json: ${describeApiKeySource(inline)}`,
			[
				{ label: "Enter key and store in auth.json (recommended)", value: "store" },
				{ label: "Enter literal key into models.json", value: "literal" },
				{ label: "Reference an environment variable", value: "env" },
				{ label: "Run a command for the key (!command)", value: "command" },
				{ label: "Remove all stored key material", value: "clear", disabled: stored === undefined && inline === undefined },
				{ label: BACK, value: "back" },
			],
		);

		if (isCancelled(answer) || answer === "back") return;
		try {
			switch (answer) {
				case "store": {
					const key = await askText(ctx, `API key for "${providerId}" (stored in auth.json)`, "sk-…");
					if (isCancelled(key) || key === "") return;
					await setStoredApiKey(paths, providerId, key);
					await clearInlineKey(provider);
					const saved = await save(ctx, paths, file);
					ctx.ui.notify(
						`saved${saved ? "" : " (provider not reloaded)"} — key stored in auth.json; models.json apiKey cleared so there is a single source`,
						saved ? "info" : "warning",
					);
					break;
				}
				case "literal": {
					const key = await askText(ctx, `Literal API key for "${providerId}" (kept in models.json)`, "sk-…");
					if (isCancelled(key) || key === "") return;
					provider.apiKey = escapeConfigValue(key);
					if (stored !== undefined) await deleteStoredCredential(paths, providerId);
					if (await save(ctx, paths, file)) ctx.ui.notify("models.json apiKey set; stored auth.json key removed", "info");
					break;
				}
				case "env": {
					const raw = await askText(ctx, "Environment variable name", "MY_RELAY_API_KEY");
					if (isCancelled(raw) || raw === "") return;
					const reference = normalizeEnvReference(raw);
					if (reference === undefined) {
						ctx.ui.notify(`Not a valid environment variable name: ${raw}`, "warning");
						return;
					}
					provider.apiKey = reference;
					if (stored !== undefined) await deleteStoredCredential(paths, providerId);
					if (await save(ctx, paths, file)) ctx.ui.notify(`models.json apiKey set to ${reference}; stored auth.json key removed`, "info");
					break;
				}
				case "command": {
					const raw = await askText(ctx, "Command whose stdout is the API key", "security find-generic-password -ws 'relay'");
					if (isCancelled(raw) || raw === "") return;
					provider.apiKey = raw.startsWith("!") ? raw : `!${raw}`;
					if (stored !== undefined) await deleteStoredCredential(paths, providerId);
					if (await save(ctx, paths, file)) ctx.ui.notify("models.json apiKey set to a command; stored auth.json key removed", "info");
					break;
				}
				case "clear": {
					const confirmed = await ctx.ui.confirm(`Remove key material for "${providerId}"?`, "Deletes the auth.json entry and the models.json apiKey.");
					if (!confirmed) return;
					if (stored !== undefined) await deleteStoredCredential(paths, providerId);
					await clearInlineKey(provider);
					if (await save(ctx, paths, file)) ctx.ui.notify("API key removed", "info");
					break;
				}
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	}
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function modelsMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const models = providerModels(provider);
		const meta = await readManagerMeta(paths);

		const choices: Choice<string>[] = models.map((model) => ({
			label: modelLabel(model, meta.models[modelMetaKey(providerId, model.id)]),
			value: `model:${model.id}`,
		}));
		choices.push({ label: "＋ Add model manually…", value: "+" });
		choices.push({ label: "↻ Fetch models from endpoint…", value: "~fetch" });
		choices.push({
			label: "✦ Fill missing metadata from models.dev…",
			value: "~enrich",
			disabled: models.length === 0,
		});
		choices.push({ label: BACK, value: "back" });

		const answer = await choose(ctx, `Models of "${providerId}" — ${models.length} configured`, choices);
		if (isCancelled(answer) || answer === "back") return;
		try {
			if (answer === "+") await addModelManually(ctx, paths, providerId);
			else if (answer === "~fetch") await fetchModels(ctx, paths, providerId);
			else if (answer === "~enrich") await enrichProvider(ctx, paths, providerId);
			else if (answer.startsWith("model:")) await modelMenu(ctx, paths, providerId, answer.slice("model:".length));
		} catch (error) {
			notifyError(ctx, error);
		}
	}
}

async function modelMenu(ctx: ExtensionContext, paths: Paths, providerId: string, modelId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		const model = provider === undefined ? undefined : findModel(provider, modelId);
		if (provider === undefined || model === undefined) return;
		const meta = (await readManagerMeta(paths)).models[modelMetaKey(providerId, modelId)];
		const input = Array.isArray(model.input) ? model.input.join("+") : "text";

		const answer = await choose<string>(
			ctx,
			`${providerId}/${modelId}${meta?.toolCall === false ? " · ⚠ no tool calling" : ""}`,
			[
				{ label: `Edit display name (${model.name ?? modelId})`, value: "name" },
				{ label: `Context window (${model.contextWindow ?? "unset"})`, value: "context" },
				{ label: `Max output tokens (${model.maxTokens ?? "unset"})`, value: "maxTokens" },
				{ label: `Reasoning (${model.reasoning === true ? "yes" : "no"})`, value: "reasoning" },
				{ label: `Input modalities (${input})`, value: "input" },
				{ label: `Pricing per 1M tokens (${costSummary(model)})`, value: "cost" },
				{ label: `API override (${model.api ?? "inherit"})`, value: "api" },
				{ label: `Base URL override (${model.baseUrl ?? "inherit"})`, value: "baseUrl" },
				{ label: "Fill metadata from models.dev…", value: "enrich" },
				{ label: "Delete model…", value: "delete" },
				{ label: BACK, value: "back" },
			],
		);
		if (isCancelled(answer) || answer === "back") return;
		try {
			switch (answer) {
				case "name": {
					const value = await askText(ctx, "Display name", model.name ?? modelId);
					if (isCancelled(value)) break;
					if (value === "") delete model.name;
					else model.name = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model name updated", "info");
					break;
				}
				case "context":
				case "maxTokens": {
					const value = await askNumber(ctx, answer === "context" ? "Context window (tokens)" : "Max output tokens", answer === "context" ? model.contextWindow : model.maxTokens);
					if (value.kind === "cancel") break;
					if (value.kind === "clear") delete model[answer];
					else model[answer] = value.value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model metadata updated", "info");
					break;
				}
				case "reasoning": {
					const value = await askYesNo(ctx, "Supports reasoning / thinking", model.reasoning);
					if (isCancelled(value)) break;
					model.reasoning = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model metadata updated", "info");
					break;
				}
				case "input": {
					const value = await choose<ModelInput[]>(ctx, "Input modalities", [
						{ label: "text", value: ["text"] },
						{ label: "text + image", value: ["text", "image"] },
						{ label: BACK, value: [] },
					]);
					if (isCancelled(value) || value.length === 0) break;
					model.input = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model metadata updated", "info");
					break;
				}
				case "cost": {
					const value = await editJsonObject(ctx, "Pricing per 1M tokens — keys: input, output, cacheRead, cacheWrite", isObject(model.cost) ? model.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
					if (isCancelled(value)) break;
					if (value === undefined) delete model.cost;
					else model.cost = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model pricing updated", "info");
					break;
				}
				case "api": {
					const value = await choose<string | undefined>(ctx, "API protocol override", [
						...API_PROTOCOLS.map((protocol) => ({ label: protocol, value: protocol as string | undefined })),
						{ label: "inherit from provider", value: undefined },
						{ label: BACK, value: "__back" },
					]);
					if (isCancelled(value) || value === "__back") break;
					if (value === undefined) delete model.api;
					else model.api = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("Model API override updated", "info");
					break;
				}
				case "baseUrl": {
					const value = await askText(ctx, "Model base URL override", model.baseUrl ?? provider.baseUrl ?? "");
					if (isCancelled(value)) break;
					if (value === "") delete model.baseUrl;
					else model.baseUrl = value.replace(/\/+$/, "");
					if (await save(ctx, paths, file)) ctx.ui.notify("Model base URL updated", "info");
					break;
				}
				case "enrich":
					await fillModelFromModelsDev(ctx, paths, providerId, modelId, false);
					break;
				case "delete": {
					const confirmed = await ctx.ui.confirm(`Delete model "${modelId}"?`, `Removes it from "${providerId}" in models.json.`);
					if (!confirmed) break;
					const fresh = await reloadModels(paths);
					const freshProvider = findProvider(fresh, providerId);
					if (freshProvider === undefined) return;
					freshProvider.models = providerModels(freshProvider).filter((entry) => entry.id !== modelId);
					if (!(await save(ctx, paths, fresh))) break;
					const meta2 = await readManagerMeta(paths);
					delete meta2.models[modelMetaKey(providerId, modelId)];
					await writeManagerMeta(paths, meta2);
					ctx.ui.notify(`Deleted model "${modelId}"`, "info");
					return;
				}
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	}
}

// ---------------------------------------------------------------------------
// Metadata enrichment
// ---------------------------------------------------------------------------

async function fillModelFromModelsDev(
	ctx: ExtensionContext,
	paths: Paths,
	providerId: string,
	modelId: string,
	overwrite: boolean,
	catalog?: CatalogHandle,
): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	const model = provider === undefined ? undefined : findModel(provider, modelId);
	if (provider === undefined || model === undefined) return;

	const handle = catalog ?? (await withCatalog(ctx, paths, false));
	if (handle.error !== undefined) ctx.ui.notify(handle.error, "warning");
	const lookup = lookupModel(handle.index, providerId, modelId);
	if (lookup === undefined) {
		ctx.ui.notify(`models.dev has no metadata for "${modelId}"`, "warning");
		return;
	}
	const enrichment = enrichFromModelsDev(model, lookup, overwrite);
	if (enrichment.filled.length === 0) {
		ctx.ui.notify(`"${modelId}" already has complete metadata`, "info");
		return;
	}
	Object.assign(model, enrichment.patch);
	if (!(await save(ctx, paths, file))) return;
	const meta = await readManagerMeta(paths);
	const key = modelMetaKey(providerId, modelId);
	meta.models[key] = { ...meta.models[key], ...enrichment.meta };
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`Models.dev (${lookup.providerId}) filled ${enrichment.filled.join(", ")} for "${modelId}"`, "info");
}

async function enrichProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const handle = await withCatalog(ctx, paths, false);
	if (handle.error !== undefined) ctx.ui.notify(handle.error, "warning");

	const meta = await readManagerMeta(paths);
	let filled = 0;
	let missed = 0;
	for (const model of providerModels(provider)) {
		const lookup = lookupModel(handle.index, providerId, model.id);
		if (lookup === undefined) {
			missed++;
			continue;
		}
		const enrichment = enrichFromModelsDev(model, lookup, false);
		if (enrichment.filled.length === 0) continue;
		Object.assign(model, enrichment.patch);
		const key = modelMetaKey(providerId, model.id);
		meta.models[key] = { ...meta.models[key], ...enrichment.meta };
		filled++;
	}
	if (filled === 0) {
		ctx.ui.notify(`No metadata changes for "${providerId}" (${missed} model(s) not found on models.dev)`, "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`Enriched ${filled} model(s) of "${providerId}" from models.dev${missed > 0 ? `; ${missed} not found` : ""}`, "info");
}

async function enrichAll(ctx: ExtensionContext, paths: Paths, refresh: boolean): Promise<void> {
	const file = await reloadModels(paths);
	const handle = await withCatalog(ctx, paths, refresh);
	if (handle.error !== undefined) ctx.ui.notify(handle.error, "warning");

	const meta = await readManagerMeta(paths);
	let models = 0;
	for (const [providerId, provider] of Object.entries(file.providers)) {
		if (!isObject(provider)) continue;
		for (const model of providerModels(provider as ManagedProvider)) {
			const lookup = lookupModel(handle.index, providerId, model.id);
			if (lookup === undefined) continue;
			const enrichment = enrichFromModelsDev(model, lookup, false);
			if (enrichment.filled.length === 0) continue;
			Object.assign(model, enrichment.patch);
			const key = modelMetaKey(providerId, model.id);
			meta.models[key] = { ...meta.models[key], ...enrichment.meta };
			models++;
		}
	}
	if (models === 0) {
		ctx.ui.notify("Nothing to enrich from models.dev", "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`Enriched ${models} model(s) from models.dev`, "info");
}

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

async function addDiscoveredModels(ctx: ExtensionContext, paths: Paths, providerId: string, discovered: DiscoveredModel[]): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const handle = await withCatalog(ctx, paths, false);
	const meta = await readManagerMeta(paths);

	const existing = new Set(providerModels(provider).map((model) => model.id));
	let added = 0;
	let withoutMetadata = 0;
	for (const entry of discovered) {
		if (existing.has(entry.id)) continue;
		const model = toManagedModel(entry);
		const lookup = lookupModel(handle.index, providerId, entry.id);
		const enrichment = enrichFromModelsDev(model, lookup, false);
		Object.assign(model, enrichment.patch);
		if (lookup !== undefined) {
			const key = modelMetaKey(providerId, entry.id);
			meta.models[key] = { ...meta.models[key], ...enrichment.meta, source: "endpoint" };
		}
		if (model.name === undefined || model.name === "") model.name = entry.id;
		if (model.contextWindow === undefined || model.maxTokens === undefined) withoutMetadata++;
		provider.models = [...providerModels(provider), model];
		existing.add(entry.id);
		added++;
	}
	if (added === 0) {
		ctx.ui.notify("No new models to add", "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(
		`Added ${added} model(s) to "${providerId}"${withoutMetadata > 0 ? `. ${withoutMetadata} lack context/max-output metadata — consider filling them from models.dev or editing them` : ""}`,
		withoutMetadata > 0 ? "warning" : "info",
	);
}

async function fetchModels(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;

		ctx.ui.setStatus(STATUS_KEY, `Listing models from ${providerId}…`);
		let discovered: DiscoveredModel[];
		let url: string;
		try {
			const result = await discoverModels(ctx, providerId, provider);
			discovered = result.models;
			url = result.url;
		} catch (error) {
			notifyError(ctx, error);
			return;
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		const local = new Set(providerModels(provider).map((model) => model.id));
		const remote = new Set(discovered.map((model) => model.id));
		const missing = discovered.filter((model) => !local.has(model.id));
		const orphaned = [...local].filter((id) => !remote.has(id));

		const answer = await choose<string>(ctx, `Endpoint returned ${discovered.length} model(s) from ${url}`, [
			{ label: `＋ Add ${missing.length} new model(s)`, value: "add", disabled: missing.length === 0 },
			{ label: "Choose models to add…", value: "pick", disabled: missing.length === 0 },
			{
				label: `↻ Add new and remove ${orphaned.length} model(s) no longer offered`,
				value: "replace",
				disabled: missing.length === 0 && orphaned.length === 0,
			},
			{ label: BACK, value: "back" },
		]);

		if (isCancelled(answer) || answer === "back") return;
		try {
			if (answer === "add") {
				await addDiscoveredModels(ctx, paths, providerId, missing);
				return;
			}
			if (answer === "replace") {
				const confirmed = await ctx.ui.confirm(
					`Remove ${orphaned.length} model(s) from "${providerId}"?`,
					orphaned.length === 0 ? "No models to remove." : `Removes: ${orphaned.slice(0, 12).join(", ")}${orphaned.length > 12 ? ", …" : ""}`,
				);
				if (!confirmed) continue;
				const fresh = await reloadModels(paths);
				const freshProvider = findProvider(fresh, providerId);
				if (freshProvider === undefined) return;
				freshProvider.models = providerModels(freshProvider).filter((model) => remote.has(model.id));
				if (!(await save(ctx, paths, fresh))) return;
				const meta = await readManagerMeta(paths);
				for (const id of orphaned) delete meta.models[modelMetaKey(providerId, id)];
				await writeManagerMeta(paths, meta);
				await addDiscoveredModels(ctx, paths, providerId, missing);
				return;
			}
			if (answer === "pick") {
				const picked = await choose(ctx, `Add which model to "${providerId}"?`, [
					...missing.map((model) => ({ label: model.name === undefined ? model.id : `${model.id} — ${model.name}`, value: model.id })),
					{ label: BACK, value: "__back" },
				]);
				if (isCancelled(picked) || picked === "__back") return;
				await addDiscoveredModels(ctx, paths, providerId, missing.filter((model) => model.id === picked));
				return;
			}
		} catch (error) {
			notifyError(ctx, error);
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Manual model entry
// ---------------------------------------------------------------------------

async function addModelManually(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;

	const idAnswer = await askText(ctx, "Model id as the endpoint expects it", "e.g. claude-sonnet-4-5");
	if (isCancelled(idAnswer) || idAnswer === "") return;
	if (findModel(provider, idAnswer) !== undefined) {
		ctx.ui.notify(`"${idAnswer}" already exists on "${providerId}"`, "warning");
		return;
	}

	const model: ManagedModel = { id: idAnswer };
	const handle = await withCatalog(ctx, paths, false);
	const lookup = lookupModel(handle.index, providerId, idAnswer);
	const enrichment = enrichFromModelsDev(model, lookup, false);
	Object.assign(model, enrichment.patch);

	if (lookup === undefined) {
		ctx.ui.notify(`models.dev has no entry for "${idAnswer}"; enter metadata manually`, "warning");
	}
	if (model.name === undefined) {
		const name = await askText(ctx, "Display name", idAnswer);
		if (isCancelled(name)) return;
		model.name = name === "" ? idAnswer : name;
	}
	if (model.contextWindow === undefined) {
		const value = await askNumber(ctx, "Context window (tokens)", 128000);
		if (value.kind === "cancel") return;
		if (value.kind === "value") model.contextWindow = value.value;
	}
	if (model.maxTokens === undefined) {
		const value = await askNumber(ctx, "Max output tokens", 16384);
		if (value.kind === "cancel") return;
		if (value.kind === "value") model.maxTokens = value.value;
	}
	if (model.reasoning === undefined) {
		const value = await askYesNo(ctx, "Supports reasoning / thinking", false);
		if (isCancelled(value)) return;
		model.reasoning = value;
	}

	provider.models = [...providerModels(provider), model];
	if (!(await save(ctx, paths, file))) return;
	if (lookup !== undefined) {
		const meta = await readManagerMeta(paths);
		const key = modelMetaKey(providerId, idAnswer);
		meta.models[key] = { ...meta.models[key], ...enrichment.meta, source: "manual" };
		await writeManagerMeta(paths, meta);
	}
	ctx.ui.notify(`Added model "${idAnswer}" to "${providerId}"`, "info");
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

async function testProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const models = providerModels(provider);
	if (models.length === 0) {
		ctx.ui.notify(`"${providerId}" has no models to test`, "warning");
		return;
	}

	const modelId = await choose(
		ctx,
		`Test "${providerId}" with which model?`,
		models.map((model) => ({ label: modelLabel(model, undefined), value: model.id })),
	);
	if (isCancelled(modelId)) return;

	const model = ctx.modelRegistry.find(providerId, modelId);
	if (model === undefined) {
		ctx.ui.notify(`"${providerId}/${modelId}" is not registered yet. Save and reload first.`, "warning");
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 120_000);
	ctx.ui.setStatus(STATUS_KEY, `Testing ${providerId}/${modelId}…`);
	const startedAt = Date.now();
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }] },
			{ maxTokens: 64, signal: controller.signal },
		);
		const result = await stream.result();
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		if (result.stopReason === "error") throw new Error(result.errorMessage ?? "provider returned an error");
		if (result.stopReason === "aborted") throw new Error("request aborted");
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(" ")
			.trim();
		ctx.ui.notify(
			`✓ ${providerId}/${modelId} in ${elapsed}s · ${result.usage.input} in / ${result.usage.output} out${text === "" ? "" : ` · "${truncate(text, 60)}"`}`,
			"info",
		);
	} catch (error) {
		notifyError(ctx, new Error(`${providerId}/${modelId} failed: ${error instanceof Error ? error.message : String(error)}`));
	} finally {
		clearTimeout(timeout);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}
