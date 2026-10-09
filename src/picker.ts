/**
 * 可滚动 + 可筛选的列表选择器。
 *
 * 为什么不能直接用 `ctx.ui.select`：它把所有选项一次性渲染成行，而 Pi 主屏模式的
 * 视口固定在缓冲区底部。列表一旦超过终端高度，标题和前几项就被顶出屏幕，连选中项
 * 都可能看不见。中转站动辄返回几百个模型，所以必须自己做一个会滚动的列表。
 *
 * 自定义组件只在 TUI 模式可用（RPC / print 模式下 `ctx.ui.custom` 拿不到终端），
 * 所以调用方必须在 `ctx.mode !== "tui"` 时准备降级路径。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export interface PickItem {
	/** 返回给调用方的稳定标识（不受筛选取值影响）。 */
	value: string;
	label: string;
	description?: string;
	/** 参与筛选的文本，默认用 label + description。 */
	search?: string;
}

export interface PickState {
	query?: string;
	selected?: string;
}

export interface PickOptions {
	state?: PickState;
	/** 一屏最多显示多少行，其余靠滚动。 */
	maxVisible?: number;
	footer?: string;
	placeholder?: string;
}

const DEFAULT_FOOTER = "输入关键字筛选，上下键 选择，Enter 确认，Esc 取消";

/** 只在 `ctx.mode === "tui"` 时调用。返回选中的 value；Esc 取消返回 undefined。 */
export async function pickList(
	ctx: ExtensionContext,
	title: string,
	items: readonly PickItem[],
	options: PickOptions = {},
): Promise<string | undefined> {
	if (items.length === 0) return undefined;
	const state = options.state ?? {};
	const searchable = items.map(item => ({ item, text: (item.search ?? `${item.label} ${item.description ?? ""}`).toLowerCase() }));

	const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const visibleRows = () => Math.max(1, Math.min(options.maxVisible ?? 14, tui.terminal.rows - 8));
		let maxVisible = visibleRows();
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const filter = new Input({ prompt: `${theme.fg("muted", "筛选 ")}`, placeholder: options.placeholder ?? "输入关键字" });
		filter.focused = true;
		filter.setValue(state.query ?? "");
		container.addChild(filter);

		const listArea = new Container();
		container.addChild(listArea);

		let list: SelectList | undefined;
		const shown: PickItem[] = [];

		const rebuild = () => {
			state.query = filter.getValue();
			const query = state.query.trim().toLowerCase();
			const selected = list?.getSelectedItem()?.value ?? state.selected;
			shown.length = 0;
			for (const { item, text } of searchable) {
				if (query === "" || text.includes(query)) shown.push(item);
			}
			listArea.clear();
			if (shown.length === 0) {
				listArea.addChild(new Text(theme.fg("warning", "  没有匹配项")));
				list = undefined;
				return;
			}
			// SelectList 的 setFilter 只按 value 前缀匹配，无法做子串搜索，
			// 所以这里自己筛好再重建列表（它自带的滚动/居中逻辑仍然有用）。
			const next = new SelectList(
				shown.map((item): SelectItem => ({ value: item.value, label: item.label, description: item.description })),
				maxVisible,
				listTheme,
			);
			next.setSelectedIndex(Math.max(0, shown.findIndex(item => item.value === selected)));
			next.onSelectionChange = item => { state.selected = item.value; };
			next.onSelect = (item) => { state.selected = item.value; done(item.value); };
			next.onCancel = () => done(null);
			listArea.addChild(next);
			list = next;
		};
		rebuild();

		container.addChild(new Text(theme.fg("dim", options.footer ?? DEFAULT_FOOTER)));

		return {
			render: (width: number) => {
				if (maxVisible !== visibleRows()) { maxVisible = visibleRows(); rebuild(); }
				return container.render(width);
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// 导航键交给列表；其余按键进入筛选框。这样就是「边打边筛」的手感。
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.pageUp") ||
					keybindings.matches(data, "tui.select.pageDown") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					if (list === undefined && keybindings.matches(data, "tui.select.cancel")) {
						done(null);
						return;
					}
					list?.handleInput(data);
				} else {
					const before = filter.getValue();
					filter.handleInput(data);
					if (filter.getValue() !== before) rebuild();
				}
				tui.requestRender();
			},
		};
	});

	return result ?? undefined;
}

/** 当前模式能不能用自定义终端组件。 */
export function canPick(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}
