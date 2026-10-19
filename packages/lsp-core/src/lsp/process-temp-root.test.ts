import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnProcess } from "./process.js";

const childScript = `
const { mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
mkdirSync(join(tmpdir(), "server-leftover"), { recursive: true });
console.log(tmpdir());
process.stdin.once("data", () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe("language server temp ownership", () => {
	it.each(["normal", "SIGTERM", "SIGKILL"] as const)(
		"#given concurrent servers #when one closes through %s #then only its scratch is removed",
		async (ending) => {
			// given
			const parent = mkdtempSync(join(tmpdir(), "lsp-process-owner-"));
			writeFileSync(join(parent, "parent-cache"), "keep");
			const env = { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent };
			const first = spawnProcess([process.execPath, "-e", childScript], { cwd: parent, env });
			const second = spawnProcess([process.execPath, "-e", childScript], { cwd: parent, env });
			const lines = [first, second].map((proc) => createInterface({ input: proc.stdout }));
			try {
				const [firstRoot, secondRoot] = await Promise.all(lines.map(async (line) => {
					for await (const value of line) return value;
					throw new Error("server exited before reporting temp root");
				}));
				if (!firstRoot || !secondRoot) throw new Error("missing child temp root");
				expect(firstRoot).not.toBe(parent);
				expect(firstRoot).not.toBe(secondRoot);
				expect(existsSync(join(firstRoot, "server-leftover"))).toBe(true);
				// when
				if (ending === "normal") first.stdin.write("exit");
				else first.kill(ending);
				await first.exited;
				// then
				expect(existsSync(firstRoot)).toBe(false);
				expect(existsSync(join(secondRoot, "server-leftover"))).toBe(true);
				expect(existsSync(join(parent, "parent-cache"))).toBe(true);
			} finally {
				for (const line of lines) line.close();
				first.kill("SIGKILL");
				second.kill("SIGKILL");
				await Promise.all([first.exited, second.exited]);
				rmSync(parent, { recursive: true, force: true });
			}
		},
	);

	it("#given an invalid server executable #when spawning fails #then its temp root is removed", async () => {
		// given
		const parent = mkdtempSync(join(tmpdir(), "lsp-process-owner-"));
		try {
			// when
			const proc = spawnProcess([join(parent, "missing-server")], {
				cwd: parent,
				env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
			});
			expect(await proc.exited).toBe(1);
			// then
			expect(readdirSync(parent)).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("#given scratch removal fails #when a server exits independently #then exit still settles and cleanup is reported", async () => {
		// given
		const parent = mkdtempSync(join(tmpdir(), "lsp-process-owner-"));
		const proc = spawnProcess([process.execPath, "-e", childScript], {
			cwd: parent,
			env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
		});
		const lines = createInterface({ input: proc.stdout });
		const originalRemove = fs.rmSync;
		const messages: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
			messages.push(String(chunk));
			return true;
		});
		try {
			const first = await lines[Symbol.asyncIterator]().next();
			if (first.done) throw new Error("server exited before reporting temp root");
			const remove = spyOn(fs, "rmSync").mockImplementation((path, options) => {
				if (path === first.value) throw Object.assign(new Error("fixture cleanup EACCES"), { code: "EACCES" });
				originalRemove(path, options);
			});
			try {
				// when
				proc.stdin.write("exit");
				// then
				expect(await proc.exited).toBe(0);
				expect(messages.some((message) => message.includes("EACCES"))).toBe(true);
			} finally {
				remove.mockRestore();
			}
		} finally {
			stderr.mockRestore();
			lines.close();
			proc.kill("SIGKILL");
			await proc.exited.catch(() => undefined);
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
