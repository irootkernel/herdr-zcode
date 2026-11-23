# Development and architecture

herdr-zcode is a line-oriented terminal client for ZCode Desktop's app-server. It uses Node.js standard libraries with no external npm dependencies. ZCode owns model execution, tools, native subagents, permissions, and conversation history. Herdr owns panes; the coordinator assigns work and an independent evaluator accepts results.

## Develop locally

Use the development tool versions in `toolchains.env`. Run these commands from a checkout:

```sh
./dev setup
./dev doctor
./dev run --help
./dev test
```

The offline suite uses fake app-server and Herdr processes with temporary credentials. It does not require a Desktop account or consume model usage.

For a real session, install ZCode Desktop on macOS and sign in to a Z.AI Individual Coding Plan account, then run:

```sh
./dev run --cwd /path/to/project
```

To install a standalone copy of the checkout:

```sh
./dev install
"$HOME/.local/bin/herdr-zcode" --version
```

`--install-links` installs a package copy instead of a symlink to the checkout. Repeat the installation after source changes. Build archives with `./dev pack`, or inspect contents with `./dev npm pack --dry-run`. See [toolchain management](toolchains.md) for setup and upgrades.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `bin/herdr-zcode-app.mjs` | CLI arguments, input admission during startup, terminal signals and paste handling, bootstrap, and cleanup orchestration. |
| `lib/app-server-client.mjs` | Child process ownership, NDJSON transport, outbound RPC correlation, reverse requests, timeouts, and process termination. |
| `lib/app-server-controller.mjs` | Session and turn state, prompt queues, interactions, background work, rendering, and cancellation. |
| `lib/error-classification.mjs` | Classify failures as quota, rate limit, authentication, permission, or general errors and return safe diagnostics. |
| `lib/runtime-profile.mjs` | Select the explicit CLI runtime and adapt canonical status to the legacy Herdr reporter. |
| `lib/desktop-runtime.mjs` | Resolve the installed Electron runtime, prepare a temporary public provider catalog, and isolate the child environment. |
| `lib/desktop-account.mjs` | Read the Desktop account, register its catalog overlay, select the model, answer matching authentication requests, and redact credentials. |
| `lib/desktop-keychain.mjs` | Verify the ZCode signer and read Keychain-backed Desktop credentials on Apple Silicon macOS. |
| `lib/herdr-reporter.mjs` | Send asynchronous status reports for one wrapper's server socket and pane. |
| `lib/osc7501-reporter.mjs` | Emit fixed state and block-kind frames for herdr-core. |

## Startup and protocol

Launch the app-owned Electron binary with `ELECTRON_RUN_AS_NODE=1` and the bundled `zcode.cjs app-server --stdio`. The wire protocol is newline-delimited JSON with `{id, method, params}` requests. It is not JSON-RPC and does not use Content-Length framing. Reverse requests must be serviced independently of pending outbound calls.

Startup registers the account catalog revision, creates or resumes the session, verifies the exact available model, applies the requested reasoning level or the model's advertised default, and subscribes to session events. The default model ID is `account:zai-individual-coding-plan/GLM-5.3`. A `$level` suffix on `--model` follows ZCode's model-reference convention (`parseModelPickerValue`: the first `$` after the `/` starts the level; a `$` at the id start or end is literal) and sets `model.options.reasoningLevel` at `session/setModel`; without it the advertised `reasoning.defaultLevel` applies (GLM-5.3 advertises `low`, `high`, `max` and defaults to `max`). The server rejects a level absent from `reasoning.levels`, listing the supported values. Verify the model returned by both selection and subscription; do not silently substitute a model or infer an ID from its display name.

Read Desktop v2 settings and the existing Coding Plan credentials on demand. By default, copy the public provider catalog into temporary storage, bind both built-in and personal provider paths, and include the active catalog path digest in revision identity. `--runtime-dir` selects the catalog's scratch directory before `TMPDIR` and platform defaults. The child receives the caller's `TMPDIR` unchanged. `--no-copy-catalog` uses the selected catalog in place. Startup checks the app against `ZCODE_APP_MIN_VERSION` before preparing the catalog or reading the account. `--skip-desktop-inspect` skips version and embedded runtime probes and still checks the executable, app-server entry, and catalog paths. `doctor --desktop` reports the observed build and embedded Node and Electron versions. Return authentication only for matching provider and account access requests. Account changes require restarting the session.

The account reader supports plaintext, `enc:v1`, and Keychain-backed `enc:v2:os` on Apple Silicon macOS. For Keychain reads, verify the selected app and a temporary private copy of its native Keychain module. Pass the module by open descriptor to the signed ZCode executable, which uses the credential file's path-bound Keychain item to authenticate and decrypt the requested value. The encryption key stays inside that process. The decrypted value returns over a private pipe, and the temporary module is removed after the read.

