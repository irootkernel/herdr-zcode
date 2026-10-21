# Verification record: herdr-zcode v0.1.0

Date: 2026-10-21, Asia/Seoul. Target: the user's macOS installation.

The current app-server implementation is designated **v0.1.0** at the user's request.
The live acceptance results below were obtained under its development label 0.2.0.
This designation changes package metadata and guide version labels, not the tested
runtime implementation. Historical observations retain their original version labels.

After the legacy cleanup on 2026-10-21, the current offline suite is **104/104 passing**.
The earlier 120-test results below include 16 now-removed hook-only tests; they are
historical evidence, not the current suite size. See the final cleanup section.

## Runtime and scope

| Component | Observed version / identity |
| --- | --- |
| Node.js | v26.7.0 |
| npm | 11.19.0 |
| Herdr | 0.9.5 |
| ZCode CLI runtime | 0.16.9, bundled in ZCode.app |
| Provider | account:zai-individual-coding-plan |
| Model | GLM-5.3, selected from the actual account catalog |
| Wrapper | 0.2.0 during live acceptance; the same app-server implementation is now designated v0.1.0 |

The wrapper does not invoke a second model API implementation. It uses the installed
app-server, native tools, permissions and subagents. Desktop account credentials were
read on demand and supplied only to matching reverse requests. No credentials, raw
authorization RPCs, response cookies, or complete provider error objects are retained
in this record.

## Offline implementation-acceptance tests (before legacy cleanup)

The implementation-acceptance `TEST_TMP_ROOT=/Volumes/RootKernel/tmp npm test` passed **120/120**, with
zero failures, skipped tests, or cancellations. This includes the new app-server
entrypoint, owned-process-group cleanup, bootstrap permission reconciliation and
stream-aware credential redaction; it is not the old claim based only on 16 legacy
bridge tests.

Coverage includes early stdin/EOF, two-turn output, reverse RPC correlation, approvals
and simultaneous requests, real question response shapes, stale/foreign/child events,
background work, cancellation, signal handling, TTY restoration, bracketed multiline
paste, exact model selection, account identity drift, coalesced asynchronous reports,
backoff, independent executors, same-pane reporter restart, and npm executable symlinks.

An initial all-suites run exposed two fixture startup timeouts under parallel process
load: the normal fake-server RPC deadline was 300ms. Normal fixture startup now has a
3-second bound; the deliberately hung-RPC scenario retains its 300ms limit. Production
RPC timeouts were not increased to hide a runtime failure. The subsequent 101-test
run passed.

The complete final gate and installed-entrypoint live results are recorded below.

## Live app-server and terminal tests

All rows below used the real installed ZCode runtime and GLM-5.3. A completed model turn
and its generated result were checked; request acceptance alone was not a pass.

| Scenario | Evidence | Result |
| --- | --- | --- |
| Account protocol | Two real turns; second returned a code from the first; assistant-only message parts verified | Passed, 23.8s |
| Korean piped terminal input | Installed executable returned 323 then contextual 331, drained EOF and exited successfully | Passed |
| Independent Herdr executors | Two different app-server sessions simultaneously worked; returned 323 and 104; first continued with 331; independent releases | Passed, 21.5s |
| Permission allow/deny | Build-mode Write to the test-owned allowed.txt was explicitly approved and verified; denied.txt was rejected and absent | Passed, 29.4s |
| Native subagent | Native Agent launched Explore; child Read obtained an unpredictable test-file marker; parent returned it | Passed, 36.6s |
| Native question | AskUserQuestion blocked the executor; selecting advertised Blue resumed the model and produced Blue | Passed, 22.8s |
| Physical Ctrl-C | Herdr sent Ctrl-C during actual streamed generation; native turn cancelled; same session then answered 63 | Passed, 23.7s |
| Multiline prompt | One bracketed paste through Herdr pane input delivered three lines as one turn and produced 323 | Passed, 12.5s |
| Persisted resume | Wrapper/app-server exited, restarted with the same session, and used prior answer 667 to generate 671 | Passed, 24.4s |
| Coding workflow | Native Edit corrected a real source file; native Bash ran its test; exact source and an independent node --test run verified the result | Passed, 37.3s |

These are final reruns. Every Herdr/model scenario used the installed entrypoint
`/Users/draccoon/.local/bin/herdr-zcode`, not an uninstalled source prototype. Times
are elapsed test observations on this machine, not product performance guarantees.

The coding workflow approved only the exact test-owned Edit/Write change and the
literal command `node --test sample.test.mjs`. Permission testing did not grant broad
project permissions or authorize commands in user repositories.

