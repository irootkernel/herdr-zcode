import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamRedactor } from '../lib/desktop-account.mjs';
import { createOsc7501Reporter, formatOsc7501 } from '../lib/osc7501-reporter.mjs';

const osc = payload => `\x1b]7501;state=${payload}\x07`;

test('OSC 7501 frames contain only known states and blocked kinds', () => {
  for (const state of ['idle', 'working', 'done', 'blocked', 'error']) {
    assert.equal(formatOsc7501({ state, message: 'secret', diagnostic: 'secret', kind: 'secret' }), osc(state));
  }
  for (const kind of ['auth', 'quota', 'rate_limit', 'permission', 'question']) {
    assert.equal(formatOsc7501({ state: 'blocked', kind }), osc(`blocked:kind=${kind}`));
  }
  for (const state of ['starting', 'unknown', '\x07secret']) {
    assert.equal(formatOsc7501({ state }), undefined);
  }
});

test('each emitted OSC frame follows a flush and repeat outcomes for distinct turns survive', async () => {
  const calls = [];
  const reporter = createOsc7501Reporter({ writeRaw: frame => calls.push(frame), flushOutput: () => calls.push('flush') });
  reporter.report({ state: 'starting' });
  reporter.report({ state: 'idle' });
  reporter.report({ state: 'idle' });
  reporter.report({ state: 'working' });
  reporter.report({ state: 'working', turnId: 'a' });
  reporter.report({ state: 'done', turnId: 'a' });
  reporter.report({ state: 'done', turnId: 'a' });
  reporter.report({ state: 'done', turnId: 'b' });
  reporter.report({ state: 'working', turnId: 'c' });
  reporter.report({ state: 'done', turnId: 'c' });
  await reporter.close();
  assert.deepEqual(calls, ['idle', 'working', 'done', 'done', 'working', 'done'].flatMap(state => ['flush', osc(state)]));
});

test('a frame emitted during a turn keeps a possible credential prefix buffered', () => {
  const redactor = createStreamRedactor(new Set(['fixture-secret']));
  let output = redactor.write('answer fixture-');
  const reporter = createOsc7501Reporter({
    writeRaw: frame => { output += frame; },
    flushOutput: () => { output += redactor.flush({ keepPrefix: true }); },
  });
  reporter.report({ state: 'working', turnId: 'a' });
  output += redactor.write('secret');
  assert.equal(output, `answer ${osc('working')}[REDACTED]`);
});
