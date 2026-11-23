# Shared-Core `herdr-core` Runtime and Mulgae Integration Dossier

## 1. Execution authority and lifetime

The sole consumer of this dossier is `herdr-zcode` [`EPIC-001`](../roadmap/README.md#epic-001-shared-core-herdr-core-runtime-and-mulgae-integration-support) (`TASK-001` through `TASK-006`). The [roadmap](../roadmap/README.md) alone owns work identity, execution order, dependencies, status, and Epic acceptance. This document is the **temporary execution source of truth (SOT)** written so an independent implementing session can execute every Task accurately, sequentially, and without re-auditing `herdr-zcode`, `mulgae`, `herdr-core`, or `ZCode.app`.

Read this dossier, [docs/app-server.md](../app-server.md), [docs/toolchains.md](../toolchains.md), and the exact target source/test files cited in each Task before editing code. Follow Tasks strictly in order (`TASK-001` → `TASK-006`). Do **not** skip ahead, combine unrelated Tasks, or alter files outside the active Task's scope.

At `EPIC-001` closeout: promote durable behavior, module architecture, CLI flags, and test instructions to `README.md`, `HERDR.md`, `docs/app-server.md`, and `docs/toolchains.md`; replace `Detailed SOT` with `Canonical Outcomes` in `docs/roadmap/README.md`; and delete this dossier and its entry in [`docs/todo/README.md`](README.md).

---

## 2. Confirmed architectural decisions (locked — do not change)

1. **Explicit runtime flag, default `tui`, NO `auto` mode**:
   - CLI flag: `--runtime <tui|core>`.
   - Default when omitted: `'tui'`.
   - Invalid values (including `'auto'`, empty string, missing value): reject immediately with exit code `1` and an explicit error message (`Use runtime tui or core`).
   - Rationale: never guess runtime semantics from ambient environment variables (`HC_TERMINAL_ID` vs `HERDR_ENV`), which causes subtle bugs under nested sessions or scrubbed environments.
2. **Direct standalone `herdr-zcode` CLI launch (no `nvm` required at runtime)**:
   - Callers (humans, `hc run`, and `mulgae`) invoke `herdr-zcode ...` directly as a normal CLI.
   - `./dev` (`scripts/toolchain.sh`, `scripts/dev.mjs`, `scripts/check-toolchain.mjs`) **keeps** strict `toolchains.env` pinning (`NODE_VERSION=26.7.0`, `NPM_VERSION=11.19.0`) for development, offline tests, packing, and installation.
   - Installed `bin/herdr-zcode` tries pinned `nvm` Node first when present, and otherwise falls back deterministically to `ZCode.app/Contents/MacOS/ZCode` with `ELECTRON_RUN_AS_NODE=1` (honoring `--app-bundle` CLI arg, `HERDR_ZCODE_APP_BUNDLE` env var, or `/Applications/ZCode.app`). It **never** falls back to ambient `node` on `PATH`.
3. **Shared core + thin runtime adapters (minimize duplication between `tui` and `core`)**:
   - **MUST NOT** create separate entrypoints (`bin/herdr-zcode-core.mjs`), separate controllers (`CoreAppServerController`), or duplicate `AppServerClient` / `desktop-account.mjs` copies.
   - Keep **one** `bin/herdr-zcode-app.mjs`, **one** `lib/app-server-controller.mjs`, **one** `lib/app-server-client.mjs`, **one** `lib/desktop-runtime.mjs`, and **one** `lib/desktop-account.mjs`.
   - Isolate `tui` vs `core` policy differences solely inside `lib/runtime-profile.mjs` and the two thin reporter modules (`lib/herdr-reporter.mjs` for `tui`, `lib/osc7501-reporter.mjs` for `core`).
4. **Grok-parity scratch-file delivery (keep `herdr-zcode` thin)**:
   - Do **NOT** add `mulgae`-specific `--output-file`, `--output-mode extraction`, `--completion-nonce`, or `session/messages` output extraction to `herdr-zcode`.
   - Under `mulgae`, ZCode will follow the exact same `terminal.send` + `Read` (`prompt.md`) + `Write` (`<scratch>/output/...` + `MULGAE_COMPLETE:<nonce>`) workflow as `mulgae`'s `grok_terminal.go`, while outer macOS Seatbelt `ReadOnlyRoots` enforces read-only repository protection.
   - `herdr-zcode` provides the general-purpose session controls (`--tool-allowlist`, `--tool-denylist`, `--additional-dir`, `--mode yolo`, `--non-interactive`) that make this work cleanly.
5. **Zero external npm dependencies**:
   - Continue using only Node.js standard library modules (`node:*`). Never add third-party packages to `package.json`.
6. **Repository scope boundary**:
   - Do **NOT** edit anything inside `/Volumes/RootKernel/RootKernel/aquarium-tools/mulgae` during `herdr-zcode:EPIC-001`. Coupled `mulgae` changes are documented in Section 7 for a separate `mulgae` Epic.

---

## 3. Hard constraints and anti-regression guardrails (MUST NOT BREAK)

Before finishing **every** Task, verify these invariants still hold:

1. **All pre-existing passing offline tests MUST remain green (`./dev test`)**:
   - **Recorded unmodified `HEAD b8cc83a` baseline (2026-11-23, Node `26.7.0`)**: `./dev test` runs `112` tests with `110` passing and `2` pre-existing deterministic failures in `tests/app-server-terminal.test.mjs:407` (`readline Ctrl-C clears a partial tty draft...`) and `tests/app-server-terminal.test.mjs:638` (`Ctrl-C discards pasted draft while busy...`), where `rl.write(null, { ctrl: true, name: 'a'/'k' })` on synthetic `PassThrough` TTY streams leaves the partial draft concatenated with the next line under Node `26.7.0`. **Do NOT confuse these 2 pre-existing failures with regressions from `EPIC-001`, and do NOT refactor `readline` Ctrl-C draft clearing unless explicitly authorized.** Every other test (`110/110`) plus all new tests added in `TASK-001`..`TASK-006` MUST pass!
   - `tests/herdr-reporter.test.mjs` imports `createHerdrReporter` directly and calls `reporter.report('working', 'hello', 'session')`. **Keep `createHerdrReporter`'s existing `(state, message, sessionId)` public API unchanged.** Adapt canonical status snapshots inside `lib/runtime-profile.mjs`.
   - `tests/app-server-terminal.test.mjs` imports `{ main, parseArgs }` and `{ AppServerController }`, calls `controller.state()`, and expects `'idle'`, `'working'`, `'blocked'`, or `'unknown'` (see lines `549`, `552`, `643`). **Keep `controller.state()` returning the 4 legacy states** (`'idle' | 'working' | 'blocked' | 'unknown'`) by deriving it from the new `controller.status()` method.
   - `tests/fixtures/app-server-entry.mjs` passes `adapters.createHerdrReporter` returning `{ report(state, message, sessionId), close() }`. Keep `adapters.createHerdrReporter` working seamlessly in `tui` mode; add an optional `adapters.createReporter` (or let `runtime-profile` select `osc7501` in `core` mode unless explicitly overridden).
   - `tests/fixtures/app-server-fake.mjs:154` asserts `prefs.askUserQuestionAutoResolutionEnabled === false` in default (`tui`) runs, and `line 197` asserts `closeRequested === true` on normal stdin EOF. Do **not** flip `askUserQuestionAutoResolutionEnabled` to `true` for default `tui` mode, and do **not** skip `session/close` on normal stdin EOF!
   - `tests/toolchain.test.mjs:57` executes `node bin/herdr-zcode-app.mjs --version` with a tampered `toolchains.env` (`NODE_VERSION=0.0.0`) and asserts rejection with `/Expected Node 0.0.0/`. Plain `node` (where `process.versions.electron` is absent) **MUST** continue to fail on `NODE_VERSION` mismatch.
   - `tests/desktop-account.test.mjs:58` asserts `DEFAULT_MODEL === 'account:zai-individual-coding-plan/GLM-5.3'`. Keep `DEFAULT_MODEL` exported and used as default in `tui` mode.
   - `tests/stream-redaction.test.mjs` verifies split-chunk secret redaction. Never bypass `redactor` for model text, diagnostics, or OSC 7501 message fields.
2. **Never leak secrets in stdout, stderr, or OSC 7501**:
   - Never print raw `apiKey`, `requestAuth`, `authorization`, cookies, provider error bodies, or stack traces.
   - Only emit curated public fields through `safeErrorSummary()` / `classifyFailure()`.
3. **Never write to native `~/.zcode` or `~/Library/Keychains`**:
   - In `--auth-file` mode, never touch `~/.zcode`, `~/Library/Keychains`, `desktop-keychain.mjs`, or `/usr/bin/codesign`.
4. **Never touch the user's running `default` `herdr-core` session during tests**:
   - Any live `herdr-core` test (`TASK-006`) MUST create an isolated temporary `HC_SESSION` and scratch `XDG_*` paths, and kill/clean up only its own test-created session.

---

## 4. Verified external runtime facts (pinned reference)

All facts below were directly verified against installed binaries and `mulgae` source code on 2026-11-23. Do not guess or deviate from them:

### 4.1 `herdr-core 0.1.20` (`hc`) OSC 7501 & process lifecycle contract
- **Wire format** (verified in `mulgae/internal/adapters/herdr/live_herdr_darwin_test.go:88-120,263-265`):
  ```text
  \x1b]7501;state=<state>\x07
  \x1b]7501;state=blocked:kind=<kind>\x07
  ```
- **Allowed `<state>` values**: `idle`, `working`, `done`, `blocked`, `error`.
- **Allowed `<kind>` values when `state=blocked`** (verified in `mulgae/internal/adapters/providercli/terminal_provider.go:909-951`):
  - `auth` → `mulgae` classifies `login_required` (`ProviderExecutionStatusAuthentication`)
  - `quota` → `mulgae` classifies `provider_quota` (`ProviderExecutionStatusQuota`)
  - `rate_limit` → `mulgae` classifies `provider_rate_limit` (`ProviderExecutionStatusRateLimit`)
  - `permission` → `mulgae` classifies `provider_permission_denied` (`ProviderExecutionStatusAuthentication`)
  - `question` → human input required (interactive `herdr-core` panes; `mulgae` maps unknown blocked kinds to `provider_execution_failed`)
- **Required `mulgae` lifecycle transitions**:
  1. Startup ready (after `session/create` + model/mode setup + `session/subscribe` + `controller.attach`): emit `\x1b]7501;state=idle\x07`. This sets `herdr-core` `Terminal.reported = true`.
  2. Prompt received / turn started: emit `\x1b]7501;state=working\x07`.
  3. Turn succeeded (`turn.completed` with non-error `resultType` and not `cancelled`): emit `\x1b]7501;state=done\x07` (increments `Terminal.turn >= 1` in `herdr-core`).
  4. Turn cancelled (`resultType === 'cancelled'`): emit `\x1b]7501;state=idle\x07`.
  5. Turn failed (`turn.failed` or `resultType.startsWith('error_')` or unrecoverable `session/send` RPC failure): emit `\x1b]7501;state=blocked:kind=quota|rate_limit|auth|permission\x07` if classified, otherwise `\x1b]7501;state=error\x07`. **NEVER emit `idle` or `done` after a failed turn.**
- **Critical `mulgae` teardown & `hc kill` behavior**:
  - Per `herdr-core --skill`: *"On Unix, exit, `hc kill`, pane close and server stop do not sweep detached processes."*
  - Per `mulgae/internal/adapters/herdr/runner_darwin.go`: `teardownPane()` sends `SIGHUP` via `terminal.kill`, waits **`150ms`** (`postKillGraceDuration`), then sends `SIGKILL` to `-panePID` and `paneSID`. Under `BashGate` (B-1 Control 5), any surviving process holding `MULGAE_TERMINAL_PROFILE_SENTINEL` triggers a fatal `process_security` failure.
  - Therefore, in `--runtime core`, `ZCode app-server` **MUST** be spawned with `detached: false` (staying inside `panePID`'s process group and `paneSID`), AND `herdr-zcode`'s `SIGHUP`/`SIGTERM` handler **MUST** terminate `ZCode app-server` within `<100ms` (no 15s RPC waits).

### 4.2 `ZCode.app 3.18.2` (`zcode.cjs 0.17.1`) verified protocol facts
- **Built-in tool names** (verified in `zcode.cjs`): `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `Agent`, `TodoWrite`.
- **`session/create` accepted fields** (verified in `zcode.cjs @877637`):
  - `workspace: { workspaceKey, workspacePath }` (required)
  - `mode`: `'plan' | 'build' | 'edit' | 'guarded' | 'yolo' | 'auto'`
  - `model`: `{ providerId, modelId, options?: { reasoningLevel?: string } }`
  - `thoughtLevel`: `string`
  - `persistence`: `'immediate' | 'deferred'`
  - `titleGenerationEnabled`: `boolean`
  - `mcpServers`: `Array<...>` (`[]` disables external MCP servers)
  - `toolAllowlist`: `string[]` (`[]` means completely tool-free; omitted means unrestricted built-in set)
  - `toolDenylist`: `string[]`
  - `offPeakToolEnabled`: `boolean`
  - `dynamicWorkflowEnabled`: `boolean`
  - `additionalDirectories`: `string[]` (max 256)
- **Additional RPCs**:
  - `session/setModel`: `{ sessionId, model: { providerId, modelId, options?: { reasoningLevel } }, persistAsWorkspaceLastUsed: false }` → returns `{ settings: { model: { current: { providerId, modelId, options?: { reasoningLevel } } } } }`.
  - `session/setThoughtLevel`: `{ sessionId, thoughtLevel }` (used when `--reasoning-effort` is set without `--model` or alongside `session/create.thoughtLevel`).
- **Permission evaluation order in `zcode.cjs @5192841`**:
  - `requiresUserInteraction` (`tool.userInteraction`) and `alwaysAsk` (`tool.alwaysAsk`) are checked **BEFORE** `mode === 'yolo'`. Therefore `mode: 'yolo'` alone does **NOT** guarantee zero reverse `interaction/requestPermission` or `interaction/requestUserInput` calls. Non-interactive runs must configure `askUserQuestionAutoResolutionEnabled: true` AND handle unexpected reverse interaction RPCs fail-closed (`deny` or `block`) without blocking forever on stdin.
- **Internal Unix socket in `os.tmpdir()`**:
  - `zcode.cjs @14761567` binds `mkdtemp(join(os.tmpdir(), 'zcode-official-'))/endpoint.sock`. Because macOS `sun_path` is limited to 104 bytes, `TMPDIR` passed into `herdr-zcode` (e.g. `/tmp/mulgae-zcode`) must be preserved intact for `ZCode app-server`.

---

## 5. Shared-core architecture blueprint

```text
bin/herdr-zcode                 (standalone sh launcher: pinned nvm Node -> ZCode embedded Node)
bin/herdr-zcode-app.mjs         (single CLI entrypoint, parseArgs, bootstrap, lifecycle, cleanup)
lib/
  runtime-profile.mjs      [NEW] (--runtime tui|core policy + reporter factory + legacy state adapter)
  error-classification.mjs [NEW] (shared safeErrorSummary + classifyFailure -> { state, kind, diagnostic })
  osc7501-reporter.mjs     [NEW] (thin core reporter: flushes redactor, writes OSC 7501)
  herdr-reporter.mjs       [KEEP API] (thin legacy herdr 0.9.5 reporter)
  app-server-controller.mjs [MOD] (single canonical status model + interaction policy + non-interactive mode)
  app-server-client.mjs     [MOD] (parameterized detached, fastTerminate, re-exports safeErrorSummary)
  desktop-runtime.mjs       [MOD] (TMPDIR/--runtime-dir priority, --no-copy-catalog, --skip-desktop-inspect, strip HC_* & HERDR_*)
  desktop-account.mjs       [MOD] (shared buildAccountOverlay + createStreamRedactor; adds projectedAccount for --auth-file)
  desktop-keychain.mjs      [KEEP] (used only when --auth-file is NOT passed)
  toolchain.mjs             [MOD] (assertNode({ allowEmbeddedElectron }), version JSON helper)
```

### Canonical status contract (shared by `tui` and `core`)

`AppServerController.status()` returns a plain object:
```js
{
  state: 'starting' | 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'unknown',
  kind: undefined | 'permission' | 'question' | 'auth' | 'quota' | 'rate_limit',
  message: string,      // short, secret-free human label
  sessionId: string | undefined,
  turnId: string | undefined,
  diagnostic: string,   // curated safeErrorSummary output, or ''
}
```

State resolution rules inside `AppServerController.status()` (evaluated in strict precedence order):
1. If `this.interactions.size > 0`:
   - Determine `kind`: if any pending interaction has `kind === 'permission'`, use `'permission'`, else `'question'`.
   - Return `{ state: 'blocked', kind, message: 'ZCode input required', ... }`.
2. If `this.uncertain || this.closing`:
   - Return `{ state: 'unknown', ... }` (unless `this.terminalOutcome` is `'blocked'` or `'error'` and `this.closing` was triggered by non-interactive block/abort — see `TASK-002` startup/abort rules).
3. If `!this.ready`:
   - Return `{ state: 'starting', ... }`.
4. If `this.current || this.sending || this.stopping || this.background.size > 0`:
   - Return `{ state: 'working', ... }`.
5. If `this.lastOutcome` is set (from the most recently finished parent turn, cleared when a new turn starts in `pump()` or `turn.started`):
   - `{ state: 'done' }` → normal `turn.completed` (neither `error_*` nor `cancelled`)
   - `{ state: 'blocked', kind: 'quota' | 'rate_limit' | 'auth' | 'permission', diagnostic }` → classified turn failure
   - `{ state: 'error', diagnostic }` → unclassified `turn.failed` or `error_*`
   - `{ state: 'idle' }` → `turn.completed` with `resultType === 'cancelled'`
6. Otherwise (ready, no turn run yet):
   - Return `{ state: 'idle', ... }`.

Legacy mapping for `controller.state()` and `tui` reporter (`mapCanonicalToLegacyState`):
- `'starting'` → `'unknown'`
- `'done'` → `'idle'`
- `'error'` → `'idle'` (when session remains alive for human input in `tui`) or `'unknown'` (when `uncertain`/`closing`)
- `'blocked'` → `'blocked'` (only for interactive `permission`/`question`; for `tui` after a failed quota turn where session is ready for next input, keep `'idle'` so existing `tests/app-server-terminal.test.mjs` assertions do not regress!)
- `'idle'`, `'working'`, `'unknown'` → unchanged.

> [!WARNING]
> **Check this subtlety carefully**: In `tui` mode, `controller.state()` MUST return `'idle'` after a cancelled turn (`tests/app-server-terminal.test.mjs:643`), `'working'` while background jobs run (`line 549`), and `'idle'` after background jobs drain (`line 552`). Meanwhile, in `core` mode, `osc7501-reporter` reads `controller.status()` directly and emits `state=done`, `state=error`, or `state=blocked:kind=quota|rate_limit|auth|permission` — **never** collapsing a failed turn to `idle`!

---

## 6. Per-Task implementation and verification playbook

Execute strictly one Task at a time. Run `./dev test` after every Task before marking it complete in `docs/roadmap/README.md`.

---

### `TASK-001`: Shared runtime profile, canonical status model, and failure classification

**Goal**: Lay down the shared-core foundation (`--runtime <tui|core>`, `lib/error-classification.mjs`, `lib/runtime-profile.mjs`, canonical `AppServerController.status()`) without changing any default `tui` behavior.

**Files to create / modify**:
1. **[NEW] `lib/error-classification.mjs`**:
   - Move `PUBLIC_CODES`, `PUBLIC_REASONS`, and `safeErrorSummary(error)` here from `lib/app-server-client.mjs` (and re-export `safeErrorSummary` from `lib/app-server-client.mjs` so existing imports never break!).
   - Add `classifyFailure(error, resultType)`:
     - Inspects structured fields from `error?.attribution ?? error?.data?.attribution ?? {}`, `error?.code`, `error?.type`, `error?.providerCode`, `error?.statusCode`, `error?.reason`, message business code regex `/\b(?:code|limit)\s*[:=]?\s*["']?(\d{3,8})\b/i`, and `resultType`.
     - Classification priority (deterministic):
       1. **Quota (`state: 'blocked', kind: 'quota'`)**: `businessCode === '1308'` OR `errorCode === 'insufficient_quota'`.
       2. **Rate limit (`state: 'blocked', kind: 'rate_limit'`)**: `businessCode === '1302'` OR `status === 429` OR `reason === 'rate_limited'` OR `errorCode === 'model_rate_limited'` OR `errorCode === 'rate_limit_exceeded'`.
       3. **Auth (`state: 'blocked', kind: 'auth'`)**: `status === 401` OR `reason === 'auth_failed'` OR `errorCode === 'invalid_api_key'` OR `errorCode === 'model_request_auth_missing'`.
       4. **Permission (`state: 'blocked', kind: 'permission'`)**: `errorCode === 'permission_denied'` OR `errorCode === 'permission_timeout'`.
       5. **General error (`state: 'error', kind: undefined`)**: everything else (`turn.failed`, `error_max_turns`, `error_max_budget`, `error_during_execution`, `error_max_tool_calls`, unknown error).
     - Note precedence between `1308` and `HTTP 429`: ZCode returns `providerErrorCode: '1308'` alongside `statusCode: 429` and `reason: 'rate_limited'` (verified in `tests/fixtures/app-server-fake.mjs:41,122`). Checking **`1308` (quota) BEFORE `429` (rate_limit)** is mandatory!
     - Returns `{ state, kind, diagnostic: safeErrorSummary(error), reason }`.
2. **[NEW] `lib/runtime-profile.mjs`**:
   - Export `RUNTIMES = Object.freeze(['tui', 'core'])`.
   - Export `mapCanonicalToLegacyState(snapshot)` (maps canonical `status()` to `'idle' | 'working' | 'blocked' | 'unknown'`).
   - Export `adaptLegacyReporter(legacyReporter)`: returns `{ report(snapshot) { legacyReporter.report(mapCanonicalToLegacyState(snapshot), snapshot.message, snapshot.sessionId); }, close: () => legacyReporter.close() }`.
   - Export `createRuntimeProfile(runtime, { env, output, flushOutput, adapters })`:
     - Rejects anything other than `'tui'` or `'core'` with `new Error('Use runtime tui or core')`.
     - For `'tui'`: `{ name: 'tui', detached: true, fastTeardown: false, defaultModelEnabled: true, createReporter() -> adaptLegacyReporter((adapters.createHerdrReporter ?? createHerdrReporter)({ env })) }`.
     - For `'core'`: `{ name: 'core', detached: false, fastTeardown: true, defaultModelEnabled: true, createReporter() }` (in `TASK-001`, stub `core` reporter or prepare hook; `TASK-002` plugs in `createOsc7501Reporter`).
3. **[MODIFY] `lib/app-server-client.mjs`**:
   - Re-export `safeErrorSummary` from `./error-classification.mjs` (remove duplicated implementation).
4. **[MODIFY] `lib/app-server-controller.mjs`**:
   - Track `this.lastOutcome = null`.
   - Clear `this.lastOutcome = null` whenever a new parent turn starts (`pump()` before `session/send`, and `turn.started` for resumed turns).
   - In `turn.completed` / `turn.failed` handler (`lines 318-330`):
     - If `failed`: compute `const classified = classifyFailure(p.error, p.resultType)` and set `this.lastOutcome = classified` (do **NOT** clear `this.lastOutcome`!).
     - Else if `p.resultType === 'cancelled'`: set `this.lastOutcome = { state: 'idle', kind: undefined, diagnostic: '' }`.
     - Else (normal completion): set `this.lastOutcome = { state: 'done', kind: undefined, diagnostic: '' }`.
   - In `abort(message, error)`: if `error` classifies to a structured failure (`blocked`/`error`), record `this.lastOutcome = classifyFailure(error)` (or `{ state: 'error', diagnostic: '' }`), then `this.report()`.
   - Add `status()` returning the canonical snapshot object.
   - Change `state()` to `return mapCanonicalToLegacyState(this.status());`.
   - Change `report()` to pass `this.status()` to `this.reporter?.report(this.status())`.
5. **[MODIFY] `bin/herdr-zcode-app.mjs`**:
   - Add `--runtime` to `parseArgs(argv)` with default `options.runtime = 'tui'`.
   - Validate `if (!['tui', 'core'].includes(options.runtime)) throw new Error('Use runtime tui or core');`.
   - Update `--help` text to document `--runtime <tui|core>`.
   - Wire `createRuntimeProfile(options.runtime, ...)` so `tui` uses `adaptLegacyReporter(...)`.

**Common pitfalls to avoid in `TASK-001`**:
- Do **NOT** break `createHerdrReporter`'s existing `(state, message, sessionId)` signature (`tests/herdr-reporter.test.mjs` tests it directly).
- Do **NOT** break `controller.state()` returning `'idle'` after cancelled turns or background-job completion (`tests/app-server-terminal.test.mjs:552,643`).
- Check `providerErrorCode === '1308'` **before** `statusCode === 429` in `classifyFailure`, because ZCode sends both on usage-limit errors!

**Verification**:
- Add `tests/runtime-profile.test.mjs` testing `--runtime` parsing (default `'tui'`, `'core'`, rejects `'auto'` / `'invalid'` / missing arg), `classifyFailure` priority (`1308`+`429` → `quota`, `1302`/`429` → `rate_limit`, `401`/`auth_failed` → `auth`, `permission_denied` → `permission`, `error_max_tool_calls` → `error`), canonical `controller.status()` vs legacy `controller.state()`, and clearing `lastOutcome` when a subsequent turn begins.
- Run `./dev test` — all pre-existing + new tests pass.

---

### `TASK-002`: `herdr-core` OSC 7501 reporter, non-detached lifecycle, and fast teardown

**Goal**: Implement `lib/osc7501-reporter.mjs` and make `--runtime core` satisfy `herdr-core 0.1.20` and `mulgae`'s 150ms zero-orphan teardown contract.

**Files to create / modify**:
1. **[NEW] `lib/osc7501-reporter.mjs`**:
   - Export `formatOsc7501(snapshot)`:
     - Valid OSC states: `new Set(['idle', 'working', 'done', 'blocked', 'error'])`.
     - Ignore `'starting'` and `'unknown'` (do **not** emit OSC 7501 before readiness or with unknown state, because `mulgae` checks `Terminal.reported == true` as proof of readiness!).
     - Valid blocked kinds: `new Set(['auth', 'quota', 'rate_limit', 'permission', 'question'])`.
     - Format:
       - If `state === 'blocked'` and `VALID_KINDS.has(snapshot.kind)`: `"\x1b]7501;state=blocked:kind=" + snapshot.kind + "\x07"`.
       - Else if `VALID_STATES.has(state)`: `"\x1b]7501;state=" + state + "\x07"`.
     - Never include unredacted or raw error text in OSC parameters.
   - Export `createOsc7501Reporter({ writeRaw, flushOutput })`:
     - Deduplicates consecutive identical OSC frames (`lastFrame`), EXCEPT allows re-emitting `working` -> `done` across distinct turns (keyed on `[frame, snapshot.turnId ?? '']`).
     - Before writing the OSC frame via `writeRaw(frame)` (direct to underlying `output.write`, bypassing `redactor.write`), **MUST call `flushOutput()`** so buffered redactor tail text is emitted cleanly before the escape sequence, and the escape sequence itself is never buffered/split by the redactor!
     - `close()` is an immediate resolved no-op (`Promise.resolve()`).
2. **[MODIFY] `lib/runtime-profile.mjs`**:
   - Wire `core` profile's `createReporter()` to `adapters.createOsc7501Reporter ?? createOsc7501Reporter` (passing `writeRaw: text => output.write(text)` and `flushOutput`).
3. **[MODIFY] `lib/app-server-client.mjs`**:
   - Add constructor option `detached = (platform !== 'win32')` (default preserves existing `tui` behavior!).
   - In `start()`: use `const detached = Boolean(this.detached && this.platform !== 'win32');`. Set `this.groupPid` ONLY when `detached` is true.
   - Add `terminateFast(graceMs = 60)` (or parameterize `terminate(timeout, { immediate = false })`):
     - If `this.child` already exited, return immediately.
     - Close `this.child.stdin` (`end()`).
     - Immediately send `SIGTERM` (`this.signalOwned('SIGTERM')`).
     - Poll `this.exited && this.ownedGroupGone()` up to `graceMs` (e.g., `60ms`, 5ms interval).
     - If still alive, immediately send `SIGKILL` (`this.signalOwned('SIGKILL')`) and wait up to `60ms`.
     - Total worst-case wall time is `<= 120ms`, safely under `mulgae`'s `150ms` `postKillGraceDuration`.
4. **[MODIFY] `bin/herdr-zcode-app.mjs`**:
   - Pass `detached: profile.detached` into `new AppServerClient(...)`.
   - Track `let interruptedBySignal = false;` when `SIGTERM` or `SIGHUP` fires (`terminate` / `hangup`).
   - In `finally`:
     - When `profile.fastTeardown && interruptedBySignal`:
       - Mark `controller.closing = true`, decline pending interactions locally, **SKIP** blocking `session/stop` and `session/close` RPCs in `controller.shutdown()`, and call `await client.terminateFast(adapters.fastExitGraceMs ?? 60)`.
     - On normal EOF or `/exit` (no `SIGHUP`/`SIGTERM`):
       - Run normal `controller.shutdown()` (in `core`, cap RPC shutdown timeout to e.g. `Math.min(adapters.rpcTimeout ?? 15000, 1500)` so normal shutdown still sends `session/close` cleanly without hanging).
   - **Startup failure OSC reporting in `core` mode**:
     - Look at the `catch (error)` block (`lines 184-190`): if `options.runtime === 'core'` and startup failed due to an authentication error (tag account/auth errors with e.g. `error.blockedKind = 'auth'`, or check `classifyFailure(error)`), emit `reporter.report({ state: 'blocked', kind: 'auth', message: 'Authentication required' })` (or `state: 'error'` if `--non-interactive` and config/model failed) **before** exiting (or wait briefly / await `SIGHUP` when `--hold-on-startup-block` if desired — check: in `herdr-core`, if the process emits `\x1b]7501;state=blocked:kind=auth\x07`, flushes stdout, and exits, wait: in `mulgae`'s `runner_darwin.go`, `herdr-core` observes OSC `reported = true` and `status = blocked, kind = auth` on the terminal even if the child exits right after flushing, PROVIDED stdout was processed before close; holding until `SIGHUP` in `--non-interactive` mode matches `mulgae/internal/adapters/herdr/live_herdr_darwin_test.go:111-114` `osc_blocked_auth` 100% and eliminates any stdout-vs-exit race!).
     - Specifically: in `core` + `--non-interactive` mode, on startup auth/quota/rate_limit failure, emit OSC `state=blocked:kind=<kind>` and wait for `SIGINT`/`SIGTERM`/`SIGHUP` (with a safety cap or `controller.done`), while in interactive `core` or `tui` mode print the diagnostic to stderr and exit `1` immediately.

**Common pitfalls to avoid in `TASK-002`**:
- **NEVER** emit `\x1b]7501;state=idle\x07` before `session/subscribe` + `controller.attach` succeeds.
- **NEVER** emit `state=unknown` over OSC 7501 (`herdr-core` does not define `unknown` as a valid OSC 7501 status).
- **NEVER** run `output.write(osc)` without calling `flushOutput()` first, and never route OSC bytes through `redactor.write()` or `terminalText()` (`terminalText` strips `\x1b` and `\x07`!).
- Do **NOT** skip `session/close` on normal stdin EOF — `tests/fixtures/app-server-fake.mjs:197` asserts `closeRequested === true` on normal EOF. Fast teardown (skipping RPCs) is triggered on `SIGHUP` / `SIGTERM`!

**Verification**:
- Add `tests/osc7501-reporter.test.mjs` testing formatting of all 5 states + 5 blocked kinds, ignoring `starting`/`unknown`, deduping + re-emitting across turns, and flushing redactor tail buffers cleanly before OSC bytes.
- Add `core` entrypoint tests in `tests/app-server-terminal.test.mjs` (or `tests/core-runtime.test.mjs`):
  - Full `idle -> working -> done` OSC sequence on normal turn.
  - `quota` (`1308`+`429`) → `\x1b]7501;state=blocked:kind=quota\x07` (and NO trailing `state=idle`!).
  - `error-result` (`error_max_tool_calls`) and `failure` → `\x1b]7501;state=error\x07` (and NO trailing `state=idle`!).
  - `SIGHUP` sent while running `hang-cleanup` scenario in `--runtime core`: verify parent AND fake child (which ignores `SIGTERM`!) both exit with `ESRCH` in `< 250ms` (specifically well under 150ms in normal non-loaded runs; test that `child.pid` is dead via `process.kill(childPid, 0)` throwing `ESRCH`).
  - Verify `tui` mode still spawns `detached: true` and passes `tests/app-server-transport.test.mjs`.
- Run `./dev test`.

---

### `TASK-003`: Standalone CLI bootstrapping, Seatbelt scratch path, and `HC_*` env isolation

**Goal**: Make `bin/herdr-zcode` executable as a normal standalone CLI in `mulgae`'s empty-`HOME` / `PATH=/usr/bin:/bin` / no-`NVM_DIR` environment, remove `/Volumes/RootKernel/tmp` Seatbelt failure, and strip `HC_*` from child env.

**Files to modify**:
1. **[MODIFY] `lib/toolchain.mjs`**:
   - Update `assertNode({ allowEmbeddedElectron = false } = {})`:
     ```js
     export function assertNode({ allowEmbeddedElectron = false } = {}) {
       if (allowEmbeddedElectron &&
           process.env.ELECTRON_RUN_AS_NODE === '1' &&
           typeof process.versions.electron === 'string' &&
           process.versions.electron.length > 0) {
         const major = Number.parseInt(String(process.versions.node).split('.')[0], 10);
         if (!Number.isInteger(major) || major < 20) {
           throw new Error(`Unsupported ZCode embedded Node ${process.versions.node}; requires >= 20.`);
         }
         return;
       }
       const expected = readToolchains().NODE_VERSION;
       if (process.versions.node !== expected) throw new Error(
         'Expected Node ' + expected + '; actual ' + process.versions.node + ' at ' + process.execPath + '. Use ./dev or the installed herdr-zcode launcher.');
     }
     ```
   - Notice: `scripts/dev.mjs` and `scripts/check-toolchain.mjs` call `assertNode()` (default `allowEmbeddedElectron: false`), so strict `toolchains.env` enforcement for `./dev` and `tests/toolchain.test.mjs:57` stays 100% intact!
   - Update `bin/herdr-zcode-app.mjs:13` to call `assertNode({ allowEmbeddedElectron: true })`.
2. **[MODIFY] `bin/herdr-zcode`** (POSIX `#!/bin/sh` — NO bashisms!):
   - Resolve symlinks to find `root` (keep existing POSIX loop).
   - Parse `NODE_VERSION` from `$root/toolchains.env` (using POSIX `while IFS='=' read -r ...`).
   - Scan `"$@"` (without mutating `"$@"`) for `--app-bundle <path>` (last one wins) to determine `app_bundle=${cli_app_bundle:-${HERDR_ZCODE_APP_BUNDLE:-/Applications/ZCode.app}}`.
   - Runtime selection order (strictly NO ambient `PATH` `node` lookup!):
     1. If `${NVM_DIR:-${HOME:-}/.nvm}/versions/node/v$pinned_node_version/bin/node` is executable (`-x`), delegate to `"$root/scripts/toolchain.sh" run "$@"` (exact existing behavior when `nvm` is present!).
     2. Else if `"$app_bundle/Contents/MacOS/ZCode"` is executable (`-x`), exec:
        ```sh
        unset NODE_OPTIONS NODE_PATH
        exec env ELECTRON_RUN_AS_NODE=1 "$app_bundle/Contents/MacOS/ZCode" "$root/bin/herdr-zcode-app.mjs" "$@"
        ```
     3. Else fail cleanly to stderr with exit code `1` explaining that neither pinned Node `v$pinned_node_version` nor ZCode Desktop at `$app_bundle` was found.
   - **Important**: Do **NOT** break `scripts/toolchain.sh` — `./dev run`, `./dev test`, `./dev doctor`, `./dev pack`, `./dev install` still use `scripts/toolchain.sh` and strictly require pinned `nvm` Node!
3. **[MODIFY] `bin/herdr-zcode-app.mjs`**:
   - Support `--version` (existing: `herdr-zcode <version>\n`) AND `--json` combined with `--version` (e.g., `herdr-zcode --version --json`):
     ```json
     {"name":"herdr-zcode","version":"0.1.0","runtimes":["tui","core"],"osc7501":true,"minZcodeAppVersion":"3.18.2"}
     ```
   - Strip **both `HERDR_*` and `HC_*`** from `childEnv` (`line 127`):
     ```js
     for (const key of Object.keys(childEnv)) {
       if (key.startsWith('HERDR_') || key.startsWith('HC_')) delete childEnv[key];
     }
     ```
   - Add CLI flags `--runtime-dir <path>`, `--no-copy-catalog`, and `--skip-desktop-inspect` and forward them to `prepareDesktopRuntime(...)`.
4. **[MODIFY] `lib/desktop-runtime.mjs`**:
   - Fix `scratchRoot(env)` (`lines 8-20`):
     - If `env.TMPDIR` is set and non-empty (e.g., `/tmp/mulgae-zcode` in `mulgae` Seatbelt), return `resolve(env.TMPDIR)` **immediately** without probing `/Volumes/RootKernel`!
     - Only if `env.TMPDIR` is unset, fall back to `tmpdir()` (and optionally check `/Volumes/RootKernel/tmp` only if `env.TMPDIR` is unset and `/Volumes/RootKernel` is writable, catching any `EPERM`/`ENOENT`). Never let a Seatbelt `EPERM` on `/Volumes/RootKernel` fail startup!
   - Support `tmpRoot` (`--runtime-dir`), `copyCatalog = true` (`--no-copy-catalog` sets `false`), and `skipInspect = false` (`--skip-desktop-inspect` sets `true`):
     - When `skipInspect` is true: resolve `executable = join(appBundle, 'Contents/MacOS/ZCode')` without invoking `/usr/libexec/PlistBuddy` or `ZCode -p` (still verify `access(executable, X_OK)`, `access(launcher)`, `access(bundled)`).
     - When `copyCatalog` is false: use `configPath = bundled` directly without creating/removing a temp directory (`close: async () => {}`).
   - Also delete `HC_*` keys inside `prepareDesktopRuntime` `childEnv` defensively (in addition to `bin/herdr-zcode-app.mjs`).

**Common pitfalls to avoid in `TASK-003`**:
- `bin/herdr-zcode` MUST remain pure POSIX `#!/bin/sh` (macOS `/bin/sh`), quote all paths for spaces (e.g., `/fixture/ZCode Custom.app`), and NEVER look up `node` from `PATH`.
- Check `tests/toolchain.test.mjs` — all 5 existing tests must continue passing without modifying their assertions!
- In `bin/herdr-zcode`, when scanning `"$@"` for `--app-bundle`, do NOT shift away the real positional parameters before `exec` — loop with `for arg in "$@"` and a `next_is_bundle=0` flag so `"$@"` remains completely intact!

**Verification**:
- Expand `tests/bin-symlink.test.mjs` and `tests/toolchain.test.mjs`:
  - Invoke symlinked `bin/herdr-zcode --version`, `--version --json`, `--help` with `{ PATH: '/usr/bin:/bin', HOME: emptyDir }` (NO `NVM_DIR`, decoy `node` on `PATH`) + a fake `ZCode.app/Contents/MacOS/ZCode` wrapper script that delegates to `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (or verifies `ELECTRON_RUN_AS_NODE=1` env and `herdr-zcode-app.mjs` argv).
  - Test `assertNode({ allowEmbeddedElectron: true })` accepts `ELECTRON_RUN_AS_NODE=1` + `versions.electron`, while plain `node` with wrong `NODE_VERSION` still throws `/Expected Node/`.
  - Test `prepareDesktopRuntime` prefers `env.TMPDIR` / `tmpRoot` over `/Volumes/RootKernel/tmp`, works with `copyCatalog: false` and `skipInspect: true`, and strips `HC_TERMINAL_ID`, `HC_SOCKET`, `HC_TERMINAL_SOCKET`, `HERDR_*`.
- Run `./dev test`.

---

### `TASK-004`: Sandbox-safe credential projection (`--auth-file`) and shared account overlay

**Goal**: Eliminate Seatbelt conflicts with native `~/.zcode`, `~/Library/Keychains`, and `/usr/bin/codesign` by adding `--auth-file` + `--consume-auth-file` sharing the exact same overlay and stream-redaction engine in `lib/desktop-account.mjs`.

**Files to modify**:
1. **[MODIFY] `lib/desktop-account.mjs`**:
   - Extract shared helper `buildAccountOverlay({ configFile, catalog, providerId, identity, selection, secrets, resolveApiKey })`:
     - Computes `builtinRevision = 'zcode-builtin:' + catalog.revision + ':' + hash(resolve(configFile))`.
     - Builds `config` (`revision`, `basedOnZCodeBuiltinRevision`, `providers`, `states`).
     - Returns `{ selection, config, runtimeHeaders(request), createStreamRedactor(), redact(text) }`.
     - Both `desktopAccount(...)` and `projectedAccount(...)` delegate to `buildAccountOverlay(...)` — zero duplicated overlay/header/redaction logic!
   - Export `projectedAccount(configFile, authFile, { model, consume = false } = {})`:
     - **Fail-closed file security checks** on `authFile` BEFORE reading:
       1. `lstat(authFile)` — MUST be a regular file (`isFile()` and NOT symlink), `uid === process.getuid()`, `(mode & 0o077) === 0` (owner-only, e.g., `0600` or `0400`), `nlink === 1`, and size `<= 65536` bytes. Reject otherwise with a concise, secret-free error (tag `error.blockedKind = 'auth'`).
       2. Open with `O_RDONLY | O_NOFOLLOW` (`constants.O_RDONLY | constants.O_NOFOLLOW`), re-verify `fstat` matches `(dev, ino)` to close TOCTOU window, read UTF-8 JSON.
     - **Expected `--auth-file` JSON schema**:
       ```json
       {
         "providerId": "account:zai-individual-coding-plan",
         "identity": "user-123",
         "apiKey": "decrypted-secret-key",
         "accountAccess": {
           "type": "zhipu-account",
           "mode": "individual-coding-plan",
           "accountType": "zai"
         }
       }
       ```
       - `accountAccess` is optional and defaults to `{ type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' }`.
       - Validate `providerId`, `identity`, `apiKey` are non-empty trimmed strings.
     - Register `apiKey` in `secrets` immediately (so even subsequent startup errors cannot leak it!).
     - If `consume === true` (`--consume-auth-file`): overwrite the file in place with zero bytes of the same length (ignoring `EACCES` if read-only `0400`) and `unlink(authFile)` **before returning** (which happens BEFORE `client.start()` spawns `ZCode app-server`!).
     - Read `catalog` from `configFile` (`readJSON(configFile, 'ZCode provider catalog')`), verify `providerId` rule exists in `catalog` and `catalog.revision >= 1`.
     - Model resolution:
       - If `model` is explicitly passed: validate it belongs to `providerId` and `rule.config.builtinModelIds` (exact same check as `desktopAccount`, no silent fallback).
       - If `model === null` (when default model override is disabled in `TASK-005`): `selection = null`.
       - If `model === undefined`: default to `DEFAULT_MODEL` (preserving `tui` behavior).
     - `resolveApiKey` simply returns `{ identity, apiKey }` from memory (no disk/Keychain/codesign reads!).
2. **[MODIFY] `bin/herdr-zcode-app.mjs`**:
   - Add CLI flags `--auth-file <path>` and `--consume-auth-file` (boolean flag; error if `--consume-auth-file` is passed without `--auth-file`).
   - When `options['auth-file']` is set:
     - Do **not** construct or invoke `createKeychainSource` (in `lib/desktop-runtime.mjs`, skip `createKeychainSource` when `useKeychain === false`).
     - Call `(adapters.projectedAccount ?? projectedAccount)(runtime.configPath, resolve(options.cwd, options['auth-file']), { model: ..., consume: Boolean(options['consume-auth-file']) })`.
   - Ensure `projectedAccount(...)` completes (including `--consume-auth-file` unlink) **BEFORE** `client.start()`!

**Common pitfalls to avoid in `TASK-004`**:
- `client.start()` is currently at `bin/herdr-zcode-app.mjs:154`, AFTER `desktopAccount(...)` at `line 143`. Keep `projectedAccount(...)` strictly BEFORE `client.start()` so the consumed auth file is already unlinked before `ZCode` starts!
- If `--auth-file` has malformed JSON containing the secret key, catch and throw a generic error (`Cannot read projected auth file`) — NEVER include `error.message` from `JSON.parse` which can echo parts of the secret!
- Tag credential/auth errors with `error.blockedKind = 'auth'` so `TASK-002`'s `core` startup handler maps them cleanly to `state=blocked:kind=auth`.

**Verification**:
- Add comprehensive tests in `tests/desktop-account.test.mjs` (or `tests/projected-account.test.mjs`):
  - Valid `--auth-file` resolves `config`, `basedOnZCodeBuiltinRevision` matching `configPath`, answers matching `runtimeHeaders`, rejects foreign `providerId`/`accountAccess`, and redacts `apiKey` across split stream deltas.
  - Rejects symlink, group/world-readable (`0644`), missing required fields, malformed JSON (confirming error message does not contain the secret!).
  - `--consume-auth-file` deletes the file on disk BEFORE `client.start()` runs (verified in entrypoint test with fake app-server checking `!existsSync(authPath)`).
  - Verify zero access to `~/.zcode` or `withOSCredentialReader` when `--auth-file` is set (pass a non-existent `home` and a throwing `withOSCredentialReader` stub!).
- Run `./dev test`.

---

### `TASK-005`: Session scoping, non-interactive policy, and independent reasoning effort

**Goal**: Expose ZCode `0.17.1`'s full session-control surface so `mulgae` (and other `herdr-core` callers) can enforce exact Grok-parity tool allowlists (`Read,Grep,Glob,Write`, `Read,Bash,Write`, `Read,Write`, or `[]`), disable MCP/title generation/dynamic workflows, prevent hangs on `alwaysAsk`/`userInteraction`, and configure model and reasoning effort independently.

**Files to modify**:
1. **[MODIFY] `bin/herdr-zcode-app.mjs`**:
   - **Fix `parseArgs(argv)` empty-value bug**:
     - Currently `line 22` checks `!argv[i + 1]`, which treats `""` (empty string) as missing!
     - Separate boolean flags vs value flags, and for value flags check `i + 1 >= argv.length` (and allow `""` specifically for `--tool-allowlist ""` and `--tool-denylist ""`!).
   - **New CLI flags to parse & validate**:
     - `--tool-allowlist <csv>`:
       - Omitted → `undefined` (do not include `toolAllowlist` in `session/create`).
       - `""` (empty string) → `[]` (explicit tool-free session).
       - `"Read,Grep,Glob,Write"` → `['Read', 'Grep', 'Glob', 'Write']` (trim entries, reject empty segments like `"Read,,Write"`).
     - `--tool-denylist <csv>`: same parsing rules as `--tool-allowlist`.
     - `--disable-mcp` (boolean): sets `mcpServers: []` in `session/create`.
     - `--disable-title-gen` (boolean): sets `titleGenerationEnabled: false` in `session/create`.
     - `--disable-offpeak` (boolean): sets `offPeakToolEnabled: false` in `session/create`.
     - `--disable-dynamic-workflow` (boolean): sets `dynamicWorkflowEnabled: false` in `session/create`.
     - `--additional-dir <path>` (repeatable value flag): appends `resolve(options.cwd, value)` into `options.additionalDirs` → sent as `additionalDirectories` in `session/create` (only when non-empty).
     - `--persistence <immediate|deferred>`: validates enum and sends `persistence` in `session/create`.
     - `--non-interactive` (boolean):
       - Defaults `autoResolveQuestions = true`, `interactionPolicy = 'block'` (unless explicitly overridden by `--interaction-policy`), disables interactive slash-command parsing in `controller.input()`, suppresses `Type /help for commands.` banner and bracketed paste escape codes (`\x1b[?2004h`/`\x1b[?2004l`), and enables default-model preservation when `--model` is omitted (do not force `DEFAULT_MODEL` if `--model` was not passed!).
     - `--interaction-policy <interactive|deny|block>`:
       - Default: `'interactive'` (or `'block'` when `--non-interactive`).
       - Reject invalid values.
     - `--auto-resolve-questions` (boolean): sets `askUserQuestionAutoResolutionEnabled: true` in `session/requestRuntimePreferences`.
     - `--reasoning-effort <level>` (accept `--thought-level <level>` as alias):
       - Reject empty/whitespace value.
       - If both `--model ...$level` AND `--reasoning-effort <other>` are passed with different values, throw `Conflicting reasoning effort values`.
   - **Wire `session/requestRuntimePreferences`**:
     ```js
     client.handle('session/requestRuntimePreferences', () => ({
       nativeSearchEnhancementsEnabled: false,
       subagentRuntimeConfigEnabled: false,
       memoryEnabled: false,
       askUserQuestionAutoResolutionEnabled: Boolean(options['auto-resolve-questions'] || options['non-interactive']),
     }));
     ```
   - **Wire `session/create` params** (only include optional fields when set, preserving exact existing payload in default `tui` runs!):
     ```js
     const createParams = { workspace, mode: options.mode };
     if (options.toolAllowlist !== undefined) createParams.toolAllowlist = options.toolAllowlist;
     if (options.toolDenylist !== undefined) createParams.toolDenylist = options.toolDenylist;
     if (options['disable-mcp']) createParams.mcpServers = [];
     if (options['disable-title-gen']) createParams.titleGenerationEnabled = false;
     if (options['disable-offpeak']) createParams.offPeakToolEnabled = false;
     if (options['disable-dynamic-workflow']) createParams.dynamicWorkflowEnabled = false;
     if (options.additionalDirs.length) createParams.additionalDirectories = options.additionalDirs;
     if (options.persistence) createParams.persistence = options.persistence;
     if (!explicitModel && options.reasoning) createParams.thoughtLevel = options.reasoning;
     ```
   - **Independent Model & Reasoning Effort Setup + Verification**:
     - Determine `explicitModel = typeof options.model === 'string'`.
     - In `tui` interactive mode (without `--non-interactive`): preserve existing behavior (if `--model` omitted, select `DEFAULT_MODEL`).
     - In `--non-interactive` mode when `--model` is omitted: do **NOT** call `session/setModel` to overwrite the server's default model! Instead:
       - Keep `controller.expectedModel = created.settings?.model?.current ?? null`.
       - If `options.reasoning` is set, call `session/setThoughtLevel` (`{ sessionId, thoughtLevel: options.reasoning }`) (in addition to `thoughtLevel` on `session/create`) and verify the applied reasoning level if returned in `settings.model.current.options.reasoningLevel` or `thoughtLevel`!
     - Whenever `session/setModel` IS called (explicit `--model` or `tui` default):
       - Verify `observed?.providerId === model.providerId && observed?.modelId === model.modelId`.
       - **NEW**: If `reasoningLevel` was requested (`options.reasoning`), verify `observed?.options?.reasoningLevel === reasoningLevel` (and check the same on `session/subscribe`'s `subscribedModel`!). If mismatched, throw `new Error('Selected reasoning level was not applied')`.
2. **[MODIFY] `lib/app-server-controller.mjs`**:
   - Accept `{ interactionPolicy = 'interactive', slashCommands = true }` in constructor options.
   - In `input(line)`: if `!this.slashCommands`, always route non-empty lines to `this.prompt(line)` (except internal programmatic `/exit` — expose an explicit `controller.exit()` method and have `quit()` call `controller.exit()` instead of `admit('/exit')` so disabling slash commands never breaks signal shutdown!).
   - In `interact(kind, params)` and `permission.requested` / `userInput.requested`:
     - If `this.interactionPolicy === 'deny'`: immediately return `decline(kind)` without registering into `this.interactions` (never stalls).
     - If `this.interactionPolicy === 'block'`: immediately return `decline(kind)` to unblock the RPC, set `this.lastOutcome = { state: 'blocked', kind, diagnostic: '' }`, `this.failed = true`, `this.report()` (which emits `\x1b]7501;state=blocked:kind=permission|question\x07` in `core`), and prevent further prompt pumping (`this.queue.length = 0`).
3. **[MODIFY] `tests/fixtures/app-server-fake.mjs`**:
   - Track `currentModel` inside the fake server: when `session/setModel` is called, update `currentModel = p.model` (preserving `options: p.model.options`) and return it in `snapshot()` (both on `session/setModel` and subsequent `session/subscribe`), so `reasoningLevel` verification works faithfully in all existing and new offline tests!
   - Support `session/setThoughtLevel` in the fake server switch statement (updating `currentModel.options = { reasoningLevel: p.thoughtLevel }`) and add scenarios to inspect `session/create` params and test `reasoning-mismatch`.

**Common pitfalls to avoid in `TASK-005`**:
- **`!argv[i + 1]` falsy trap**: `--tool-allowlist ""` MUST parse as `[]`, NOT throw `Invalid command arguments`!
- **`quit()` calling `admit('/exit')`**: Currently `bin/herdr-zcode-app.mjs:101` implements `quit()` by calling `admit('/exit')`. If you disable slash commands in `controller.input()` without giving `AppServerController` a dedicated `exit()` method, `SIGTERM`/`SIGHUP` will send `"/exit"` as a prompt to ZCode instead of quitting! Refactor `quit()` to call `controller.exit()` (or set a startup-exit flag before `controller` exists).
- **Do NOT change default `tui` `session/create` or `session/requestRuntimePreferences` payloads**: keep `askUserQuestionAutoResolutionEnabled: false` and `DEFAULT_MODEL` unchanged when `--non-interactive` / `--auto-resolve-questions` are not passed.

**Verification**:
- Add thorough offline tests covering:
  - `--tool-allowlist ""` sends `toolAllowlist: []`; `--tool-allowlist Read,Grep,Glob,Write` sends `['Read','Grep','Glob','Write']`; omitted sends no `toolAllowlist`.
  - `--tool-denylist`, `--disable-mcp`, `--disable-title-gen`, `--disable-offpeak`, `--disable-dynamic-workflow`, multiple `--additional-dir`, `--persistence deferred`.
  - `--non-interactive` with `--interaction-policy deny` (turn completes after denying unexpected `interaction/requestPermission`) and `--interaction-policy block` (emits `\x1b]7501;state=blocked:kind=permission\x07` without hanging).
  - Slash-prefixed prompt (`"/review src/a.js"`) passes through literally as prompt in `--non-interactive` while `SIGTERM` still exits cleanly via `controller.exit()`.
  - Independent `--reasoning-effort high` without `--model` in `--non-interactive` calls `session/setThoughtLevel` without calling `session/setModel`; mismatched `reasoningLevel` fails closed; conflicting `--model ...$low --reasoning-effort high` fails at arg parsing.
- Run `./dev test`.

---

### `TASK-006`: Package manifest, live `herdr-core` certification, and canonical docs closeout

**Goal**: Ensure packaging includes every new file, certify real `herdr-core 0.1.20` + `ZCode.app >= 3.18.2` execution end-to-end, and update canonical documentation.

**Files to create / modify**:
1. **[MODIFY] `package.json`**:
   - Add every new file under `lib/` (`lib/runtime-profile.mjs`, `lib/error-classification.mjs`, `lib/osc7501-reporter.mjs`) to `"files"`.
   - Add `"test:live-herdr-core": "node scripts/check-toolchain.mjs && node tests/live-herdr-core.mjs --authorize-live"` to `"scripts"`.
2. **[NEW] `tests/live-herdr-core.mjs`**:
   - Requires explicit `--authorize-live` flag (same convention as `tests/live-herdr-app.mjs`).
   - Launches an **isolated** `herdr-core` daemon using a unique temporary `HC_SESSION` and scratch `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_RUNTIME_DIR` (NEVER touches the operator's default `herdr-core`!).
   - Verifies against real `hc 0.1.20` + real `ZCode.app >= 3.18.2` + installed/checkout `bin/herdr-zcode`:
     1. Run `bin/herdr-zcode --runtime core --non-interactive --mode yolo --disable-mcp --disable-title-gen --tool-allowlist Read,Write --additional-dir <scratchDir> --cwd <neutralDir>` under scrubbed env (`HOME=<disposableHome>`, `PATH=/usr/bin:/bin`, no `NVM_DIR`, `TMPDIR=<shortTmpDir>`) with `--auth-file <projectedAuth> --consume-auth-file`.
     2. Confirm `hc get` observes `reported === true` and `status === 'idle'`.
     3. Confirm `<projectedAuth>` was unlinked before any prompt is sent.
     4. Send a prompt via `hc send` instructing ZCode to `Read` `<scratchDir>/input/prompt.md` and `Write` `<scratchDir>/output/result.txt` (Grok-parity out-of-`--cwd` scratch delivery).
     5. Wait with `hc wait` → confirm `status === 'done'` and `turn >= 1`, and verify `<scratchDir>/output/result.txt` contains the expected content.
     6. Run `hc kill` → confirm within `< 200ms` that both `herdr-zcode` AND child `ZCode` process are `ESRCH` (zero orphans).
     7. Shut down the isolated test `herdr-core` daemon and clean up all temp files.
3. **[MODIFY] Canonical documentation**:
   - `README.md`: document `--runtime <tui|core>`, standalone ZCode embedded-Node fallback, and new automation flags.
   - `HERDR.md`: add a concise `herdr-core` (`hc`) section alongside legacy `herdr 0.9.5`.
   - `docs/app-server.md`: update module responsibilities table (`runtime-profile.mjs`, `error-classification.mjs`, `osc7501-reporter.mjs`), canonical status model, `--auth-file`, and live `herdr-core` test command.
   - `docs/toolchains.md`: document the split between strict `./dev` `nvm` pins and standalone `bin/herdr-zcode` ZCode embedded-Node fallback.
   - `docs/roadmap/README.md`: mark `TASK-006` completed when verified; keep `EPIC-001` `In Review` pending explicit Master Epic acceptance (do **not** retire this dossier until Master accepts `EPIC-001`).

**Verification**:
- `./dev test`
- `./dev pack` and inspect `tar -tzf dist/herdr-zcode-*.tgz` to verify every `lib/*.mjs` file is packaged.
- `./dev install --prefix /tmp/hz-install-verify` and run `env -i HOME=/tmp/hz-empty PATH=/usr/bin:/bin /tmp/hz-install-verify/bin/herdr-zcode --version --json`.
- With Master's live-test authorization: `./dev npm run test:live-herdr-core`.
- `git diff --check`.

---

## 7. Downstream `mulgae` integration contract (out of scope for `herdr-zcode:EPIC-001`)

Once `herdr-zcode:EPIC-001` is completed and accepted, a separate `mulgae` Epic will consume `herdr-zcode` with the following contract:

1. **`BashGate` regex narrowing (`mulgae/internal/adapters/process/live_boundary_darwin.go:250`)**: narrow `(regex #"^(.*/)?(hc|herdr[^/]*)$")` to multiplexer binaries (`^(.*/)?(hc|herdr|herdr-core|herdr-app|herdrd)$`) so `mulgae` can execute `herdr-zcode` directly inside `BashGate` while still blocking model `Bash` commands from invoking `hc`/`herdr*`.
2. **Host-side Keychain decryption → `--auth-file --consume-auth-file`**: reuse `mulgae`'s existing `zcode_account.go` + `zcode_keychain.go` on the trusted host to project a `0600` ephemeral auth JSON inside `<namespace>/auth/` while keeping `~/.zcode` and `~/Library/Keychains` kernel-denied in Seatbelt.
3. **`zcodeTerminalProfile` (`zcode_terminal.go`)**: invoke `herdr-zcode --runtime core --non-interactive --mode yolo --disable-mcp --disable-title-gen --disable-offpeak --disable-dynamic-workflow --no-copy-catalog --skip-desktop-inspect --runtime-dir /tmp/mulgae-zcode --auth-file <path> --consume-auth-file --additional-dir <inputDir> --additional-dir <outputDir> [--additional-dir <projectRoot>] --tool-allowlist <purpose-scoped> --tool-denylist Edit,Agent,TodoWrite[,Bash] [--model ...] [--reasoning-effort ...] --cwd <neutralCWD>`.
4. **RuntimeTempRoot + `TMPDIR=/tmp/mulgae-zcode`**: preserve short `TMPDIR` for `zcode-official-*/endpoint.sock` under `PaneTTY` / `BashGate` and live-verify socket bind/listen behavior.
5. **Tool parity & `artist` role**: verify Workspace Review (`Read,Grep,Glob,Write`), Git Review (`Read,Bash,Write` + `BashGate`), Extraction/Qualification (`Read,Write`), `artist` multimodal image reads, `doctor` `herdr-core` + `herdr-zcode --version --json` checks, and `DF-030` closure.
