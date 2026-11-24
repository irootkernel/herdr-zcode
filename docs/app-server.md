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
| `lib/desktop-catalog.mjs` | Validate explicit provider catalog files and compare their Coding Plan API rules with the trusted bundle. |
| `lib/toolchain.mjs` | Enforce toolchain pins and inspect the Desktop bundle and embedded runtime for doctor and standalone diagnostics. |
| `lib/desktop-account.mjs` | Load Desktop or projected credentials and share the account overlay, model validation, authentication responses, and stream redaction. |
| `lib/desktop-keychain.mjs` | Verify the ZCode signer and read Keychain-backed Desktop credentials on Apple Silicon macOS. |
| `lib/herdr-reporter.mjs` | Send asynchronous status reports for one wrapper's server socket and pane. |
| `lib/osc7501-reporter.mjs` | Emit fixed state and block-kind frames for herdr-core. |

## Startup and protocol

Launch the app-owned Electron binary with `ELECTRON_RUN_AS_NODE=1` and the bundled `zcode.cjs app-server --stdio`. The wire protocol is newline-delimited JSON with `{id, method, params}` requests. It is not JSON-RPC and does not use Content-Length framing. Reverse requests must be serviced independently of pending outbound calls.

Startup registers the account catalog revision, creates or resumes the session, configures any requested model and effort, and subscribes to session events. For an explicit model, a requested `$level` or `--reasoning-effort` accompanies the model in `session/setModel`. The response and subscription must report that level in `model.options.reasoningLevel`. An explicit model without a requested level uses the model's advertised default. The selected model's identity is verified during configuration and subscription.

When `--model` is omitted, both runtimes keep the model ZCode chooses for the new or resumed session. If the caller requests only effort, `session/create` includes an initial `thoughtLevel` hint and `session/setThoughtLevel` applies the effort to that model. The client checks reported effort from the response and subscription, including `settings.thoughtLevel.current`. Omitted optional metadata does not establish a verified setting. Existing invocations may still pass `--preserve-default-model`.

New-session flags map to `toolAllowlist`, `toolDenylist`, `mcpServers`, `titleGenerationEnabled`, `offPeakToolEnabled`, `dynamicWorkflowEnabled`, `additionalDirectories`, and `persistence` in `session/create`. Omitted fields stay absent and an explicitly empty tool list stays empty. Up to 256 additional directories resolve relative to the final `--cwd`. Combining these flags with `--resume` is rejected before startup.

Read Desktop v2 settings and the existing Coding Plan credentials on demand. With a Desktop login, `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` takes precedence. Otherwise, prefer a valid newer Desktop cache for the inspected app version, platform, and ZCode endpoint. Use the bundled catalog when that cache is missing, invalid, or no newer. A catalog downloaded by ZCode can expose models added after the app was packaged.

By default, copy the selected public catalog into temporary storage, bind both built-in and personal provider paths, and include the active catalog path digest in revision identity. `--runtime-dir` selects the catalog's scratch directory before `TMPDIR` and platform defaults. The child receives the caller's `TMPDIR` unchanged. `--no-copy-catalog` uses the selected catalog in place. Startup checks the app against `ZCODE_APP_MIN_VERSION` before preparing the catalog or reading the account. `--skip-desktop-inspect` skips version and embedded runtime probes and automatic cache selection. It still checks the executable, app-server entry, and catalog paths. `doctor --desktop` reports the observed build and embedded Node and Electron versions. Return authentication only for matching provider and account access requests. Account changes require restarting the session.

The account reader supports plaintext, `enc:v1`, and Keychain-backed `enc:v2:os` on Apple Silicon macOS. For Keychain reads, verify the selected app and a temporary private copy of its native Keychain module. Pass the module by open descriptor to the signed ZCode executable, which uses the credential file's path-bound Keychain item to authenticate and decrypt the requested value. The encryption key stays inside that process. The decrypted value returns over a private pipe, and the temporary module is removed after the read.

Do not write Desktop credentials, workspace model defaults, or personal provider settings. Strip inherited `HC_*` and `HERDR_*` routing and legacy bridge credentials from the app-server environment. Unsupported optional host requests return explicit errors; Browser, Computer Use, and a full Desktop UI are outside this client's scope.

## Projected account authentication

`--auth-file <path>` selects a projected Z.AI Coding Plan credential. Relative paths resolve against `--cwd`. The file must be a regular, single-linked, owner-readable file owned by the invoking user, with group and other permissions clear and at most 64 KiB. Symlinks are rejected. A `0600` file is the usual representation. The UTF-8 JSON must provide `providerId`, `identity`, and `apiKey`. The optional `accountAccess` defaults to the object below.

```json
{
  "providerId": "account:zai-individual-coding-plan",
  "identity": "example-account",
  "apiKey": "example-placeholder",
  "accountAccess": { "type": "zhipu-account", "mode": "individual-coding-plan", "accountType": "zai" }
}
```

