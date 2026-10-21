# Share Herdr rules across projects

Use this setup if you want your coding agents to follow the same Herdr operating rules in every project. It is optional for running herdr-zcode.

## Install the guide

Copy this repository's [HERDR.md](HERDR.md) to a stable location such as `~/HERDR.md`. If a file already exists there, read it and merge the rules instead of overwriting it. Keep a regular file so it remains available when the source checkout is unavailable.

Update the copy when you update the repository guide. Editing the repository alone does not update an installed copy.

## Connect your agents

Use the absolute path to your installed guide in the examples below. Replace `/absolute/path/to/HERDR.md` before saving them. Preserve any existing instructions.

For Codex, add this instruction to your active configuration directory's `AGENTS.md` (normally `~/.codex/AGENTS.md`, or under `CODEX_HOME` when configured):

```md
Before operating Herdr in any project, read `/absolute/path/to/HERDR.md` and follow it.
ZCode is executor-only. Use Codex, Claude, or Gemini as coordinator and evaluator.
```

For Claude Code, add an import to `~/.claude/CLAUDE.md`:

```md
@/absolute/path/to/HERDR.md
```

For Gemini CLI, add the same import to `~/.gemini/GEMINI.md`. Other products need their own supported instruction mechanism; Gemini CLI and Antigravity are separate products.

## Check the setup

Start a new agent session and confirm it reads the guide, including when started from a different project directory. Existing Herdr sessions do not need to be restarted.

Global configuration, CLI installation, and runtime testing are separate operations. Only report a configuration as applied after checking the installed file and the agent's behavior.
