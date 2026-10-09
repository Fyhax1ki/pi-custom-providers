import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, lookupModel, enrichFromModelsDev, loadCatalog } from "../src/modelsdev.ts";
import { mergeDiscoveredModels } from "../src/model-operations.ts";
import { fixture, put } from "./helpers.mjs";

test("exact dated model IDs win and missing dates are not guessed", () => {
	const index=buildIndex({upstream:{models:{"demo-2025-01-01":{id:"demo-2025-01-01"},"demo-2025-06-01":{id:"demo-2025-06-01"}}}});
	assert.equal(lookupModel(index,"upstream","demo-2025-06-01").model.id,"demo-2025-06-01");
	assert.equal(lookupModel(index,"upstream","demo-2025-09-01"),undefined);
});

test("ambiguous catalog matches are not chosen by insertion order", () => {
	const index=buildIndex({a:{models:{demo:{id:"demo"}}},b:{models:{demo:{id:"demo"}}}});
	assert.equal(lookupModel(index,"relay","demo"),undefined);
	assert.equal(lookupModel(index,"b","demo").providerId,"b");
	assert.equal(lookupModel(index,"relay","b/demo").providerId,"b");
});

test("free pricing is valid and existing values are preserved", () => {
	const result=enrichFromModelsDev({id:"free",contextWindow:100,cost:{input:2}}, {providerId:"upstream",model:{id:"free",limit:{context:1000},cost:{input:0,output:0}}},false);
	assert.equal(result.patch.contextWindow,undefined);
	assert.deepEqual(result.patch.cost,{input:2,output:0,cacheRead:0,cacheWrite:0});
});

test("sidecar-only enrichment is available independently of model fields", () => {
	const result=enrichFromModelsDev({id:"demo"},{providerId:"upstream",model:{id:"demo",tool_call:true,family:"test"}},false);
	assert.deepEqual(result.filled,[]); assert.equal(result.meta.toolCall,true);
});

test("fresh catalog reuses its in-memory index", async t => {
	const p=await fixture(t);
	await put(p.modelsDevCachePath,{fetchedAt:Date.now(),catalog:{upstream:{models:{demo:{id:"demo"}}}}});
	t.mock.method(globalThis,"fetch",()=>{throw Error("Unexpected network");});
	const a=await loadCatalog(p); const b=await loadCatalog(p);
	assert.equal(a.index,b.index);
});

test("offline mode never fetches and cancellation is not swallowed", async t => {
	const p=await fixture(t); const old=process.env.PI_OFFLINE; process.env.PI_OFFLINE="1";
	t.after(()=>{if(old===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=old;});
	t.mock.method(globalThis,"fetch",()=>{throw Error("Unexpected network");});
	assert.equal((await loadCatalog(p)).stale,true);
	await assert.rejects(loadCatalog(p,{signal:AbortSignal.abort()}),{name:"AbortError"});
});

test("synchronization plans the entire result without changing the old model list", () => {
	const existing=[{id:"keep",contextWindow:100,maxTokens:10,custom:true},{id:"remove"}];
	const meta={version:1,models:{"relay/remove":{family:"old"},"other/keep":{family:"keep"}}};
	const result=mergeDiscoveredModels("relay",existing,meta,[{id:"keep",contextWindow:200},{id:"new"},{id:"new"}],buildIndex({}),true);
	assert.deepEqual(result.models.map(m=>m.id),["keep","new"]);
	assert.equal(result.models[0].contextWindow,200); assert.equal(result.models[0].maxTokens,10);
	assert.equal(result.models[0].custom,true); assert.equal(existing[0].contextWindow,100);
	assert.equal(result.added,1); assert.deepEqual(result.removed,["remove"]);
	assert.equal(meta.models["relay/remove"],undefined); assert.equal(meta.models["other/keep"].family,"keep");
});
