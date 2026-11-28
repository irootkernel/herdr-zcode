# herdr-core and isolated execution

Use an owned herdr-core terminal and `--runtime core` for OSC 7501 status. These examples use herdr-core 0.1.20.

## Start with the Desktop login

Run this as the signed-in ZCode Desktop user. Set `executor` to the absolute path of the installed `herdr-zcode` and `project_dir` to the task directory.

```sh
hc run --bg --json --cwd "$project_dir" -- "$executor" --runtime core
```

Use the returned terminal address as `terminal` and attach to interact.

```sh
hc attach "$terminal"
```

Check `Selected:` and wait for ZCode's input prompt before sending work. Use `/exit` when finished.

## Run with projected credentials

The remaining steps cover the first task in a fresh noninteractive terminal. Scope the working directory, tool allowlist and any `--additional-dir` paths to the authorized task.

`--non-interactive` treats each input line as a prompt, disables slash controls and enables ZCode's question auto-resolution preference. With the default `block` interaction policy, a permission request or question that still reaches the wrapper is declined. The wrapper closes input and ends the run with a `blocked` result. Use `build` unless the user authorizes another mode. A permission request in `build` can end the run.

## Prepare projected inputs

Run preparation on the trusted host as the signed-in ZCode Desktop user, with that user's `HOME`. Use the verified absolute `executor` path and a fresh, empty, owner-only `0700` directory with a stable path and ancestors.

```sh
PATH=/usr/bin:/bin TMPDIR=/tmp "$executor" prepare-isolated --out-dir "$private_dir" --json
```

Read `authFile` and `catalogFile` from the successful receipt. Keep the account identity hash and credentials out of general-purpose logs. The example below passes the two disposable files from the same receipt.

## Launch and send the first task

Set `project_dir` and `allowed_tools` from the authorized task and `auth_file` and `catalog_file` from the receipt. Record the terminal address returned by `hc run`. If you add `--no-copy-catalog`, keep the catalog path and contents stable until the app-server exits.

```sh
hc run --bg --json --cwd "$project_dir" --no-parent --no-notify -- "$executor" \
  --runtime core --non-interactive --cwd "$project_dir" \
  --tool-allowlist "$allowed_tools" \
  --auth-file "$auth_file" --consume-auth-file --catalog-file "$catalog_file"
```

```sh
hc get --json "$terminal"
hc read --lines 30 "$terminal"
```

Before sending work, require `reported: true`, `status.state: idle` and `turn: 0`. Verify that the disposable auth path is absent. Check `Selected:` in the startup output for the session model and its `reasoning:` value. Report any missing value as unconfirmed. Require confirmation of any explicitly requested effort before delivery.

Set `task` to one nonempty line. Embedded newlines may produce multiple turns. Keep the prompt out of the launch command so the caller can check readiness and auth consumption before sending.

```sh
hc send --json --if idle --wait "$terminal" "$task"
```

Confirm that the wait and a fresh terminal observation report `done` for the expected turn. Check the result artifacts before acceptance. The `--if idle` guard is for this first delivery. With hc 0.1.20, a terminal reporting `done` fails that guard.

## Handle a failed run and clean up

Read the observed status and recent output for `blocked`, `error` or an uncertain send outcome. A noninteractive block is terminal for the run. Keep approval commands out of Core input. For a new authorized attempt, prepare fresh projected files. Check whether a timed-out send arrived before sending again.

Identify the wrapper and its owned app-server before stopping an owned terminal. After `hc kill "$terminal"`, verify that both processes have exited and check the terminal process group for any surviving owned descendants. The Core app-server shares that group. On hangup or termination, the wrapper skips session shutdown RPCs and terminates its app-server directly. Identify and handle any surviving processes within the authorized cleanup scope.

After the owned processes stop, check the private preparation directory. Dispose of any surviving auth file according to the applicable credential-handling rules. Remove the owned catalog and the directory created for that run when finished.
