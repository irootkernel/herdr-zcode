#!/usr/bin/env node
import readline from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { AppServerClient, safeErrorSummary } from '../lib/app-server-client.mjs';
import { AppServerController } from '../lib/app-server-controller.mjs';
import { desktopAccount } from '../lib/desktop-account.mjs';
import { appServerEnvironment, prepareDesktopRuntime } from '../lib/desktop-runtime.mjs';
import { classifyFailure } from '../lib/error-classification.mjs';
import { createRuntimeProfile, RUNTIMES } from '../lib/runtime-profile.mjs';
import { assertNode, readToolchains } from '../lib/toolchain.mjs';

try { assertNode({ allowEmbeddedElectron: true }); }
catch (error) { console.error('herdr-zcode: ' + error.message); process.exit(1); }

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), mode: 'build', runtime: 'tui' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--bridge-help'].includes(arg)) { options.help = true; continue; }
    if (arg === '--version') { options.version = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--no-copy-catalog') { options.copyCatalog = false; continue; }
    if (arg === '--skip-desktop-inspect') { options.skipDesktopInspect = true; continue; }
    if (arg === '--non-interactive') { options.nonInteractive = true; continue; }
    if (arg === '--runtime') {
      const runtime = argv[++i];
      if (!RUNTIMES.includes(runtime)) throw new Error('Use runtime tui or core');
      options.runtime = runtime;
      continue;
    }
    if (!['--cwd', '--model', '--mode', '--resume', '--prompt-file', '--app-bundle', '--runtime-dir'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid command arguments');
    options[arg.slice(2)] = argv[++i];
  }
  // ZCode's own model-reference convention: a `$level` suffix after the first
  // `/` selects the reasoning level; a `$` at the id start or end stays literal.
  if (typeof options.model === 'string') {
    const idStart = options.model.indexOf('/') + 1;
    const marker = options.model.indexOf('$', idStart);
    if (marker > idStart && marker < options.model.length - 1) {
      options.reasoning = options.model.slice(marker + 1);
      options.model = options.model.slice(0, marker);
    }
  }
  options.cwd = resolve(options.cwd);
  if (!['plan', 'build', 'edit', 'guarded', 'yolo', 'auto'].includes(options.mode)) throw new Error('Use mode plan, build, edit, guarded, yolo, or auto');
  if (options.json && !options.version) throw new Error('--json requires --version');
  return options;
}

// Explicit adapters let offline integration tests run the real entrypoint against
// a child fake server without reading credentials or starting Electron/Herdr.
export async function main({ argv = process.argv.slice(2), env = process.env,
  input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}, adapters = {}) {
  let redactor = { write: text => text, flush: () => '' };
  const write = text => { const safe = redactor.write(text); if (safe) output.write(safe); };
  const flushOutput = options => { const safe = redactor.flush(options); if (safe) output.write(safe); };
  let options;
  try { options = parseArgs(argv); }
  catch (error) { errorOutput.write(error.message + '\n'); return 1; }
  if (options.version) {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    if (options.json) {
      write(JSON.stringify({ name: metadata.name, version: metadata.version, runtimes: RUNTIMES, osc7501: true,
        minZcodeAppVersion: readToolchains().ZCODE_APP_MIN_VERSION }) + '\n');
    } else write(`herdr-zcode ${metadata.version}\n`);
    return 0;
  }
  if (options.help) {
    write('herdr-zcode [--cwd <path>] [--model <provider/model[$level]>] [--mode <mode>] [--resume <session>]\n[--runtime <tui|core>] [--non-interactive] [--prompt-file <path>] [--app-bundle <path>]\n[--runtime-dir <path>] [--no-copy-catalog] [--skip-desktop-inspect] [--version [--json]] [--bridge-help]\nThe default runtime is tui. With --non-interactive, core reports startup failures through OSC 7501.\nModes use native ZCode semantics: plan, build (default), edit, guarded, yolo, auto. Only explicit --mode changes the default.\nA $level suffix on --model, such as GLM-5.3$high, overrides the model\'s advertised default reasoning level.\nPrompt text or /help. EOF drains queued work; /exit cancels. Ctrl-C stops active work; idle Ctrl-C quits.\n');
    return 0;
  }
  const early = [];
  const exitStartup = Symbol('exit startup');
  let controller, eof = false, signalCode = 0, runtime, client, reporter, failed = false;
  let signalTermination, finishStartupBlock;
  const profile = createRuntimeProfile(options.runtime, { env, output, adapters,
    flushOutput: () => flushOutput({ keepPrefix: Boolean(controller?.current && !controller.closing) }),
  });
  const initialRawMode = input.isRaw;
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let pasting = false, pasteDraft = false, pasteLines = [], pasteSubmit = false, bracketedEnabled = false;
  const discardPaste = () => { pasting = false; pasteDraft = false; pasteLines = []; pasteSubmit = false; };
  const admit = (content, prompt = false) => {
    if (controller) prompt ? controller.prompt(content) : controller.input(content);
    else early.push({ content, prompt });
  };
  const pasteKey = (text, key) => {
    pasteSubmit = !pasting && ['enter', 'return'].includes(key?.name);
    if (key?.name === 'paste-start') { pasting = true; pasteDraft = true; }
    else if (key?.name === 'paste-end') pasting = false;
  };
  // Readline emits each pasted newline as a line event. Observe the boundary
  // before its own keypress listener so no partial pasted line is admitted.
  if (rl.terminal) input.prependListener('keypress', pasteKey);
  const releaseInput = () => {
    discardPaste();
    try {
      if (bracketedEnabled) { bracketedEnabled = false; write('\x1b[?2004l'); }
      input.pause?.();
      if (typeof initialRawMode === 'boolean' && input.setRawMode && input.isRaw !== initialRawMode) input.setRawMode(initialRawMode);
    } catch { failed = true; } // A hung-up tty must not prevent child cleanup.
  };
  rl.on('line', line => {
    if (pasting) { pasteLines.push(line); return; }
    if (pasteDraft) {
      // Readline also emits a final line on EOF. That is not confirmation of a
      // pasted draft; only an Enter key outside the bracketed region submits it.
      if (!pasteSubmit) { discardPaste(); return; }
      const content = [...pasteLines, line].join('\n');
      // Multiline tasks are literal prompts. A single-line pasted command keeps
      // ordinary command semantics, including approvals and /stop while busy.
      discardPaste(); admit(content, content.includes('\n'));
    } else admit(line);
  });
  rl.on('close', () => { eof = true; releaseInput(); controller?.eof(); });
  const quit = code => {
    signalCode ||= code;
    if (finishStartupBlock) { finishStartupBlock(); return; }
    admit('/exit');
  };
  const interrupt = () => {
    discardPaste();
    if (finishStartupBlock) { quit(130); return; }
    if (!eof && rl.terminal) {
      rl.write(null, { ctrl: true, name: 'a' });
      rl.write(null, { ctrl: true, name: 'k' });
      write('\n');
    }
    if (controller && !controller.closing && (controller.current || controller.sending || controller.stopping || controller.interactions.size || controller.background.size)) void controller.stop();
    else quit(130);
  };
  const terminateFromSignal = code => {
    if (!profile.fastTeardown) { quit(code); return; }
    signalCode ||= code;
    controller?.closeInput();
    finishStartupBlock?.();
    if (!signalTermination && client?.child) {
      // Start teardown even during an in-flight bootstrap or shutdown RPC.
      signalTermination = client.terminateFast(adapters.fastExitGraceMs).then(() => true, () => false);
      client.fail(new Error('App-server shutdown interrupted by signal'));
    }
  };
  const terminate = () => terminateFromSignal(143);
  const hangup = () => terminateFromSignal(129);
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  try {
    if (profile.name === 'core') reporter = profile.createReporter();
    if (rl.terminal) { bracketedEnabled = true; write('\x1b[?2004h'); }
    let prompt;
    if (options['prompt-file']) prompt = await readFile(resolve(options.cwd, options['prompt-file']), 'utf8');
    if (profile.name === 'tui') reporter = profile.createReporter();
    runtime = await (adapters.prepareDesktopRuntime ?? prepareDesktopRuntime)({ env, appBundle: options['app-bundle'],
      tmpRoot: options['runtime-dir'], copyCatalog: options.copyCatalog, skipInspect: options.skipDesktopInspect });
    if (profile.fastTeardown && signalCode) throw exitStartup;
    // Remove terminal routing and hook credentials even from custom adapters.
    const childEnv = appServerEnvironment(runtime.env);
    client = new AppServerClient({ executable: runtime.executable, args: runtime.args,
      env: childEnv, cwd: options.cwd, launch: adapters.launch,
      requestTimeout: adapters.rpcTimeout, detached: profile.detached });
    controller = new AppServerController({ client, reporter, reportBeforeReady: profile.reportBeforeReady,
      output: write, rpcTimeout: adapters.rpcTimeout });
    // Observe transitions after the controller handles the event. Unrelated child
    // or stale terminal events must not flush a prefix from the active turn.
    let outputTurn;
    client.on('message', () => {
      if (outputTurn && outputTurn !== controller.current) flushOutput();
      outputTurn = controller.current;
    });
    if (prompt) controller.prompt(prompt);
    for (const { content, prompt } of early) admit(content, prompt);
    if (eof) controller.eof();
    if (controller.closing) throw exitStartup;
    const account = await (adapters.desktopAccount ?? desktopAccount)(runtime.configPath, {
      env, home: runtime.home, model: options.model, withOSCredentialReader: runtime.withOSCredentialReader,
    });
    controller.expectedModel = account.selection;
    redactor = account.createStreamRedactor?.() ?? {
      write: text => account.redact ? account.redact(text) : text, flush: () => '',
    };
    if (controller.closing) throw exitStartup;
    client.handle('interaction/requestProviderRuntimeHeaders', params => account.runtimeHeaders(params));
    client.handle('session/requestRuntimePreferences', () => ({ nativeSearchEnhancementsEnabled: false,
      subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }));
    client.start();
    const rpc = (method, params) => client.request(method, params, adapters.rpcTimeout);
    await rpc('provider/updateAccountConfig', account.config);
    if (controller.closing) throw exitStartup;
    const workspace = { workspaceKey: options.cwd, workspacePath: options.cwd };
    const created = await rpc(options.resume ? 'session/resume' : 'session/create', options.resume
      ? { sessionId: options.resume, workspace } : { workspace, mode: options.mode });
    const sessionId = created?.session?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || (options.resume && sessionId !== options.resume)) throw new Error('Invalid session');
    // Store identity before subsequent fallible startup RPCs so cleanup can close it.
    controller.sessionId = sessionId;
    controller.snapshot(created);
    if (controller.closing) throw exitStartup;
    const chosen = created.settings?.model?.available?.find(item => item.ref?.providerId === account.selection.providerId && item.ref?.modelId === account.selection.modelId);
    if (!chosen || chosen.availability === 'unavailable') throw new Error('Selected model unavailable');
    const model = { ...account.selection };
    const reasoningLevel = options.reasoning || chosen.reasoning?.defaultLevel;
    if (reasoningLevel) model.options = { reasoningLevel };
    const configured = await rpc('session/setModel', { sessionId, model, persistAsWorkspaceLastUsed: false });
    const observed = configured?.settings?.model?.current;
    if (observed?.providerId !== model.providerId || observed?.modelId !== model.modelId) throw new Error('Selected model was not applied');
    if (options.resume) await rpc('session/setMode', { sessionId, mode: options.mode });
    const subscribed = await rpc('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true });
    const subscribedModel = subscribed?.snapshot?.settings?.model?.current;
    if (subscribedModel?.providerId !== model.providerId || subscribedModel?.modelId !== model.modelId) throw new Error('Selected model changed before subscription');
    write(`Selected: ${account.selection.providerId}/${account.selection.modelId}${reasoningLevel ? ` (reasoning: ${reasoningLevel})` : ''}\n`);
    controller.attach(sessionId, subscribed?.snapshot ?? created,
      subscribed?.snapshot?.runtime?.eventSeq ?? subscribed?.eventSeq ?? 0);
    write('Type /help for commands.\n');
    await controller.done;
  } catch (error) {
    if (error !== exitStartup && !(profile.fastTeardown && signalCode)) {
      failed = true;
      errorOutput.write('ZCode startup or transport failed. Check installation, account, selected model and catalog compatibility.\n');
      const diagnostic = error.safeSummary || safeErrorSummary(error);
      if (diagnostic) errorOutput.write(diagnostic + '\n');
      if (profile.fastTeardown && options.nonInteractive && !controller?.ready) {
        const failure = error.blockedKind === 'auth' ? { state: 'blocked', kind: 'auth' }
          : error.failure ?? classifyFailure(error);
        reporter?.report(failure);
        if (failure.state === 'blocked' && ['auth', 'quota', 'rate_limit'].includes(failure.kind)) {
          // Leave the terminal observable to its supervisor, with a finite cap.
          let timer;
          try {
            await new Promise(resolve => {
              finishStartupBlock = resolve;
              timer = setTimeout(resolve, 5000);
            });
          } finally {
            clearTimeout(timer);
            finishStartupBlock = undefined;
          }
        }
      }
    }
  } finally {
    try { rl.close(); } catch { failed = true; }
    releaseInput();
    if (!signalTermination) {
      const shutdownTimeout = profile.fastTeardown ? Math.min(adapters.rpcTimeout ?? 15000, 1500) : undefined;
      await controller?.shutdown(shutdownTimeout);
    }
    let exited = !client?.child;
    try {
      if (signalTermination) {
        if (!await signalTermination) throw new Error('App-server exit unobserved');
      } else await client?.terminate(adapters.exitTimeout);
      exited = true;
    }
    catch { failed = true; errorOutput.write('App-server exit not observed; reporter ownership retained.\n'); }
    if (exited) {
      try { await reporter?.close?.(); }
      catch { failed = true; errorOutput.write('Herdr reporter release failed.\n'); }
      try { await runtime?.close?.(); }
      catch { failed = true; errorOutput.write('Runtime cleanup failed.\n'); }
    }
    releaseInput();
    flushOutput();
    input.removeListener('keypress', pasteKey);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGHUP', hangup);
  }
  return signalCode || (failed || controller?.failed ? 1 : 0);
}

// npm exposes bin commands through symlinks; compare the resolved executable,
// while importing main from a test/adapter must not start the production client.
let invokedURL;
if (process.argv[1]) {
  try { invokedURL = pathToFileURL(await realpath(resolve(process.argv[1]))).href; } catch { /* Imported/non-file caller. */ }
}
if (import.meta.url === invokedURL) process.exitCode = await main();