Do not write Desktop credentials, workspace model defaults, or personal provider settings. Strip inherited `HC_*` and `HERDR_*` routing and legacy bridge credentials from the app-server environment. Unsupported optional host requests return explicit errors; Browser, Computer Use, and a full Desktop UI are outside this client's scope.

## Input and interaction contract

Prompt text queues a turn. `/help`, `/status`, `/stop`, `/exit`, `/allow`, `/deny`, `/choose`, and `/answer` remain responsive while a turn runs. Bracketed paste and `--prompt-file` submit multiline content as one turn. Ordinary pipes submit one turn per line. EOF drains accepted work before exit and declines requests that can no longer receive input; explicit exit cancels work.

Permission options come from the server. `/allow <id>` selects only an advertised one-time option; other options require `/choose <id> <option>`. Display the proposed input and native-subagent origin. Multiple questions accept `/answer <id> {"question text":"answer",...}` with an answer for every question. Do not add automatic approval or impose an arbitrary lifetime on valid work.

## State and lifecycle invariants

One controller owns the current session and turn, pending interactions, and known active background work. Ignore foreign sessions and correlate terminal events with the submitted turn when IDs exist. Native child events must not complete the parent turn.

`AppServerController.status()` describes the session and turn with `starting`, `idle`, `working`, `done`, `blocked`, `error`, or `unknown`. A `blocked` status identifies a pending permission or question, or a classified failure. Pending interactions take precedence over active work and the last turn outcome. A new turn clears that outcome. The `tui` runtime projects the snapshot into the existing `controller.state()` and reporter contract. A finished turn, including a failed turn with the session still accepting input, returns the TUI to `idle`.

An explicit RPC rejection retains its terminal failure status while the TUI reports `unknown` during teardown. An ambiguous transport failure reports `unknown` in both views.

A newer authoritative permission snapshot removes obsolete snapshot-only registrations. A delayed snapshot must not remove a request observed through a live event or reverse RPC. Missing snapshot fields are not empty lists, and an unanswered bootstrap registration without a response channel must not keep the client blocked.

Redaction spans output chunks, including credentials split across model deltas. Buffer only suffixes that may match a known credential; flush ordinary text on completion or shutdown and add refreshed credentials to the redaction set. Never print raw authentication exchanges, cookies, headers, stacks, or complete provider error objects.

Each wrapper owns one app-server and a reporter selected by `--runtime`. The default `tui` reporter uses `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`. It coalesces updates with ordered sequence numbers, short timeouts, and backoff. The `core` reporter writes OSC 7501 to stdout for herdr-core 0.1.20. Frames carry a fixed state and, when blocked, an allowlisted kind. A ready session emits `idle`, successful work emits `done`, and a failed turn emits `blocked` or `error`. Startup and ambiguous transport states do not emit frames. With `--non-interactive`, Core does report a classified startup failure. Startup auth, quota, and rate-limit blocks remain observable for up to five seconds or until interrupted.

On normal exit, decline unresolved requests, stop and close the session, await owned-process termination, then release the reporter. TUI starts an isolated Unix process group. Core keeps the app-server in its pane's process group and session. On `SIGHUP` or `SIGTERM`, Core skips RPC shutdown and terminates the direct app-server with bounded escalation. The outer supervisor owns pane-wide cleanup. A timeout leaves cancellation unconfirmed, and leader-process exit alone does not establish descendant exit.

## Testing changes

Run `./dev test` for changes to transport, controllers, account handling, or reporting. The suite covers startup and EOF, reverse RPCs, simultaneous interactions, stale and foreign events, background work, model identity, stream redaction, cancellation, process-group cleanup, reporter outages, and executable symlinks. Use `TEST_TMP_ROOT` to select a writable scratch root when needed.

Live checks are separate and use real services. Account and Herdr/model checks consume account usage. Run only the checks relevant to an explicitly authorized integration test:

```sh
./dev npm run test:live-account
./dev npm run test:live-reporter
./dev npm run test:live-herdr -- --scenario basic
```

Other Herdr/model scenarios are `permissions`, `subagent`, `question`, `cancel`, `multiline`, `resume`, and `coding`. Set `HERDR_TEST_BIN` if Herdr is not installed at `~/.local/bin/herdr`. Live drivers create disposable named sessions and test-owned directories; never substitute an existing user session. Remove only test-owned resources.

Distinguish offline simulation, real Herdr reporting, and completed model execution when reporting results. Request acceptance alone is not a completed model turn; provider or quota errors are failures or blockers. See the [Herdr guide](../HERDR.md) for coordinator and evaluator responsibilities.
