import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { installCachedPlugin } from "./install/cache.mjs";
import { makeTempDir, writeJson } from "./install-test-fixtures.mjs";

test("#given external MCP package runtime #when installing cached plugin #then runtime is copied into the plugin cache", async () => {
	const repoRoot = await makeTempDir();
	const codexHome = await makeTempDir();
	const sourceRoot = join(repoRoot, "packages", "omo-codex", "plugin");
	const astGrepPackageRoot = join(repoRoot, "packages", "ast-grep-mcp");
	const lspPackageRoot = join(repoRoot, "packages", "lsp-tools-mcp");

	await writeJson(join(astGrepPackageRoot, "package.json"), {
		name: "@example/does-not-matter-either",
		version: "0.1.0",
		type: "module",
		bin: { "omo-ast-grep": "./dist/cli.js" },
	});
	await writeJson(join(lspPackageRoot, "package.json"), {
		name: "@example/does-not-matter",
		version: "0.1.0",
		type: "module",
		bin: { "omo-lsp": "./dist/cli.js" },
	});
	await writeJson(join(sourceRoot, "package.json"), {
		name: "@example/omo",
		version: "0.1.0",
	});
	await writeJson(join(sourceRoot, ".mcp.json"), {
		mcpServers: {
			ast_grep: {
				command: "node",
				args: ["../../ast-grep-mcp/dist/cli.js", "mcp"],
				cwd: ".",
			},
			lsp: {
				command: "node",
				args: ["../../lsp-tools-mcp/dist/cli.js", "mcp"],
				cwd: ".",
			},
		},
	});
	await writeJson(join(astGrepPackageRoot, "dist", "cli.js"), { executable: true });
	await writeJson(join(lspPackageRoot, "dist", "cli.js"), { executable: true });
	await writeJson(join(lspPackageRoot, "dist", "lsp", "manager.js"), { copied: true });

	const result = await installCachedPlugin({
		codexHome,
		marketplaceName: "sisyphuslabs",
		name: "omo",
		runCommand: async () => {},
		sourcePath: sourceRoot,
		version: "0.1.0",
	});

	const cachedMcp = JSON.parse(await readFile(join(result.path, ".mcp.json"), "utf8"));
	const copiedAstGrepCli = join(result.path, "mcp", "ast_grep", "dist", "cli.js");
	const copiedCli = join(result.path, "mcp", "lsp", "dist", "cli.js");

	assert.deepEqual(cachedMcp.mcpServers.ast_grep.args, [copiedAstGrepCli, "mcp"]);
	assert.deepEqual(cachedMcp.mcpServers.lsp.args, [copiedCli, "mcp"]);
	assert.equal(Object.hasOwn(cachedMcp.mcpServers.ast_grep, "cwd"), false);
	assert.equal(Object.hasOwn(cachedMcp.mcpServers.lsp, "cwd"), false);
	assert.equal((await stat(copiedAstGrepCli)).isFile(), true);
	assert.equal((await stat(copiedCli)).isFile(), true);
	assert.equal((await stat(join(result.path, "mcp", "lsp", "dist", "lsp", "manager.js"))).isFile(), true);
});
