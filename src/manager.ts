/**
 * 交互式 Provider 管理器。
 *
 * 所有修改都写进 `models.json`，然后让 Pi 的 model registry 重新加载。
 * 校验、provider 组合和流式请求全部由 Pi 负责；这个扩展除了列 `/models`
 * 和通过 Pi 自己的 streaming 实现发一次测试请求之外，不直接访问 provider API。
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverModels, type DiscoveredModel } from "./endpoint.ts";
import { enrichFromModelsDev, loadCatalog, lookupModel, type CatalogHandle } from "./modelsdev.ts";
import { canPick, pickList, type PickItem } from "./picker.ts";
import { runWizard, type WizardStep } from "./wizard.ts";
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
import { API_PROTOCOLS, CANCELLED, isCancelled, modelMetaKey, type ManagedModel, type ManagedProvider, type ModelInput, type ModelMeta, type ModelsFile } from "./types.ts";

const BACK = "← 返回";
const STATUS_KEY = "provider-manager";

type Answer<T> = T | typeof CANCELLED;

// ---------------------------------------------------------------------------
// UI 小工具
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
	const shown = current === undefined ? "（未设置）" : String(current);
	const raw = await ctx.ui.input(`${title} — 当前：${shown}`, "数字，留空表示不设置");
	if (raw === undefined) return { kind: "cancel" };
	const text = raw.trim();
	if (text === "") return { kind: "clear" };
	const value = Number(text);
	if (Number.isFinite(value) && value > 0) return { kind: "value", value };
	ctx.ui.notify(`不是正数：${text}`, "warning");
	return askNumber(ctx, title, current);
}

async function askYesNo(ctx: ExtensionContext, title: string, current?: boolean): Promise<Answer<boolean>> {
	const shown = current === undefined ? "未设置" : current ? "是" : "否";
	const answer = await choose(ctx, `${title} — 当前：${shown}`, [
		{ label: "是", value: true },
		{ label: "否", value: false },
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
			ctx.ui.notify("需要是一个 JSON 对象", "warning");
			return editJsonObject(ctx, title, current);
		}
		return parsed;
	} catch (error) {
		ctx.ui.notify(`JSON 无效：${error instanceof Error ? error.message : String(error)}`, "warning");
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
// 文案
// ---------------------------------------------------------------------------

function authLabel(ctx: ExtensionContext, providerId: string): string {
	const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
	if (!status.configured) return "无 key";
	switch (status.source) {
		case "stored":
			return "已存 key (auth.json)";
		case "runtime":
			return "运行时 key";
		case "environment":
			return `环境变量 ${status.label ?? ""}`.trim();
		case "models_json_key":
			return "models.json 字面量";
		case "models_json_command":
			return "models.json 命令";
		case "fallback":
			return "扩展回退";
		default:
			return status.source ?? "已配置";
	}
}

function providerLabel(ctx: ExtensionContext, provider: ManagedProvider, providerId: string): string {
	const api = typeof provider.api === "string" ? provider.api : "未设 api";
	const count = providerModels(provider).length;
	const name = typeof provider.name === "string" && provider.name !== "" ? provider.name : providerId;
	return `${providerId} — ${name} [${api}] ${count} 个模型 · ${authLabel(ctx, providerId)}`;
}

function modelLabel(model: ManagedModel, meta: { toolCall?: boolean } | undefined): string {
	const parts = [`${model.id}`];
	parts.push(`上下文 ${formatTokens(model.contextWindow)} / 输出 ${formatTokens(model.maxTokens)}`);
	if (model.reasoning === true) parts.push("推理");
	const input = Array.isArray(model.input) ? model.input : ["text"];
	if (input.includes("image")) parts.push("+图片");
	if (meta?.toolCall === false) parts.push("无工具调用");
	if (model.contextWindow === undefined || model.maxTokens === undefined) parts.push("⚠ 信息不全");
	return parts.join("  ·  ");
}

function costSummary(model: ManagedModel): string {
	if (!isObject(model.cost)) return "未设置";
	return `入 $${formatNumber(model.cost.input)} / 出 $${formatNumber(model.cost.output)}`;
}

/** 列表里的副标题（模型 id 已经当主标题了）。 */
function modelDescription(model: ManagedModel, meta: { toolCall?: boolean } | undefined): string {
	const parts = [`上下文 ${formatTokens(model.contextWindow)} / 输出 ${formatTokens(model.maxTokens)}`];
	if (model.reasoning === true) parts.push("推理");
	const input = Array.isArray(model.input) ? model.input : ["text"];
	if (input.includes("image")) parts.push("+图片");
	if (meta?.toolCall === false) parts.push("无工具调用");
	if (model.contextWindow === undefined || model.maxTokens === undefined) parts.push("⚠ 信息不全");
	return parts.join(" · ");
}

