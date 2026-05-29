import { describe, expect, it } from "vitest";

import { formatDynamicBlock, formatStaticBlock } from "../src/rules/formatter.js";
import type { LoadedRule, MatchReason, RuleSource } from "../src/rules/types.js";

const FORMAT_OPTIONS = {
	maxRuleChars: 10_000,
	maxResultChars: 10_000,
};

describe("rules formatter hook context", () => {
	it("#given multiline dynamic rules #when formatting PostToolUse context #then labels and bodies render on separate lines", () => {
		// given
		const rule = loadedRule({
			path: "/repo/packages/AGENTS.md",
			relativePath: "packages/AGENTS.md",
			body: ["# packages", "", "## OVERVIEW", "23 sibling packages.", "", "## CONVENTIONS", "Use npm."].join("\n"),
		});

		// when
		const block = formatDynamicBlock(
			[rule],
			"packages/omo-codex/plugin/components/ulw-loop/src/paths.ts",
			FORMAT_OPTIONS,
		);

		// then
		expect(block).toBe(
			[
				"Additional project instructions matched for packages/omo-codex/plugin/components/ulw-loop/src/paths.ts:",
				"",
				"Instructions from: /repo/packages/AGENTS.md",
				"",
				"# packages",
				"",
				"## OVERVIEW",
				"23 sibling packages.",
				"",
				"## CONVENTIONS",
				"Use npm.",
			].join("\n"),
		);
	});

	it("#given static rules #when formatting SessionStart context #then it avoids leading blank lines", () => {
		// given
		const rule = loadedRule({
			path: "/repo/AGENTS.md",
			relativePath: "AGENTS.md",
			body: "Keep generated hook context readable.",
		});

		// when
		const block = formatStaticBlock([rule], FORMAT_OPTIONS);

		// then
		expect(block).toBe(
			[
				"## Project Instructions",
				"",
				"Instructions from: /repo/AGENTS.md",
				"",
				"Keep generated hook context readable.",
			].join("\n"),
		);
	});

	it("#given CRLF and bare CR rule bodies #when formatting context #then it normalizes line endings", () => {
		// given
		const rule = loadedRule({
			body: "First line\r\n  indented second line\rThird line",
		});

		// when
		const block = formatDynamicBlock([rule], "src/app.ts", FORMAT_OPTIONS);

		// then
		expect(block).toContain("First line\n  indented second line\nThird line");
		expect(block).not.toContain("\r");
	});

	it("#given duplicate static rules with different line endings #when formatting context #then it renders one copy", () => {
		// given
		const lfRule = loadedRule({
			path: "/repo/AGENTS.md",
			relativePath: "AGENTS.md",
			body: "Shared rule\nKeep one copy.",
		});
		const crlfRule = loadedRule({
			path: "/repo/packages/AGENTS.md",
			relativePath: "packages/AGENTS.md",
			body: "Shared rule\r\nKeep one copy.",
		});

		// when
		const block = formatStaticBlock([lfRule, crlfRule], FORMAT_OPTIONS);

		// then
		expect(occurrenceCount(block, "Shared rule\nKeep one copy.")).toBe(1);
		expect(block).not.toContain("/repo/packages/AGENTS.md");
	});

	it("#given no matching rules #when formatting hook context #then it emits no context", () => {
		// given
		const rules: LoadedRule[] = [];

		// when
		const dynamicBlock = formatDynamicBlock(rules, "src/app.ts", FORMAT_OPTIONS);
		const staticBlock = formatStaticBlock(rules, FORMAT_OPTIONS);

		// then
		expect(dynamicBlock).toBe("");
		expect(staticBlock).toBe("");
	});
});

function loadedRule(input: {
	readonly body: string;
	readonly path?: string;
	readonly relativePath?: string;
	readonly source?: RuleSource;
	readonly matchReason?: MatchReason;
}): LoadedRule {
	const path = input.path ?? "/repo/AGENTS.md";
	const relativePath = input.relativePath ?? "AGENTS.md";
	const source = input.source ?? "AGENTS.md";
	return {
		path,
		realPath: path,
		source,
		distance: 0,
		isGlobal: false,
		isSingleFile: true,
		relativePath,
		frontmatter: {},
		body: input.body,
		contentHash: "hash",
		matchReason: input.matchReason ?? "single-file",
	};
}

function occurrenceCount(value: string, search: string): number {
	return value.split(search).length - 1;
}
