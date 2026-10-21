# herdr-zcode

Use ZCode from your Mac's terminal, with optional status reporting in [Herdr](HERDR.md). Describe a task in plain language, review any requested file changes or commands, and read the result in the same window.

herdr-zcode uses your existing ZCode Desktop account and tools. No separate API key or hook plugin is required.

## Before you start

You need:

- macOS with ZCode Desktop installed, normally in `/Applications/ZCode.app`.
- A Z.AI Individual Coding Plan account signed in through ZCode Desktop.
- Node.js 20 or later, including npm. If you need to install Node.js, use the [official download page](https://nodejs.org/en/download).

Open Terminal by pressing Command-Space, typing `Terminal`, and pressing Enter. Paste each command block below into Terminal and press Enter. To check Node.js and npm, run:

```sh
node --version
npm --version
```

## Install

1. Open the [v0.1.0 release page](https://github.com/irootkernel/herdr-zcode/releases/tag/v0.1.0).
2. Under **Assets**, download `herdr-zcode-0.1.0.tgz`. Leave it compressed. The source code archives are for developers.
3. If your browser saved it in Downloads, run:

```sh
cd "$HOME/Downloads"
npm install --global --prefix "$HOME/.local" ./herdr-zcode-0.1.0.tgz
export PATH="$HOME/.local/bin:$PATH"
herdr-zcode --version
```

The last command should print `herdr-zcode 0.1.0`. If the download is in another folder, open that folder in Terminal instead. To check the download, save `SHA256SUMS` from the release into the same folder and run `shasum -a 256 -c SHA256SUMS`.

The `export` command makes herdr-zcode available in this Terminal window. For new windows, you can use its full path, `"$HOME/.local/bin/herdr-zcode"`, or add the same `export` line to your shell's startup file (`~/.zshrc` for the default macOS shell).

## Try your first task

Create a practice folder and start herdr-zcode there:

```sh
mkdir -p "$HOME/herdr-zcode-demo"
herdr-zcode --cwd "$HOME/herdr-zcode-demo"
```

`--cwd` chooses the folder ZCode will work in. After startup, you should see the selected model, a session ID, and `Type /help for commands.`

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

| Problem | What to check |
| --- | --- |
| `node` or `npm` is not found | Install Node.js, then open a new Terminal window. |
| `herdr-zcode` is not found | Run the `export PATH` command above or use `"$HOME/.local/bin/herdr-zcode"`. |
| npm cannot find the package | Check that Terminal is in the folder containing the downloaded `.tgz` file. |
| Startup or account error | Open ZCode Desktop, check your Coding Plan login, then restart herdr-zcode. Restart it after switching accounts. |
| ZCode is installed elsewhere | Start with `herdr-zcode --app-bundle "/path/to/ZCode.app"`. |
| Selected model is unavailable | Check that your account catalog offers `account:zai-individual-coding-plan/GLM-5.3`. The client reports an error instead of choosing another model. |
| Work is waiting for input | Use `/status`, read the pending request, and respond with the matching approval or answer command. |

## For developers

See the [development and architecture guide](docs/app-server.md) for source installation, protocol behavior, module responsibilities, and tests. This client provides a line-oriented terminal interface; optional Desktop host features such as Browser and Computer Use are outside its scope.