/** 从端点拿到的模型在列表里的副标题。 */
function discoveredDescription(model: DiscoveredModel, isConfigured: boolean): string {
	const parts: string[] = [];
	if (model.name !== undefined && model.name !== model.id) parts.push(model.name);
	const limits: string[] = [];
	if (model.contextWindow !== undefined) limits.push(`上下文 ${formatTokens(model.contextWindow)}`);
	if (model.maxTokens !== undefined) limits.push(`输出 ${formatTokens(model.maxTokens)}`);
	if (limits.length > 0) parts.push(limits.join(" / "));
	parts.push(isConfigured ? "已配置" : "未添加");
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 公共操作
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

async function withCatalog(ctx: ExtensionContext, paths: Paths, refresh: boolean, label = "models.dev"): Promise<CatalogHandle> {
	ctx.ui.setStatus(STATUS_KEY, refresh ? `${label} · 正在刷新…` : `${label} · 正在读取…`);
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
// 入口
// ---------------------------------------------------------------------------

export async function runManager(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Provider 管理器需要交互式会话。", "error");
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
			return { label: isObject(provider) ? providerLabel(ctx, provider as ManagedProvider, id) : `${id}（无效条目）`, value: id };
		});
		choices.push({ label: "＋ 添加 provider…", value: "+" });
		choices.push({
			label: "✦ 用 models.dev 补全缺失信息（所有 provider）…",
			value: "~enrich",
			disabled: ids.length === 0,
		});
		choices.push({ label: "✕ 关闭", value: "close" });

		const answer = await choose(ctx, `Provider 管理器 — models.json 中有 ${ids.length} 个 provider`, choices);
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
// Provider 层级
// ---------------------------------------------------------------------------

async function providerMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const models = providerModels(provider);
		const headers = isObject(provider.headers) ? Object.keys(provider.headers).length : 0;

		const answer = await choose<string>(ctx, `Provider "${providerId}" · key：${authLabel(ctx, providerId)}`, [
			{ label: "测试连接…", value: "test", disabled: models.length === 0 },
			{ label: "从端点获取模型列表…", value: "fetch" },
			{ label: `模型（${models.length}）…`, value: "models" },
			{ label: "用 models.dev 补全缺失信息…", value: "enrich", disabled: models.length === 0 },
			{ label: `API key — ${authLabel(ctx, providerId)}…`, value: "key" },
			{ label: `修改供应商名称（${provider.name ?? "未设置"}）`, value: "name" },
			{ label: `修改 Base URL（${provider.baseUrl ?? "未设置"}）`, value: "baseUrl" },
			{ label: `API 协议（${provider.api ?? "未设置"}）`, value: "api" },
			{ label: `附加 Headers（${headers}）…`, value: "headers" },
			{ label: "删除 provider…", value: "delete" },
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
	const answer = await askText(ctx, `"${providerId}" 的供应商名称`, provider.name ?? providerId);
	if (isCancelled(answer)) return;
	if (answer === "") delete provider.name;
	else provider.name = answer;
	if (await save(ctx, paths, file)) ctx.ui.notify("供应商名称已更新", "info");
}

async function editBaseUrl(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const answer = await askText(ctx, `"${providerId}" 的 Base URL`, provider.baseUrl ?? "https://api.example.com/v1");
	if (isCancelled(answer)) return;
	if (answer === "") {
		delete provider.baseUrl;
	} else {
		let url: URL;
		try {
			url = new URL(answer);
		} catch {
			ctx.ui.notify(`无效 URL：${answer}`, "warning");
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			ctx.ui.notify("Base URL 必须使用 http 或 https", "warning");
			return;
		}
		provider.baseUrl = answer.replace(/\/+$/, "");
	}
	if (await save(ctx, paths, file)) ctx.ui.notify("Base URL 已更新", "info");
}

async function editApi(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const answer = await choose(ctx, `"${providerId}" 的 API 协议`, [
		...API_PROTOCOLS.map((protocol) => ({ label: protocol, value: protocol as string | undefined })),
		{ label: BACK, value: undefined },
	]);
	if (isCancelled(answer) || answer === undefined) return;
	provider.api = answer;
	if (await save(ctx, paths, file)) ctx.ui.notify(`API 协议已设为 ${answer}`, "info");
}

async function editHeaders(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const current = isObject(provider.headers) ? (provider.headers as Record<string, unknown>) : undefined;
	const answer = await editJsonObject(ctx, `"${providerId}" 的附加 Headers（JSON 对象）`, current);
	if (isCancelled(answer)) return;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(answer ?? {})) {
		if (typeof value !== "string") {
			ctx.ui.notify(`Header "${key}" 的值必须是字符串`, "warning");
			return;
		}
		headers[key] = value;
	}
	if (Object.keys(headers).length === 0) delete provider.headers;
	else provider.headers = headers;
	if (await save(ctx, paths, file)) ctx.ui.notify("Headers 已更新", "info");
}

async function deleteProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<boolean> {
	const stored = await getStoredCredentialKind(paths, providerId);
	const confirmed = await ctx.ui.confirm(
		`删除 provider "${providerId}"？`,
		`会把它从 models.json 中移除${stored === undefined ? "" : "，并删除 auth.json 里存的 API key"}。`,
	);
	if (!confirmed) return false;
	const file = await reloadModels(paths);
	delete file.providers[providerId];
	if (!(await save(ctx, paths, file))) return false;
	if (stored !== undefined) await deleteStoredCredential(paths, providerId);
	const meta = await readManagerMeta(paths);
	dropManagerMetaPrefix(meta, providerId);
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`已删除 provider "${providerId}"`, "info");
	return true;
}

