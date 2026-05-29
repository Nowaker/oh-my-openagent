import { describe, expect, it } from "vitest";

import {
	createLazyMcpProxy,
	DEFAULT_LAZY_MCP_IDLE_TIMEOUT_MS,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type LazyMcpBackend,
	type LazyMcpClock,
	type LazyMcpConnection,
	type LazyMcpTimer,
	type McpToolDescriptor,
} from "../src/lazy-mcp-proxy.js";

const toolDescriptors: readonly McpToolDescriptor[] = [
	{
		name: "diagnostics",
		title: "LSP Diagnostics",
		description: "Get diagnostics.",
		inputSchema: { type: "object", properties: {} },
	},
];

describe("lazy MCP proxy backend restarts", () => {
	it("#given an exited active backend #when a later tool call arrives #then the proxy restarts the backend for that call", async () => {
		// given
		const firstConnection = new ScriptedConnection();
		const restartedConnection = new ScriptedConnection();
		const backend = new SequencedBackend([
			{ kind: "connection", connection: firstConnection },
			{ kind: "connection", connection: restartedConnection },
		]);
		const proxy = createProxy(backend);
		await proxy.handleRequest(toolCall(1, "first.ts"));

		// when
		firstConnection.close();
		const response = await proxy.handleRequest(toolCall(2, "second.ts"));

		// then
		expect(response?.result?.isError).toBe(false);
		expect(backend.startCalls).toBe(2);
		expect(firstConnection.methods()).toEqual(["initialize", "tools/call"]);
		expect(restartedConnection.methods()).toEqual(["initialize", "tools/call"]);
	});

	it("#given concurrent calls after backend exit #when restart is still starting #then the proxy shares one restarted backend", async () => {
		// given
		const firstConnection = new ScriptedConnection();
		const restartGate = createDeferred();
		const restartedConnection = new ScriptedConnection(restartGate.promise);
		const backend = new SequencedBackend([
			{ kind: "connection", connection: firstConnection },
			{ kind: "connection", connection: restartedConnection },
		]);
		const proxy = createProxy(backend);
		await proxy.handleRequest(toolCall(1, "first.ts"));
		firstConnection.close();

		// when
		const first = proxy.handleRequest(toolCall(2, "second.ts"));
		const second = proxy.handleRequest(toolCall(3, "third.ts"));
		restartGate.resolve();
		const responses = await Promise.all([first, second]);

		// then
		expect(responses.map((response) => response?.result?.isError)).toEqual([false, false]);
		expect(backend.startCalls).toBe(2);
		expect(restartedConnection.methods()).toEqual(["initialize", "tools/call", "tools/call"]);
	});

	it("#given a failed restart after backend exit #when another call arrives #then the proxy retries with a fresh backend", async () => {
		// given
		const firstConnection = new ScriptedConnection();
		const recoveredConnection = new ScriptedConnection();
		const backend = new SequencedBackend([
			{ kind: "connection", connection: firstConnection },
			{ kind: "error", error: new Error("restart failed") },
			{ kind: "connection", connection: recoveredConnection },
		]);
		const proxy = createProxy(backend);
		await proxy.handleRequest(toolCall(1, "first.ts"));

		// when
		firstConnection.close();
		const failedRestart = await proxy.handleRequest(toolCall(2, "second.ts"));
		const recovered = await proxy.handleRequest(toolCall(3, "third.ts"));

		// then
		expect(failedRestart?.result?.isError).toBe(true);
		expect(failedRestart?.result?.content?.[0]?.text).toContain("restart failed");
		expect(recovered?.result?.isError).toBe(false);
		expect(backend.startCalls).toBe(3);
		expect(recoveredConnection.methods()).toEqual(["initialize", "tools/call"]);
	});

	it("#given an active backend whose close signal rejects #when the close settles #then the active backend is cleared", async () => {
		// given
		const firstConnection = new ScriptedConnection();
		const restartedConnection = new ScriptedConnection();
		const backend = new SequencedBackend([
			{ kind: "connection", connection: firstConnection },
			{ kind: "connection", connection: restartedConnection },
		]);
		const proxy = createProxy(backend);
		await proxy.handleRequest(toolCall(1, "first.ts"));

		// when
		firstConnection.closeWithError(new Error("backend transport failed"));
		await Promise.resolve();

		// then
		expect(proxy.hasActiveBackend()).toBe(false);
		const response = await proxy.handleRequest(toolCall(2, "second.ts"));
		expect(response?.result?.isError).toBe(false);
		expect(backend.startCalls).toBe(2);
	});
});

type BackendStep =
	| { readonly kind: "connection"; readonly connection: ScriptedConnection }
	| { readonly kind: "error"; readonly error: Error };

class SequencedBackend implements LazyMcpBackend {
	startCalls = 0;

	constructor(private readonly steps: readonly BackendStep[]) {}

	async start(): Promise<LazyMcpConnection> {
		const step = this.steps[this.startCalls];
		this.startCalls++;
		if (step === undefined) throw new Error("unexpected backend start");
		switch (step.kind) {
			case "connection":
				return step.connection;
			case "error":
				throw step.error;
		}
	}
}

class ScriptedConnection implements LazyMcpConnection {
	stopCalls = 0;
	readonly requests: JsonRpcRequest[] = [];
	readonly closed: Promise<void>;

	private closedState = false;
	private rejectClosed: (error: Error) => void = () => {};
	private resolveClosed: () => void = () => {};

	constructor(private readonly startGate?: Promise<void>) {
		this.closed = new Promise((resolve, reject) => {
			this.resolveClosed = resolve;
			this.rejectClosed = reject;
		});
	}

	async request(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
		if (request.method === "initialize") await this.startGate;
		if (this.closedState) throw new Error("Lazy MCP backend exited");
		this.requests.push(request);
		return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [], isError: false } };
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		this.close();
	}

	close(): void {
		if (this.closedState) return;
		this.closedState = true;
		this.resolveClosed();
	}

	closeWithError(error: Error): void {
		if (this.closedState) return;
		this.closedState = true;
		this.rejectClosed(error);
	}

	methods(): string[] {
		return this.requests.flatMap((request) => (typeof request.method === "string" ? [request.method] : []));
	}
}

class ManualClock implements LazyMcpClock {
	setTimeout(): LazyMcpTimer {
		return {};
	}

	clearTimeout(): void {}
}

function createProxy(backend: LazyMcpBackend) {
	return createLazyMcpProxy({
		backend,
		clock: new ManualClock(),
		idleTimeoutMs: DEFAULT_LAZY_MCP_IDLE_TIMEOUT_MS,
		toolDescriptors,
	});
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolveDeferred: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolveDeferred = resolve;
	});
	return { promise, resolve: resolveDeferred };
}

function toolCall(id: number, filePath: string): JsonRpcRequest {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "diagnostics", arguments: { filePath } },
	};
}
