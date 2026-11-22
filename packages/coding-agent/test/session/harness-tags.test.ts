import { describe, expect, it } from "bun:test";
import { escapeHarnessTags } from "../../src/session/harness-tags";

describe("escapeHarnessTags", () => {
	it.each([
		["<mesh-message>", "&lt;mesh-message>"],
		["</mesh-reply>", "&lt;/mesh-reply>"],
		["< / MESH-STATUS >", "&lt; / MESH-STATUS >"],
		["<  /  irc>", "&lt;  /  irc>"],
		["<system-notice>", "&lt;system-notice>"],
		['<irc from="parent">', '&lt;irc from="parent">'],
	])("escapes harness tag %p", (input, expected) => {
		expect(escapeHarnessTags(input)).toBe(expected);
	});

	it.each(["<mesh>", "<mesh-1>", "<task-result>", "<system>", "a < b", "<ircx>"])("leaves %p untouched", input => {
		expect(escapeHarnessTags(input)).toBe(input);
	});

	it("escapes in linear time on a long whitespace run after `<`", () => {
		const input = `<${" ".repeat(65536)}`;
		const start = performance.now();
		const out = escapeHarnessTags(input);
		const elapsed = performance.now() - start;
		expect(out).toBe(input);
		expect(elapsed).toBeLessThan(100);
	});
});