// ---------------------------------------------------------------------------
// 添加 provider
// ---------------------------------------------------------------------------

interface ProviderDraft {
	id: string;
	name: string;
	protocol: string;
	baseUrl: string;
	key: string;
}

async function addProvider(ctx: ExtensionContext, paths: Paths): Promise<void> {
	const draft: ProviderDraft = { id: "", name: "", protocol: "", baseUrl: "", key: "" };

	const steps: WizardStep<ProviderDraft>[] = [
		{
			label: "provider id",
			run: async (c, d, progress) => {
				while (true) {
					const answer = await askText(c, `${progress} · provider id`, "例如 my-relay（供应商名称默认同 id）");
					if (isCancelled(answer)) return false;
					if (answer === "") {
						c.ui.notify("provider id 不能为空", "warning");
						continue;
					}
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(answer)) {
						c.ui.notify("provider id 必须以字母或数字开头，只能包含字母、数字、点、下划线、短横线。", "warning");
						continue;
					}
					const current = await reloadModels(paths);
					if (current.providers[answer] !== undefined) {
						c.ui.notify(`models.json 中已存在 "${answer}"`, "warning");
						continue;
					}
					if (c.modelRegistry.getProvider(answer) !== undefined) {
						const ok = await c.ui.confirm(
							`"${answer}" 是内置 provider`,
							"这里定义的模型会被加到内置 provider 上，而不是创建一个独立 provider。要继续吗？",
						);
						if (!ok) continue;
					}
					d.id = answer;
					return true;
				}
			},
		},
		{
			label: "供应商名称",
			run: async (c, d, progress) => {
				const answer = await askText(c, `${progress} · 供应商名称（${d.id}）`, d.name === "" ? `${d.id}（留空即用 id）` : d.name);
				if (isCancelled(answer)) return false;
				d.name = answer === "" ? d.id : answer;
				return true;
			},
		},
		{
			label: "API 协议",
			run: async (c, d, progress) => {
				const protocol = await choose(
					c,
					`${progress} · API 协议（${d.id}）`,
					API_PROTOCOLS.map((value) => ({ label: value, value: value as string })),
				);
				if (isCancelled(protocol)) return false;
				d.protocol = protocol;
				return true;
			},
		},
		{
			label: "Base URL",
			run: async (c, d, progress) => {
				while (true) {
					const answer = await askText(c, `${progress} · Base URL（${d.id}）`, d.baseUrl === "" ? "https://api.example.com/v1" : d.baseUrl);
					if (isCancelled(answer)) return false;
					if (answer === "") {
						c.ui.notify("Base URL 不能为空", "warning");
						continue;
					}
					try {
						const parsed = new URL(answer);
						d.baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
						return true;
					} catch {
						c.ui.notify(`无效 URL：${answer}`, "warning");
						continue;
					}
				}
			},
		},
		{
			label: "API key（留空跳过）",
			run: async (c, d, progress) => {
				const key = await askText(c, `${progress} · API key（${d.id}，留空跳过）`, "sk-…（存入 auth.json）");
				// Esc 在这里也是「退回上一步」，不是跳过：跳过请直接回车
				if (isCancelled(key)) return false;
				d.key = key;
				return true;
			},
		},
	];

	const result = await runWizard(ctx, draft, steps, { progress: (_d, position, total) => `添加 provider  ${position}/${total}` });
	if (result === undefined) return;

	// 前三步都过了才落盘，避免在 models.json 留半成品
	const file = await reloadModels(paths);
	file.providers[result.id] = {
		name: result.name === "" ? result.id : result.name,
		baseUrl: result.baseUrl,
		api: result.protocol,
	};
	if (!(await save(ctx, paths, file))) return;

	let keySaved = false;
	if (result.key !== "") {
		try {
			await setStoredApiKey(paths, result.id, result.key);
			const afterKey = await reloadModels(paths);
			const provider = findProvider(afterKey, result.id);
			if (provider !== undefined) await clearInlineKey(provider);
			keySaved = await save(ctx, paths, afterKey);
		} catch (error) {
			notifyError(ctx, error);
		}
	}

	ctx.ui.notify(
		`已添加 provider "${result.id}"（供应商名称：${result.name === "" ? result.id : result.name}）${keySaved ? "，key 已存入 auth.json" : "（未配置 key）"}`,
		"info",
	);
	await providerMenu(ctx, paths, result.id);
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

/**
 * 修改 key 的入口。每次进入只做一件事，做完就返回上一层，
 * 不再回到自己（否则输完 key 还要手动“返回”才能往前走）。
 */