The initial permission scenario used native guarded mode and did not produce an
approval for ordinary Write. That is ZCode's actual guarded-mode behavior, not a
wrapper approval bypass. The scenario was corrected to build mode, and both real
approval and real rejection were then verified. Documentation reflects this distinction.

## Real Herdr without model usage

`tests/live-herdr-reporter.mjs --authorize-herdr` ran four independent reporter
processes in real Herdr panes. It verified idle, working and blocked states,
independent release, restart in the same pane, and final release for every reporter.
This validates real Herdr reporting, but is explicitly not model-generation evidence.

## Confirmed Herdr compatibility boundary

Herdr 0.9.5 accepts custom agent reports, displays the ZCode executor and its state,
but rejects `agent prompt` with `agent_not_ready: not an active named agent`.
Renaming the custom agent did not change that result. This was tested in disposable
sessions rather than assumed from general agent documentation.

The supported control surface is `pane send-text` plus `pane send-keys`, with explicit
bracketed paste for multiline input, and `pane read` for output. This path was verified
against the real model. The wrapper does not masquerade as Codex/Claude or patch Herdr.

## Independent review

A separate Codex review identified startup snapshot reconciliation and mismatched
background-job keys. Both were fixed with regression tests. A follow-up review found
that leader-process exit did not prove that a stubborn descendant in the owned process
group had exited. The final cleanup patch distinguishes those facts and tests the
leader-exits/descendant-ignores-SIGTERM case before reporter release.

The earlier reviewer could not run legacy Unix-socket bridge tests in its sandbox
(EPERM). The main DevSpace test environment ran the complete suite; sandbox failures
are not recorded as passing tests.

The final independent audit found two additional defects, both reproduced offline:

- A credential split across two text deltas bypassed per-write redaction. Output now
  retains only potential secret-prefix suffixes and redacts across chunk boundaries;
  refreshed credentials share the same live set. Fixture credentials, never real
  secrets, were used in the regressions.
- A permission present only in the bootstrap snapshot could remain blocked after a
  newer subscription snapshot omitted it. Snapshot-only registrations are now
  reconciled while live event/reverse-request ownership is preserved.

The final follow-up review reported no actionable regressions. Its 77 focused tests
and a combined production-entrypoint reproduction passed. The main environment then
passed all 120 tests. No reviewer called a model API or read real credentials.

## Isolation and cleanup

Herdr live tests created only uniquely named `hz-test-*` servers and their own
workspaces under `/Volumes/RootKernel/tmp`. They did not inspect the user's focused
session, restart existing sessions, or replace existing panes. Each test driver
stopped/deleted its own server and removed its own scratch directories.

ZCode's own persisted test conversation records may remain in Desktop history; normal
session close does not mean deleting conversation history. No broad history purge was
performed. Existing user hooks, aliases, Desktop settings and unrelated repositories
were not changed. No commit, push, public npm publication, or release tag was made.

## Installation and global guide

The package installation and installed-entrypoint checks are recorded in the final
gate below. The package includes the terminal client, five runtime modules and
its guides, with no external dependencies or test credentials.

The project source `HERDR.md` and `GLOBAL-SETUP.md` describe the app-server path,
now designated v0.1.0.
During the 2026-10-21 installation, DevSpace denied both reading
`/Users/draccoon/HERDR.md` and opening `/Users/draccoon` as outside allowed roots.
The global guide was not synchronized during that work. Its ZCode section was
subsequently updated on 2026-10-22 as recorded below, preserving the existing common
operating rules and Codex/Claude guide links.

## Implementation acceptance gate (development label 0.2.0)

Completed on 2026-10-21, Asia/Seoul, with installed live checks finishing after 21:57.

1. Full offline suite: **120 passed, 0 failed, 0 skipped**, including real local
   child-process cleanup regressions. It consumes no real model usage.
2. Installed with `npm install --global --prefix "$HOME/.local" --install-links .`.
   Both `herdr-zcode --version` (0.2.0) and `herdr-zcode --help` succeeded.
3. The installed package's entrypoint, five runtime modules and package.json were
   byte-for-byte equal to the tested source (7 production files checked).
4. The live account protocol passed two completed model turns. Real Herdr reporter
   checks passed four simultaneous reporters, independent state/release and same-pane restart.
5. All **8 installed Herdr/model scenarios passed**: basic, permissions, subagent,
   question, cancel, multiline, resume and coding. The coding test independently
   reran `node --test sample.test.mjs` and checked exact modified source content.
6. A final installed CLI pipeline with two Korean prompts returned `323` and `331`,
   produced two completion markers and exited successfully on EOF.
