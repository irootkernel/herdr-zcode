#!/usr/bin/env node
import readline from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { AppServerClient, safeErrorSummary } from '../lib/app-server-client.mjs';
import { AppServerController } from '../lib/app-server-controller.mjs';
import { desktopAccount, projectedAccount } from '../lib/desktop-account.mjs';
import { appServerEnvironment, prepareDesktopRuntime } from '../lib/desktop-runtime.mjs';
import { classifyFailure } from '../lib/error-classification.mjs';
import { createRuntimeProfile, RUNTIMES } from '../lib/runtime-profile.mjs';
import { assertNode, readToolchains } from '../lib/toolchain.mjs';

try { assertNode({ allowEmbeddedElectron: true }); }
catch (error) { console.error('herdr-zcode: ' + error.message); process.exit(1); }

const CREATE_SWITCHES = {
  '--disable-mcp': ['mcpServers', []],
  '--disable-title-gen': ['titleGenerationEnabled', false],
  '--disable-offpeak': ['offPeakToolEnabled', false],
  '--disable-dynamic-workflow': ['dynamicWorkflowEnabled', false],
};
const TOOL_FLAGS = { '--tool-allowlist': 'toolAllowlist', '--tool-denylist': 'toolDenylist' };
const VALUE_FLAGS = new Set(['--cwd', '--model', '--mode', '--resume', '--prompt-file', '--app-bundle', '--runtime-dir',
  '--auth-file', '--interaction-policy', '--additional-dir', '--persistence', '--reasoning-effort', '--thought-level', ...Object.keys(TOOL_FLAGS)]);
function requestedReasoning(current, next) {
  const level = next.trim();
  if (!level) throw new Error('Reasoning effort must be non-empty');
  if (current && current !== level) throw new Error('Conflicting reasoning effort values');
  return level;
}

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), mode: 'build', runtime: 'tui', sessionScope: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--bridge-help'].includes(arg)) { options.help = true; continue; }
    if (arg === '--version') { options.version = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--no-copy-catalog') { options.copyCatalog = false; continue; }
    if (arg === '--skip-desktop-inspect') { options.skipDesktopInspect = true; continue; }
    if (arg === '--consume-auth-file') { options.consumeAuthFile = true; continue; }
    if (arg === '--non-interactive') { options.nonInteractive = true; continue; }
    if (arg === '--preserve-default-model') { options.preserveDefaultModel = true; continue; }
    if (arg === '--auto-resolve-questions') { options.autoResolveQuestions = true; continue; }
    if (Object.hasOwn(CREATE_SWITCHES, arg)) {
      const [field, value] = CREATE_SWITCHES[arg];
      options.sessionScope[field] = Array.isArray(value) ? [] : value;
      continue;
    }
    if (arg === '--runtime') {
      const runtime = argv[++i];
      if (!RUNTIMES.includes(runtime)) throw new Error('Use runtime tui or core');
      options.runtime = runtime;
      continue;
    }
    const value = argv[i + 1];
    if (!VALUE_FLAGS.has(arg) || value === undefined || value.startsWith('--') || (value === '' && !Object.hasOwn(TOOL_FLAGS, arg))) {
      throw new Error('Invalid command arguments');
    }
    i++;
    if (Object.hasOwn(TOOL_FLAGS, arg)) {
      const tools = value === '' ? [] : value.split(',').map(name => name.trim());
      if (tools.includes('')) throw new Error(`${arg} contains an empty tool name`);
      options.sessionScope[TOOL_FLAGS[arg]] = tools;
    } else if (arg === '--additional-dir') {
      const directories = options.sessionScope.additionalDirectories ??= [];
      if (value.includes('\0')) throw new Error('--additional-dir contains a NUL character');
      if (directories.length === 256) throw new Error('Use at most 256 --additional-dir arguments');
      directories.push(value);
    } else if (arg === '--persistence') {
      if (!['immediate', 'deferred'].includes(value)) throw new Error('Use persistence immediate or deferred');
      options.sessionScope.persistence = value;
    } else if (arg === '--reasoning-effort' || arg === '--thought-level') {
      options.reasoning = requestedReasoning(options.reasoning, value);
    } else options[arg.slice(2)] = value;
  }
  // ZCode's own model-reference convention: a `$level` suffix after the first
  // `/` selects the reasoning level; a `$` at the id start or end stays literal.
  if (typeof options.model === 'string') {
    const idStart = options.model.indexOf('/') + 1;
    const marker = options.model.indexOf('$', idStart);
    if (marker > idStart && marker < options.model.length - 1) {
      options.reasoning = requestedReasoning(options.reasoning, options.model.slice(marker + 1));
      options.model = options.model.slice(0, marker);
    }
  }
  options.cwd = resolve(options.cwd);
  if (options.sessionScope.additionalDirectories) {
    options.sessionScope.additionalDirectories = options.sessionScope.additionalDirectories.map(path => resolve(options.cwd, path));
  }
  if (options.resume && Object.keys(options.sessionScope).length) throw new Error('Session creation flags cannot be used with --resume');
  options.interactionPolicy = options['interaction-policy'] ?? (options.nonInteractive ? 'block' : 'interactive');
  if (!['interactive', 'deny', 'block'].includes(options.interactionPolicy)) throw new Error('Use interaction policy interactive, deny, or block');
  if (options.nonInteractive && options.interactionPolicy === 'interactive') throw new Error('--non-interactive requires an interaction policy of deny or block');
  if (!['plan', 'build', 'edit', 'guarded', 'yolo', 'auto'].includes(options.mode)) throw new Error('Use mode plan, build, edit, guarded, yolo, or auto');
  if (options.json && !options.version) throw new Error('--json requires --version');
  if (options.consumeAuthFile && !options['auth-file']) throw new Error('--consume-auth-file requires --auth-file');
  return options;
}

