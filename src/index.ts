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
		description: "Manage custom providers, relay endpoints, API keys and models (models.json)",
		handler: async (_args, ctx) => {
			await runManager(ctx);
		},
	});
}
