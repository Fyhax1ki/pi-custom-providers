/** Plain, cancellable progress text; no animated glyphs or extra dependency. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export async function withProgress<T>(ctx: ExtensionContext, label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (ctx.mode !== "tui") return work(new AbortController().signal);
	type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
	const outcome = await ctx.ui.custom<Outcome>((_tui, theme, keys, done) => {
		const controller = new AbortController();
		const text = new Text(theme.fg("muted", `${label}（Esc 取消）`));
		let finished = false;
		const finish = (result: Outcome) => {
			if (finished) return;
			finished = true;
			done(result);
		};
		void Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return work(controller.signal);
		}).then(value => {
			controller.signal.throwIfAborted();
			finish({ ok: true, value });
		}).catch(error => finish({ ok: false, error }));
		return {
			render: (width: number) => text.render(width),
			invalidate: () => text.invalidate(),
			handleInput: (data: string) => {
				if (keys.matches(data, "tui.select.cancel")) {
					controller.abort();
					finish({ ok: false, error: controller.signal.reason });
				}
			},
			dispose: () => controller.abort(),
		};
	});
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
