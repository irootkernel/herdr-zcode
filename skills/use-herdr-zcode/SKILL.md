---
name: use-herdr-zcode
description: Operate the herdr-zcode executor in a terminal, an assigned Herdr TUI pane, or herdr-core. Use for authorized ZCode executor launches, task delivery, status, interaction handling, cancellation, and session recovery.
---

# Use herdr-zcode

Use ZCode as an executor. Choose a Codex, Claude, or Gemini agent to coordinate the work and a different agent from that same set to evaluate the result and evidence independently.

Include the task scope in the assignment. Tell ZCode and its native children to request any additional executors from the coordinator and to leave wrapper launches and pane allocation to that coordinator. The parent executor collects the native children's results and reports on the assignment.

## Start or resume an interactive session

Resolve the intended `herdr-zcode` executable and check its `--version --json` when the installed build is uncertain. `herdr-zcode --check-desktop --json` checks Desktop compatibility offline. For herdr-core or projected credentials, read [herdr-core and isolated execution](references/herdr-core.md).

Use the assigned working directory when starting from an ordinary terminal.

```sh
herdr-zcode --cwd "$project_dir"
```

ZCode selects the session model and effort. Read the model and `reasoning:` value from `Selected:`. Report any missing value as unconfirmed. Record the session ID and verify input readiness before submitting work.

To resume, use the observed session ID and its original working directory. After a Herdr server restart or forced termination, check the previous wrapper and app-server before deciding whether to resume.

```sh
herdr-zcode --cwd "$project_dir" --resume "$zcode_session"
```

For a long interactive assignment, pass `--prompt-file "$task_file"` at startup or use one bracketed paste in a running TUI. Use an absolute `task_file` path for both forms. Ordinary piped input submits one turn per line.

## Work inside Herdr TUI

For Herdr pane control, follow the shared `herdr` skill and any configured `HERDR.md`. Start in an available shell from the coordinator's verified allocation. In the commands below, `herdr_session` and `pane` come from that allocation. Omit the `--session` option when the allocator returns no session. Substitute the actual shell-quoted project path in the launch command.

```sh
herdr --session "$herdr_session" pane run "$pane" 'herdr-zcode --runtime tui --cwd "/absolute/path/to/project"'
herdr --session "$herdr_session" pane read "$pane" --source recent-unwrapped --lines 10
herdr --session "$herdr_session" pane process-info --pane "$pane"
```

Verify the expected session, input readiness and the executor's foreground process before sending input. On Herdr 0.9.5, use pane input for this custom agent, including after a rename.

```sh
herdr --session "$herdr_session" pane send-text "$pane" "$task"
herdr --session "$herdr_session" pane send-keys "$pane" enter
herdr --session "$herdr_session" pane read "$pane" --source recent-unwrapped --lines 10
```

Send multiline text as a single bracketed paste and then press Enter.

```sh
task=$(cat "$task_file")
paste=$(printf '\033[200~%s\033[201~' "$task")
herdr --session "$herdr_session" pane send-text "$pane" "$paste"
herdr --session "$herdr_session" pane send-keys "$pane" enter
```

Observe acceptance and progress in the target pane. On a timeout, re-read before resending. Send task text only while the verified executor owns the foreground.

## Handle TUI interactions and finish

Use `/status` to see the session state, queue and background counts, and pending request IDs. For each pending ID, read the full request block and any later `Updated proposed input` or `Child origin` for that request. Expand the pane read if any part is cut off. Base a decision on the current input, origin and options. If an update leaves those details unclear, leave the request pending for clarification or decline it within the user's authorization. Use the default `build` mode unless the user authorizes a different mode. Keep automatic approvals off. `guarded` automatically allows ordinary operations.

| Input | Action |
| --- | --- |
| `/allow <id>` | Select the advertised one-time approval when authorized. |
| `/deny <id>` | Decline the pending permission or question. |
| `/choose <id> <option>` | Select an authorized option from the request. |
| `/answer <id> <text>` | Answer the question. For multiple questions, supply a JSON object keyed by question text with an answer for each question. |
| `/stop` | Request cancellation of active work, decline pending interactions and discard queued prompts. |
| `/exit` | Cancel work, close the session and clean up the executor. |

Relay a control command through `pane send-text` and press Enter with `pane send-keys`. Handle a pending request within the user's authorization before sending new work.

Ctrl-C requests cancellation during active work and exits when idle. SIGTERM and SIGHUP take the cleanup path. Wait for the terminal events after requesting a stop. Treat a timeout or `cancellation unconfirmed` as uncertain and inspect the owned processes before reuse.

In the interactive TUI, `idle` or Herdr's `done` means ready for input. `working` covers submitted or active work and background activity. `blocked` means there is a pending interaction. Read the screen when the state is `unknown` or stale. Assess completion using the parent executor's result, artifacts and verification.

Before closing or reusing a pane, verify that the wrapper and its owned app-server exited. The TUI app-server runs in a separate process group and may outlive a force-terminated wrapper. Identify that process before taking further cleanup action. Follow the shared Herdr guidance for pane disposition.
