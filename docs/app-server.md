# App-server wrapper contract

The default command is a thin, line-oriented terminal client for the installed ZCode app-server. ZCode owns inference, tools, native subagents, permissions, history and model execution. Herdr owns panes; the coordinator owns task assignment and the evaluator owns acceptance. No new scheduler, agent framework, database, or full-screen renderer is required.

## Runtime

- Launch the app-owned Electron binary with `ELECTRON_RUN_AS_NODE=1`, its `zcode.cjs`, `app-server --stdio`. Use the installed provider configuration and Desktop v2 account, following Mulgae's working account bridge. Do not modify Desktop credentials or workspace model defaults.
- Wire protocol is NDJSON `{id, method, params}`, not JSON-RPC and not Content-Length. Handle reverse requests independently of outbound requests.
- Register the account catalog revision (including the active catalog path digest), create/resume the session, verify the exact selected catalog model, set it with its advertised reasoning default, and subscribe. The initial default is `account:zai-individual-coding-plan/GLM-5.3`; never silently choose a different model.
- Support interactive input and scripted input. Input remains responsive throughout a turn, including permissions, questions, `/stop`, `/status`, and `/exit`. Piped EOF drains accepted work before exiting; explicit exit cancels it. Long valid work has no arbitrary two-minute lifetime.
- Display assistant text, tool activity, native-subagent activity, requests and concise failures. Do not print credentials, raw auth RPCs, cookies, or complete provider error objects.
- User-facing approval options come from the server. Do not add automatic approval. Decline unresolved requests on exit, stop the session, close it, await child termination, then release Herdr ownership. Stop/close timeouts are bounded and do not mean successful cancellation.

## State ownership

One controller owns input admission, the current session/turn, pending interactions and known active background work. Reject/ignore foreign sessions and correlate terminal events to the submitted turn when IDs exist. Keep `blocked` while any interaction remains. Native child events must not finish the parent turn. Ready is `idle` (input readiness, not evaluator approval); active work is `working`; ambiguous/disconnected state is `unknown`.

A newer authoritative pending-permission snapshot removes obsolete snapshot-only registrations. A permission observed through a live event or reverse request is not removed merely because an older/delayed snapshot omits it. Missing snapshot fields are not empty lists. A dropped bootstrap registration cannot keep the terminal blocked without a response channel.

Terminal redaction is continuous across output chunks. A known credential split over multiple model deltas must remain redacted; only an incomplete suffix that could match a known credential may be buffered. Completion/shutdown flushes safe ordinary text, and refreshed credentials join the redaction set.

One asynchronous Herdr reporter per wrapper coalesces current state, uses an ordered sequence and short timeouts/backoff. It never blocks ZCode input or protocol IO. Each wrapper keeps its own process, session and reporter. Never inherit hook bridge credentials into app-server or run both reporting paths. Existing user sessions/panes must not be changed for tests.

## Commands

Keep the command surface small: prompt text, `/help`, `/status`, `/stop`, `/exit`, `/allow <id>`, `/deny <id>`, `/choose <id> <option>`, `/answer <id> <text>`. Optional multiline capture and prompt files avoid shell quoting. Support cwd, explicit model, permission mode, and resume using verified native protocol fields. Internal ZCode subagents are allowed; ZCode is not a Herdr coordinator or independent evaluator.

## Acceptance evidence

1. Offline fake app-server tests cover bootstrap, reverse auth/preferences, two turns, early stdin/EOF, approval and rejection while busy, simultaneous requests, question response, stream rendering, cancellation, server crash, stale/foreign events, background child activity, timeout cleanup and no secret output.
2. Reporter tests cover independent routes, fast repeated events during an outage, recovery and release after actual app-server exit. Obsolete hook bridge code and its dedicated tests/fixtures are removed; current app-server and reporter tests, including inherited legacy-environment stripping, remain.
3. Live installed ZCode tests cover a model reply, a second turn, a controlled tool operation, native subagent execution, cancellation and clean shutdown. Any quota or provider failure is a failure/blocker, not a pass.
4. An explicitly named disposable Herdr session verifies launch, prompt, output, states, independent executors and release. Do not inspect or modify the user's focused session. Remove only the test-owned session/artifacts.
5. Install the verified command, update README and the global-guide source; apply the existing global guide only through permitted access. Record exact supported versions and distinguish real-model, real-terminal and simulated evidence.
