import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppServerClient, safeErrorSummary } from '../lib/app-server-client.mjs';

function transport({ pid, ...options } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  let bytes = '';
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) { bytes += chunk; callback(); } });
  child.kill = signal => { child.emit('close', null, signal); return true; };
  let spawnOptions;
  const client = new AppServerClient({ launch: (exe, args, config) => { spawnOptions = config; return child; }, requestTimeout: 100, ...options }).start();
  const frames = () => bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  return { client, child, frames, send, spawnOptions };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('NDJSON chunk boundaries, notification routing, and reverse ids are independent of outbound ids', async () => {
  const { client, child, frames, send } = transport();
  let finish;
  client.handle('reverse', () => new Promise(resolve => { finish = resolve; }));
  const rpc = client.request('normal', { text: 'a\nb' });
  const request = frames()[0];
  assert.equal(request.jsonrpc, undefined);
  assert.equal(request.method, 'normal');
  child.stdout.write('{"id":1,"method":"reverse","params":');
  child.stdout.write('{} }\n');
  send({ id: request.id, result: { accepted: true } });
  assert.deepEqual(await rpc, { accepted: true });
  finish({ reverse: true }); await flush();
  assert.deepEqual(frames()[1], { id: 1, result: { reverse: true } });
  child.emit('close', 0, null);
});

test('reverse handlers register synchronously in wire order and asynchronously respond without blocking normal RPCs', async () => {
  const { client, child, frames, send } = transport();
  const order = [];
  client.handle('question', () => { order.push('question'); return Promise.resolve({ action: 'decline' }); });
  client.on('message', () => order.push('terminal'));
  child.stdout.write('{"id":"q","method":"question"}\n{"method":"session/event"}\n');
  assert.deepEqual(order, ['question', 'terminal']);
  await flush();
  assert.deepEqual(frames()[0], { id: 'q', result: { action: 'decline' } });
  const rpc = client.request('another');
  send({ id: frames()[1].id, result: {} }); await rpc;
  child.emit('close', 0, null);
});

test('unknown reverse methods and asynchronous header failures return sanitized protocol errors', async () => {
  const { client, child, frames, send } = transport();
  client.handle('headers', async () => { throw new Error('credential-secret private error'); });
  send({ id: 'u', method: 'unknown' }); send({ id: 'h', method: 'headers' });
  await flush();
  assert.equal(frames()[0].error.code, -32601);
  assert.equal(frames()[1].error.code, -32603);
  assert.doesNotMatch(JSON.stringify(frames()), /credential-secret|private error/);
  child.emit('close', 0, null);
});

test('remote RPC errors never expose complete provider error objects', async () => {
  const { client, child, frames, send } = transport();
  const request = client.request('session/send');
  send({ id: frames()[0].id, error: { code: -32001, message: 'credential-secret', data: { headers: 'credential-secret' } } });
  await assert.rejects(request, error => error.message === 'session/send rejected' && error.code === -32001);
  child.emit('close', 0, null);
});

test('malformed output rejects outstanding RPCs once and bounded teardown awaits actual close', async () => {
  const { client, child } = transport();
  let closed = 0; client.on('closed', () => { closed++; });
  const request = client.request('pending');
  child.stdout.write('not NDJSON\n');
  await assert.rejects(request, /Invalid app-server frame/);
  await client.terminate(5);
  assert.equal(client.exited, true);
  assert.equal(closed, 1);
  assert.equal(client.pending.size, 0);
});

