import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { main, parseArgs } from '../bin/herdr-zcode-app.mjs';
import { AppServerController } from '../lib/app-server-controller.mjs';
import { classifyFailure } from '../lib/error-classification.mjs';
import { createRuntimeProfile } from '../lib/runtime-profile.mjs';

test('runtime selection defaults to tui, accepts core, and rejects missing or invalid values', async () => {
  assert.equal(parseArgs([]).runtime, 'tui');
  assert.equal(parseArgs(['--runtime', 'tui']).runtime, 'tui');
  assert.equal(parseArgs(['--runtime', 'core']).runtime, 'core');
  for (const args of [['--runtime'], ['--runtime', ''], ['--runtime', 'auto'], ['--runtime', 'invalid'], ['--runtime', '--help']]) {
    assert.throws(() => parseArgs(args), { message: 'Use runtime tui or core' });
  }
  let error = '';
  assert.equal(await main({ argv: ['--runtime', 'auto'], errorOutput: { write: text => { error += text; } } }), 1);
  assert.equal(error, 'Use runtime tui or core\n');
  let help = '';
  assert.equal(await main({ argv: ['--runtime', 'core', '--help'], output: { write: text => { help += text; } } }), 0);
  assert.match(help, /--runtime <tui\|core>/);
});

test('failure classification uses structured priority and emits safe diagnostics', () => {
  const cases = [
    [{ data: { attribution: { providerErrorCode: 1308, statusCode: 429, reason: 'rate_limited' } } }, 'quota'],
    [{ message: 'Provider limit: 1308, token=fixture-secret', statusCode: 429 }, 'quota'],
    [{ code: 'INSUFFICIENT_QUOTA' }, 'quota'],
    [{ code: -32001, type: 'insufficient_quota', statusCode: 429 }, 'quota'],
    [{ providerErrorCode: '1308', statusCode: 429 }, 'quota'],
    [{ attribution: { providerErrorCode: 1302 } }, 'rate_limit'],
    [{ statusCode: 429 }, 'rate_limit'],
    [{ statusCode: 401 }, 'auth'],
    [{ reason: 'auth_failed' }, 'auth'],
    [{ type: 'permission_denied' }, 'permission'],
    [{ code: -32000, type: 'permission_denied' }, 'permission'],
    [{ code: 'fixture-secret', type: 'permission_timeout' }, 'permission'],
  ];
  for (const [error, expected] of cases) {
    const result = classifyFailure(error);
    assert.equal(result.state, 'blocked');
    assert.equal(result.kind, expected);
    assert.doesNotMatch(result.diagnostic, /fixture-secret/);
  }
  assert.equal(classifyFailure({ code: 'fixture-secret', type: 'permission_timeout' }).diagnostic, 'code=permission_timeout');
  assert.deepEqual(classifyFailure({ message: 'private body', reason: 'private reason' }, 'error_max_tool_calls'), {
    state: 'error', kind: undefined, diagnostic: '', reason: 'error_max_tool_calls',
  });
});

test('canonical turn outcomes leave legacy TUI ready and clear when a new turn starts', async () => {
  const client = new EventEmitter();
  client.handle = () => {};
  client.request = async () => ({ accepted: true, sessionId: 'session' });
  const reports = [];
  const profile = createRuntimeProfile('tui', { adapters: {
    createHerdrReporter: () => ({ report: (...args) => reports.push(args), close() {} }),
  } });
  const controller = new AppServerController({ client, reporter: profile.createReporter(), output: () => {} });
  const event = (type, payload, turnId) => controller.event({
    method: 'session/event', params: { type, payload, sessionId: 'session', turnId },
  });
  const start = async turnId => {
    controller.prompt('work');
    event('turn.started', { inputId: controller.current.inputId }, turnId);
    await Promise.resolve();
    assert.equal(controller.status().state, 'working');
    assert.equal(controller.status().diagnostic, '');
  };
  assert.equal(controller.status().state, 'starting');
  assert.equal(controller.state(), 'unknown');
  controller.attach('session');
  assert.equal(controller.status().state, 'idle');
  await start('quota');
  event('turn.failed', { error: { attribution: { providerErrorCode: '1308', statusCode: 429 } } }, 'quota');
  assert.equal(controller.status().state, 'blocked');
  assert.equal(controller.status().kind, 'quota');
  assert.equal(controller.status().turnId, 'quota');
  assert.equal(controller.state(), 'idle');
  assert.deepEqual(reports.at(-1), ['idle', 'ZCode executor', 'session']);

  await start('permission');
  event('permission.requested', { requestId: 'confirm' }, 'permission');
  assert.equal(controller.status().kind, 'permission');
  assert.equal(controller.state(), 'blocked');
  assert.deepEqual(reports.at(-1), ['blocked', 'ZCode input required', 'session']);
  event('permission.resolved', { requestId: 'confirm' }, 'permission');
  event('turn.failed', { error: { code: 'permission_denied' } }, 'permission');
  assert.equal(controller.status().kind, 'permission');
  assert.equal(controller.state(), 'idle');

  await start('limited');
  event('turn.completed', { resultType: 'error_max_tool_calls' }, 'limited');
  assert.equal(controller.status().state, 'error');
  assert.equal(controller.state(), 'idle');
  event('turn.started', {}, 'resumed');
  assert.equal(controller.status().state, 'working');
  event('turn.completed', { resultType: 'cancelled' }, 'resumed');
  assert.equal(controller.status().state, 'idle');

  await start('successful');
  event('turn.completed', { resultType: 'success' }, 'successful');
  assert.equal(controller.status().state, 'done');
  assert.equal(controller.state(), 'idle');
});

test('core profile passes structured snapshots to its reporter adapter', () => {
  const snapshots = [];
  const profile = createRuntimeProfile('core', { adapters: {
    createOsc7501Reporter: () => ({ report: snapshot => snapshots.push(snapshot) }),
  } });
  assert.equal(profile.detached, false);
  assert.equal(profile.fastTeardown, true);
  const snapshot = { state: 'blocked', kind: 'quota' };
  profile.createReporter().report(snapshot);
  assert.deepEqual(snapshots, [snapshot]);
  const frames = [];
  const fallback = createRuntimeProfile('core', { output: { write: frame => frames.push(frame) } }).createReporter();
  fallback.report(snapshot);
  assert.deepEqual(frames, ['\x1b]7501;state=blocked:kind=quota\x07']);
  fallback.close();
});

test('explicit send rejection retains canonical failure while ambiguous transport loss stays unknown', async () => {
  for (const [failure, state, kind] of [
    [classifyFailure({ code: -32001, type: 'insufficient_quota' }), 'blocked', 'quota'],
    [classifyFailure({ code: -32000 }), 'error', undefined],
    [undefined, 'unknown', undefined],
  ]) {
    const client = new EventEmitter();
    client.handle = () => {};
    client.request = async () => { throw Object.assign(new Error('send failed'), { failure }); };
    const reports = [];
    const profile = createRuntimeProfile('tui', { adapters: {
      createHerdrReporter: () => ({ report: (...args) => reports.push(args) }),
    } });
    const controller = new AppServerController({ client, reporter: profile.createReporter(), output: () => {} });
    controller.attach('session');
    controller.prompt('work');
    await controller.done;
    assert.equal(controller.status().state, state);
    assert.equal(controller.status().kind, kind);
    assert.equal(controller.status().diagnostic, failure?.diagnostic ?? '');
    assert.equal(controller.state(), 'unknown');
    assert.equal(reports.at(-1)[0], 'unknown');
  }
});