async function apiKeyMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const stored = await getStoredCredentialKind(paths, providerId);
	const inline = typeof provider.apiKey === "string" ? provider.apiKey : undefined;

	const answer = await choose<string>(
		ctx,
		`${providerId} › API key · auth.json：${stored === undefined ? "无" : "已存 key"} · models.json：${describeApiKeySource(inline)}`,
		[
			{ label: "输入 key 并存到 auth.json（推荐）", value: "store" },
			{ label: "输入 key 直接写进 models.json", value: "literal" },
			{ label: "引用环境变量", value: "env" },
			{ label: "用命令获取 key（!command）", value: "command" },
			{ label: "清除所有已存的 key", value: "clear", disabled: stored === undefined && inline === undefined },
			{ label: BACK, value: "back" },
		],
	);

	if (isCancelled(answer) || answer === "back") return;
	try {
		switch (answer) {
			case "store": {
				const key = await askText(ctx, `${providerId} › API key（存到 auth.json）`, "sk-…");
				if (isCancelled(key) || key === "") return;
				await setStoredApiKey(paths, providerId, key);
				await clearInlineKey(provider);
				const saved = await save(ctx, paths, file);
				ctx.ui.notify(
					`已保存${saved ? "" : "（但 provider 未能重新加载）"} — key 已存进 auth.json，models.json 的 apiKey 已清空以保证只有一个来源`,
					saved ? "info" : "warning",
				);
				return;
			}
			case "literal": {
				const key = await askText(ctx, `${providerId} › 字面量 API key（写进 models.json）`, "sk-…");
				if (isCancelled(key) || key === "") return;
				provider.apiKey = escapeConfigValue(key);
				if (stored !== undefined) await deleteStoredCredential(paths, providerId);
				if (await save(ctx, paths, file)) ctx.ui.notify("models.json 的 apiKey 已设置，auth.json 里存的 key 已删除", "info");
				return;
			}
			case "env": {
				const raw = await askText(ctx, `${providerId} › 环境变量名`, "MY_RELAY_API_KEY");
				if (isCancelled(raw) || raw === "") return;
				const reference = normalizeEnvReference(raw);
				if (reference === undefined) {
					ctx.ui.notify(`不是合法的环境变量名：${raw}`, "warning");
					return;
				}
				provider.apiKey = reference;
				if (stored !== undefined) await deleteStoredCredential(paths, providerId);
				if (await save(ctx, paths, file)) ctx.ui.notify(`models.json 的 apiKey 已设为 ${reference}，auth.json 里存的 key 已删除`, "info");
				return;
			}
			case "command": {
				const raw = await askText(ctx, `${providerId} › 输出 API key 的命令（取 stdout）`, "security find-generic-password -ws 'relay'");
				if (isCancelled(raw) || raw === "") return;
				provider.apiKey = raw.startsWith("!") ? raw : `!${raw}`;
				if (stored !== undefined) await deleteStoredCredential(paths, providerId);
				if (await save(ctx, paths, file)) ctx.ui.notify("models.json 的 apiKey 已设为命令，auth.json 里存的 key 已删除", "info");
				return;
			}
			case "clear": {
				const confirmed = await ctx.ui.confirm(`清除 ${providerId} 的 key 信息？`, "会删除 auth.json 里的条目和 models.json 的 apiKey。");
				if (!confirmed) return;
				if (stored !== undefined) await deleteStoredCredential(paths, providerId);
				await clearInlineKey(provider);
				if (await save(ctx, paths, file)) ctx.ui.notify("API key 已清除", "info");
				return;
			}
		}
	} catch (error) {
		notifyError(ctx, error);
	}
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

