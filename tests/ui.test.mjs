import test from "node:test";
import assert from "node:assert/strict";
import { pickList } from "../src/picker.ts";
import { withProgress } from "../src/progress.ts";
const theme={fg:(_color,text)=>text,bold:text=>text};
const keys={matches:(data,action)=>({"tui.select.confirm":"\r","tui.select.cancel":"\x1b","tui.select.down":"\x1b[B","tui.select.up":"\x1b[A"})[action]===data};
function customContext(action) {
	return {mode:"tui",ui:{custom:factory=>new Promise(resolve=>{
		const tui={terminal:{rows:24},requestRender:()=>{}};
		const component=factory(tui,theme,keys,resolve);
		action(component,tui);
	})}};
}

test("picker preserves query and selected model across reopening", async()=>{
	const items=[{value:"a",label:"alpha"},{value:"b",label:"beta one"},{value:"c",label:"beta two"}];
	const state={};
	const first=customContext(component=>{component.handleInput("beta");component.handleInput("\x1b[B");component.handleInput("\r");});
	assert.equal(await pickList(first,"Models",items,{state}),"c");assert.equal(state.query,"beta");
	const second=customContext(component=>component.handleInput("\r"));
	assert.equal(await pickList(second,"Models",items,{state}),"c");
});

test("picker reduces visible rows when the terminal shrinks", async()=>{
	const ctx=customContext((component,tui)=>{
		const large=component.render(100).length;
		tui.terminal.rows=12;
		const small=component.render(100).length;
		assert.ok(small<large);assert.ok(small<=12,`rendered ${small} rows`);
		component.handleInput("\x1b");
	});
	assert.equal(await pickList(ctx,"Models",Array.from({length:50},(_,i)=>({value:String(i),label:`model ${i}`}))),undefined);
});

test("picker can escape when no items match",async()=>{
	const ctx=customContext(component=>{component.handleInput("missing");component.handleInput("\x1b");});
	assert.equal(await pickList(ctx,"Models",[{value:"a",label:"alpha"}]),undefined);
});

test("network progress propagates Esc cancellation",async()=>{
	const ctx=customContext(component=>component.handleInput("\x1b"));
	await assert.rejects(withProgress(ctx,"Loading",async signal=>{signal.throwIfAborted();return "unexpected";}),{name:"AbortError"});
});
