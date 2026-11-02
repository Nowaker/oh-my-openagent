import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createAgentUsageReminderHook } from "./index";
import { clearSessionAgent, updateSessionAgent, _resetForTesting } from "../../features/claude-code-session-state";
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value";
import * as storage from "./storage";

describe("agent-usage-reminder hook", () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let clearStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _resetForTesting();
    loadStateSpy = spyOn(storage, "loadAgentUsageState").mockReturnValue(null);
    saveStateSpy = spyOn(storage, "saveAgentUsageState").mockImplementation(mock(() => {}));
    clearStateSpy = spyOn(storage, "clearAgentUsageState").mockImplementation(mock(() => {}));
  });

  afterEach(() => {
    loadStateSpy?.mockRestore();
    saveStateSpy?.mockRestore();
    clearStateSpy?.mockRestore();
  });

  function createHook() {
    return createAgentUsageReminderHook(unsafeTestValue<PluginInput>({}));
  }

  test("release reloads persisted reminder state without resetting a sibling", async () => {
    // given
    const hook = createHook();
    const sessionID = "agent-usage-retired";
    const siblingID = "agent-usage-sibling";
    type PersistedState = NonNullable<ReturnType<typeof storage.loadAgentUsageState>>;
    const persisted = new Map<string, PersistedState>();
    loadStateSpy.mockImplementation((id: string) => persisted.get(id) ?? null);
    saveStateSpy.mockImplementation((state: PersistedState) => {
      persisted.set(state.sessionID, { ...state });
    });
    await hook["tool.execute.after"]({ tool: "task", sessionID, callID: "1" }, { title: "", output: "", metadata: {} });
    await hook["tool.execute.after"]({ tool: "task", sessionID: siblingID, callID: "2" }, { title: "", output: "", metadata: {} });
    const persistedBefore = persisted.get(sessionID);
    loadStateSpy.mockClear();

    // when
    hook.releaseSession(sessionID);
    hook.releaseSession(sessionID);
    const targetOutput = { title: "", output: "target", metadata: {} };
    const siblingOutput = { title: "", output: "sibling", metadata: {} };
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "3" }, targetOutput);
    await hook["tool.execute.after"]({ tool: "grep", sessionID: siblingID, callID: "4" }, siblingOutput);

    // then
    expect(loadStateSpy.mock.calls).toEqual([[sessionID]]);
    expect(clearStateSpy).not.toHaveBeenCalled();
    expect(persisted.get(sessionID)).toEqual(persistedBefore);
    expect(targetOutput.output).toBe("target");
    expect(siblingOutput.output).toBe("sibling");
  });

  test("caps reminders and does not re-arm after session.compacted", async () => {
    // given - an orchestrator session has already hit the reminder cap
    const hook = createHook();
    const sessionID = "agent-usage-compact-session";
    updateSessionAgent(sessionID, "Sisyphus");

    const output1 = { title: "", output: "result-1", metadata: {} };
    const output2 = { title: "", output: "result-2", metadata: {} };
    const output3 = { title: "", output: "result-3", metadata: {} };
    const output4 = { title: "", output: "result-4", metadata: {} };

    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "1" }, output1);
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "2" }, output2);
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "3" }, output3);

    // then - the first three reminders are shown
    expect(output1.output).toContain("[Agent Usage Reminder]");
    expect(output2.output).toContain("[Agent Usage Reminder]");
    expect(output3.output).toContain("[Agent Usage Reminder]");

    // when - compaction happens and another target tool runs
    await hook.event({ event: { type: "session.compacted", properties: { sessionID } } });
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "4" }, output4);

    // then - compaction does not reset the reminder cap
    expect(output4.output).not.toContain("[Agent Usage Reminder]");

    clearSessionAgent(sessionID);
  });

  test("resets reminder state on session.deleted", async () => {
    // given - an orchestrator session has reminder state
    const hook = createHook();
    const sessionID = "agent-usage-delete-session";
    updateSessionAgent(sessionID, "Sisyphus");

    const output1 = { title: "", output: "result-1", metadata: {} };
    const output2 = { title: "", output: "result-2", metadata: {} };
    const output3 = { title: "", output: "result-3", metadata: {} };
    const output4 = { title: "", output: "result-4", metadata: {} };
    const output5 = { title: "", output: "result-5", metadata: {} };

    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "1" }, output1);
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "2" }, output2);
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "3" }, output3);
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "4" }, output4);

    expect(output1.output).toContain("[Agent Usage Reminder]");
    expect(output2.output).toContain("[Agent Usage Reminder]");
    expect(output3.output).toContain("[Agent Usage Reminder]");
    expect(output4.output).not.toContain("[Agent Usage Reminder]");

    // when - the session is deleted and another target tool runs
    await hook.event({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } });
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "5" }, output5);

    // then - deletion still resets the state
    expect(output5.output).toContain("[Agent Usage Reminder]");

    clearSessionAgent(sessionID);
  });

  test("does not re-arm after session.compacted when task delegation already happened", async () => {
    // given - an orchestrator session already delegated through task
    const hook = createHook();
    const sessionID = "agent-usage-delegated-session";
    updateSessionAgent(sessionID, "Sisyphus");

    const output = { title: "", output: "result", metadata: {} };

    await hook["tool.execute.after"]({ tool: "task", sessionID, callID: "1" }, output);

    // when - compaction happens and another target tool runs
    await hook.event({ event: { type: "session.compacted", properties: { sessionID } } });
    await hook["tool.execute.after"]({ tool: "grep", sessionID, callID: "2" }, output);

    // then - compaction does not clear delegated state
    expect(output.output).not.toContain("[Agent Usage Reminder]");

    clearSessionAgent(sessionID);
  });
});