async function modelsMenu(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const models = providerModels(provider);
		const meta = await readManagerMeta(paths);

		// TUI：用可滚动列表（provider 可能有上百个模型，ctx.ui.select 放不下）
		if (canPick(ctx)) {
			const items: PickItem[] = models.map((model) => ({
				value: `::model:${model.id}`,
				label: model.id,
				description: modelDescription(model, meta.models[modelMetaKey(providerId, model.id)]),
			}));
			items.push({ value: "::add", label: "＋ 手动添加模型", description: "输入模型 id，然后从 models.dev 补全信息" });
			items.push({ value: "::fetch", label: "↻ 从端点获取模型列表", description: "请求端点的 /models" });
			if (models.length > 0) {
				items.push({ value: "::enrich", label: "✦ 用 models.dev 补全缺失信息", description: `检查全部 ${models.length} 个模型` });
			}
			const picked = await pickList(ctx, `${providerId} › 模型（${models.length} 个）`, items, {
				maxVisible: 16,
				footer: "输入关键字筛选 · ↑↓ 选择 · Enter 进入 · Esc 返回",
			});
			if (picked === undefined) return;
			try {
				if (picked === "::add") await addModelManually(ctx, paths, providerId);
				else if (picked === "::fetch") await fetchModels(ctx, paths, providerId);
				else if (picked === "::enrich") await enrichProvider(ctx, paths, providerId);
				else if (picked.startsWith("::model:")) await modelMenu(ctx, paths, providerId, picked.slice("::model:".length));
			} catch (error) {
				notifyError(ctx, error);
			}
			continue;
		}

		// 非 TUI（RPC / print）：没有自定义组件，用选项菜单降级
		const choices: Choice<string>[] = models.map((model) => ({
			label: modelLabel(model, meta.models[modelMetaKey(providerId, model.id)]),
			value: `model:${model.id}`,
		}));
		choices.push({ label: "＋ 手动添加模型…", value: "+" });
		choices.push({ label: "↻ 从端点获取模型列表…", value: "~fetch" });
		choices.push({
			label: "✦ 用 models.dev 补全缺失信息…",
			value: "~enrich",
			disabled: models.length === 0,
		});
		choices.push({ label: BACK, value: "back" });

		const answer = await choose(ctx, `${providerId} › 模型（${models.length} 个）`, choices);
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
			`${providerId} › ${modelId}${meta?.toolCall === false ? " · ⚠ 不支持工具调用" : ""}`,
			[
				{ label: `修改显示名（${model.name ?? modelId}）`, value: "name" },
				{ label: `上下文窗口（${model.contextWindow ?? "未设置"}）`, value: "context" },
				{ label: `最大输出 tokens（${model.maxTokens ?? "未设置"}）`, value: "maxTokens" },
				{ label: `推理（${model.reasoning === true ? "是" : "否"}）`, value: "reasoning" },
				{ label: `输入模态（${input}）`, value: "input" },
				{ label: `价格 / 1M tokens（${costSummary(model)}）`, value: "cost" },
				{ label: `API 覆盖（${model.api ?? "跟随 provider"}）`, value: "api" },
				{ label: `Base URL 覆盖（${model.baseUrl ?? "跟随 provider"}）`, value: "baseUrl" },
				{ label: "用 models.dev 补全信息…", value: "enrich" },
				{ label: "删除模型…", value: "delete" },
				{ label: BACK, value: "back" },
			],
		);
		if (isCancelled(answer) || answer === "back") return;
		try {
			switch (answer) {
				case "name": {
					const value = await askText(ctx, "显示名", model.name ?? modelId);
					if (isCancelled(value)) break;
					if (value === "") delete model.name;
					else model.name = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型显示名已更新", "info");
					break;
				}
				case "context":
				case "maxTokens": {
					const value = await askNumber(ctx, answer === "context" ? "上下文窗口（tokens）" : "最大输出 tokens", answer === "context" ? model.contextWindow : model.maxTokens);
					if (value.kind === "cancel") break;
					if (value.kind === "clear") delete model[answer];
					else model[answer] = value.value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型信息已更新", "info");
					break;
				}
				case "reasoning": {
					const value = await askYesNo(ctx, "是否支持推理 / thinking", model.reasoning);
					if (isCancelled(value)) break;
					model.reasoning = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型信息已更新", "info");
					break;
				}
				case "input": {
					const value = await choose<ModelInput[]>(ctx, "输入模态", [
						{ label: "纯文本", value: ["text"] },
						{ label: "文本 + 图片", value: ["text", "image"] },
						{ label: BACK, value: [] },
					]);
					if (isCancelled(value) || value.length === 0) break;
					model.input = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型信息已更新", "info");
					break;
				}
				case "cost": {
					const value = await editJsonObject(ctx, "价格 / 1M tokens — 键：input, output, cacheRead, cacheWrite", isObject(model.cost) ? model.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
					if (isCancelled(value)) break;
					if (value === undefined) delete model.cost;
					else model.cost = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型价格已更新", "info");
					break;
				}
				case "api": {
					const value = await choose<string | undefined>(ctx, "API 协议覆盖", [
						...API_PROTOCOLS.map((protocol) => ({ label: protocol, value: protocol as string | undefined })),
						{ label: "跟随 provider", value: undefined },
						{ label: BACK, value: "__back" },
					]);
					if (isCancelled(value) || value === "__back") break;
					if (value === undefined) delete model.api;
					else model.api = value;
					if (await save(ctx, paths, file)) ctx.ui.notify("模型 API 覆盖已更新", "info");
					break;
				}
				case "baseUrl": {
					const value = await askText(ctx, "模型 Base URL 覆盖", model.baseUrl ?? provider.baseUrl ?? "");
					if (isCancelled(value)) break;
					if (value === "") delete model.baseUrl;
					else model.baseUrl = value.replace(/\/+$/, "");
					if (await save(ctx, paths, file)) ctx.ui.notify("模型 Base URL 已更新", "info");
					break;
				}
				case "enrich":
					await fillModelFromModelsDev(ctx, paths, providerId, modelId, false);
					break;
				case "delete": {
					const confirmed = await ctx.ui.confirm(`删除模型 "${modelId}"？`, `会把它从 models.json 的 "${providerId}" 中移除。`);
					if (!confirmed) break;
					const fresh = await reloadModels(paths);
					const freshProvider = findProvider(fresh, providerId);
					if (freshProvider === undefined) return;
					freshProvider.models = providerModels(freshProvider).filter((entry) => entry.id !== modelId);
					if (!(await save(ctx, paths, fresh))) break;
					const meta2 = await readManagerMeta(paths);
					delete meta2.models[modelMetaKey(providerId, modelId)];
					await writeManagerMeta(paths, meta2);
					ctx.ui.notify(`已删除模型 "${modelId}"`, "info");
					return;
				}
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	}
}

// ---------------------------------------------------------------------------
// 补全信息
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

	const handle = catalog ?? (await withCatalog(ctx, paths, false, `补全信息 · 读取 models.dev`));
	if (handle.error !== undefined) ctx.ui.notify(handle.error, "warning");
	const lookup = lookupModel(handle.index, providerId, modelId);
	if (lookup === undefined) {
		ctx.ui.notify(`models.dev 中找不到 "${modelId}" 的信息`, "warning");
		return;
	}
	const enrichment = enrichFromModelsDev(model, lookup, overwrite);
	if (enrichment.filled.length === 0) {
		ctx.ui.notify(`"${modelId}" 的信息已经完整，无需补全`, "info");
		return;
	}
	Object.assign(model, enrichment.patch);
	if (!(await save(ctx, paths, file))) return;
	const meta = await readManagerMeta(paths);
	const key = modelMetaKey(providerId, modelId);
	meta.models[key] = { ...meta.models[key], ...enrichment.meta };
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`已用 models.dev（${lookup.providerId}）补全 ${enrichment.filled.join(", ")}：${modelId}`, "info");
}

