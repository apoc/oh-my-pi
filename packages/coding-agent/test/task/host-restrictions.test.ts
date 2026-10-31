import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgFetchEnabled, cfgWebSearchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

describe("host restrictions", () => {
	it("bind every descendant, even one whose own overrides re-enable them", () => {
		const responder = createSubagentSettings(Settings.isolated(), undefined, undefined, {
			"fetch.enabled": false,
			"web_search.enabled": false,
		});
		const scout = createSubagentSettings(responder, { "fetch.enabled": true, "web_search.enabled": true });
		const nested = createSubagentSettings(scout);
		for (const settings of [responder, scout, nested]) {
			expect(cfgFetchEnabled.get(settings)).toBe(false);
			expect(cfgWebSearchEnabled.get(settings)).toBe(false);
		}
	});
});
