import test from "node:test";
import assert from "node:assert/strict";
import { runManager } from "../src/manager.ts";
import { runWizard } from "../src/wizard.ts";
import { fixture, sample, context, put, json, goodRegistry } from "./helpers.mjs";

test("editing context updates contextWindow, not context", async t => {
	const p=await fixture(t);
	const menu=["relay","模型（","demo","上下文窗口","返回","返回","返回","关闭"];
	const {ctx,notifications}=context(t,p,menu,"2000");
	await runManager(ctx);
	const model=(await json(p.modelsPath)).providers.relay.models[0];
	assert.equal(model.contextWindow,2000);assert.equal(model.context,undefined);assert.equal(menu.length,0);
	assert.equal(notifications.some(n=>n.level==="error"),false);
});

test("clearing context removes the real field", async t => {
	const p=await fixture(t);const {ctx}=context(t,p,["relay","模型（","demo","上下文窗口","返回","返回","返回","关闭"],"");
	await runManager(ctx);assert.equal((await json(p.modelsPath)).providers.relay.models[0].contextWindow,undefined);
});

test("key source rejection leaves the old credential usable", async t => {
	const p=await fixture(t);await put(p.authPath,{relay:{type:"api_key",key:"old-test"}});let count=0;
	const {ctx,notifications}=context(t,p,["relay","API key","引用环境变量","返回","关闭"],"DUMMY",{refresh:async()=>{count++;},getError:()=>count===1?"rejected":undefined});
	await runManager(ctx);assert.equal((await json(p.authPath)).relay.key,"old-test");assert.deepEqual(await json(p.modelsPath),sample());
	assert.equal(notifications.some(n=>n.level==="error"),true);
});

test("sidecar-only information is saved through the menu", async t => {
	const p=await fixture(t);await put(p.modelsDevCachePath,{fetchedAt:Date.now(),catalog:{relay:{models:{demo:{id:"demo",tool_call:true,family:"test"}}}}});
	const {ctx}=context(t,p,["relay","模型（","demo","用 models.dev","返回","返回","返回","关闭"]);
	await runManager(ctx);assert.equal((await json(p.metaPath)).models["relay/demo"].toolCall,true);
});

test("failed sync restores removed models and does not retain new additions", async t => {
	const p=await fixture(t);await put(p.modelsDevCachePath,{fetchedAt:Date.now(),catalog:{relay:{models:{fresh:{id:"fresh"}}}}});
	t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({data:[{id:"fresh"}]})));
	let refreshes=0;const registry={...goodRegistry(),getApiKeyAndHeaders:async()=>({ok:true}),refresh:async()=>{if(++refreshes===1)throw Error("test failure");}};
	const {ctx,notifications}=context(t,p,["relay","从端点获取","添加新模型，并移除","返回","关闭"],"",registry);
	await runManager(ctx);assert.deepEqual(await json(p.modelsPath),sample());
	assert.equal(notifications.some(n=>n.message.includes("test failure")),true);
});

test("incomplete discovery does not offer destructive synchronization", async t => {
	const p=await fixture(t);t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({data:[{id:"fresh"}],has_more:true})));
	const {ctx}=context(t,p,["relay","从端点获取","返回","返回","关闭"],"",{...goodRegistry(),getApiKeyAndHeaders:async()=>({ok:true})});
	const select=ctx.ui.select;ctx.ui.select=async(title,labels)=>{if(title.includes("列表不完整"))assert.equal(labels.some(l=>l.includes("移除")),false);return select(title,labels);};
	await runManager(ctx);assert.deepEqual(await json(p.modelsPath),sample());
});

test("menu text has no decorative symbols", async t => {
	const p=await fixture(t);const {ctx}=context(t,p,["relay","模型（","demo","返回","返回","返回","关闭"]);
	const select=ctx.ui.select;ctx.ui.select=async(title,labels)=>{assert.doesNotMatch([title,...labels].join(""),/[←↑↓✓✗⚠＋✦✕↻›·]/u);return select(title,labels);};
	await runManager(ctx);
});

test("wizard backtracking skips automatic steps and cancels at the first real step", async () => {
	const visits=[];let last=0;
	const result=await runWizard({}, {}, [
		{label:"first",run:async()=>{visits.push("first");return visits.length===1;}},
		{label:"automatic",skip:()=>true,run:async()=>{throw Error("must be skipped");}},
		{label:"last",run:async()=>{last++;visits.push("last");return false;}},
	],{progress:()=>""});
	assert.equal(result,undefined);assert.deepEqual(visits,["first","last","first"]);assert.equal(last,1);
});