7. Global-guide source and installation instructions are ready. The actual
   `/Users/draccoon/HERDR.md` was not changed because DevSpace denied that path;
   this is a deployment-document limitation, not an unimplemented runtime feature.

No model-generation or Herdr-integration acceptance scenario listed here remains
unrun. Optional Desktop host features and automatic Herdr session restoration remain
outside this thin wrapper's documented scope.

## v0.1.0 version designation and revalidation

The user designated the current implementation v0.1.0 on 2026-10-21. Package metadata,
README and guide version labels were updated; production files under `bin/` and `lib/`
were unchanged. The executable-symlink test now checks the package manifest version
instead of hardcoding the former development label.

- `TEST_TMP_ROOT=/Volumes/RootKernel/tmp npm test`: **120 passed, 0 failed, 0 skipped**.
- The local package was reinstalled with the same documented npm installation command.
- Installed `herdr-zcode --version` returned `herdr-zcode 0.1.0`; `--help` also succeeded.
- All **12 packaged files** matched the source, and the installed command resolved to
  `bin/herdr-zcode-app.mjs` in the installed package.
- No live model calls or Herdr session mutations were needed for this metadata-only
  change. The historical live results above retain their original 0.2.0 label.
- At designation time, legacy hook-plugin manifests and the legacy passthrough
  launcher retained their development version and were excluded from the installed
  package. They were subsequently removed in the cleanup recorded below.
- The global guide was not changed. No Git commit, tag, push, or public release was made.

## Legacy cleanup and revalidation (v0.1.0)

Completed on 2026-10-21, Asia/Seoul. The app-server runtime and package version are
unchanged. Removed the obsolete hook implementation and its isolated test graph:

- `hooks/hooks.json`, `hooks/report.mjs`, and the empty `hooks/` directory.
- `lib/bridge.mjs` and the old `bin/herdr-zcode.mjs` passthrough launcher.
- `.zcode-plugin/plugin.json`, its empty directory, and `marketplace.json`.
- `tests/bridge.test.mjs` and its exclusive `fake-zcode.mjs` / `fake-herdr.mjs` fixtures.

Preserved all app-server tests, `lib/herdr-reporter.mjs`, its current tests and
fixtures, live-test drivers, and the inherited legacy-environment stripping defenses.
Updated `.gitignore`, README and guide/contract source without erasing the historical
120-test and live-model evidence above.

Validation after deletion: `TEST_TMP_ROOT=/Volumes/RootKernel/tmp npm test` passed
**104 tests, 0 failed, 0 skipped, 0 cancelled**. The reduction is exactly the 16
obsolete hook-only tests, not a removal of current runtime coverage. `git diff --check`
passed. No model calls or running Herdr sessions were needed for this cleanup.

The exact user-scope plugin `herdr-zcode@herdr-zcode-local` was uninstalled through
ZCode's plugin manager with `--keep-data`, retaining any previous plugin data.
The now-unused single-plugin marketplace `herdr-zcode-local` was unregistered.
A before/after digest confirmed all other 16 plugins' IDs, versions and enabled
states are unchanged; both other marketplace registrations remain.

The removed files were mostly staged additions. The cleanup worker initially could
not create `.git/index.lock`, leaving eight deleted additions as `AD` in Git status.
The deletions were subsequently staged; those entries are now absent from both the
index and the worktree. The ignored plugin manifest was never in the index.
Unrelated staged entries were preserved. No commit, tag or push was made, and the
global guide was not edited during that cleanup.

## Global-guide synchronization and probe cleanup (2026-10-22)

At the user's request, `/Users/draccoon/HERDR.md` was updated in the current
authorized environment. Its ZCode section now matches the repository guide's
`herdr-zcode v0.1.0: app-server executor` section exactly. The preceding common
operating rules were preserved byte-for-byte; existing Codex/Claude guide links
were not changed. `GLOBAL-SETUP.md` records the completed global update separately
from the earlier plugin cleanup and installation.

Removed the unreferenced development helper `bin/herdr-zcode-probe.mjs`, which
called the nonexistent `AppServerClient.stop()` method. It was excluded from the
installed package and had no callers. The supported app-server entrypoint, runtime
modules, package version and current tests are unchanged.

Follow-up validation: `TEST_TMP_ROOT=<task-owned scratch directory> npm test` passed
**104 tests, 0 failed, 0 skipped, 0 cancelled**. The global-section comparison and
unchanged common-prefix checks passed. The two updated documentation files and
probe removal were staged; all other index entries matched the pre-change manifest.
`git diff --cached --check` passed, with no unstaged changes remaining. No commit,
tag, push, live model calls, or Herdr session operations were performed.
