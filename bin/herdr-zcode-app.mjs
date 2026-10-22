#!/usr/bin/env node
import readline from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { AppServerClient, safeErrorSummary } from '../lib/app-server-client.mjs';
import { AppServerController } from '../lib/app-server-controller.mjs';
import { desktopAccount } from '../lib/desktop-account.mjs';
import { prepareDesktopRuntime } from '../lib/desktop-runtime.mjs';
import { createHerdrReporter } from '../lib/herdr-reporter.mjs';

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), mode: 'build' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--bridge-help'].includes(arg)) { options.help = true; continue; }
    if (arg === '--version') { options.version = true; continue; }
    if (!['--cwd', '--model', '--mode', '--resume', '--prompt-file', '--app-bundle'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid command arguments');
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
  return options;
}

// Explicit adapters let offline integration tests run the real entrypoint against
// a child fake server without reading credentials or starting Electron/Herdr.
export async function main({ argv = process.argv.slice(2), env = process.env,
  input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}, adapters = {}) {
  let redactor = { write: text => text, flush: () => '' };
  const write = text => { const safe = redactor.write(text); if (safe) output.write(safe); };
  const flushOutput = () => { const safe = redactor.flush(); if (safe) output.write(safe); };
  let options;
  try { options = parseArgs(argv); }
  catch (error) { errorOutput.write(error.message + '\n'); return 1; }
  if (options.version) {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    write(`herdr-zcode ${metadata.version}\n`);
    return 0;
  }
  if (options.help) {
    write('herdr-zcode [--cwd <path>] [--model <provider/model[$level]>] [--mode <mode>] [--resume <session>]\n[--prompt-file <path>] [--app-bundle <path>] [--version] [--bridge-help]\nModes use native ZCode semantics: plan, build (default), edit, guarded, yolo, auto. Only explicit --mode changes the default.\nA $level suffix on --model, such as GLM-5.3$high, overrides the model\'s advertised default reasoning level.\nPrompt text or /help. EOF drains queued work; /exit cancels. Ctrl-C stops active work; idle Ctrl-C quits.\n');
    return 0;
  }
  const early = [];
  const exitStartup = Symbol('exit startup');
  let controller, eof = false, signalCode = 0, runtime, client, reporter, failed = false;
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
    admit('/exit');
  };
  const interrupt = () => {
    discardPaste();
    if (!eof && rl.terminal) {
      rl.write(null, { ctrl: true, name: 'a' });
      rl.write(null, { ctrl: true, name: 'k' });
      write('\n');
    }
    if (controller && !controller.closing && (controller.current || controller.sending || controller.stopping || controller.interactions.size || controller.background.size)) void controller.stop();
    else quit(130);
  };
  const terminate = () => quit(143);
  const hangup = () => quit(129);
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  try {
    if (rl.terminal) { bracketedEnabled = true; write('\x1b[?2004h'); }
    let prompt;
    if (options['prompt-file']) prompt = await readFile(resolve(options.cwd, options['prompt-file']), 'utf8');
    reporter = (adapters.createHerdrReporter ?? createHerdrReporter)({ env });
    runtime = await (adapters.prepareDesktopRuntime ?? prepareDesktopRuntime)({ env, appBundle: options['app-bundle'] });
    // Do not give the app-server any Herdr route or legacy hook credentials.
    const childEnv = { ...runtime.env, ELECTRON_RUN_AS_NODE: '1' };
    for (const key of Object.keys(childEnv)) if (key.startsWith('HERDR_')) delete childEnv[key];
    client = new AppServerClient({ executable: runtime.executable, args: runtime.args,
      env: childEnv, cwd: options.cwd, launch: adapters.launch,
      requestTimeout: adapters.rpcTimeout });
    controller = new AppServerController({ client, reporter, output: write, rpcTimeout: adapters.rpcTimeout });
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
    const account = await (adapters.desktopAccount ?? desktopAccount)(runtime.configPath, { env, home: runtime.home, model: options.model });
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
    if (error !== exitStartup) {
      failed = true;
      errorOutput.write('ZCode startup or transport failed. Check installation, account, selected model and catalog compatibility.\n');
      const diagnostic = error.safeSummary || safeErrorSummary(error);
      if (diagnostic) errorOutput.write(diagnostic + '\n');
    }
  } finally {
    try { rl.close(); } catch { failed = true; }
    releaseInput();
    await controller?.shutdown();
    let exited = !client?.child;
    try { await client?.terminate(adapters.exitTimeout); exited = true; }
    catch { failed = true; errorOutput.write('App-server exit not observed; reporter ownership retained.\n'); }
    if (exited) {
      try { await reporter?.close(); }
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
