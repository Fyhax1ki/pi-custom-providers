/**
 * 向导式流程：Esc 退回上一步，第一步按 Esc 则整体取消。
 *
 * 为什么需要它：`ctx.ui.input` / `ctx.ui.select` 用 `undefined` 表示用户按了 Esc，
 * 本身分不出「取消整个流程」和「回上一步」。多步流程里必须自己维护步骤指针，
 * 否则第 3 步按 Esc 会把前两步白填。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WizardStep<Draft> {
	/** 步骤名，由各步自己拼进标题。 */
	label: string;
	/**
	 * 该步是否可以直接跳过（比如 models.dev 已经把这个字段补全了）。
	 * 注意：判断依据必须是「自动填充结果」这类稳定信息，不能是用户刚输入的值，
	 * 否则后退时会一路跳过、退不回真正提问过的步骤。
	 */
	skip?: (draft: Draft) => boolean;
	/** 返回 false 表示用户按了 Esc，退回上一步。 */
	run: (ctx: ExtensionContext, draft: Draft, progress: string) => Promise<boolean>;
}

export interface WizardOptions<Draft> {
	/** 进度前缀，例如 `添加 provider  1/4`。 */
	progress: (draft: Draft, position: number, total: number) => string;
}

/** 走完全部步骤返回 draft；在第一步按 Esc 返回 undefined（整体取消）。 */
export async function runWizard<Draft extends object>(
	ctx: ExtensionContext,
	draft: Draft,
	steps: readonly WizardStep<Draft>[],
	options: WizardOptions<Draft>,
): Promise<Draft | undefined> {
	let index = 0;
	while (index < steps.length) {
		const step = steps[index]!;
		if (step.skip?.(draft) === true) {
			index++;
			continue;
		}
		const active = steps.filter((entry) => entry.skip?.(draft) !== true);
		const ok = await step.run(ctx, draft, options.progress(draft, active.indexOf(step) + 1, active.length));
		if (ok) {
			index++;
			continue;
		}
		// Esc：退回上一个真正会提问的步骤（跳过的那些不算「上一步」）
		let target = index - 1;
		while (target >= 0 && steps[target]!.skip?.(draft) === true) target--;
		if (target < 0) return undefined;
		index = target;
	}
	return draft;
}
