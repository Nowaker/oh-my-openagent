# OMO on OpenCode v2: bridge spike

The bridge runs current OMO on real OpenCode 2.2.7: the plugin is active, all 11 OMO agents register, Sisyphus receives its resolved dynamic prompt, OMO tools and four MCP definitions register, and a real model/tool/model turn completes. This proves bridge viability, not must-tier parity. Delegation, todo continuation and several SDK-dependent recovery paths still need the work below.

## Revisions and ownership

- OMO base: `95292a32aaddc3acc065f12bbc803f379a352b5d`, version 5.1.66, on task branch `v2`. The spike does not integrate into `dev-nowaker`.
- Reference: [herjarsa 0.4.2, f4e0fb956b](https://github.com/herjarsa/oh-my-openagent-v2/tree/f4e0fb956b/packages/omo-opencode/src/plugin-v2). Its bridge supplied the translation design; this port uses current OMO's factory/config pipeline and current typed v2 APIs instead of beta.90's positional agent assembly and empty-return facade.
- Runtime: npm `@opencode/cli-linux-x64@2.2.7`, matching upstream tag `v2.2.7`; binary SHA256 `589253d36810f21217edd51545cd435b328cdc3cf4f451fbe0cce6f88afcf5e1`. `@opencode/plugin` is pinned to 2.2.7; the v1 SDK/plugin pins remain 1.18.31.
- Implementation and QA: [W2](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e3831b47affebONO8ZtnFQXsho), with [facade worker](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e3826c833ffes2g928pYXLYs4F) and [hook worker](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e382325cfffe2qLTY64Nk6ieQZ). [Coordinator](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e383ee7faffe6JX8m2EP26dXUC).

## What the real host proved

| Observation | Result | Local artifact under `.omo/evidence/20261110-v2-bridge/` |
|---|---|---|
| Upstream no-op baseline | OMO active; only native agents, no Sisyphus | `baseline/plugins.json`, `baseline/agents.json` |
| Bridged registration | OMO active; all 11 OMO agents plus native agents | `omo-tools-proven/plugins.json`, `omo-tools-proven/agents.json` |
| Dynamic prompt delivery | Registered Sisyphus system text reaches the fake provider unchanged; SHA256 `83165522d30f63544e18ba69aa81db612a52f9f0e3a99b1a1ddbfe6933e6b8a2` | `omo-tools-proven/qa-summary.json`, `omo-tools-proven/provider-requests.json` |
| Tool admission and execution | All 14 OMO definitions reach the real model registry; three provider requests execute OMO glob (`Found 1 file(s)`) and OMO-only `background_output` with a deliberately absent ID | `omo-tools-proven/messages.json`, `omo-tools-proven/export.json`, `omo-tools-proven/qa-summary.json` |
| Lifecycle wire proof | `session.tool.called`, `session.tool.success`, `session.execution.succeeded`, request/step/text events observed | `omo-tools-proven/events.txt` |
| MCP registration | `context7`, `grep_app`, `lsp`, `websearch` register; connection state varies and remote tools were not exercised | `omo-tools-proven/mcp.json` |
| TUI smoke | Throwaway tmux TUI renders Sisyphus and the tool exchange; no Native startup recommendation | `omo-tools-proven/tui.txt`, `omo-tools-proven/tui-stream.ansi` |

The provider is deliberately scripted and local. It proves host admission, prompt propagation and tool execution; it does not measure model intelligence. The missing-task response tests the result tool's error path, not a spawned background task. The TUI displayed the final answer twice although native history contains one answer. This is an observed display discrepancy with an unproven cause, not a duplicate stored turn.

The first tool proof was false: all OMO definitions were rejected and native glob survived. The capture at `accepted/` and the original demo are retained but superseded. The stronger driver rejects that old bundle with `OMO-only background_output was not admitted`; see `negative-control.txt`. The real-host `normalized-host-schema/tmp/normalized-schema-probe.json` reproduces the `seen.ref` failure on re-conversion and the correct description-preserving result on direct encoder invocation.

## Section 4.1 must tier

"Loaded" means the current implementation is registered through the bridge. "Works" names the evidence actually obtained, not an inference from registration.

| Capability | Loaded | Works | Broken or missing |
|---|---|---|---|
| Agent roster and dynamic prompts | Yes | All 11 register; Sisyphus prompt delivered exactly | Full per-agent turn matrix not exercised |
| Categories and model routing | Yes | Configured fake model and distinct GPT-shaped Hephaestus fixture retained; translation tests retain variant | Category dispatch/fallback chains not exercised through a real delegated turn |
| Keyword detector | Yes | Prompt hook registered | Keyword-mode behavior not exercised live |
| Rules injector and default mode | Yes | Existing v1 pipeline and context transform load | Rule fixtures, default modes and instruction-entry replacement not exercised live |
| Todo continuation and stop guard | Yes | Hooks load | `session.todo` is unsupported; experimental todo extraction and idle admission remain missing |
| Compaction context and todo preservation | Yes | Compaction translation unit checks pass | Real compaction not exercised; todo access and post-compaction autocontinue missing |
| `task` contract | Yes | Tool definition loads | Legacy permissions, per-prompt tools/system and synthetic semantics can throw; no delegated turn or continuation proved |
| Background task/result/cancel contract | Yes | OMO-only result tool returns the expected deliberately missing-task response | No background launch, cancel, status, restart recovery or parent-wake lifecycle proved |
| `skill`, `skill_mcp`, compatibility loaders | Yes | Tool context forwards permission assertions; current config/loader pipeline retained | No live skill/embedded-MCP or Claude loader scenario; loaders disabled in the fixture |
| Existing OMO configuration schema | Yes | Real `[opencode]` fixture validates; agent/model overrides apply through current config hook | `client.config.get` unsupported; no full user-profile/override parity claim |

Foreign slash-command interception and compaction autocontinue are explicit unmapped hooks. Source-sensitive `shell.env` cannot be projected honestly because v2's shell hook lacks the source/session/message/call identity. Opaque media, reasoning, native checkpoints and tool-result messages survive by identity; unsupported edits to them fail explicitly. The TUI's existing sidebar/BTW features are not ported by this spike.

## Throwing facade

Every unsupported method throws `UnsupportedV1ClientCallError` and logs only its method path. The successful live runs observed exactly `config.get`, `session.status`, and `tui.showToast`; existing OMO callers catch those exceptions. They are visible gaps, not successful empty reads. See `omo-tools-proven/qa-summary.json` and `omo-tools-proven/tmp/oh-my-opencode.log`.

Additional explicitly rejected calls/options covered by owner checks are `experimental_workspace.register`, `session.todo`, `session.children`, `session.create.permission`, `session.messages.limit`, absent prompt bodies, prompt `system`/`tools`, a variant without model authority, unsupported synthetic/ignored text metadata, file-source overrides, subtask parts, and unknown nested method paths. Unsupported native responses also throw instead of fabricating an assistant result. Complete signatures and cases are in `w2a-result.txt`; hook-specific unsupported translations are in `w2b-evidence.txt`.

## Isolation and reproducibility

`script/qa/v2-bridge-spike.ts` launches the real binary with a clean environment, scratch HOME and XDG directories, explicit scratch `OPENCODE_DB`, tools/plugins directories, loopback ports and generated private authentication. The project lives below scratch HOME; a realpath ancestor check refuses an escaping project walk. TUI smoke uses its own short `/tmp/omo-v2-spike-<pid>.sock` because the evidence path exceeds Unix socket path limits. The driver closes its server, fake provider and owned tmux server.

Two 2.2.7 host contracts matter: configured local plugins must name directories (`core/src/config/plugin/source.ts` drops file entries), and the native fake provider uses `@opencode/ai/providers/openai-compatible` with `capabilities.tools=true`. Wait for location initialization and `plugin.updated` before reading registration. The v2 API uses deep-object location query parameters.

The current OMO registry installs a zero-argument `_zod.toJSONSchema` encoder on each argument. Wrapping that field in another Zod conversion skips its described parent's traversal and fails in `seen.ref`; the bridge consumes the existing encoder's JSON directly. V2 puts plugin tools into Code Mode by default, so `codemode: false` retains the v1 direct-call contract. Setup and teardown run both cleanup layers and preserve combined failures; owner tests cover both error paths.

An early fixture used `opencode` instead of `[opencode]`, so OMO rejected it and used defaults. This was initially mistaken for inherited host configuration. A subsequent metadata-only origin audit proved the only source was the scratch user file; the loader already excludes the real account home from its project walk. No host config was read by that loader. The metadata audit found no changed real OMO/OpenCode config files and no v2-attributable writes in the audited live-state directories. Live v1 logging and collector files continued to change independently. See `config-origin.json`, `verified-config-origin.json`, `host-modified-paths.txt`, `ancestor-modified-paths.txt`, and `ancestor-config-paths.txt`.

Downloaded reference sources were kept in their own empty directory. Two early child Bun substring filters accidentally discovered reference unit tests; those processes had clean scratch HOME/XDG/TMPDIR environments. The commands were corrected to exact `./` paths. No downloaded lifecycle, install or shell scripts ran. The host's live OpenCode DB was never opened by a v2 binary; no live DB count query was used because the task forbids touching that DB.

Build the current `index`, `tui`, and `node-require-shim` nodes from `script/build-nodes.ts`, including their declared host-runtime externals and the shared-skill assets. Then run:

```sh
bun script/qa/v2-bridge-spike.ts .omo/evidence/20261110-v2-bridge/run tmp/v2-cli/package/bin/opencode dist/index.js turn tui
```

The binary argument must be the downloaded 2.2.7 binary or the coordinator's guarded `opencode2`, never the live v1 command. Artifacts are local and ignored; credentials and headers are not copied into the report.

## Verification

- Final focused bridge, factory, interface, TUI, export, audit, Node bundle and build suite: 120 pass, 0 fail across 20 files, 253 assertions. Cleanup mutation: removing the v1 disposer makes all three owner tests fail; restoration is byte-checked and the final suite is green. Facade and hook worker mutation proofs are retained.
- Root typecheck: no errors in 2,384 files. Script typecheck: no errors in 1,305 files. Bridge plus test scope: no errors in 1,914 files. LSP diagnostics for the bridge directory and QA driver: zero. Server and TUI bundles build, including the Node require shim.
- Untouched-base broad adapter run: 10,995 pass, 14 skip, 30 fail. Final candidate: 11,034 pass, 14 skip, 31 fail. `baseline-comparison.json` mechanically confirms all 30 baseline assertion names also fail in the candidate, with none removed and only `(unnamed)` added. That extra failure is the `omo-t` temporary-entry teardown, an open caveat with owner unknown; it is not folded into the baseline. See `v1-baseline-tests.txt` and `delivery-v1-tests.txt`.
- V1 entry blobs match exactly: `index.ts` is `e648643c51c2dee7fffc99b6f4dc919be48ae4f5`, `tui.ts` is `f99fbad2992378e0ad7c3eb5ab1c1158d2ea5dcf`, on both base and candidate. Final Oracle gate: APPROVE, high confidence, with the stated residual risks (`review.txt`). Public evidence hashes are in `artifacts.sha256`. No full Codex/Senpi/native build or minimal production-payload QA is claimed.

## Demonstration

The [corrected Portal-visible controller](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e3786ce2affecEwsHDMyRFhq2O) drives the real isolated [v2 session](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e37844fffffeppZ1FleacdEry7). The second link names its ID only: Portal does not index the scratch v2 DB yet. The controller quotes the actual prompt, assistant answer, OMO glob's `Found 1 file(s)` result and OMO-only `background_output` response. Its public evidence is at `~/projekty/tmp/vibeterm/opencode-omo-demos/w2-omo-tools/{export,messages,plugins,agents,session,qa-summary}.json`; no v2 history was imported into live v1 storage. The [superseded controller](https://portal.vibeterm.desktop.ts.nowaker.net/session/ses_e37d491d6ffepfbqCuJsF9YYJo) is retained and now displays an explicit correction that its glob result was native, not OMO; it is not tool-admission evidence.

## Re-sized steps 2-5

These are engineering-day estimates from the observed gaps, not the spike's elapsed runtime. All work remains a bridge following every OMO release; there is no native OMO rebuild.

| Step | Previous estimate | Revised estimate | Evidence driving the change |
|---|---|---|---|
| 2. Current-layout delegation fixes and facade fidelity | 2-3 days | 3-5 days | Truthful config/status/todo/children/message fields, permissions and per-prompt tools/system are broader gaps than model/agent-name translation |
| 3. Native fills | 3-4 days | 3-5 days | Permission assertion is already wired; todo extraction, idle continuation, manual compaction semantics and instruction entries need separate live scenarios |
| 4. Thin task wrapper on engine semantics | 2-3 days | 2-4 days | Current background manager boots but its lifecycle contract is not proved; continuation, restart and parent wake must follow the section 4.4 cases |
| 5. Must-tier parity and bump gate | 2-3 days | 3-4 days | Add real hook/permission/compaction/skill/delegation cases, preserve message identity, separate baseline test failures, and test host-runtime packaging |

Remaining estimate: 11-18 engineering days. Expect 0.5-1.5 days per OMO bump until the parity suite stabilizes the SDK boundary; an unsupported new call is deliberately loud.
