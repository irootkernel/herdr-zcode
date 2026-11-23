# Herdr operating guide

These rules apply when using herdr-zcode with Herdr. For installation, see the [README](README.md). To make the rules available across projects, see [global setup](GLOBAL-SETUP.md).

## Roles and pane allocation

| Role | Agent | Responsibility |
| --- | --- | --- |
| Coordinator | Codex, Claude, or Gemini | Divide work, assign executors, track progress, and collect results. |
| Executor | An agent selected by the coordinator | Implement, investigate, or test within the assigned scope. |
| Evaluator | Codex, Claude, or Gemini | Independently assess requirements, changes, and validation. |

ZCode is executor-only. Within an assigned task it may use ZCode's native Agent tool and subagents. The parent executor collects their results. Internal subagents must not launch nested herdr-zcode clients or allocate additional Herdr panes; request additional executors from the coordinator.

Before controlling Herdr, read the shared Herdr skill installed for your agent. Operate from a verified Herdr context with `HERDR_ENV=1`. Keep the main tab unsplit and allocate helpers through the existing allocator, using a distinct, stable name for each concurrent executor:

```sh
dev-herdr --subagent-pane implementation --cwd "$PWD"
dev-herdr --subagent-pane verification --cwd "$PWD"
```

Use the returned `.result.pane.pane_id` and `.result.session`. If a session is returned, pass it to subsequent commands with `--session`. An existing allocation with the same name may be returned; read its output before reusing it. Each coordinator must use its own verified caller and allocation results.

If caller verification fails, follow the shared skill's `dev-herdr --identify-caller` recovery procedure. Do not infer identity from focus, working directory, or inherited pane IDs, create substitute panes, or share a pending probe. Existing session, login-service, and running-view configuration remains governed by the local Herdr installation.

## Model and reasoning level

The default model is `account:zai-individual-coding-plan/GLM-5.3`. To request the `max` reasoning level explicitly, run:

```sh
herdr-zcode --cwd /path/to/project --model 'account:zai-individual-coding-plan/GLM-5.3$max'
```

Keep the model reference in single quotes so the shell passes `$max` literally. Without a `$level` suffix, the model's advertised default applies; GLM-5.3 defaults to `max`. Check the startup line for the selected model and reasoning level. See the [README](README.md#choosing-a-model-and-reasoning-level) for details.

## Start an executor and send a task

Start in an available shell pane assigned by the coordinator. Replace placeholders below with actual allocator results; omit `--session` if none was returned.

```sh
herdr --session <returned-session> pane run <returned-pane-id> 'herdr-zcode --cwd /path/to/project'
herdr --session <returned-session> pane read <returned-pane-id> --source recent-unwrapped --lines 10
herdr --session <returned-session> pane process-info --pane <returned-pane-id>
```

Confirm the session shown at startup, input readiness, and that the foreground process is herdr-zcode before sending input. Do not replace a running coordinator, evaluator, or other process.

Herdr 0.9.5 rejects `agent prompt` for custom agents with `not an active named agent`, even after renaming. Use pane commands:

```sh
herdr --session <returned-session> pane send-text <returned-pane-id> '<executor task>'
herdr --session <returned-session> pane send-keys <returned-pane-id> enter
herdr --session <returned-session> pane read <returned-pane-id> --source recent-unwrapped --lines 10
```

Do not use `herdr agent start --kind zcode` or impersonate a built-in agent. Successful delivery does not prove that a task started or finished. Check state changes and the result. After a timeout, inspect output before resending. Do not send task text to a pane that has returned to a shell.

For a long request, use `--prompt-file /absolute/path/to/task.md` at startup, or one bracketed paste. In this example, `session` and `pane` must contain the verified allocator results:

```sh
task=$(cat /absolute/path/to/task.md)
herdr --session "$session" pane send-text "$pane" "$(printf '\033[200~')${task}$(printf '\033[201~')"
herdr --session "$session" pane send-keys "$pane" enter
```

Ordinary piped input submits one turn per line.

## Permissions and cancellation

Read the requested tool input, available options, and any subagent origin. Respond within the authorization already granted; the coordinator cannot grant a user approval it does not have. Send control commands instead of new tasks while an interaction is blocked.

| Input | Action |
| --- | --- |
| `/allow <id>` | Select the server's one-time approval option. |
| `/deny <id>` | Decline a permission request or question. |
| `/choose <id> <option>` | Select a displayed option. |
| `/answer <id> <text>` | Answer a question. |
| `/status` | Inspect state, queued prompts, pending interactions, and background work. |
| `/stop` | Request cancellation and discard queued prompts. |
| `/exit` | Cancel work, close the session, and clean up the process. |

Send these through `pane send-text`, followed by `pane send-keys ... enter`. Use the request ID and option from the actual screen.

Ctrl-C cancels active work and exits when idle. SIGTERM and SIGHUP also use the cleanup path. The default native permission mode is `build`; do not add automatic approval. ZCode's `guarded` mode allows ordinary operations automatically and must not be described as stricter.

## States, results, and cleanup

| State | Meaning |
| --- | --- |
| `idle` (or `done` in Herdr) | Ready for input; independent evaluation is still required. |
| `working` | A submitted or active turn, or observed background work. |
| `blocked` | A permission request or question needs a response. |
| `unknown` | Startup, cleanup, or a connection problem leaves state uncertain. |

An unresolved interaction keeps the executor blocked even if another tool or turn finishes. Native child completion does not finish the parent task. Herdr displays the parent executor; native subagents do not receive separate panes.

Each wrapper owns its app-server, session, interactions, and reporter. Reports are bound to the server socket and pane, sent asynchronously, and coalesced with backoff during outages. Displays may be stale during an outage; consult terminal output when needed. Registration is released after app-server termination is observed. Cleanup cannot be guaranteed after SIGKILL or system shutdown. Automatic restoration after a Herdr server restart is outside the client's scope; resume explicitly with `herdr-zcode --resume SESSION_ID --cwd /path/to/project`.

Task assignments must state the goal, allowed files, preservation requirements, completion criteria, and validation. Result reports must identify changes, checks actually run, and remaining issues. A completion claim or successful exit code alone does not establish correctness; the evaluator checks the actual changes and evidence.

Each coordinator tracks its executors and file ownership. Separate panes do not isolate changes to the same files; agree on ownership or use separate worktrees. Read result reports and questions first; use a short recent-output view for progress and detailed logs when investigating a problem. Close only helpers whose results have been read and which will not be reused. Preserve shared tabs with active helpers and existing user sessions.

## herdr-core 0.1.20

Start the installed command as an executable with `hc run` and select `--runtime core --non-interactive`. Set the working directory, allowed tools, and additional directories to the task's authorized scope. Use a disposable projected credential with `--auth-file <path> --consume-auth-file` when supplying a Coding Plan account for isolated automation.

Read the assigned terminal with `hc get --json <terminal>`. Wait for `reported: true` and `status.state: idle` before delivering a task. Use `hc send --if idle --wait <terminal> <prompt>` to guard delivery. A completed turn reports `done` and advances the turn counter. Check the result artifacts before accepting the work. A `blocked` or `error` state needs investigation.

Use `hc kill <terminal>` to stop a terminal you own. Core keeps its app-server in the terminal's process group and takes the fast teardown path on hangup or termination. The [live Core test](docs/app-server.md#live-herdr-core-certification) uses its own daemon and checks that both processes are gone.
