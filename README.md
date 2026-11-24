# herdr-zcode

Use ZCode from your Mac's terminal, with optional status reporting in [Herdr](HERDR.md). Describe a task in plain language, review any requested file changes or commands, and read the result in the same window.

herdr-zcode uses your existing ZCode Desktop account and tools. No separate API key or hook plugin is required.

## Before you start

You need:

- macOS with ZCode Desktop 3.18.2 or later, normally in `/Applications/ZCode.app`. Keychain-backed accounts require Apple Silicon.
- A Z.AI Individual Coding Plan account signed in through ZCode Desktop.
- [nvm](https://github.com/nvm-sh/nvm) with the exact Node.js version declared in `toolchains.env` when building or installing from the checkout.

The project selects its own Node.js and npm versions. System and shell-default upgrades do not upgrade this project. See [toolchain management](docs/toolchains.md) for setup and explicit upgrades.

## Install

From a source checkout containing the version-managed launcher, run:

```sh
./dev setup
./dev doctor --desktop
./dev install
export PATH="$HOME/.local/bin:$PATH"
herdr-zcode --version
```

If the declared Node is missing, `setup` prints the exact `nvm install` command; run it and repeat `setup`. Setup prepares an isolated npm without changing global npm. `doctor --desktop` checks ZCode without reading your account.

Installation copies the package to `~/.local`; repeat it after source changes. Previously published archives remain unchanged: the older v0.1.0 asset does not include this toolchain policy. Build a new archive with `./dev pack` and install it with `./dev npm install --global --prefix "$HOME/.local" /absolute/path/to/archive.tgz`.

The installed command uses the exact pinned nvm Node when available and otherwise uses the embedded Node runtime that ships with ZCode Desktop. The fallback works with an empty `HOME`, unset `NVM_DIR`, and `PATH=/usr/bin:/bin`. To select a different bundle, pass `--app-bundle` or set `HERDR_ZCODE_APP_BUNDLE`. `herdr-zcode --version --json` reports supported runtimes, capabilities, and the minimum Desktop version without opening an account session.

The `export` command makes herdr-zcode available in this Terminal window. For new windows, you can use its full path, `"$HOME/.local/bin/herdr-zcode"`, or add the same `export` line to your shell's startup file (`~/.zshrc` for the default macOS shell).

## Try your first task

Create a practice folder and start herdr-zcode there:

```sh
mkdir -p "$HOME/herdr-zcode-demo"
herdr-zcode --cwd "$HOME/herdr-zcode-demo"
```

`--cwd` chooses the folder ZCode will work in. After startup, you should see the selected model, a session ID, and `Type /help for commands.`

`--runtime tui` explicitly selects the default interactive runtime. Runtime selection is explicit even inside a Herdr pane.

Use `--runtime core` under herdr-core 0.1.20 (`hc`) to report state through OSC 7501. In that runtime, `SIGHUP` and `SIGTERM` stop the app-server without waiting for session shutdown RPCs. Add `--non-interactive` to expose startup failures through OSC status. See the [herdr-core operating guide](HERDR.md#herdr-core-0120).

In an isolated session, use `--auth-file <path>` to provide a projected Z.AI Coding Plan credential. Supply an owner-readable private JSON file. Add `--consume-auth-file` when the wrapper should remove that file before launching the app-server. Use a disposable copy for consumption. See [projected account authentication](docs/app-server.md#projected-account-authentication) for the file format and lifecycle.

Add `--catalog-file <path>` to a projected TUI or Core session when it needs models from a newer compatible catalog, such as GLM-5.4. Both paths resolve against `--cwd`. An explicit catalog must match the bundled Coding Plan API settings. If validation fails, the session stops before the app-server starts. The wrapper uses the bundled catalog when you omit `--catalog-file`.

On the trusted host, `herdr-zcode prepare-isolated --out-dir <directory> [--app-bundle <path>] [--json]` reads your current Desktop Coding Plan login and prepares the credential and catalog together. Supply an existing owner-only `0700` directory and keep the directory and its ancestors stable. The command writes `auth.json` with mode `0600` and `catalog.json` with mode `0400`. Both forms return one JSON receipt or one safe failure object. Use the returned paths unchanged for `--auth-file --consume-auth-file` and `--catalog-file --no-copy-catalog`. Protect the disposable auth file and remove it after a failed launch. See [trusted-host preparation](docs/app-server.md#trusted-host-preparation) for the receipt and cleanup contract.

Type this request into herdr-zcode and press Enter:

```text
Create a file named hello.txt containing Hello from ZCode. If it already exists, leave it unchanged and tell me.
```

When ZCode asks for permission, read the proposed change. To approve this one action, type `/allow` followed by the request ID shown on screen. For example, if the ID is `request-1`:

```text
/allow request-1
```

Use the actual ID from your screen. `/deny request-1` declines it. If no one-time approval option is available, use `/choose` with one of the displayed options.

Wait for ZCode's answer, then type `/exit` and press Enter. Back at the normal Terminal prompt, check the file:

```sh
cat "$HOME/herdr-zcode-demo/hello.txt"
```

For a newly created file, the output should be `Hello from ZCode`. You can now start herdr-zcode in a folder of your choice and describe the task you want done.

## Everyday commands

Type these inside herdr-zcode:

| Command | What it does |
| --- | --- |
| `/help` | Show available commands. |
| `/status` | Show current work, queued prompts, and requests waiting for your response. |
| `/allow <id>` | Approve one action using the server's one-time option. |
| `/deny <id>` | Decline a permission request or question. |
| `/choose <id> <option>` | Select an option displayed by ZCode. |
| `/answer <id> <text>` | Answer a question. |
| `/stop` | Request cancellation and discard queued prompts. |
| `/exit` | Cancel outstanding work, close the session, and exit. |

Replace text in angle brackets with the value shown on screen; do not type the brackets. New prompts entered while ZCode is working wait for the next turn. Control commands remain available during a task.

Ctrl-C cancels active work. When no work is running, Ctrl-C exits. The default permission mode is `build`. Other modes use ZCode's own permission rules; `guarded` automatically allows ordinary operations and is not a stricter approval mode.

### Choosing a model and reasoning level

Without `--model`, herdr-zcode uses the model and effort selected by ZCode for the session. To select GLM-5.4 with max effort, use ZCode's model-reference syntax:

```sh
herdr-zcode --cwd /path/to/project --model 'account:zai-individual-coding-plan/GLM-5.4$max'
```

Keep the model reference in single quotes so the shell passes `$max` literally. An explicit model without a suffix uses the effort advertised by ZCode. The startup line shows the applied model and any reported effort, such as `Selected: account:zai-individual-coding-plan/GLM-5.4 (reasoning: max)`.

Use `--reasoning-effort <level>` or its alias `--thought-level <level>` to choose effort separately. If you also use a `$level` model suffix, the values must agree. With a Desktop login, the wrapper uses a newer matching model catalog downloaded by ZCode when available. If GLM-5.4 is missing, open ZCode Desktop to refresh its Coding Plan model catalog. See [catalog selection](docs/app-server.md#startup-and-protocol) for overrides and fallbacks.

### Running a scoped session

Use `--tool-allowlist` and `--tool-denylist` with comma-separated tool names. An explicit empty string (`''`) sends an empty list. Use `--disable-mcp`, `--disable-title-gen`, `--disable-offpeak`, or `--disable-dynamic-workflow` for the corresponding behavior. Repeat `--additional-dir <path>` up to 256 times and use `--persistence immediate|deferred` to choose the session's persistence. These flags apply to new sessions.

With `--non-interactive`, all input lines, including slash-prefixed lines, are prompts. Unexpected permission requests and questions stop the session by default. Pass `--interaction-policy deny` to decline them and let the server continue. Noninteractive mode enables question auto-resolution, which you can also request independently with `--auto-resolve-questions`.

### Longer requests and saved conversations

Paste a multiline request as one paste, or save it to a text file and start with:

```sh
herdr-zcode --cwd /path/to/project --prompt-file /absolute/path/to/task.txt
```

Replace the example paths with your own. To reopen a conversation, use the session ID printed during its earlier run:

```sh
herdr-zcode --cwd /path/to/project --resume SESSION_ID
```

Ordinary piped input submits one turn per line. End-of-input waits for queued work to finish; permission requests that cannot be answered are declined.

## Use with Herdr

In Herdr, run herdr-zcode in a shell pane assigned by your coordinator. ZCode carries out assigned tasks; Codex, Claude, or Gemini coordinates the work and independently evaluates results. ZCode can use its own native subagents within an assigned task.

Herdr receives `idle`, `working`, `blocked`, or `unknown` status. `idle` means ready for input; the task's result still needs review. The terminal also works outside Herdr.

Herdr 0.9.5 requires pane commands to send input to custom agents. See the [Herdr operating guide](HERDR.md) for allocation, input, and cleanup, and [global setup](GLOBAL-SETUP.md) for sharing those rules across projects.

## Troubleshooting

Run `herdr-zcode --check-desktop --json [--app-bundle <path>]` to check the Desktop bundle offline. The command returns one JSON object and exits `0` for a compatible bundle or `1` with a failure reason. It works with an empty `HOME` and `PATH=/usr/bin:/bin` and performs no account access or model calls.

| Problem | What to check |
| --- | --- |
| A pinned tool is missing or mismatched | Run `./dev setup` and `./dev doctor` from the source checkout. Follow the exact Node installation instruction when needed. |
| `herdr-zcode` is not found | Run the `export PATH` command above or use `"$HOME/.local/bin/herdr-zcode"`. |
| ZCode is below the minimum version | Run `./dev doctor --desktop` to check the minimum, then update ZCode Desktop. |
| Startup or account error | Open ZCode Desktop, check your Coding Plan login, then restart herdr-zcode. Restart it after switching accounts. |
| ZCode is installed elsewhere | Start with `herdr-zcode --app-bundle "/path/to/ZCode.app"`. |
| Selected model is unavailable | Check that the active catalog offers the requested model. If the bundled catalog lacks GLM-5.4, refresh the Desktop Coding Plan catalog and pass the compatible `catalogFile` from a fresh `prepare-isolated` receipt as `--catalog-file`. |
| Work is waiting for input | Use `/status`, read the pending request, and respond with the matching approval or answer command. |

## For developers

See the [development and architecture guide](docs/app-server.md) for source installation, protocol behavior, module responsibilities, and tests. This client provides a line-oriented terminal interface; optional Desktop host features such as Browser and Computer Use are outside its scope.
