import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withPostCompactBudget } from "../src/post-compact-budget.js";
import type { PiRulesConfig } from "../src/rules/types.js";

const tempDirectories: string[] = [];
const CONFIG: PiRulesConfig = {
	disabled: false,
	mode: "both",
	maxRuleChars: 30_000,
	maxResultChars: 50_000,
	postCompactMaxRuleChars: 12_000,
	postCompactMaxResultChars: 20_000,
	enabledSources: "auto",
};

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("post-compact context budget", () => {
	it("#given known model near its context window #when resolving post-compact budget #then shrinks projected rule injection", () => {
		// given
		const transcriptPath = writeCompactedTranscript("A".repeat(760_000));

		// when
		const budget = withPostCompactBudget(CONFIG, { model: "gpt-5.5", transcriptPath });

		// then
		expect(budget.maxResultChars).toBeLessThan(1_000);
		expect(budget.maxRuleChars).toBeLessThanOrEqual(budget.maxResultChars);
	});

	it("#given unknown model #when resolving post-compact budget #then keeps configured fallback cap", () => {
		// given
		const transcriptPath = writeCompactedTranscript("A".repeat(760_000));

		// when
		const budget = withPostCompactBudget(CONFIG, { model: "unknown-model", transcriptPath });

		// then
		expect(budget.maxRuleChars).toBe(CONFIG.postCompactMaxRuleChars);
		expect(budget.maxResultChars).toBe(CONFIG.postCompactMaxResultChars);
	});

	it("#given known roomy model #when resolving post-compact budget #then keeps configured post-compact cap", () => {
		// given
		const transcriptPath = writeCompactedTranscript("small compacted summary");

		// when
		const budget = withPostCompactBudget(CONFIG, { model: "openai.gpt-5.5", transcriptPath });

		// then
		expect(budget.maxRuleChars).toBe(CONFIG.postCompactMaxRuleChars);
		expect(budget.maxResultChars).toBe(CONFIG.postCompactMaxResultChars);
	});
});

function writeCompactedTranscript(retainedText: string): string {
	const root = mkdtempSync(path.join(tmpdir(), "post-compact-budget-"));
	tempDirectories.push(root);
	const transcriptPath = path.join(root, "transcript.jsonl");
	writeFileSync(
		transcriptPath,
		`${JSON.stringify({
			type: "compacted",
			payload: {
				message: "summary",
				replacement_history: [{ type: "message", role: "user", content: retainedText }],
			},
		})}\n`,
	);
	return transcriptPath;
}
