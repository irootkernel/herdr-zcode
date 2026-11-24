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
| [EPIC-001](#epic-001-shared-core-herdr-core-runtime-and-mulgae-integration-support) | Completed | Add explicit `--runtime core` (`herdr-core 0.1.20` OSC 7501 + fast non-detached teardown) alongside default `--runtime tui` over a shared core, make `herdr-zcode` directly executable in isolated/sandboxed environments without `nvm`, and add sandbox auth projection, session tool scoping, non-interactive fail-closed handling, and independent reasoning effort control for Mulgae integration. |
| [EPIC-002](#epic-002-isolated-zcode-desktop-companion-cli) | Planned | Enable GLM-5.4 with projected credentials and provide host preparation and offline compatibility checks so isolated callers can use ZCode without managing Desktop internals. |

## Adopted execution order

Execute `EPIC-001` Tasks sequentially in table order (`TASK-001` through `TASK-006`). Each Task after `TASK-001` depends on completion and verification of the preceding Task.

`EPIC-002` builds on the completed `EPIC-001`. Execute `TASK-007`, then `TASK-008`, then `TASK-009`. Each Task after `TASK-007` depends on completion and verification of the preceding Task.

`Planned` records an approved work definition; moving a Task or Epic to `In Progress`, `In Review`, or `Completed` requires implementation and recorded verification evidence. Release, npm packing/installation, commits, pushes, and downstream `mulgae` integration remain separate from individual Task completion.

---

## EPIC-001: Shared-core herdr-core runtime and Mulgae integration support

Status: Completed

Canonical Outcomes: [CLI and automation](../../README.md), [Herdr operations](../../HERDR.md), [app-server architecture and certification](../app-server.md), and [toolchain and standalone installation](../toolchains.md).

Goal: evolve `herdr-zcode` into a dual-runtime standalone CLI supporting both legacy `herdr 0.9.5` (`--runtime tui`, default) and `herdr-core 0.1.20` (`--runtime core`) over one shared protocol/controller/account core with minimal runtime adapters, while satisfying every runtime, security, lifecycle, and session-control requirement needed for `mulgae` to run ZCode inside isolated `herdr-core` + Seatbelt panes using Grok-parity `Read`/`Write` scratch delivery.

The [app-server architecture](../app-server.md) and [CLI guide](../../README.md) document these architectural boundaries.

- **Explicit runtime selection (`--runtime <tui|core>`, default `tui`, no `auto`)**: omitting `--runtime` preserves existing legacy `herdr 0.9.5` TUI behavior 100%; `--runtime core` deterministically enables OSC 7501 reporting, non-detached child ownership, and fast `SIGHUP`/`SIGTERM` teardown without ambient environment-variable guessing.
- **Shared core + thin runtime adapters (no duplicated controller/entrypoint/client)**: one `bin/herdr-zcode-app.mjs`, one `AppServerController` computing one canonical structured status snapshot, one `AppServerClient`, one `desktop-account.mjs` overlay/redactor engine, and one `desktop-runtime.mjs`. Runtime differences stay confined to `lib/runtime-profile.mjs` and the two thin reporter adapters (`lib/herdr-reporter.mjs` for `tui`, `lib/osc7501-reporter.mjs` for `core`).
- **Standalone direct CLI launch**: `./dev` keeps strict `toolchains.env` `nvm` Node/npm pinning for development, tests, and packaging, while installed `bin/herdr-zcode` falls back deterministically from pinned `nvm` Node to `ZCode.app/Contents/MacOS/ZCode` (`ELECTRON_RUN_AS_NODE=1`) with zero ambient `PATH` Node lookup, allowing direct `herdr-zcode` execution in empty-`HOME` / `PATH=/usr/bin:/bin` sandboxes.
- **Grok-parity delivery (keep `herdr-zcode` thin)**: no `mulgae`-specific `--output-file`, `--output-mode`, or `--completion-nonce` logic inside `herdr-zcode`. Under `mulgae`, ZCode receives `terminal.send` instructions to `Read` `prompt.md` and `Write` the staged output file while outer macOS Seatbelt `ReadOnlyRoots` enforces read-only protection on the target repository.
- **Repository boundary (non-goals)**: no modifications to `mulgae` (`BashGate` regex narrowing, `zcodeTerminalProfile`, host Keychain projection, `doctor`, `qualifier`); those belong to a separate downstream `mulgae` Epic.

| Task | Status | Objective | Verification |
| --- | --- | --- | --- |
| TASK-001 | Completed | Introduce `lib/runtime-profile.mjs` and `--runtime <tui|core>` (default `tui`, no `auto`); extract shared failure classification (`classifyFailure`) and canonical rich status (`starting`, `idle`, `working`, `done`, `blocked` + `kind`, `error`, `unknown`) in `AppServerController` (keeping backward-compatible `controller.state()` and legacy `tui` reporter adapter while fixing `turn.failed` / `error_*` false-success reporting). | All existing offline suites (`./dev test`) pass unchanged; new unit/entrypoint tests verify `--runtime` validation, canonical transitions (`idle -> working -> done`, cancelled `-> idle`, `turn.failed` / `1308` / `1302` / `429` / `401` / `auth_failed` / `error_*` -> `blocked(kind)` or `error`), and legacy `tui` mapping. |
| TASK-002 | Completed | Add thin `lib/osc7501-reporter.mjs` emitting `\x1b]7501;state=...[:kind=...]\x07` after redactor flush with sanitized, secret-free payloads; parameterize `AppServerClient` (`detached`, `terminateTimeout`, immediate signal teardown) and `bin/herdr-zcode-app.mjs` so `core` runs non-detached (`detached: false`, same PGID/SID), completes `SIGHUP`/`SIGTERM` teardown well under 150ms with zero orphan descendants, and reports non-interactive startup auth/config failures via OSC 7501 instead of silent pre-report exit. | Offline OSC 7501 emitter/redaction-split tests; fake-app-server `core` lifecycle tests (`idle -> working -> done`, `blocked:kind=quota\|rate_limit\|auth`, `error`, startup auth block); real child-process `SIGHUP` timing (<100ms) and `ESRCH` descendant-absence tests; `tui` detached-group tests remain green. |
| TASK-003 | Completed | Make `bin/herdr-zcode` directly runnable without `nvm`/`$HOME` by falling back from pinned `nvm` Node to `ZCode.app/Contents/MacOS/ZCode` (`ELECTRON_RUN_AS_NODE=1`, honoring `--app-bundle` / `HERDR_ZCODE_APP_BUNDLE`) while keeping `./dev` strict `toolchains.env` pins intact; update `assertNode({ allowEmbeddedElectron })` and add `--version --json`; fix `lib/desktop-runtime.mjs` to prefer `--runtime-dir`/`TMPDIR` over `/Volumes/RootKernel/tmp`, support `--no-copy-catalog` and `--skip-desktop-inspect`, and strip **both `HC_*` and `HERDR_*`** from child env. | Offline tests under empty `HOME`, unset `NVM_DIR`, `PATH=/usr/bin:/bin` (including decoy `node` on `PATH` and symlinked `bin/herdr-zcode`); existing `tests/toolchain.test.mjs` pin guards stay green; `HC_*` stripping, `--version --json`, `--runtime-dir`/`TMPDIR` scratch-root, and `--no-copy-catalog` tests pass. |
| TASK-004 | Completed | Refactor `lib/desktop-account.mjs` to share catalog-overlay construction, provider matching, header dispatch, and `createStreamRedactor` between Desktop storage and sandboxed projected credentials; add `--auth-file <path>` and `--consume-auth-file` with fail-closed `0600` owner-only regular non-symlink validation, zero-fill + `unlink` before spawning `ZCode`, and zero `~/.zcode`, Keychain, or `codesign` access. | Offline tests for valid/malformed/wrong-mode/symlink `--auth-file`, proof that `--consume-auth-file` unlinks before child spawn, stream redaction of projected keys across split chunks, `builtinRevision` alignment with `configPath`, and zero reads of `~/.zcode` or Keychain; existing `tests/desktop-account.test.mjs` stays green. |
| TASK-005 | Completed | Add ZCode `0.17.1` `session/create` scoping flags (`--tool-allowlist <csv>` preserving `""` as `[]`, `--tool-denylist <csv>`, `--disable-mcp`, `--disable-title-gen`, `--disable-offpeak`, `--disable-dynamic-workflow`, repeatable `--additional-dir <path>`, `--persistence <immediate\|deferred>`), `--non-interactive` + `--interaction-policy <deny\|block>` + `--auto-resolve-questions` (covering `alwaysAsk`/`userInteraction` precedence over `yolo`, disabling slash-command hijacking and interactive chrome), and independent `--reasoning-effort` (`--thought-level` + `session/setThoughtLevel` + `reasoningLevel` response verification + `--preserve-default-model` / default-model preservation when `--model` omitted in non-interactive mode). | Offline fake-app-server tests covering empty `toolAllowlist: []`, Grok-parity tool sets (`Read,Grep,Glob,Write`, `Read,Bash,Write`, `Read,Write`), `toolDenylist`, `mcpServers: []`, `titleGenerationEnabled: false`, `additionalDirectories`, `alwaysAsk`/`userInteraction` handling in `deny` and `block` policies, slash-prefixed prompt passthrough, independent `--reasoning-effort` and mismatch rejection, and unchanged `tui` defaults. |
| TASK-006 | Completed | Update `package.json` `files` manifest for all new modules; add opt-in live certification harness (`tests/live-herdr-core.mjs`, `test:live-herdr-core`) against real `herdr-core 0.1.20` (`hc`) and `ZCode.app >= 3.18.2` verifying OSC 7501 `reported == true` / `turn >= 1`, `--auth-file`, tool scoping, out-of-`--cwd` `Read` + `Write` under `mode: yolo` + `--additional-dir`, and zero-orphan `hc kill` teardown; verify `./dev test`, `./dev pack`, and `./dev install`; promote durable outcomes to canonical docs (`README.md`, `HERDR.md`, `docs/app-server.md`, `docs/toolchains.md`) and prepare Epic closeout. | `./dev test`, `./dev pack`, standalone `./dev install` smoke (`--version`, `--version --json`, `--help` in empty `HOME`), live `test:live-herdr-core` against isolated `HC_SESSION` (never touching the operator's default `herdr-core`), zero `tui` regression, relative link & `git diff --check` verification. |

### Epic acceptance

- [x] Every member Task (`TASK-001` through `TASK-006`) is implemented and verified with recorded evidence matching its verification criteria.
- [x] `tui` (`--runtime tui` and default omitted flag) preserves 100% backward compatibility with legacy `herdr 0.9.5` and all pre-existing offline tests (`./dev test`), with zero duplicated controller/client/entrypoint code between `tui` and `core`.
- [x] `herdr-zcode --runtime core` runs directly via the installed `herdr-zcode` executable under empty `HOME`, unset `NVM_DIR`, and `PATH=/usr/bin:/bin`, emits valid OSC 7501 state/blocked/error transitions (`Terminal.reported == true`, `turn >= 1`), never emits `idle` on turn failure, strips `HC_*` and `HERDR_*` from child env, and leaves zero surviving `ZCode` processes after `SIGHUP`/`hc kill` (<150ms teardown budget).
- [x] Sandbox-safe execution (`--auth-file --consume-auth-file`, `--runtime-dir`/`TMPDIR`, `--tool-allowlist`, `--tool-denylist`, `--disable-mcp`, `--disable-title-gen`, `--non-interactive`, `--additional-dir`, `--reasoning-effort`) is verified offline and in live `herdr-core 0.1.20` + `ZCode.app >= 3.18.2` certification (including out-of-`--cwd` scratch `Read` + `Write` under `mode: yolo`).
- [x] `package.json` `files`, `./dev pack`, and `./dev install` bundle every new module cleanly without breaking `./dev` toolchain pinning.
- [x] Durable behavior, architecture, CLI contracts, and testing guidance are promoted into `README.md`, `HERDR.md`, `docs/app-server.md`, and `docs/toolchains.md`; `Detailed SOT` is replaced with `Canonical Outcomes`; the temporary dossier and its `docs/todo/README.md` entry are removed upon closeout; and explicit Epic acceptance is granted.

---

## EPIC-002: Isolated ZCode Desktop companion CLI

Status: Planned

Detailed SOT: [Isolated ZCode Desktop companion CLI](../todo/TODO-ISOLATED-ZCODE-DESKTOP-COMPANION-CLI.md).

Goal: support GLM-5.4 with projected credentials and make `herdr-zcode` responsible for Desktop bundle inspection, active catalog selection, and trusted-host credential projection. Mulgae owns the outer sandbox, review workflow, and downstream integration qualification.

| Task | Status | Objective | Verification |
| --- | --- | --- | --- |
| TASK-007 | Planned | Add `--catalog-file` to projected `tui` and `core` sessions. Bind the same validated catalog to account/model selection and the app-server, with exact Coding Plan API matching. Fail closed on unverified explicit reasoning in noninteractive Core. | Projected rev `48` selects GLM-5.4; invalid files or catalogs fail before app-server launch with no fallback; omitted model and effort preserve fresh-session defaults; explicit effort is verified before prompt delivery. |
| TASK-008 | Planned | Add offline `--check-desktop --json`, with structured failures from both shell bootstrap and the JavaScript toolchain guard. Reuse Desktop inspection across entry points. | Installed-launcher tests with empty `HOME` and minimal `PATH` cover compatible, missing, invalid, below-minimum, and invalid embedded-runtime fixtures. The probe performs no account or Keychain access, app-server launch, or network calls. |
| TASK-009 | Planned | Add trusted-host `prepare-isolated`, advertise the companion CLI, package the `0.2.0` candidate, and extend the live Core harness for the installed GLM-5.4 path. | Verify private projection, catalog and receipt integrity, deadline and cleanup, tarball-to-install provenance and fingerprint coverage, and standalone command smoke tests. |

### Epic acceptance

- [ ] All three Tasks are verified with recorded evidence. The final candidate passes the offline suite, package-content checks, and installed smoke checks.
- [ ] The offline launch-adapter test observes authentication-file consumption before app-server spawn. The exact installed candidate completes one authorized real GLM-5.4 / `max` turn with ZCode.app `4.0.0` and `hc 0.1.20`. Live evidence includes auth-file absence before prompt delivery, unchanged native Desktop state, and teardown in less than 150 ms with zero surviving owned processes.
- [ ] The installed candidate's Git SHA, version, package fingerprint, and verification results are recorded for Mulgae `EPIC-019`. Mulgae owns the separate `TASK-095` Seatbelt and BashGate qualification.
- [ ] Durable outcomes are promoted into the canonical CLI, operations, architecture, and toolchain documents. Explicit Epic acceptance governs the status transition and dossier retirement.
