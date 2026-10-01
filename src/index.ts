/**
 * Pi Provider Manager
 *
 * Manages third-party providers and relay endpoints through Pi's own
 * `models.json`, so Pi keeps owning validation, request conversion and
 * streaming. Run `/providers`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runManager } from "./manager.ts";

export default function providerManager(pi: ExtensionAPI): void {
	pi.registerCommand("providers", {
		description: "管理自定义 provider、中转站、API key 和模型（models.json）",
		handler: async (_args, ctx) => {
			await runManager(ctx);
		},
	});
}