The wrapper validates the credential file and selects the provider from the bundled catalog by default. Only matching app-server authentication requests can use the in-memory key, and the same redactor protects streamed output in both account modes. `--consume-auth-file` requires `--auth-file`. It overwrites a writable file through its validated open descriptor before unlinking it. A read-only file can be unlinked without being overwritten. Any consumption error stops startup before the app-server spawns. The caller owns any credential file left behind by a failure before consumption.

Projected mode uses a private temporary app state directory and a personal catalog path inside it. The child inherits the caller's `TMPDIR`, while its home and ZCode data locations point to the private state directory. The wrapper removes that state after the app-server exits or a startup failure stops the launch. Native Desktop account and Keychain state are outside the projected session.

`--catalog-file <path>` selects an explicit catalog for `--auth-file` in either runtime, including with `--skip-desktop-inspect`. Relative paths resolve against `--cwd`. Use a single-linked regular file from 1 byte through 4 MiB, owned by the invoking user, with group and other write bits clear. Mode `0644` is valid. The strict UTF-8 JSON must declare schema version 1, a positive revision, model rules, and one valid Coding Plan rule for the projected provider. Its API type and full HTTPS base URL must match the bundled provider rule exactly. An invalid explicit catalog stops launch with `catalog_invalid`. Noninteractive Core reports that diagnostic as `error`.

The account overlay uses the parsed catalog and binds its revision to the same absolute path used by the app-server. By default the wrapper writes the validated bytes to the private runtime directory. With `--no-copy-catalog`, it checks the original path and file metadata again before spawn. Keep that input and its path stable for the lifetime of the app-server. When a fresh projected session omits the model and effort, ZCode supplies both defaults. An effort-only request retains the server-selected model. Noninteractive Core stops before delivering a prompt when the requested effort conflicts with a report or neither the configuration RPC nor the subscription confirms it.

## Input and interaction contract

Prompt text queues a turn. `/help`, `/status`, `/stop`, `/exit`, `/allow`, `/deny`, `/choose`, and `/answer` remain responsive while a turn runs. Bracketed paste and `--prompt-file` submit multiline content as one turn. Ordinary pipes submit one turn per line. EOF drains accepted work before exit and declines requests that can no longer receive input; explicit exit cancels work.

Permission options come from the server. `/allow <id>` selects only an advertised one-time option; other options require `/choose <id> <option>`. Display the proposed input and native-subagent origin. Multiple questions accept `/answer <id> {"question text":"answer",...}` with an answer for every question. Do not add automatic approval or impose an arbitrary lifetime on valid work.

`--non-interactive` disables command parsing and terminal prompts, and activates `askUserQuestionAutoResolutionEnabled` in `session/requestRuntimePreferences`. An explicit `--auto-resolve-questions` enables that preference by itself. The `deny` policy declines reverse permission and question requests without registering an interactive wait. The `block` policy also closes input admission, clears queued prompts, and ends the session with an observable blocked result. It remains blocked if the provider reports late completion. Piped EOF leaves these policies active for the admitted turn.

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

### Live herdr-core certification

From the source checkout, with authorization for a live Z.AI Coding Plan call, sign in to the Coding Plan in ZCode Desktop and put `hc` 0.1.20 on `PATH`. The harness uses `/Applications/ZCode.app` at the pinned minimum version or newer and explicitly selects `account:zai-individual-coding-plan/GLM-5.3` from the bundled catalog.

```sh
./dev npm run test:live-herdr-core
```

The harness reads the current Desktop login through the existing account reader and signed Keychain path when needed. Set `HERDR_ZCODE_LIVE_AUTH_FILE` to the absolute path of a private projected credential to use a separate account source. Both sources stay untouched. The harness writes a disposable `0600` projection and verifies that `--consume-auth-file` removed it before prompt delivery. The isolated wrapper and app-server use only the projected account.

Set `HERDR_ZCODE_LIVE_BINARY` to the absolute path of a standalone installed candidate to verify that package. The default is the checkout's launcher.

The harness starts a unique `HC_SESSION` with private `HOME`, XDG directories, and short physical `TMPDIR`, using `PATH=/usr/bin:/bin` and no `NVM_DIR`. It uses an empty working directory and restricts the session to `Read` and `Write` under `--mode yolo`, with MCP, title generation, off-peak tools, and dynamic workflows disabled. It checks reported `idle`, submits one guarded turn that copies a fresh fixture outside the working directory through `--additional-dir`, then verifies reported `done`, `turn >= 1`, and the exact output. It times `hc kill` until both owned PIDs return `ESRCH`, with a strict 150 ms Epic budget and a 200 ms harness ceiling. It stops only its isolated server and removes its temporary files. If server cleanup fails, it removes the credential copy and reports where it kept the private routing files for recovery.
