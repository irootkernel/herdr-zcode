import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('./fixtures/app-server-entry.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(t, scenario) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, TEST_SCENARIO: scenario }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.on('error', () => {});
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Concurrent executor did not stop')); }, 10000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ out, err, code, signal }); });
  });
  return { child, result, send: line => child.stdin.write(line + '\n'),
    output: () => out,
    async wait(text) {
      const end = performance.now() + 5000;
      while (!out.includes(text)) {
        if (performance.now() > end || child.exitCode !== null) throw new Error(`Missing ${text}: ${out}\n${err}`);
        await sleep(5);
      }
    },
  };
}

test('two coordinators with two app-server executors each isolate same request IDs, turns and shutdown', async t => {
  // Each process gets its own actual child fake-server and transport. All four
  // deliberately reuse identical protocol session/request IDs, like independent
  // Herdr servers may reuse pane IDs; no global singleton can own their state.
  const a1 = launch(t, 'permissions'), a2 = launch(t, 'normal');
  const b1 = launch(t, 'permissions'), b2 = launch(t, 'normal');
  const all = [a1, a2, b1, b2];
  assert.equal(new Set(all.map(app => app.child.pid)).size, 4);
  for (const app of all) app.send('task');
  await Promise.all([a1.wait('[permission] p2'), b1.wait('[permission] p2'), a2.wait('Reply 1'), b2.wait('Reply 1')]);
  a1.send('/allow p1'); a1.send('/deny p2');
  await a1.wait('permission responses verified');
  b1.send('/status'); await b1.wait('State: blocked');
  assert.doesNotMatch(b1.output(), /permission responses verified/);
  a2.send('/exit'); a2.child.stdin.end();
  assert.equal((await a2.result).code, 0);
  b2.send('second task'); await b2.wait('Reply 2');
  b1.send('/allow p1'); b1.send('/deny p2');
  await b1.wait('permission responses verified');
  for (const app of [a1, b1, b2]) app.child.stdin.end();
  for (const result of await Promise.all(all.map(app => app.result))) {
    assert.equal(result.code, 0, result.out + '\n' + result.err);
    assert.doesNotMatch(result.out + result.err, /header-secret|legacy-secret|private-error/);
    assert.ok(result.err.indexOf('[child exited]') < result.err.indexOf('[reporter released]'));
  }
});
