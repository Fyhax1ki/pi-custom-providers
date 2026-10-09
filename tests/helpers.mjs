import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sample = () => ({ providers: { relay: { api: "openai-completions", baseUrl: "https://example.invalid/v1", models: [{ id: "demo", contextWindow: 1000, maxTokens: 100 }] } } });
export const goodRegistry = () => ({ getError: () => undefined, refresh: async () => {} });
export const json = async path => JSON.parse(await readFile(path, "utf8"));
export const put = (path, data) => writeFile(path, JSON.stringify(data));
export async function fixture(t, models = sample()) {
	const root = await mkdtemp(join(workspace, ".test-tmp-"));
	t.after(async () => {
		assert.equal(dirname(resolve(root)), workspace);
		assert.ok(root.startsWith(join(workspace, ".test-tmp-")));
		for (const file of await readdir(root, { withFileTypes: true })) {
			const path = resolve(root, file.name);
			assert.equal(dirname(path), resolve(root));
			if (file.isDirectory()) await rmdir(path); else await unlink(path);
		}
		await rmdir(root);
	});
	const paths = { agentDir: root, modelsPath: join(root,"models.json"), authPath: join(root,"auth.json"), metaPath: join(root,"provider-manager.json"), modelsDevCachePath: join(root,"provider-manager-modelsdev.json") };
	await put(paths.modelsPath, models);
	return paths;
}
export function context(t, paths, selections, input = "", registry = goodRegistry()) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const notifications = [];
	const ctx = {
		hasUI: true, mode: "rpc", waitForIdle: async () => {},
		modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), ...registry },
		ui: {
			select: async (title, labels) => {
				const prefix = selections.shift();
				assert.notEqual(prefix, undefined, `Unexpected menu: ${title}`);
				if (prefix === null) return undefined;
				const label = labels.find(label => label.startsWith(prefix));
				assert.notEqual(label, undefined, `${prefix} not found: ${labels.join(" | ")}`);
				return label;
			},
			input: async () => Array.isArray(input) ? input.shift() : input,
			confirm: async () => true,
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
		}
	};
	return { ctx, notifications };
}
