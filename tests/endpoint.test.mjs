import test from "node:test";
import assert from "node:assert/strict";
import { discoverModels, extractModels } from "../src/endpoint.ts";
const ctx={modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"test-only"})}};
const provider={baseUrl:"https://example.invalid/v1",api:"anthropic-messages"};
const reply=body=>new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});

test("discovery consumes Anthropic pages and deduplicates model IDs", async t => {
	const urls=[];
	t.mock.method(globalThis,"fetch",async url=>{urls.push(url);return urls.length===1?reply({data:[{id:"a"}],has_more:true,last_id:"a"}):reply({data:[{id:"a"},{id:"b"}],has_more:false});});
	const result=await discoverModels(ctx,"relay",provider);
	assert.equal(result.complete,true);assert.deepEqual(result.models.map(m=>m.id),["a","b"]);
	assert.equal(new URL(urls[1]).searchParams.get("after_id"),"a");
});

test("unknown pagination is add-only", async t => {
	t.mock.method(globalThis,"fetch",async()=>reply({data:[{id:"a"}],has_more:true}));
	const result=await discoverModels(ctx,"relay",provider);
	assert.equal(result.complete,false);assert.equal(result.models.length,1);
});

test("a failed second page preserves add-only results", async t => {
	let calls=0;t.mock.method(globalThis,"fetch",async()=>++calls===1?reply({data:[{id:"a"}],has_more:true,last_id:"a"}):new Response("error",{status:500}));
	const result=await discoverModels(ctx,"relay",provider);
	assert.equal(result.complete,false);assert.deepEqual(result.models,[{id:"a"}]);
});

test("cross-origin pagination cannot receive credentials", async t => {
	let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return reply({data:[{id:"a"}],next:"https://other.invalid/models"});});
	assert.equal((await discoverModels(ctx,"relay",provider)).complete,false);assert.equal(calls,1);
});

test("repeated pagination cursor is detected", async t => {
	let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return reply({data:[{id:"a"}],next_cursor:"same"});});
	assert.equal((await discoverModels(ctx,"relay",provider)).complete,false);assert.equal(calls,2);
});

test("empty recognized lists are complete, malformed entries are not", async t => {
	t.mock.method(globalThis,"fetch",async()=>reply({data:[]}));
	assert.equal((await discoverModels(ctx,"relay",provider)).complete,true);
	t.mock.method(globalThis,"fetch",async()=>reply({data:[{nonsense:true},{id:"a"}]}));
	assert.equal((await discoverModels(ctx,"relay",provider)).complete,false);
});

test("abort propagates without trying alternate URLs", async t => {
	const controller=new AbortController();let calls=0;
	t.mock.method(globalThis,"fetch",async()=>{calls++;controller.abort();throw controller.signal.reason;});
	await assert.rejects(discoverModels(ctx,"relay",provider,controller.signal),{name:"AbortError"});assert.equal(calls,1);
});

test("common endpoint response shapes remain supported", () => {
	for(const body of [["a"],{data:[{id:"a"}]},{models:[{model:"a"}]}])assert.deepEqual(extractModels(body),[{id:"a"}]);
});


test("HTTP Link pagination is followed for bare arrays", async t=>{
	let calls=0;t.mock.method(globalThis,"fetch",async()=>++calls===1?new Response(JSON.stringify(["a"]),{headers:{link:'<https://example.invalid/v1/models?page=2>; rel="next"'}}):reply(["b"]));
	const result=await discoverModels(ctx,"relay",provider);assert.equal(result.complete,true);assert.deepEqual(result.models,[{id:"a"},{id:"b"}]);assert.equal(calls,2);
});

test("numbered pagination is followed and unknown tokens are add-only", async t=>{
	let calls=0;t.mock.method(globalThis,"fetch",async()=>reply({data:[{id:String(++calls)}],pagination:{page:calls,total_pages:2}}));
	assert.equal((await discoverModels(ctx,"relay",provider)).models.length,2);
	t.mock.method(globalThis,"fetch",async()=>reply({data:[{id:"a"}],next_page_token:"unknown-format"}));
	assert.equal((await discoverModels(ctx,"relay",provider)).complete,false);
});