function sameModel(actual, expected) {
  return actual?.providerId === expected.providerId && actual?.modelId === expected.modelId;
}

function checkReasoning(result, effort, modelRequired = false) {
  const modelLevel = result?.settings?.model?.current?.options?.reasoningLevel;
  const observed = modelRequired ? [modelLevel]
    : [modelLevel, result?.settings?.thoughtLevel?.current, result?.thoughtLevel].filter(level => level !== undefined);
  if (observed.some(level => level !== effort)) {
    const message = 'Selected reasoning level was not applied';
    throw Object.assign(new Error(message), { safeSummary: message });
  }
  return observed.length > 0;
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
    write(`herdr-zcode [--cwd <path>] [--model <provider/model[$level]>] [--mode <mode>] [--resume <session>]
[--runtime <tui|core>] [--non-interactive] [--interaction-policy <interactive|deny|block>] [--auto-resolve-questions]
[--reasoning-effort <level> | --thought-level <level>] [--preserve-default-model]
[--tool-allowlist <csv>] [--tool-denylist <csv>] [--disable-mcp] [--disable-title-gen]
[--disable-offpeak] [--disable-dynamic-workflow] [--additional-dir <path>] [--persistence <immediate|deferred>]
[--prompt-file <path>] [--app-bundle <path>] [--auth-file <path> [--consume-auth-file]]
[--runtime-dir <path>] [--no-copy-catalog] [--skip-desktop-inspect] [--version [--json]] [--bridge-help]
The default runtime is tui. Noninteractive input treats slash lines as prompts and blocks on unexpected interaction by default.
Modes use native ZCode semantics: plan, build (default), edit, guarded, yolo, auto. Only explicit --mode changes the default.
A $level suffix on --model, such as GLM-5.3$high, overrides the model's advertised default reasoning level.
Interactive input accepts /help and /exit. EOF drains queued work. Ctrl-C stops active work; idle Ctrl-C quits.
`);
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
  const rl = readline.createInterface({ input, output, terminal: Boolean(!options.nonInteractive && input.isTTY && output.isTTY) });
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
    controller?.closeInput();
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
    if (signalCode) throw exitStartup;
    if (profile.name === 'tui') reporter = profile.createReporter();
    const authFile = options['auth-file'];
    runtime = await (adapters.prepareDesktopRuntime ?? prepareDesktopRuntime)({ env, appBundle: options['app-bundle'],
      tmpRoot: options['runtime-dir'], copyCatalog: options.copyCatalog, skipInspect: options.skipDesktopInspect, useKeychain: !authFile });
    if (signalCode) throw exitStartup;
    // Remove terminal routing and hook credentials even from custom adapters.
    const childEnv = appServerEnvironment(runtime.env);
    client = new AppServerClient({ executable: runtime.executable, args: runtime.args,
      env: childEnv, cwd: options.cwd, launch: adapters.launch,
      requestTimeout: adapters.rpcTimeout, detached: profile.detached });
    controller = new AppServerController({ client, reporter, reportBeforeReady: profile.reportBeforeReady,
      output: write, rpcTimeout: adapters.rpcTimeout, slashCommands: !options.nonInteractive, interactionPolicy: options.interactionPolicy });
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
    const preserve = options.model === undefined && (options.nonInteractive || options.preserveDefaultModel);
    const accountModel = preserve ? null : options.model;
    const account = authFile
      ? await (adapters.projectedAccount ?? projectedAccount)(runtime.configPath, resolve(options.cwd, authFile), {
        model: accountModel, consume: options.consumeAuthFile,
      })
      : await (adapters.desktopAccount ?? desktopAccount)(runtime.configPath, {
        env, home: runtime.home, model: accountModel, withOSCredentialReader: runtime.withOSCredentialReader,
      });
    redactor = account.createStreamRedactor?.() ?? {
      write: text => account.redact ? account.redact(text) : text, flush: () => '',
    };
    if (controller.closing) throw exitStartup;
    client.handle('interaction/requestProviderRuntimeHeaders', params => account.runtimeHeaders(params));
    client.handle('session/requestRuntimePreferences', () => ({ nativeSearchEnhancementsEnabled: false,
      subagentRuntimeConfigEnabled: false, memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: Boolean(options.nonInteractive || options.autoResolveQuestions) }));
    client.start();
    const rpc = (method, params) => client.request(method, params, adapters.rpcTimeout);
    await rpc('provider/updateAccountConfig', account.config);
    if (controller.closing) throw exitStartup;
    const workspace = { workspaceKey: options.cwd, workspacePath: options.cwd };
    const createParams = { workspace, mode: options.mode, ...options.sessionScope };
    if (options.model === undefined && options.reasoning) createParams.thoughtLevel = options.reasoning;
    const created = await rpc(options.resume ? 'session/resume' : 'session/create', options.resume
      ? { sessionId: options.resume, workspace } : createParams);
    const sessionId = created?.session?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || (options.resume && sessionId !== options.resume)) throw new Error('Invalid session');
    // Store identity before subsequent fallible startup RPCs so cleanup can close it.
    controller.sessionId = sessionId;
    controller.snapshot(created);
    if (controller.closing) throw exitStartup;
    const selection = preserve ? null : account.selection;
    const current = created.settings?.model?.current ?? null;
    controller.expectedModel = selection ?? current;
    let reasoningLevel = options.reasoning;
    let reasoningVerified = false;
    if (selection) {
      const chosen = created.settings?.model?.available?.find(item => sameModel(item.ref, selection));
      if (!chosen || chosen.availability === 'unavailable') throw new Error('Selected model unavailable');
      reasoningLevel ??= chosen.reasoning?.defaultLevel;
      const model = reasoningLevel ? { ...selection, options: { reasoningLevel } } : selection;
      const configured = await rpc('session/setModel', { sessionId, model, persistAsWorkspaceLastUsed: false });
      if (!sameModel(configured?.settings?.model?.current, model)) throw new Error('Selected model was not applied');
      if (options.reasoning) checkReasoning(configured, options.reasoning, true);
    } else if (options.reasoning) {
      const configured = await rpc('session/setThoughtLevel', { sessionId, thoughtLevel: options.reasoning });
      const observed = configured?.settings?.model?.current;
      if (current && observed && !sameModel(observed, current)) throw new Error('Selected model changed while applying reasoning');
      controller.expectedModel ??= observed;
      reasoningVerified = checkReasoning(configured, options.reasoning);
    }
    if (controller.closing) throw exitStartup;
    if (options.resume) await rpc('session/setMode', { sessionId, mode: options.mode });
    const subscribed = await rpc('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true });
    const subscribedModel = subscribed?.snapshot?.settings?.model?.current;
    if (controller.closing) throw exitStartup;
    if (controller.expectedModel && !sameModel(subscribedModel, controller.expectedModel)) throw new Error('Selected model changed before subscription');
    if (options.reasoning) {
      const subscribedEffort = checkReasoning(subscribed?.snapshot, options.reasoning, Boolean(selection));
      if (!selection && !reasoningVerified && !subscribedEffort) reasoningLevel = undefined;
    }
    controller.expectedModel ??= subscribedModel;
    if (controller.expectedModel) {
      const { providerId, modelId } = controller.expectedModel;
      controller.print(`Selected: ${providerId}/${modelId}${reasoningLevel ? ` (reasoning: ${reasoningLevel})` : ''}`);
    }
    controller.attach(sessionId, subscribed?.snapshot ?? created,
      subscribed?.snapshot?.runtime?.eventSeq ?? subscribed?.eventSeq ?? 0);
    if (!options.nonInteractive) write('Type /help for commands.\n');
    await controller.done;
  } catch (error) {
    if (error !== exitStartup && !controller?.interactionBlocked && !(profile.fastTeardown && signalCode)) {
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
      const shutdownTimeout = profile.fastTeardown || options.nonInteractive ? Math.min(adapters.rpcTimeout ?? 15000, 1500) : undefined;
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