test('Unix teardown signals only the owned detached process group, escalating until child close', async () => {
  const signals = [];
  let alive = true;
  const fixture = transport({ pid: 43210, platform: 'darwin', signalProcess: (pid, signal) => {
    if (signal === 0) { if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' }); return; }
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') { alive = false; fixture.child.emit('close', null, signal); }
  } });
  assert.equal(fixture.spawnOptions.detached, true);
  await fixture.client.terminate(5);
  assert.deepEqual(signals, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
  assert.equal(fixture.client.exited, true);
});

test('Windows and missing/unsafe group identities fall back only to their owned child', async () => {
  for (const options of [{ platform: 'win32', pid: 43210 }, { platform: 'darwin', pid: 1 }, { platform: 'darwin' }]) {
    const fixture = transport({ ...options, signalProcess: () => assert.fail('No verified owned group') });
    await fixture.client.terminate(5);
    assert.equal(fixture.client.exited, true);
    assert.equal(fixture.spawnOptions.detached, options.platform !== 'win32');
  }
});

test('a disappeared process group falls back to the owned child without broad process matching', async () => {
  const signals = [];
  const fixture = transport({ platform: 'darwin', pid: 43210, signalProcess: (pid, signal) => {
    signals.push([pid, signal]); throw Object.assign(new Error(), { code: 'ESRCH' });
  } });
  await fixture.client.terminate(5);
  assert.deepEqual(signals, [[-43210, 0]]);
  assert.equal(fixture.client.exited, true);
});

test('diagnostics keep native lowercase model codes and safe reasons while rejecting arbitrary secret fields', () => {
  assert.equal(safeErrorSummary({ code: 'model_rate_limited', attribution: { providerErrorCode: '1308', statusCode: 429, reason: 'rate_limited' } }), 'code=model_rate_limited; provider_code=1308; HTTP 429; reason=usage limit');
  assert.equal(safeErrorSummary({ code: 'credential-secret', safeSummary: 'credential-secret', reason: 'credential-secret', data: { headers: 'credential-secret' } }), '');
  assert.match(safeErrorSummary({ message: 'Provider error code: 1308; credential-secret' }), /provider_code=1308/);
});

test('leader close after SIGTERM does not suppress SIGKILL of its surviving owned group', async () => {
  let alive = true;
  const signals = [];
  const fixture = transport({ pid: 43210, platform: 'darwin', signalProcess: (pid, signal) => {
    if (signal === 0) { if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' }); return; }
    signals.push([pid, signal]);
    if (signal === 'SIGTERM') fixture.child.emit('close', 0, null);
    if (signal === 'SIGKILL') { assert.equal(fixture.client.exited, true); alive = false; }
  } });
  await fixture.client.terminate(5);
  assert.deepEqual(signals, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
  assert.equal(fixture.client.groupGone, true);
  alive = true; // A later group with the same id is no longer ours to signal.
  await fixture.client.terminate(5);
  assert.deepEqual(signals, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
});

test('unknown group state fails even after leader close, without claiming cleanup or sending broad signals', async () => {
  const calls = [];
  const fixture = transport({ pid: 43210, platform: 'darwin', signalProcess: (pid, signal) => {
    calls.push([pid, signal]); throw Object.assign(new Error('private diagnostic'), { code: 'EPERM' });
  } });
  fixture.child.emit('close', 0, null);
  await assert.rejects(fixture.client.terminate(5), /Owned app-server process group state unavailable/);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(([pid, signal]) => pid === -43210 && signal === 0));
  assert.notEqual(fixture.client.groupGone, true);
});

test('a group still present after SIGKILL is a bounded cleanup failure', async () => {
  const fixture = transport({ pid: 43210, platform: 'darwin', signalProcess: () => {} });
  fixture.child.emit('close', 0, null);
  await assert.rejects(fixture.client.terminate(5), /owned process group exit not observed/);
  assert.notEqual(fixture.client.groupGone, true);
});

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('close', resolve));
}
function absent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
async function within(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded')), ms); })]);
  } finally { clearTimeout(timer); }
}

for (const mode of ['term', 'close']) test(`actual owned group cleanup kills stubborn descendant after leader ${mode === 'term' ? 'SIGTERM' : 'normal close'}`, { skip: process.platform === 'win32' }, async context => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const signals = [];
  const client = new AppServerClient({ executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/app-server-owned-group.mjs', import.meta.url)), mode],
    signalProcess: (pid, signal) => {
      if (signal !== 0) {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') assert.equal(client.exited, true, 'leader must already be closed in this regression');
      }
      return process.kill(pid, signal);
    },
  });
  context.after(async () => {
    // Only the two test-owned scopes may be cleaned, including on assertion or
    // startup failure. No process searches and no inherited group signaling.
    try {
      if (client.child) {
        if (Number.isInteger(client.groupPid) && client.groupPid > 1 && !client.groupGone) {
          try { process.kill(-client.groupPid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        if (!client.exited && client.child.exitCode == null && client.child.signalCode == null) client.child.kill('SIGKILL');
        await within(client.exit);
      }
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
      await within(exited(unrelated));
    }
  });
  const ready = new Promise(resolve => client.on('message', message => {
    if (message.method === 'fixture/ready') resolve(message.params);
  }));
  client.start();
  const { leaderPid, descendantPid } = await within(ready);
  assert.equal(leaderPid, client.groupPid);
  assert.equal(absent(descendantPid), false);
  await client.terminate(200);
  // A reporter awaiting terminate() can release only after these facts hold.
  assert.equal(client.exited, true);
  assert.equal(client.groupGone, true);
  assert.equal(absent(leaderPid), true);
  assert.equal(absent(descendantPid), true);
  assert.equal(absent(-leaderPid), true);
  assert.deepEqual(signals, [[-leaderPid, 'SIGTERM'], [-leaderPid, 'SIGKILL']]);
  assert.equal(unrelated.exitCode, null);
  assert.equal(absent(unrelated.pid), false, 'unrelated inherited-group work must remain alive');
});

test('actual normal leader close with an empty owned group needs no destructive signal', { skip: process.platform === 'win32' }, async context => {
  const signals = [];
  const client = new AppServerClient({ executable: process.execPath,
    args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    signalProcess: (pid, signal) => { if (signal !== 0) signals.push([pid, signal]); return process.kill(pid, signal); },
  }).start();
  context.after(async () => {
    if (Number.isInteger(client.groupPid) && client.groupPid > 1 && !client.groupGone) {
      try { process.kill(-client.groupPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await within(client.exit);
  });
  await client.terminate(1000);
  assert.equal(client.exited, true); assert.equal(client.groupGone, true);
  assert.deepEqual(signals, []);
});

test('a transient indeterminate probe waits for ESRCH without assuming exit or sending a signal', async () => {
  let probes = 0;
  const fixture = transport({ pid: 43210, platform: 'darwin', signalProcess: (pid, signal) => {
    assert.equal(pid, -43210); assert.equal(signal, 0);
    throw Object.assign(new Error(), { code: ++probes === 1 ? 'EPERM' : 'ESRCH' });
  } });
  fixture.child.emit('close', 0, null);
  await fixture.client.terminate(50);
  assert.equal(probes, 2); assert.equal(fixture.client.groupGone, true);
});