async function enrichProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const handle = await withCatalog(ctx, paths, false, `${providerId} › 补全信息 · 读取 models.dev`);
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
		ctx.ui.notify(`"${providerId}" 没有需要补全的信息（${missed} 个模型在 models.dev 中找不到）`, "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`已补全 ${filled} 个模型（provider "${providerId}"），来源 models.dev${missed > 0 ? `；${missed} 个未找到` : ""}`, "info");
}

async function enrichAll(ctx: ExtensionContext, paths: Paths, refresh: boolean): Promise<void> {
	const file = await reloadModels(paths);
	const handle = await withCatalog(ctx, paths, refresh, "补全信息（全部 provider） · 读取 models.dev");
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
		ctx.ui.notify("没有需要从 models.dev 补全的信息", "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(`已用 models.dev 补全 ${models} 个模型`, "info");
}

// ---------------------------------------------------------------------------
// 从端点获取模型
// ---------------------------------------------------------------------------

async function addDiscoveredModels(ctx: ExtensionContext, paths: Paths, providerId: string, discovered: DiscoveredModel[]): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const handle = await withCatalog(ctx, paths, false, `添加模型 · 读取 models.dev`);
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
		ctx.ui.notify("没有新模型可添加", "info");
		return;
	}
	if (!(await save(ctx, paths, file))) return;
	await writeManagerMeta(paths, meta);
	ctx.ui.notify(
		`已添加 ${added} 个模型到 "${providerId}"${withoutMetadata > 0 ? `。其中 ${withoutMetadata} 个缺少上下文/最大输出信息，建议用 models.dev 补全或手动编辑` : ""}`,
		withoutMetadata > 0 ? "warning" : "info",
	);
}

