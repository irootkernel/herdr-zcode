# herdr-zcode roadmap

This roadmap owns the identity, status, dependencies, and ordering of planned `herdr-zcode` work. Current runtime behavior remains authoritative in source code, tests, and the canonical documents indexed from [docs/README.md](../README.md).

## Status vocabulary

- `Planned`: adopted and specified, not yet started.
- `In Progress`: implementation is active.
- `In Review`: implementation is complete and acceptance is being verified.
- `Completed`: explicit Epic or Task acceptance is complete.
- `Deferred`: intentionally postponed pending a stated prerequisite or decision.
- `Blocked`: progress cannot continue until a stated blocker is resolved.

Epic status is independent of child Task status. Completing every member Task does not complete an Epic without explicit Epic acceptance.

## Epic summary

| Epic | Status | Goal |
| --- | --- | --- |
| [EPIC-001](#epic-001-shared-core-herdr-core-runtime-and-mulgae-integration-support) | In Progress | Add explicit `--runtime core` (`herdr-core 0.1.20` OSC 7501 + fast non-detached teardown) alongside default `--runtime tui` over a shared core, make `herdr-zcode` directly executable in isolated/sandboxed environments without `nvm`, and add sandbox auth projection, session tool scoping, non-interactive fail-closed handling, and independent reasoning effort control for Mulgae integration. |

## Adopted execution order

Execute `EPIC-001` Tasks sequentially in table order (`TASK-001` through `TASK-006`). Each Task after `TASK-001` depends on completion and verification of the preceding Task.

`Planned` records an approved work definition; moving a Task or Epic to `In Progress`, `In Review`, or `Completed` requires implementation and recorded verification evidence. Release, npm packing/installation, commits, pushes, and downstream `mulgae` integration remain separate from individual Task completion.

---

## EPIC-001: Shared-core herdr-core runtime and Mulgae integration support

Status: In Progress

Detailed SOT: [temporary execution dossier](../todo/TODO-HERDR-CORE-RUNTIME-AND-MULGAE-SUPPORT.md)

Goal: evolve `herdr-zcode` into a dual-runtime standalone CLI supporting both legacy `herdr 0.9.5` (`--runtime tui`, default) and `herdr-core 0.1.20` (`--runtime core`) over one shared protocol/controller/account core with minimal runtime adapters, while satisfying every runtime, security, lifecycle, and session-control requirement needed for `mulgae` to run ZCode inside isolated `herdr-core` + Seatbelt panes using Grok-parity `Read`/`Write` scratch delivery.

Locked architectural boundaries (see the [temporary execution dossier](../todo/TODO-HERDR-CORE-RUNTIME-AND-MULGAE-SUPPORT.md) for exact contracts, line references, code skeletons, and pitfalls to avoid):

- **Explicit runtime selection (`--runtime <tui|core>`, default `tui`, no `auto`)**: omitting `--runtime` preserves existing legacy `herdr 0.9.5` TUI behavior 100%; `--runtime core` deterministically enables OSC 7501 reporting, non-detached child ownership, and fast `SIGHUP`/`SIGTERM` teardown without ambient environment-variable guessing.
- **Shared core + thin runtime adapters (no duplicated controller/entrypoint/client)**: one `bin/herdr-zcode-app.mjs`, one `AppServerController` computing one canonical structured status snapshot, one `AppServerClient`, one `desktop-account.mjs` overlay/redactor engine, and one `desktop-runtime.mjs`. Runtime differences stay confined to `lib/runtime-profile.mjs` and the two thin reporter adapters (`lib/herdr-reporter.mjs` for `tui`, `lib/osc7501-reporter.mjs` for `core`).
- **Standalone direct CLI launch**: `./dev` keeps strict `toolchains.env` `nvm` Node/npm pinning for development, tests, and packaging, while installed `bin/herdr-zcode` falls back deterministically from pinned `nvm` Node to `ZCode.app/Contents/MacOS/ZCode` (`ELECTRON_RUN_AS_NODE=1`) with zero ambient `PATH` Node lookup, allowing direct `herdr-zcode` execution in empty-`HOME` / `PATH=/usr/bin:/bin` sandboxes.
- **Grok-parity delivery (keep `herdr-zcode` thin)**: no `mulgae`-specific `--output-file`, `--output-mode`, or `--completion-nonce` logic inside `herdr-zcode`. Under `mulgae`, ZCode receives `terminal.send` instructions to `Read` `prompt.md` and `Write` the staged output file while outer macOS Seatbelt `ReadOnlyRoots` enforces read-only protection on the target repository.
- **Repository boundary (non-goals)**: no modifications to `mulgae` (`BashGate` regex narrowing, `zcodeTerminalProfile`, host Keychain projection, `doctor`, `qualifier`); those belong to a separate downstream `mulgae` Epic.

| Task | Status | Objective | Verification |
| --- | --- | --- | --- |
| TASK-001 | Completed | Introduce `lib/runtime-profile.mjs` and `--runtime <tui|core>` (default `tui`, no `auto`); extract shared failure classification (`classifyFailure`) and canonical rich status (`starting`, `idle`, `working`, `done`, `blocked` + `kind`, `error`, `unknown`) in `AppServerController` (keeping backward-compatible `controller.state()` and legacy `tui` reporter adapter while fixing `turn.failed` / `error_*` false-success reporting). | All existing offline suites (`./dev test`) pass unchanged; new unit/entrypoint tests verify `--runtime` validation, canonical transitions (`idle -> working -> done`, cancelled `-> idle`, `turn.failed` / `1308` / `1302` / `429` / `401` / `auth_failed` / `error_*` -> `blocked(kind)` or `error`), and legacy `tui` mapping. |
| TASK-002 | Completed | Add thin `lib/osc7501-reporter.mjs` emitting `\x1b]7501;state=...[:kind=...]\x07` after redactor flush with sanitized, secret-free payloads; parameterize `AppServerClient` (`detached`, `terminateTimeout`, immediate signal teardown) and `bin/herdr-zcode-app.mjs` so `core` runs non-detached (`detached: false`, same PGID/SID), completes `SIGHUP`/`SIGTERM` teardown well under 150ms with zero orphan descendants, and reports non-interactive startup auth/config failures via OSC 7501 instead of silent pre-report exit. | Offline OSC 7501 emitter/redaction-split tests; fake-app-server `core` lifecycle tests (`idle -> working -> done`, `blocked:kind=quota\|rate_limit\|auth`, `error`, startup auth block); real child-process `SIGHUP` timing (<100ms) and `ESRCH` descendant-absence tests; `tui` detached-group tests remain green. |
| TASK-003 | Planned | Make `bin/herdr-zcode` directly runnable without `nvm`/`$HOME` by falling back from pinned `nvm` Node to `ZCode.app/Contents/MacOS/ZCode` (`ELECTRON_RUN_AS_NODE=1`, honoring `--app-bundle` / `HERDR_ZCODE_APP_BUNDLE`) while keeping `./dev` strict `toolchains.env` pins intact; update `assertNode({ allowEmbeddedElectron })` and add `--version --json`; fix `lib/desktop-runtime.mjs` to prefer `--runtime-dir`/`TMPDIR` over `/Volumes/RootKernel/tmp`, support `--no-copy-catalog` and `--skip-desktop-inspect`, and strip **both `HC_*` and `HERDR_*`** from child env. | Offline tests under empty `HOME`, unset `NVM_DIR`, `PATH=/usr/bin:/bin` (including decoy `node` on `PATH` and symlinked `bin/herdr-zcode`); existing `tests/toolchain.test.mjs` pin guards stay green; `HC_*` stripping, `--version --json`, `--runtime-dir`/`TMPDIR` scratch-root, and `--no-copy-catalog` tests pass. |
| TASK-004 | Planned | Refactor `lib/desktop-account.mjs` to share catalog-overlay construction, provider matching, header dispatch, and `createStreamRedactor` between Desktop storage and sandboxed projected credentials; add `--auth-file <path>` and `--consume-auth-file` with fail-closed `0600` owner-only regular non-symlink validation, zero-fill + `unlink` before spawning `ZCode`, and zero `~/.zcode`, Keychain, or `codesign` access. | Offline tests for valid/malformed/wrong-mode/symlink `--auth-file`, proof that `--consume-auth-file` unlinks before child spawn, stream redaction of projected keys across split chunks, `builtinRevision` alignment with `configPath`, and zero reads of `~/.zcode` or Keychain; existing `tests/desktop-account.test.mjs` stays green. |
| TASK-005 | Planned | Add ZCode `0.17.1` `session/create` scoping flags (`--tool-allowlist <csv>` preserving `""` as `[]`, `--tool-denylist <csv>`, `--disable-mcp`, `--disable-title-gen`, `--disable-offpeak`, `--disable-dynamic-workflow`, repeatable `--additional-dir <path>`, `--persistence <immediate\|deferred>`), `--non-interactive` + `--interaction-policy <deny\|block>` + `--auto-resolve-questions` (covering `alwaysAsk`/`userInteraction` precedence over `yolo`, disabling slash-command hijacking and interactive chrome), and independent `--reasoning-effort` (`--thought-level` + `session/setThoughtLevel` + `reasoningLevel` response verification + `--preserve-default-model` / default-model preservation when `--model` omitted in non-interactive mode). | Offline fake-app-server tests covering empty `toolAllowlist: []`, Grok-parity tool sets (`Read,Grep,Glob,Write`, `Read,Bash,Write`, `Read,Write`), `toolDenylist`, `mcpServers: []`, `titleGenerationEnabled: false`, `additionalDirectories`, `alwaysAsk`/`userInteraction` handling in `deny` and `block` policies, slash-prefixed prompt passthrough, independent `--reasoning-effort` and mismatch rejection, and unchanged `tui` defaults. |
| TASK-006 | Planned | Update `package.json` `files` manifest for all new modules; add opt-in live certification harness (`tests/live-herdr-core.mjs`, `test:live-herdr-core`) against real `herdr-core 0.1.20` (`hc`) and `ZCode.app >= 3.18.2` verifying OSC 7501 `reported == true` / `turn >= 1`, `--auth-file`, tool scoping, out-of-`--cwd` `Read` + `Write` under `mode: yolo` + `--additional-dir`, and zero-orphan `hc kill` teardown; verify `./dev test`, `./dev pack`, and `./dev install`; promote durable outcomes to canonical docs (`README.md`, `HERDR.md`, `docs/app-server.md`, `docs/toolchains.md`) and prepare Epic closeout. | `./dev test`, `./dev pack`, standalone `./dev install` smoke (`--version`, `--version --json`, `--help` in empty `HOME`), live `test:live-herdr-core` against isolated `HC_SESSION` (never touching the operator's default `herdr-core`), zero `tui` regression, relative link & `git diff --check` verification. |

### Epic acceptance

- [ ] Every member Task (`TASK-001` through `TASK-006`) is implemented and verified with recorded evidence matching its verification criteria.
- [ ] `tui` (`--runtime tui` and default omitted flag) preserves 100% backward compatibility with legacy `herdr 0.9.5` and all pre-existing offline tests (`./dev test`), with zero duplicated controller/client/entrypoint code between `tui` and `core`.
- [ ] `herdr-zcode --runtime core` runs directly via the installed `herdr-zcode` executable under empty `HOME`, unset `NVM_DIR`, and `PATH=/usr/bin:/bin`, emits valid OSC 7501 state/blocked/error transitions (`Terminal.reported == true`, `turn >= 1`), never emits `idle` on turn failure, strips `HC_*` and `HERDR_*` from child env, and leaves zero surviving `ZCode` processes after `SIGHUP`/`hc kill` (<150ms teardown budget).
- [ ] Sandbox-safe execution (`--auth-file --consume-auth-file`, `--runtime-dir`/`TMPDIR`, `--tool-allowlist`, `--tool-denylist`, `--disable-mcp`, `--disable-title-gen`, `--non-interactive`, `--additional-dir`, `--reasoning-effort`) is verified offline and in live `herdr-core 0.1.20` + `ZCode.app >= 3.18.2` certification (including out-of-`--cwd` scratch `Read` + `Write` under `mode: yolo`).
- [ ] `package.json` `files`, `./dev pack`, and `./dev install` bundle every new module cleanly without breaking `./dev` toolchain pinning.
- [ ] Durable behavior, architecture, CLI contracts, and testing guidance are promoted into `README.md`, `HERDR.md`, `docs/app-server.md`, and `docs/toolchains.md`; `Detailed SOT` is replaced with `Canonical Outcomes`; the temporary dossier and its `docs/todo/README.md` entry are removed upon closeout; and explicit Epic acceptance is granted.
