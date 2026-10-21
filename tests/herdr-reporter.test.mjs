import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHerdrReporter } from '../lib/herdr-reporter.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = performance.now() + 4_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'fixture condition timed out');
    await pause(10);
  }
}
const option = (entry, name) => entry.args[entry.args.indexOf(name) + 1];
const command = entry => entry.args[1];

function fixture(t, config = {}) {
  // TEST_TMP_ROOT can select the mounted volume; the restricted runner only
  // grants scratch writes in the system temporary directory by default.
  const directory = mkdtempSync(join(process.env.TEST_TMP_ROOT || tmpdir(), 'herdr-reporter-'));
  const binary = join(directory, 'fake herdr reporter.mjs');
  copyFileSync(fileURLToPath(new URL('./fixtures/fake-herdr-reporter.mjs', import.meta.url)), binary);
  chmodSync(binary, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
  Object.assign(env, {
    HERDR_ENV: '1', HERDR_BIN_PATH: binary,
    HERDR_PANE_ID: 'fixture-pane', HERDR_SOCKET_PATH: join(directory, 'fake.sock'),
    REPORTER_CONTROL: join(directory, 'control.json'), REPORTER_TRACE: join(directory, 'trace.jsonl'),
  });
  const reporters = [];
  const control = value => writeFileSync(env.REPORTER_CONTROL, JSON.stringify(value));
  control(config);
  const trace = () => existsSync(env.REPORTER_TRACE)
    ? readFileSync(env.REPORTER_TRACE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const calls = () => trace().filter(entry => entry.phase === 'start');
  t.after(async () => {
    await Promise.all(reporters.map(reporter => reporter.close()));
    for (const { pid } of calls()) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `reporter process ${pid} leaked`);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, env, control, trace, calls,
    create(timing = {}, overrides) {
      const reporter = createHerdrReporter({ env: overrides ? { ...env, ...overrides } : env, timing });
      reporters.push(reporter);
      return reporter;
    },
  };
}

function manualTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    timing: {
      timeoutMs: 1_500, retryBaseMs: 20, retryMaxMs: 80,
      setTimeout(fn, ms) { const handle = ++id; pending.set(handle, { fn, ms }); return handle; },
      clearTimeout(handle) { pending.delete(handle); },
    },
    retry(ms) {
      assert.equal(pending.size, 1, 'only one retry timer may remain after a write');
      const [handle, task] = pending.entries().next().value;
      assert.equal(task.ms, ms);
      pending.delete(handle);
      task.fn();
    },
    waiting(ms) { return pending.size === 1 && [...pending.values()][0].ms === ms; },
  };
}

function warnings(t) {
  const chunks = [];
  t.mock.method(process.stderr, 'write', chunk => { chunks.push(String(chunk)); return true; });
  return chunks;
}

function assertOrdered(calls) {
  const sequences = calls.map(entry => Number(option(entry, '--seq')));
  assert.ok(sequences.every(value => Number.isSafeInteger(value) && value > 0));
  assert.ok(sequences.every((value, i) => i === 0 || value > sequences[i - 1]));
  assert.ok(calls.every(entry => option(entry, '--source') === 'custom:herdr-zcode-app'));
  assert.ok(calls.every(entry => option(entry, '--agent') === 'zcode'));
  assert.equal(command(calls.at(-1)), 'release-agent');
  assert.ok(!calls.at(-1).args.includes('--agent-session-id'));
  assert.equal(calls.filter(entry => command(entry) === 'release-agent').length, 1);
}

test('outside Herdr or without an explicit route, report and close are no-ops', async t => {
  const f = fixture(t);
  // A PATH lookup must never substitute for the pane owner's explicit binary.
  const decoy = join(f.directory, 'herdr');
  copyFileSync(f.env.HERDR_BIN_PATH, decoy);
  chmodSync(decoy, 0o755);
  for (const overrides of [
    { HERDR_ENV: undefined }, { HERDR_ENV: '0' },
    { HERDR_BIN_PATH: undefined }, { HERDR_BIN_PATH: '' },
    { HERDR_PANE_ID: undefined }, { HERDR_SOCKET_PATH: undefined },
  ]) {
    const reporter = f.create({}, {
      ...overrides, PATH: [f.directory, dirname(process.execPath)].join(delimiter),
    });
    reporter.report('working', 'hello', 'session');
    await reporter.close();
  }
  assert.deepEqual(f.calls(), []);
});

