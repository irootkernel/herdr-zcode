# Development and architecture

herdr-zcode is a line-oriented terminal client for ZCode Desktop's app-server. It uses Node.js standard libraries with no external npm dependencies. ZCode owns model execution, tools, native subagents, permissions, and conversation history. Herdr owns panes; the coordinator assigns work and an independent evaluator accepts results.

## Develop locally

Use Node.js 20 or later. From a checkout of this repository:

```sh
node bin/herdr-zcode-app.mjs --help
npm test
```

The offline suite uses fake app-server and Herdr processes with temporary credentials. It does not require a Desktop account or consume model usage.

For a real session, install ZCode Desktop on macOS and sign in to a Z.AI Individual Coding Plan account, then run:

```sh
node bin/herdr-zcode-app.mjs --cwd /path/to/project
```

To install a standalone copy of the checkout:

```sh
npm install --global --prefix "$HOME/.local" --install-links .
"$HOME/.local/bin/herdr-zcode" --version
```

`--install-links` installs a package copy instead of a symlink to the checkout. Repeat the installation after source changes. Inspect distribution contents with `npm pack --dry-run`.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `bin/herdr-zcode-app.mjs` | CLI arguments, input admission during startup, terminal signals and paste handling, bootstrap, and cleanup orchestration. |
| `lib/app-server-client.mjs` | Child process ownership, NDJSON transport, outbound RPC correlation, reverse requests, timeouts, and process termination. |
| `lib/app-server-controller.mjs` | Session and turn state, prompt queues, interactions, background work, rendering, and cancellation. |
| `lib/desktop-runtime.mjs` | Resolve the installed Electron runtime, prepare a temporary public provider catalog, and isolate the child environment. |
| `lib/desktop-account.mjs` | Read the Desktop account, register its catalog overlay, select the model, answer matching authentication requests, and redact credentials. |
| `lib/herdr-reporter.mjs` | Send asynchronous status reports for one wrapper's server socket and pane. |

## Startup and protocol

Launch the app-owned Electron binary with `ELECTRON_RUN_AS_NODE=1` and the bundled `zcode.cjs app-server --stdio`. The wire protocol is newline-delimited JSON with `{id, method, params}` requests. It is not JSON-RPC and does not use Content-Length framing. Reverse requests must be serviced independently of pending outbound calls.

Startup registers the account catalog revision, creates or resumes the session, verifies the exact available model, applies its advertised reasoning default, and subscribes to session events. The default model ID is `account:zai-individual-coding-plan/GLM-5.3`. Verify the model returned by both selection and subscription; do not silently substitute a model or infer an ID from its display name.

Read Desktop v2 settings and the existing Coding Plan credentials on demand. Copy only the public provider catalog into temporary storage, bind both built-in and personal provider paths, and include the active catalog path digest in revision identity. Avoid hardcoding app versions, CPU architectures, or endpoint-cache paths. Return authentication only for matching provider/account-access requests. Account changes require restarting the session.

Do not write Desktop credentials, workspace model defaults, or personal provider settings. Strip inherited Herdr routing and legacy bridge credentials from the app-server environment. Unsupported optional host requests return explicit errors; Browser, Computer Use, and a full Desktop UI are outside this client's scope.

## Input and interaction contract

Prompt text queues a turn. `/help`, `/status`, `/stop`, `/exit`, `/allow`, `/deny`, `/choose`, and `/answer` remain responsive while a turn runs. Bracketed paste and `--prompt-file` submit multiline content as one turn. Ordinary pipes submit one turn per line. EOF drains accepted work before exit and declines requests that can no longer receive input; explicit exit cancels work.

Permission options come from the server. `/allow <id>` selects only an advertised one-time option; other options require `/choose <id> <option>`. Display the proposed input and native-subagent origin. Multiple questions accept `/answer <id> {"question text":"answer",...}` with an answer for every question. Do not add automatic approval or impose an arbitrary lifetime on valid work.

## State and lifecycle invariants

One controller owns the current session and turn, pending interactions, and known active background work. Ignore foreign sessions and correlate terminal events with the submitted turn when IDs exist. Pending interactions keep state `blocked`; active work is `working`, input readiness is `idle`, and ambiguous or disconnected state is `unknown`. Native child events must not complete the parent turn.

A newer authoritative permission snapshot removes obsolete snapshot-only registrations. A delayed snapshot must not remove a request observed through a live event or reverse RPC. Missing snapshot fields are not empty lists, and an unanswered bootstrap registration without a response channel must not keep the client blocked.

Redaction spans output chunks, including credentials split across model deltas. Buffer only suffixes that may match a known credential; flush ordinary text on completion or shutdown and add refreshed credentials to the redaction set. Never print raw authentication exchanges, cookies, headers, stacks, or complete provider error objects.

Each wrapper owns one app-server and asynchronous reporter. Herdr reporting requires `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`. Coalesce updates with ordered sequence numbers, short timeouts, and backoff so reporting cannot block model or terminal I/O. Do not run legacy hook reporting alongside it.

On exit, decline unresolved requests, stop and close the session, await owned-process termination, then release Herdr registration. A timeout is not successful cancellation, and leader-process exit does not prove that descendants have exited.

## Testing changes

Run `npm test` for changes to transport, controllers, account handling, or reporting. The suite covers startup and EOF, reverse RPCs, simultaneous interactions, stale and foreign events, background work, model identity, stream redaction, cancellation, process-group cleanup, reporter outages, and executable symlinks. Use `TEST_TMP_ROOT` to select a writable scratch root when needed.

Live checks are separate and use real services. Account and Herdr/model checks consume account usage. Run only the checks relevant to an explicitly authorized integration test:

```sh
npm run test:live-account
npm run test:live-reporter
npm run test:live-herdr -- --scenario basic
```

Other Herdr/model scenarios are `permissions`, `subagent`, `question`, `cancel`, `multiline`, `resume`, and `coding`. Set `HERDR_TEST_BIN` if Herdr is not installed at `~/.local/bin/herdr`. Live drivers create disposable named sessions and test-owned directories; never substitute an existing user session. Remove only test-owned resources.

Distinguish offline simulation, real Herdr reporting, and completed model execution when reporting results. Request acceptance alone is not a completed model turn; provider or quota errors are failures or blockers. See the [Herdr guide](../HERDR.md) for coordinator and evaluator responsibilities.
