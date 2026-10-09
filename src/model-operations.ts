/** Pure model changes: build the complete result before touching any file. */
import type { DiscoveredModel } from "./endpoint.ts";
import { enrichFromModelsDev, lookupModel, type CatalogIndex } from "./modelsdev.ts";
import { modelMetaKey, type ManagedModel, type ManagerMeta } from "./types.ts";

export function mergeDiscoveredModels(
	providerId: string,
	existing: readonly ManagedModel[],
	meta: ManagerMeta,
	discovered: readonly DiscoveredModel[],
	index: CatalogIndex,
	sync = false,
): { models: ManagedModel[]; added: number; removed: string[]; withoutMetadata: number } {
	const remote = new Map(discovered.map(model => [model.id, model]));
	const removed = sync ? existing.filter(model => !remote.has(model.id)).map(model => model.id) : [];
	const models = existing.filter(model => !sync || remote.has(model.id)).map(model => ({ ...model }));
	const configured = new Map(models.map(model => [model.id, model]));
	let added = 0;
	let withoutMetadata = 0;
	for (const entry of remote.values()) {
		let model = configured.get(entry.id);
		if (model && !sync) continue;
		if (!model) {
			model = { id: entry.id };
			models.push(model);
			configured.set(entry.id, model);
			added++;
		}
		// Endpoint facts win, then existing fields, then catalog reference values.
		for (const key of ["name", "contextWindow", "maxTokens"] as const) {
			if (entry[key] !== undefined) Object.assign(model, { [key]: entry[key] });
		}
		const enrichment = enrichFromModelsDev(model, lookupModel(index, providerId, entry.id), false);
		Object.assign(model, enrichment.patch);
		if (enrichment.lookup) {
			const key = modelMetaKey(providerId, entry.id);
			meta.models[key] = { ...meta.models[key], ...enrichment.meta };
		}
		if (!model.name) model.name = entry.id;
		if (model.contextWindow === undefined || model.maxTokens === undefined) withoutMetadata++;
	}
	for (const id of removed) delete meta.models[modelMetaKey(providerId, id)];
	return { models, added, removed, withoutMetadata };
}