async function fetchModels(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const initial = await reloadModels(paths);
	const initialProvider = findProvider(initial, providerId);
	if (initialProvider === undefined) return;

	// 1/2 请求端点（只请求一次，后面选模型不再重复发请求）
	ctx.ui.setStatus(STATUS_KEY, `获取模型 1/2 · 正在请求 ${providerId} 的端点…`);
	let discovered: DiscoveredModel[];
	let url: string;
	try {
		const result = await discoverModels(ctx, providerId, initialProvider);
		discovered = result.models;
		url = result.url;
	} catch (error) {
		notifyError(ctx, error);
		return;
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	const remoteIds = new Set(discovered.map((model) => model.id));

	// 2/2 展示模型列表
	while (true) {
		const file = await reloadModels(paths);
		const provider = findProvider(file, providerId);
		if (provider === undefined) return;
		const configured = new Map(providerModels(provider).map((model) => [model.id, model]));
		const missing = discovered.filter((model) => !configured.has(model.id));
		const orphaned = [...configured.keys()].filter((id) => !remoteIds.has(id));
		const title = `${providerId} 端点返回 ${discovered.length} 个模型（已配置 ${configured.size} 个）· ${url}`;

		// TUI：直接把端点返回的模型列出来，逐个挑或批量加
		if (canPick(ctx)) {
			const items: PickItem[] = discovered.map((model) => ({
				value: model.id,
				label: `${configured.has(model.id) ? "✓" : "＋"} ${model.id}`,
				description: discoveredDescription(model, configured.has(model.id)),
			}));
			for (const id of orphaned) {
				items.push({ value: `::local:${id}`, label: `⚠ ${id}`, description: "端点未提供，本地保留" });
			}
			if (missing.length > 0) {
				items.push({ value: "::all", label: `＋ 添加全部 ${missing.length} 个未配置模型`, description: "一次写入 models.json" });
			}
			if (missing.length > 0 || orphaned.length > 0) {
				items.push({
					value: "::sync",
					label: `↻ 同步：添加 ${missing.length} 个，移除 ${orphaned.length} 个`,
					description: "让本地列表和端点完全一致",
				});
			}
			const picked = await pickList(ctx, title, items, {
				maxVisible: 16,
				footer: "输入关键字筛选 · ↑↓ 选择 · Enter 添加 · Esc 返回",
			});
			if (picked === undefined) return;
			try {
				if (picked.startsWith("::local:")) {
					ctx.ui.notify(`"${picked.slice("::local:".length)}" 已经配置过了`, "info");
					continue;
				}
				if (picked === "::all") {
					await addDiscoveredModels(ctx, paths, providerId, missing);
					return;
				}
				if (picked === "::sync") {
					await syncEndpoint(ctx, paths, providerId, discovered);
					return;
				}
				// 选单个模型：加完留在列表里，方便接着挑
				const model = discovered.find((entry) => entry.id === picked);
				if (model !== undefined && !configured.has(model.id)) {
					await addDiscoveredModels(ctx, paths, providerId, [model]);
				} else {
					ctx.ui.notify(`"${picked}" 已经配置过了`, "info");
				}
				continue;
			} catch (error) {
				notifyError(ctx, error);
				return;
			}
		}

		// 非 TUI（RPC / print）降级：只能给出批量选项
		const answer = await choose<string>(ctx, `获取模型 2/2 · ${title}`, [
			{ label: `＋ 添加 ${missing.length} 个新模型`, value: "add", disabled: missing.length === 0 },
			{ label: "选择要添加的模型…", value: "pick", disabled: missing.length === 0 },
			{
				label: `↻ 添加新模型，并移除 ${orphaned.length} 个端点已不再提供的模型`,
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
				await syncEndpoint(ctx, paths, providerId, discovered);
				return;
			}
			if (answer === "pick") {
				const picked = await choose(ctx, `添加哪个模型到 ${providerId}？`, [
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

/** 让本地模型列表和端点完全一致：先确认删除多余的，再把新的加进去。 */
async function syncEndpoint(ctx: ExtensionContext, paths: Paths, providerId: string, discovered: DiscoveredModel[]): Promise<void> {
	const remote = new Set(discovered.map((model) => model.id));
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const orphaned = providerModels(provider)
		.map((model) => model.id)
		.filter((id) => !remote.has(id));

	if (orphaned.length > 0) {
		const confirmed = await ctx.ui.confirm(
			`移除 ${orphaned.length} 个模型（provider "${providerId}"）？`,
			`将移除：${orphaned.slice(0, 12).join(", ")}${orphaned.length > 12 ? " 等" : ""}`,
		);
		if (!confirmed) return;
	}

	provider.models = providerModels(provider).filter((model) => remote.has(model.id));
	if (!(await save(ctx, paths, file))) return;
	const meta = await readManagerMeta(paths);
	for (const id of orphaned) delete meta.models[modelMetaKey(providerId, id)];
	await writeManagerMeta(paths, meta);

	const kept = new Set(providerModels(provider).map((model) => model.id));
	await addDiscoveredModels(ctx, paths, providerId, discovered.filter((model) => !kept.has(model.id)));
}

// ---------------------------------------------------------------------------
// 手动添加模型
// ---------------------------------------------------------------------------

interface ModelDraft {
	id: string;
	model: ManagedModel;
	/** models.dev 自动填好的字段名（决定哪些步骤可跳过；不随用户输入变化）。 */
	auto: Set<string>;
	meta?: ModelMeta;
}

async function addModelManually(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const initial = await reloadModels(paths);
	if (findProvider(initial, providerId) === undefined) return;

	const draft: ModelDraft = { id: "", model: { id: "" }, auto: new Set() };

	const steps: WizardStep<ModelDraft>[] = [
		{
			label: "模型 id",
			run: async (c, d, progress) => {
				while (true) {
					const answer = await askText(c, `${progress} · 模型 id（要和端点上的写法一致）`, "例如 claude-sonnet-4-5");
					if (isCancelled(answer) || answer === "") return false;
					const current = await reloadModels(paths);
					const currentProvider = findProvider(current, providerId);
					if (currentProvider !== undefined && findModel(currentProvider, answer) !== undefined) {
						c.ui.notify(`"${answer}" 已经存在于 "${providerId}"`, "warning");
						continue;
					}
					// 换 id 就重来：清掉上一次自动填充的结果
					d.id = answer;
					d.model = { id: answer };
					d.auto = new Set();
					d.meta = undefined;
					const handle = await withCatalog(c, paths, false, "添加模型 · 读取 models.dev");
					if (handle.error !== undefined) c.ui.notify(handle.error, "warning");
					const lookup = lookupModel(handle.index, providerId, answer);
					if (lookup === undefined) {
						c.ui.notify(`models.dev 中找不到 "${answer}"，请手动填写信息`, "warning");
					} else {
						const enrichment = enrichFromModelsDev(d.model, lookup, false);
						Object.assign(d.model, enrichment.patch);
						for (const field of enrichment.filled) d.auto.add(field);
						d.meta = enrichment.meta;
					}
					return true;
				}
			},
		},
		{
			label: "显示名",
			skip: (d) => d.auto.has("name"),
			run: async (c, d, progress) => {
				const answer = await askText(c, `${progress} · 显示名`, d.model.name ?? d.id);
				if (isCancelled(answer)) return false;
				d.model.name = answer === "" ? d.id : answer;
				return true;
			},
		},
		{
			label: "上下文窗口",
			skip: (d) => d.auto.has("contextWindow"),
			run: async (c, d, progress) => {
				const value = await askNumber(c, `${progress} · 上下文窗口（tokens，留空不设）`, d.model.contextWindow ?? 128000);
				if (value.kind === "cancel") return false;
				if (value.kind === "value") d.model.contextWindow = value.value;
				else delete d.model.contextWindow;
				return true;
			},
		},
		{
			label: "最大输出 tokens",
			skip: (d) => d.auto.has("maxTokens"),
			run: async (c, d, progress) => {
				const value = await askNumber(c, `${progress} · 最大输出 tokens（留空不设）`, d.model.maxTokens ?? 16384);
				if (value.kind === "cancel") return false;
				if (value.kind === "value") d.model.maxTokens = value.value;
				else delete d.model.maxTokens;
				return true;
			},
		},
		{
			label: "是否支持推理",
			skip: (d) => d.auto.has("reasoning"),
			run: async (c, d, progress) => {
				const value = await askYesNo(c, `${progress} · 是否支持推理 / thinking`, d.model.reasoning ?? false);
				if (isCancelled(value)) return false;
				d.model.reasoning = value;
				return true;
			},
		},
	];

	const result = await runWizard(ctx, draft, steps, { progress: (_d, position, total) => `添加模型到 ${providerId}  ${position}/${total}` });
	if (result === undefined) return;

	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	provider.models = [...providerModels(provider), result.model];
	if (!(await save(ctx, paths, file))) return;

	if (result.meta !== undefined) {
		const meta = await readManagerMeta(paths);
		const key = modelMetaKey(providerId, result.id);
		meta.models[key] = { ...meta.models[key], ...result.meta, source: "manual" };
		await writeManagerMeta(paths, meta);
	}
	ctx.ui.notify(`已添加模型 "${result.id}" 到 "${providerId}"`, "info");
}

// ---------------------------------------------------------------------------
// 测试连接
// ---------------------------------------------------------------------------

async function testProvider(ctx: ExtensionContext, paths: Paths, providerId: string): Promise<void> {
	const file = await reloadModels(paths);
	const provider = findProvider(file, providerId);
	if (provider === undefined) return;
	const models = providerModels(provider);
	if (models.length === 0) {
		ctx.ui.notify(`"${providerId}" 没有可测试的模型`, "warning");
		return;
	}

	let modelId: string | undefined;
	if (canPick(ctx)) {
		modelId = await pickList(
			ctx,
			`测试连接 1/2 · 用哪个模型测试 ${providerId}？`,
			models.map((model) => ({ value: model.id, label: model.id, description: modelDescription(model, undefined) })),
			{ maxVisible: 16, footer: "输入关键字筛选 · ↑↓ 选择 · Enter 测试 · Esc 取消" },
		);
	} else {
		const picked = await choose(
			ctx,
			`测试连接 1/2 · 用哪个模型测试 ${providerId}？`,
			models.map((model) => ({ label: modelLabel(model, undefined), value: model.id })),
		);
		modelId = isCancelled(picked) ? undefined : picked;
	}
	if (modelId === undefined) return;

	const model = ctx.modelRegistry.find(providerId, modelId);
	if (model === undefined) {
		ctx.ui.notify(`"${providerId}/${modelId}" 还没注册成功，请先保存并重新加载。`, "warning");
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 120_000);
	ctx.ui.setStatus(STATUS_KEY, `测试连接 2/2 · 正在请求 ${providerId}/${modelId}…`);
	const startedAt = Date.now();
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }] },
			{ maxTokens: 64, signal: controller.signal },
		);
		const result = await stream.result();
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		if (result.stopReason === "error") throw new Error(result.errorMessage ?? "provider 返回错误");
		if (result.stopReason === "aborted") throw new Error("请求已中止");
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(" ")
			.trim();
		ctx.ui.notify(
			`✓ 测试连接成功 · ${providerId}/${modelId} 耗时 ${elapsed}s · 输入 ${result.usage.input} / 输出 ${result.usage.output} tokens${text === "" ? "" : ` · "${truncate(text, 60)}"`}`,
			"info",
		);
	} catch (error) {
		notifyError(ctx, new Error(`✗ 测试连接失败 · ${providerId}/${modelId}：${error instanceof Error ? error.message : String(error)}`));
	} finally {
		clearTimeout(timeout);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}
