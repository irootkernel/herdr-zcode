#!/usr/bin/env node
// Explicit opt-in account/protocol smoke test. It does not approve tool calls.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { desktopAccount } from '../lib/desktop-account.mjs';
import { prepareDesktopRuntime } from '../lib/desktop-runtime.mjs';

if (!process.argv.includes('--authorize-live')) throw new Error('Pass --authorize-live to spend ZCode usage');
const started = performance.now();
const runtime = await prepareDesktopRuntime();
const account = await desktopAccount(runtime.configPath, { env: runtime.env, home: runtime.home });
const cwd = join(dirname(runtime.configPath), 'workspace');
await mkdir(cwd);
const child = spawn(runtime.executable, runtime.args, { env: runtime.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const closed = once(child, 'close');
let nextId = 0, buffer = '', sessionId, waitingTurn, stderrBytes = 0;
const pending = new Map(), methods = {}, types = {};
function write(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
function request(method, params, timeout = 30000) {
  const id = `smoke-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); write({ id, method, params });
  });
}
async function dispatch(message) {
  if (message.method && message.id !== undefined) {
    methods[message.method] = (methods[message.method] || 0) + 1;
    let result;
    if (message.method === 'session/requestRuntimePreferences') result = { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false };
    else if (message.method === 'interaction/requestProviderRuntimeHeaders') result = await account.runtimeHeaders(message.params);
    else if (message.method === 'interaction/requestPermission') result = { decision: 'deny', reason: 'This smoke test does not authorize tool use' };
    else { write({ id: message.id, error: { code: -32601, message: 'Not supported by account smoke test' } }); return; }
    write({ id: message.id, result }); return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(account.redact(message.error.message || 'Protocol request failed')));
    else entry.resolve(message.result);
    return;
  }
  if (message.method !== 'session/event') return;
  const event = message.params?.event || message.params;
  types[event.type] = (types[event.type] || 0) + 1;
  if (event.sessionId && event.sessionId !== sessionId) return;
  if (event.type === 'turn.failed') {
    const error = event.payload?.error;
    waitingTurn?.reject(new Error(account.redact(`${error?.code || 'turn.failed'}: ${error?.message || 'Turn failed'}`)));
  } else if (event.type === 'turn.completed') waitingTurn?.resolve(event);
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (line) { try { void dispatch(JSON.parse(line)).catch(error => waitingTurn?.reject(error)); } catch { waitingTurn?.reject(new Error('Invalid NDJSON')); } }
  }
});
child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
child.stdin.on('error', () => {});
child.on('close', () => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('App-server closed')); }
  pending.clear(); waitingTurn?.reject(new Error('App-server closed during turn'));
});
async function turn(content) {
  let timer;
  const completion = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Live smoke turn exceeded 180 seconds')), 180000);
    waitingTurn = { resolve, reject };
  });
  // Register rejection consumption before sending: a fast failure can precede its ack.
  completion.catch(() => {});
  try {
    const sent = await request('session/send', { sessionId, content });
    assert.equal(sent.accepted, true);
    await completion;
  } finally { clearTimeout(timer); waitingTurn = undefined; }
}
function textParts(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const here = [];
  if (value.type === 'text' && typeof value.text === 'string') here.push(value.text);
  if (typeof value.content === 'string') here.push(value.content);
  return [...here, ...Object.values(value).filter(item => typeof item === 'object').flatMap(textParts)];
}
let passed = false;
try {
  const registered = await request('provider/updateAccountConfig', account.config);
  assert.equal(registered.receivedRevision, account.config.revision);
  assert.equal(registered.providerCount, 1);
  const created = await request('session/create', { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: 'build', titleGenerationEnabled: false });
  sessionId = created.session.sessionId;
  const available = created.settings.model.available.find(model => model.ref?.providerId === account.selection.providerId && model.ref?.modelId === account.selection.modelId);
  assert.ok(available, 'Requested model must be available');
  assert.ok(available.reasoning?.defaultLevel, 'Use the advertised default reasoning level');
  const selected = await request('session/setModel', { sessionId, model: { ...account.selection, options: { reasoningLevel: available.reasoning.defaultLevel } }, persistAsWorkspaceLastUsed: false });
  assert.equal(selected.settings.model.current.modelId, account.selection.modelId);
  await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true });
  await turn('Reply with exactly HZ_LIVE_OK. Do not use tools or subagents. Remember the verification code SEASHELL_73 for the next question.');
  await turn('Reply only with the verification code from the previous message. Do not use tools or subagents.');
  const messages = await request('session/messages', { sessionId });
  const assistant = (messages.messages || []).filter(message => message.info?.role === 'assistant');
  const text = assistant.flatMap(message => textParts(message.parts)).join('\n');
  assert.ok(assistant.length >= 2, 'Both real assistant turns must be present');
  assert.match(text, /HZ_LIVE_OK/);
  assert.match(text, /SEASHELL_73/);
  passed = true;
  console.log(JSON.stringify({ test: 'live-account', passed, model: account.selection, sessionId, completedTurns: types['turn.completed'], serverRequests: methods, eventTypes: Object.keys(types), stderrSuppressedBytes: stderrBytes, elapsedMs: Math.round(performance.now() - started) }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ test: 'live-account', passed: false, error: account.redact(error.message), elapsedMs: Math.round(performance.now() - started) }));
} finally {
  if (sessionId) { try { await request('session/close', { sessionId }, 5000); } catch {} }
  child.stdin.end();
  let timer;
  await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  await runtime.close();
}
