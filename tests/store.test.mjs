import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdir, rmdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { readModelsFile, saveModelsFile, readManagerMeta, setStoredApiKey, deleteStoredCredential, serializeModelsFile } from "../src/store.ts";
import { withFileLock } from "../src/file-io.ts";
import { fixture, sample, goodRegistry, json, put } from "./helpers.mjs";

test("refresh rejection restores config, credential and sidecar", async t => {
	const p = await fixture(t);
	await put(p.authPath, { relay: { type: "api_key", key: "old-test-key" }, other: { type: "api_key", key: "keep" } });
	await put(p.metaPath, { version: 1, models: {} });
	const before = await Promise.all([p.modelsPath,p.authPath,p.metaPath].map(path=>readFile(path,"utf8")));
	const file = await readModelsFile(p); file.providers.relay.apiKey = "$DUMMY";
	const meta = await readManagerMeta(p); meta.models["relay/demo"] = { toolCall: true };
	let count = 0;
	await assert.rejects(saveModelsFile(p, { refresh: async () => { count++; }, getError: () => count === 1 ? "rejected" : undefined }, file, { credential: { providerId: "relay" }, meta }), /已恢复/);
	const after = await Promise.all([p.modelsPath,p.authPath,p.metaPath].map(json));
	assert.deepEqual(after,before.map(JSON.parse));
});

test("refresh throwing restores the old config", async t => {
	const p = await fixture(t); const file = await readModelsFile(p); file.providers = {};
	let count = 0;
	await assert.rejects(saveModelsFile(p,{getError:()=>undefined,refresh:async()=>{if (++count === 1) throw Error("offline failure");}},file),/offline failure/);
	assert.deepEqual(await json(p.modelsPath),sample());
});

test("an unchanged registry error is still a failed save", async t => {
	const p = await fixture(t); const file = await readModelsFile(p); file.providers = {};
	await assert.rejects(saveModelsFile(p,{getError:()=>"same error",refresh:async()=>{}},file),/same error/);
	assert.deepEqual(await json(p.modelsPath),sample());
});

test("stale menu snapshots cannot overwrite another writer", async t => {
	const p = await fixture(t); const a = await readModelsFile(p); const b = await readModelsFile(p);
	a.providers.relay.name = "first"; b.providers.relay.name = "second";
	await saveModelsFile(p,goodRegistry(),a);
	await assert.rejects(saveModelsFile(p,goodRegistry(),b),/其他会话/);
	assert.equal((await json(p.modelsPath)).providers.relay.name,"first");
});

test("rollback preserves edits made by an external writer during refresh", async t => {
	const p = await fixture(t); const file = await readModelsFile(p); file.providers = {};
	const external = { providers: {}, marker: "external" }; let count = 0;
	await assert.rejects(saveModelsFile(p,{getError:()=>undefined,refresh:async()=>{if (++count===1) { await put(p.modelsPath,external); throw Error("refresh failure"); }}},file),/未覆盖/);
	assert.deepEqual(await json(p.modelsPath),external);
});

test("concurrent credential writes preserve unrelated providers", async t => {
	const p = await fixture(t);
	await Promise.all(Array.from({length:8},(_,i)=>setStoredApiKey(p,`provider${i}`,`test${i}`)));
	assert.equal(Object.keys(await json(p.authPath)).length,8);
	await deleteStoredCredential(p,"provider0"); assert.equal(Object.keys(await json(p.authPath)).length,7);
});

test("auth lock is released before Pi refresh reads credentials", async t => {
	const p = await fixture(t); const file = await readModelsFile(p);
	await saveModelsFile(p,{getError:()=>undefined,refresh:async()=>withFileLock(p.authPath,async()=>assert.equal((await json(p.authPath)).relay.key,"test"))},file,{credential:{providerId:"relay",key:"test"}});
});

test("credential rollback retains unrelated login changes", async t => {
	const p = await fixture(t); await setStoredApiKey(p,"relay","old");
	const file = await readModelsFile(p); let count=0;
	await assert.rejects(saveModelsFile(p,{getError:()=>undefined,refresh:async()=>{if (++count===1) { await setStoredApiKey(p,"other","new"); throw Error("fail"); }}},file,{credential:{providerId:"relay",key:"replacement"}}));
	assert.equal((await json(p.authPath)).relay.key,"old"); assert.equal((await json(p.authPath)).other.key,"new");
});

test("auth permissions remain private after overwrite and deletion", {skip:process.platform==="win32"}, async t => {
	const p = await fixture(t); await setStoredApiKey(p,"a","test"); await setStoredApiKey(p,"b","test"); await deleteStoredCredential(p,"a");
	assert.equal((await stat(p.authPath)).mode & 0o777,0o600);
});

test("compatible directory lock waits for another writer", async t => {
	const p = await fixture(t); await mkdir(`${p.authPath}.lock`);
	const release = sleep(100).then(()=>rmdir(`${p.authPath}.lock`));
	await setStoredApiKey(p,"relay","test"); await release;
	assert.equal((await json(p.authPath)).relay.key,"test");
});

test("unknown fields and string comments round-trip", async t => {
	const p=await fixture(t);
	await writeFile(p.modelsPath,'// comment\n{"providers":{"relay":{"api":"openai-completions","baseUrl":"https://example.invalid","extra":{"keep":true}}},"unknown":42}');
	const file=await readModelsFile(p); const saved=JSON.parse(serializeModelsFile(file));
	assert.equal(saved.unknown,42); assert.deepEqual(saved.providers.relay.extra,{keep:true});
});


test("invalid metadata fails before writing any credential", async t => {
	const p=await fixture(t); await setStoredApiKey(p,"relay","old");
	const file=await readModelsFile(p); file.providers.relay.models[0].cost={input:-1};
	await assert.rejects(saveModelsFile(p,goodRegistry(),file,{credential:{providerId:"relay",key:"new"}}),/非负数/);
	assert.equal((await json(p.authPath)).relay.key,"old");
});

test("sidecar write failure compensates an already updated credential", async t=>{
	const p=await fixture(t); await setStoredApiKey(p,"relay","old"); await mkdir(p.metaPath);
	const file=await readModelsFile(p);
	await assert.rejects(saveModelsFile(p,goodRegistry(),file,{credential:{providerId:"relay",key:"new"},meta:{version:1,models:{}}}));
	assert.equal((await json(p.authPath)).relay.key,"old"); assert.deepEqual(await json(p.modelsPath),sample());
});

test("rollback does not erase a replacement credential from another login", async t=>{
	const p=await fixture(t); await setStoredApiKey(p,"relay","old");const file=await readModelsFile(p);let count=0;
	await assert.rejects(saveModelsFile(p,{getError:()=>undefined,refresh:async()=>{if(++count===1){await setStoredApiKey(p,"relay","external");throw Error("fail");}}},file,{credential:{providerId:"relay",key:"new"}}),/未覆盖新凭据/);
	assert.equal((await json(p.authPath)).relay.key,"external");
});