test('nonblocking burst coalesces to the latest state, dedups, and pins session identity', async t => {
  const output = warnings(t);
  const f = fixture(t);
  const gate = join(f.directory, 'allow-completion');
  f.control({ gate });
  const reporter = f.create({ timeoutMs: 3_000 });
  const literal = 'literal $(never-run); spaces\nline';
  reporter.report('working', literal, 'owned');
  await until(() => f.calls().length === 1);
  const started = performance.now();
  for (let i = 0; i < 5_000; i++) reporter.report('working', `event ${i}`, 'owned');
  reporter.report('idle', 'ready', 'owned');
  reporter.report('blocked', 'foreign', 'other');
  reporter.report('done', 'invalid', 'owned');
  await pause(0); // Protocol/input callbacks can run while the executable is held.
  assert.ok(performance.now() - started < 500, 'reports delayed the event loop');
  assert.equal(f.trace().filter(entry => entry.phase === 'finish').length, 0);
  assert.equal(f.calls().length, 1);
  writeFileSync(gate, 'go');
  await until(() => f.trace().filter(entry => entry.phase === 'finish').length === 2);
  reporter.report('idle', 'ready');
  await pause(50);
  assert.equal(f.calls().length, 2);
  const closing = reporter.close();
  assert.equal(reporter.close(), closing);
  reporter.report('working', 'after close', 'owned');
  await closing;
  reporter.report('working', 'after release', 'owned');
  await pause(30);
  const calls = f.calls();
  assert.deepEqual(calls.slice(0, -1).map(entry => option(entry, '--state')), ['working', 'idle']);
  assert.equal(option(calls[0], '--message'), literal);
  assert.ok(calls.slice(0, -1).every(entry => option(entry, '--agent-session-id') === 'owned'));
  assert.ok(f.trace().some(entry => entry.phase === 'finish' && command(entry) === 'release-agent'),
    'fixture must accept the release options');
  assert.equal(output.length, 0);
  assertOrdered(calls);
});

test('timestamp sequences advance across wrapper restarts and tolerate local clock rollback', async t => {
  const f = fixture(t);
  const timers = manualTimers();
  const epoch = 1_800_000_000_000;
  let clock = epoch;
  const timing = { ...timers.timing, now: () => clock };
  const first = f.create(timing);
  first.report('idle', 'ready', 'session-one');
  await until(() => f.calls().length === 1 && timers.pending.size === 0);
  clock -= 1_000;
  first.report('working', 'busy', 'session-one');
  await until(() => f.calls().length === 2 && timers.pending.size === 0);
  await first.close();
  const firstCalls = f.calls();
  assertOrdered(firstCalls);
  assert.equal(Number(option(firstCalls[0], '--seq')), epoch * 1_000 + 1);
  assert.equal(Number(option(firstCalls.at(-1), '--seq')), epoch * 1_000 + 3);

  clock = epoch + 1;
  const restarted = f.create(timing);
  restarted.report('idle', 'ready', 'session-two');
  await until(() => f.calls().length === 4 && timers.pending.size === 0);
  await restarted.close();
  const secondCalls = f.calls().slice(firstCalls.length);
  assertOrdered(secondCalls);
  assert.ok(Number(option(secondCalls[0], '--seq')) > Number(option(firstCalls.at(-1), '--seq')),
    'restart on the same pane/source must use a newer sequence');
  assert.equal(timers.pending.size, 0);
});

test('failure retries reassert current state, cap backoff, reset after recovery, and warn once', async t => {
  const output = warnings(t);
  const f = fixture(t);
  const timers = manualTimers();
  const reporter = f.create(timers.timing);
  reporter.report('idle', 'ready', 'owned');
  await until(() => f.calls().length === 1 && timers.pending.size === 0);
  f.control({ fail: true });
  reporter.report('working', 'may have applied', 'owned');
  await until(() => timers.waiting(20));
  // Returning to the acknowledged state still needs a recovery reassertion.
  reporter.report('idle', 'ready', 'owned');
  for (const [index, delay] of [20, 40, 80].entries()) {
    for (let i = 0; i < 1_000; i++) reporter.report('idle', 'ready', 'owned');
    assert.equal(f.calls().length, index + 2);
    timers.retry(delay);
    await until(() => timers.waiting(Math.min(delay * 2, 80)));
  }
  f.control({});
  timers.retry(80);
  await until(() => timers.pending.size === 0);
  assert.equal(option(f.calls().at(-1), '--state'), 'idle');
  assert.equal(f.calls().length, 6);
  f.control({ fail: true });
  reporter.report('blocked', 'interaction', 'owned');
  await until(() => timers.waiting(20));
  // Close bypasses cooldown and must not run any queued report afterward.
  await reporter.close();
  assert.equal(timers.pending.size, 0);
  assert.equal(output.length, 1);
  assert.match(output[0], /reporting unavailable/);
  assert.ok(!output.join('').includes('fixture-secret'));
  assertOrdered(f.calls());
});

