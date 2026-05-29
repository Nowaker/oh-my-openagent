import { describe, expect, it } from "vitest";

import { extractMutatedFilePaths, runLspPostToolUseHook } from "../src/codex-hook.js";

describe("codex PostToolUse hook", () => {
	it("extracts files from Codex apply_patch command payloads", () => {
		const paths = extractMutatedFilePaths({
			tool_name: "apply_patch",
			tool_input: {
				command: [
					"*** Begin Patch",
					"*** Add File: src/new.ts",
					"+export const value = 1;",
					"*** Update File: src/existing.ts",
					"@@",
					"-export const old = true;",
					"+export const old = false;",
					"*** End Patch",
				].join("\n"),
			},
			tool_response: "Success. Updated files.",
		});

		expect(paths).toEqual(["src/new.ts", "src/existing.ts"]);
	});

	it("extracts files from edit-style tool input aliases", () => {
		const paths = extractMutatedFilePaths({
			tool_name: "Edit",
			tool_input: { file_path: "src/edit.ts" },
			tool_response: { ok: true },
		});

		expect(paths).toEqual(["src/edit.ts"]);
	});

	it("#given post-edit diagnostics contain one error #when the hook blocks #then it keeps the blocked output shape", async () => {
		// given
		const output = await runLspPostToolUseHook(
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: src/broken.ts\n@@\n+missing();\n*** End Patch\n",
				},
				tool_response: "Success. Updated files.",
			},
			async (filePath) => {
				expect(filePath).toBe("src/broken.ts");
				return "error[typescript] (2304) at 1:1: Cannot find name 'missing'.";
			},
		);

		// when
		const parsed: unknown = JSON.parse(output);

		// then
		expect(JSON.parse(output)).toEqual({
			decision: "block",
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext:
					"LSP diagnostics after editing src/broken.ts:\n\n" +
					"- error[typescript] (2304) at 1:1: Cannot find name 'missing'.",
			},
			reason:
				"LSP diagnostics after editing src/broken.ts:\n\n" +
				"- error[typescript] (2304) at 1:1: Cannot find name 'missing'.",
		});
		expect(parsed).toHaveProperty("decision", "block");
	});

	it("#given adjacent TypeScript diagnostics #when the hook blocks #then it renders each diagnostic on its own bullet line", async () => {
		// given
		const output = await runLspPostToolUseHook(
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: src/broken.ts\n@@\n+missing();\n*** End Patch\n",
				},
				tool_response: "Success. Updated files.",
			},
			async () =>
				"error[typescript] (2307) at 5:7: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.error[typescript] (2307) at 6:49: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.error[typescript] (2307) at 10:7: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.",
		);

		// when
		const parsed: unknown = JSON.parse(output);
		if (!isPostToolUseHookOutput(parsed)) throw new TypeError("Expected PostToolUse hook output");

		// then
		expect(parsed.reason).toBe(
			[
				"LSP diagnostics after editing src/broken.ts:",
				"",
				"- error[typescript] (2307) at 5:7: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.",
				"- error[typescript] (2307) at 6:49: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.",
				"- error[typescript] (2307) at 10:7: Cannot find module 'openclaw/plugin-sdk/config-runtime' or its corresponding type declarations.",
			].join("\n"),
		);
		expect(parsed.hookSpecificOutput.additionalContext).toBe(parsed.reason);
	});

	it("#given plain non-diagnostic feedback #when the hook blocks #then it preserves the text after the readable header", async () => {
		// given
		const output = await runLspPostToolUseHook(
			{
				tool_name: "write",
				tool_input: { path: "src/broken.ts" },
				tool_response: { ok: true },
			},
			async () => "language server failed before diagnostics could be collected",
		);

		// when
		const parsed: unknown = JSON.parse(output);
		if (!isPostToolUseHookOutput(parsed)) throw new TypeError("Expected PostToolUse hook output");

		// then
		expect(parsed.reason).toBe(
			"LSP diagnostics after editing src/broken.ts:\n\nlanguage server failed before diagnostics could be collected",
		);
		expect(parsed.hookSpecificOutput.additionalContext).toBe(parsed.reason);
	});

	it("#given multiple edited files #when only one file has diagnostics #then it injects only files with diagnostics", async () => {
		// given
		const checkedFilePaths: string[] = [];
		const output = await runLspPostToolUseHook(
			{
				tool_name: "MultiEdit",
				tool_input: {
					file_paths: ["src/clean.ts", "README.md", "src/broken.ts", "src/broken.ts"],
				},
				tool_response: { ok: true },
			},
			async (filePath) => {
				checkedFilePaths.push(filePath);
				if (filePath === "src/broken.ts") {
					return "error[typescript] (2322) at 1:7: Type 'number' is not assignable to type 'string'.";
				}
				if (filePath === "README.md") {
					return "No LSP server configured for extension: .md";
				}
				return "No diagnostics found";
			},
		);

		// when
		const expectedDiagnostics =
			"LSP diagnostics after editing src/broken.ts:\n\n" +
			"- error[typescript] (2322) at 1:7: Type 'number' is not assignable to type 'string'.";

		// then
		expect(checkedFilePaths).toEqual(["src/clean.ts", "README.md", "src/broken.ts"]);
		expect(JSON.parse(output)).toEqual({
			decision: "block",
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: expectedDiagnostics,
			},
			reason: expectedDiagnostics,
		});
	});

	it("does not run diagnostics for failed mutation tool responses", async () => {
		const output = await runLspPostToolUseHook(
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: src/broken.ts\n@@\n+missing();\n*** End Patch\n",
				},
				tool_response: { isError: true },
			},
			async () => {
				throw new Error("diagnostics should not run after failed mutations");
			},
		);

		expect(output).toBe("");
	});

	it("is silent for clean diagnostics and unsupported extensions", async () => {
		const output = await runLspPostToolUseHook(
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: README.md\n@@\n+hello\n*** End Patch\n",
				},
				tool_response: "Success. Updated files.",
			},
			async () => "No LSP server configured for extension: .md",
		);

		expect(output).toBe("");
	});
});

interface PostToolUseHookOutput {
	readonly decision: "block";
	readonly reason: string;
	readonly hookSpecificOutput: {
		readonly hookEventName: "PostToolUse";
		readonly additionalContext: string;
	};
}

function isPostToolUseHookOutput(value: unknown): value is PostToolUseHookOutput {
	if (!isRecord(value)) return false;
	const hookSpecificOutput = value["hookSpecificOutput"];
	return (
		value["decision"] === "block" &&
		typeof value["reason"] === "string" &&
		isRecord(hookSpecificOutput) &&
		hookSpecificOutput["hookEventName"] === "PostToolUse" &&
		typeof hookSpecificOutput["additionalContext"] === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