test('same pane on separate sockets has independent sequences, sessions, retry and release', async t => {
  warnings(t);
  const a = fixture(t, { fail: true });
  const b = fixture(t);
  const timers = manualTimers();
  const first = a.create(timers.timing);
  const second = b.create(timers.timing);
  first.report('blocked', 'a', 'session-a');
  second.report('working', 'b', 'session-b');
  await until(() => timers.waiting(20));
  await first.close();
  assert.equal(timers.pending.size, 0);
  second.report('idle', 'ready', 'session-b');
  await until(() => b.calls().length === 2 && timers.pending.size === 0);
  await second.close();
  for (const [f, session] of [[a, 'session-a'], [b, 'session-b']]) {
    assertOrdered(f.calls());
    assert.ok(f.calls().every(entry => entry.socket === f.env.HERDR_SOCKET_PATH));
    assert.ok(f.calls().every(entry => entry.args[2] === 'fixture-pane'));
    assert.ok(f.calls().slice(0, -1).every(entry => option(entry, '--agent-session-id') === session));
  }
});

test('close kills and awaits the in-flight writer; release is last and route is captured', async t => {
  const f = fixture(t, { hang: true });
  const timers = manualTimers();
  const reporter = f.create(timers.timing);
  reporter.report('unknown', 'starting');
  await until(() => f.calls().length === 1);
  const socket = f.env.HERDR_SOCKET_PATH;
  f.env.HERDR_SOCKET_PATH = '/foreign/socket';
  f.env.HERDR_PANE_ID = 'foreign-pane';
  reporter.report('idle', 'ready', 'pinned');
  await reporter.close();
  assert.equal(timers.pending.size, 0);
  const calls = f.calls();
  assert.equal(calls.length, 2, 'coalesced state must not run during shutdown');
  assert.ok(calls.every(entry => entry.socket === socket && entry.args[2] === 'fixture-pane'));
  assert.ok(!calls.at(-1).args.includes('--agent-session-id'));
  assert.throws(() => process.kill(calls[0].pid, 0), { code: 'ESRCH' });
  assertOrdered(calls);
});

test('hung executable and hung release are bounded, with all timers and children removed', async t => {
  const output = warnings(t);
  const f = fixture(t, { hang: true, release: { hang: true } });
  const pending = new Set();
  const reporter = f.create({
    timeoutMs: 300, retryBaseMs: 10_000,
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { pending.delete(timer); fn(); }, ms);
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); pending.delete(timer); },
  });
  reporter.report('working', 'hang', 'owned');
  await until(() => output.length === 1);
  assert.equal(f.calls().length, 1);
  const started = performance.now();
  await reporter.close();
  assert.ok(performance.now() - started < 2_000, 'release timeout must be bounded');
  assert.equal(pending.size, 0);
  assert.equal(output.length, 1);
  assertOrdered(f.calls());
});

test('missing executable and synchronous spawn errors fail open without unhandled errors', async t => {
  const output = warnings(t);
  const f = fixture(t);
  for (const binary of [join(f.directory, 'missing-secret-executable'), '\0invalid']) {
    const timers = manualTimers();
    const reporter = f.create(timers.timing, { HERDR_BIN_PATH: binary });
    assert.doesNotThrow(() => reporter.report('working', 'hello', 'owned'));
    await until(() => timers.waiting(20));
    await reporter.close();
    assert.equal(timers.pending.size, 0);
  }
  assert.equal(output.length, 2, 'one generic warning per wrapper, including release failure');
  assert.ok(!output.join('').includes('secret'));
  assert.deepEqual(f.calls(), []);
});

test('reporting failure preserves caller exit code and stdout, then exits without leaked handles', async t => {
  const f = fixture(t, { fail: true, release: { hang: true } });
  const moduleUrl = new URL('../lib/herdr-reporter.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createHerdrReporter } from ${JSON.stringify(moduleUrl)};
    const reporter = createHerdrReporter({ timing: { timeoutMs: 300, retryBaseMs: 10000 } });
    process.exitCode = 37;
    reporter.report('working', 'hello', 'owned');
    setTimeout(async () => { await reporter.close(); console.log('protocol-ok'); }, 200);
  `], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('wrapper leaked handles')); }, 3_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve(code); });
  });
  assert.equal(code, 37);
  assert.equal(stdout, 'protocol-ok\n');
  assert.equal(stderr, 'herdr-zcode: Herdr reporting unavailable; ZCode continues.\n');
  assertOrdered(f.calls());
});
