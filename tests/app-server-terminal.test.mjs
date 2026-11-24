import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppServerController } from '../lib/app-server-controller.mjs';
import { main, parseArgs } from '../bin/herdr-zcode-app.mjs';
import { offlineAdapters } from './fixtures/app-server-entry.mjs';

const entry = fileURLToPath(new URL('./fixtures/app-server-entry.mjs', import.meta.url));
function launch(scenario = 'normal', args = [], options = {}) {
  const { env, ...spawnOptions } = options;
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, TEST_SCENARIO: scenario,
    TEST_AUTO_RESOLVE_QUESTIONS: args.includes('--non-interactive') || args.includes('--auto-resolve-questions') ? '1' : '0',
    TEST_PRESERVE_MODEL: args.includes('--model') ? '0' : '1',
    ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.on('error', () => {});
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Entrypoint did not exit\n${out}\n${err}`)); }, 5000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ out, err, code, signal });
    });
  });
  return { child, result,
    send: text => child.stdin.write(text + '\n'),
    wait: async needle => {
      const deadline = Date.now() + 3000;
      while (!(out + err).includes(needle)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Missing ${needle}\n${out}\n${err}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return { out, err };
    },
  };
}
function clean(result, code = 0) {
  assert.equal(result.code, code, result.out + '\n' + result.err);
  assert.doesNotMatch(result.out + result.err, /header-secret|legacy-secret|private-error|PRIVATE REASONING|authorization|requestProviderRuntimeHeaders/);
  if (result.err.includes('[child exited]')) assert.ok(result.err.indexOf('[child exited]') < result.err.indexOf('[reporter released]'));
}

test('real entrypoint captures early piped prompts/EOF, bootstraps, renders two turns once and releases after child exit', async () => {
  const app = launch();
  app.child.stdin.end('first prompt\nsecond prompt\n');
  const result = await app.result;
  clean(result);
  assert.equal(result.out.match(/Reply 1/g)?.length, 1);
  assert.equal(result.out.match(/Reply 2/g)?.length, 1);
  assert.equal(result.out.match(/\[turn completed/g)?.length, 2);
  assert.doesNotMatch(result.out, /first prompt|second prompt|"content"/);
  assert.match(result.err, /report idle/);
});

const oscStates = text => [...text.matchAll(/\x1b\]7501;state=([^\x07]+)\x07/g)].map(match => match[1]);

test('core entrypoint reports idle, working and done, with normal EOF closing the session', async () => {
  const app = launch('normal', ['--runtime', 'core']);
  app.child.stdin.end('first prompt\n');
  const result = await app.result;
  assert.equal(result.code, 0, result.out + '\n' + result.err);
  assert.match(result.out, /Reply 1/);
  assert.deepEqual(oscStates(result.out), ['idle', 'working', 'done']);
  assert.ok(result.out.indexOf('ZCode session:') < result.out.indexOf('\x1b]7501;state=idle'));
  assert.ok(result.out.indexOf('Reply 1') < result.out.indexOf('\x1b]7501;state=done'));
  assert.doesNotMatch(result.out, /session\/close unconfirmed/);
  assert.match(result.err, /\[child exited\]/);
  assert.doesNotMatch(result.err, /\[report(?: |er released)/);
});

for (const [scenario, outcome] of [
  ['quota', 'blocked:kind=quota'], ['rpc-quota', 'blocked:kind=quota'],
  ['rate-limit', 'blocked:kind=rate_limit'], ['turn-auth', 'blocked:kind=auth'],
  ['error-result', 'error'], ['failure', 'error'],
]) {
  test(`core reports ${scenario} as ${outcome} without returning to idle`, async () => {
    const app = launch(scenario, ['--runtime', 'core']);
    app.child.stdin.end('run\n');
    const result = await app.result;
    assert.equal(result.code, 1, result.out + '\n' + result.err);
    assert.deepEqual(oscStates(result.out), ['idle', 'working', outcome]);
    assert.doesNotMatch(result.out + result.err, /header-secret|private provider failure|PRIVATE STACK/);
  });
}

test('core startup authentication is observable before a supervisor stops the blocked wrapper', { skip: process.platform === 'win32' }, async () => {
  const app = launch('startup-auth', ['--runtime', 'core', '--non-interactive']);
  const { out } = await app.wait('\x1b]7501;state=blocked:kind=auth\x07');
  assert.equal(app.child.exitCode, null);
  assert.deepEqual(oscStates(out), ['blocked:kind=auth']);
  assert.ok(app.child.kill('SIGHUP'));
  const result = await app.result;
  assert.equal(result.code, 129, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['blocked:kind=auth']);
  assert.doesNotMatch(result.out + result.err, /header-secret|auth body/);
});

test('core SIGINT releases a startup auth block with a provisional turn', { skip: process.platform === 'win32' }, async () => {
  const app = launch('startup-auth-with-provisional-turn', ['--runtime', 'core', '--non-interactive', '--model', 'account:zai-individual-coding-plan/GLM-5.3']);
  await app.wait('\x1b]7501;state=blocked:kind=auth\x07');
  assert.ok(app.child.kill('SIGINT'));
  const result = await app.result;
  assert.equal(result.code, 130, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['blocked:kind=auth']);
  assert.doesNotMatch(result.out, /session\/close unconfirmed/);
});

test('core reports startup configuration failure without claiming readiness', async () => {
  const app = launch('missing-model', ['--runtime', 'core', '--non-interactive', '--model', 'account:zai-individual-coding-plan/GLM-5.3']);
  app.child.stdin.end('never submitted\n');
  const result = await app.result;
  assert.equal(result.code, 1, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['error']);
  assert.match(result.err, /Selected model unavailable/);
  assert.doesNotMatch(result.out, /session\/close unconfirmed/);
});

test('core withholds provisional startup permissions until subscription reconciles them', async () => {
  const app = launch('snapshot-permission-reconciled', ['--runtime', 'core']);
  await app.wait('Type /help');
  app.child.stdin.end('prompt\n');
  const result = await app.result;
  assert.equal(result.code, 0, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['idle', 'working', 'done']);
});

for (const [signal, code, scenario] of [['SIGHUP', 129, 'hang-cleanup'], ['SIGTERM', 143, 'hang-bootstrap']]) {
  test(`core ${signal} reaps a stubborn child in under 100ms during ${scenario}`, { skip: process.platform === 'win32' }, async t => {
    const app = launch(scenario, ['--runtime', 'core'], { detached: true,
      env: { ...process.env, TEST_SCENARIO: scenario, TEST_CAPTURE_CHILD_SCOPE: '1' } });
    const groupPid = app.child.pid;
    let reaped = false;
    t.after(() => {
      // This test created a private group so cleanup cannot target the runner.
      if (reaped) return;
      try { process.kill(-groupPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    });
    if (scenario === 'hang-cleanup') app.send('hang');
    const { err } = await app.wait(scenario === 'hang-cleanup' ? 'Type /help' : '[child runtime headers requested]');
    const childPid = Number(/\[child pid (\d+)\]/.exec(err)?.[1]);
    assert.ok(childPid > 1);
    const sessionColumn = process.platform === 'darwin' ? 'sess=' : 'sid=';
    const scope = pid => execFileSync('/bin/ps', ['-o', 'pgid=', '-o', sessionColumn, '-p', String(pid)], { encoding: 'utf8' }).trim();
    assert.equal(scope(childPid), scope(groupPid));
    assert.equal(Number(scope(groupPid).split(/\s+/)[0]), groupPid);
    const started = performance.now();
    assert.ok(app.child.kill(signal));
    const result = await app.result;
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(groupPid, 0), { code: 'ESRCH' });
    reaped = true;
    const elapsed = performance.now() - started;
    t.diagnostic(`${signal} from send to wrapper and child ESRCH: ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 100, `${signal} took ${elapsed.toFixed(1)}ms to reap owned processes`);
    assert.equal(result.code, code, result.out + '\n' + result.err);
    assert.match(result.err, /\[child status SIGKILL\]/);
    assert.doesNotMatch(result.out + result.err, /session\/(?:stop|close) unconfirmed|exit not observed/);
  });
}

test('permission allow/deny, simultaneous requests and reannouncement remain responsive during a turn', async () => {
  const app = launch('permissions'); app.send('permissions');
  await app.wait('[permission] p2');
  app.send('/allow p1'); app.send('/status');
  await app.wait('State: blocked');
  app.send('/deny p2'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /permission responses verified/);
  assert.equal(result.out.match(/\[permission\] p1/g)?.length, 1);
});

test('choose forwards the server-supplied permissionUpdates response unchanged', async () => {
  const app = launch('choose'); app.send('choose');
  await app.wait('[permission] project-request');
  app.send('/choose project-request project'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /advertised response preserved/);
});

for (const [scenario, command] of [
  ['question', '/choose q1 blue'],
  ['question', '/answer q1 blue'],
  ['multi-question', '/answer q1 {"Which color?":"blue","Which size?":"small"}'],
]) test(`question responses while busy: ${command}`, async () => {
  const app = launch(scenario); app.send('question');
  await app.wait('[question] q1');
  app.send(command); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /question response verified/);
});

test('EOF declines future permissions/questions while draining accepted turns', async () => {
  const app = launch('eof-interaction'); app.child.stdin.end('ask\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /EOF defaults verified/);
});

test('parent terminal event preserves unrelated pending/blocked state and queued input', async () => {
  const app = launch('blocked-terminal'); app.send('blocked');
  await app.wait('parent terminal');
  app.send('/status');
  await app.wait('State: blocked');
  app.send('/deny pending-p'); app.child.stdin.end();
  const result = await app.result; clean(result);
});

test('foreign/stale/child terminal events cannot finish parent; EOF waits for native background child', async () => {
  const app = launch('stale'); app.child.stdin.end('parent\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /parent verified/);
  assert.match(result.out, /subagent tool.*Read/);
  assert.match(result.out, /child-1: completed/);
  assert.doesNotMatch(result.out, /FOREIGN SECRET|STALE REPLY|CHILD REPLY/);
});

test('reverse auth works while normal session/send request is awaiting its ACK', async () => {
  const app = launch('slow-ack'); app.child.stdin.end('hello\n');
  const result = await app.result; clean(result); assert.match(result.out, /Reply 1/);
});

test('/status, /help and /stop remain responsive; subsequent turn is admitted after cancellation', async () => {
  const app = launch(); app.send('hang');
  await app.wait('Type /help');
  app.send('/status'); app.send('/help'); app.send('/stop');
  await app.wait('Stop requested');
  app.send('after cancellation'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /State: working/);
  assert.match(result.out, /Prompt text queues a turn/);
  assert.match(result.out, /Reply 2/);
});

test('explicit /exit cancels active work and discards queued prompts', async () => {
  const app = launch(); app.send('hang');
  await app.wait('Type /help');
  app.send('never run'); app.send('/exit'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /stopped by client/);
  assert.doesNotMatch(result.out, /Reply 2/);
});

test('server crash fails promptly without leaking stderr or hanging turn wait', async () => {
  const app = launch('crash'); app.child.stdin.end('crash\n');
  const result = await app.result; clean(result, 1);
  assert.match(result.out, /disconnected|unknown/);
});

test('provider failure is a failure and does not print remote error objects', async () => {
  const app = launch('failure'); app.child.stdin.end('fail\n');
  const result = await app.result; clean(result, 1);
  assert.match(result.out, /turn failed/);
});

test('stop/close timeouts are bounded, force child exit and do not claim cancellation success', async () => {
  const app = launch('hang-cleanup'); app.send('hang');
  await app.wait('Type /help'); app.send('/exit'); app.child.stdin.end();
  const result = await app.result; clean(result, 1);
  assert.match(result.out, /session\/stop unconfirmed/);
  assert.match(result.out, /session\/close unconfirmed/);
  assert.match(result.err, /child exited/);
});

test('exact catalog model is required; startup failure closes the created session', async () => {
  const app = launch('missing-model', ['--model', 'account:zai-individual-coding-plan/GLM-5.3']);
  app.child.stdin.end('never submitted\n');
  const result = await app.result; clean(result, 1);
  assert.match(result.err, /selected model and catalog compatibility/);
  assert.doesNotMatch(result.out, /turn completed/);
});

test('resume/cwd/mode use verified native fields', async () => {
  const app = launch('resume', ['--resume', 'session-main', '--mode', 'guarded', '--cwd', process.cwd()]);
  app.child.stdin.end('resumed prompt\n');
  const result = await app.result; clean(result); assert.match(result.out, /Reply 1/);
});

test('CLI defaults to build and accepts user-explicit native modes while refusing unknown arguments', () => {
  assert.equal(parseArgs([]).mode, 'build');
  assert.equal(parseArgs(['--mode', 'yolo']).mode, 'yolo');
  assert.equal(parseArgs(['--mode', 'auto']).mode, 'auto');
  assert.throws(() => parseArgs(['--mode', 'invented']));
  assert.throws(() => parseArgs(['--unknown']));
  assert.throws(() => parseArgs(['--cwd']));
});

test('a $level suffix on --model overrides the advertised default reasoning level', async () => {
  const plain = parseArgs(['--model', 'account:zai/GLM-5.3']);
  assert.equal(plain.model, 'account:zai/GLM-5.3');
  assert.equal(plain.reasoning, undefined);
  const leveled = parseArgs(['--model', 'account:zai/GLM-5.3$high']);
  assert.equal(leveled.model, 'account:zai/GLM-5.3');
  assert.equal(leveled.reasoning, 'high');
  assert.equal(parseArgs(['--model', 'GLM-5.3$low']).reasoning, 'low');
  const trailing = parseArgs(['--model', 'account:zai/GLM-5.3$']);
  assert.equal(trailing.model, 'account:zai/GLM-5.3$');
  assert.equal(trailing.reasoning, undefined);
  const leading = parseArgs(['--model', 'account:zai/$high']);
  assert.equal(leading.model, 'account:zai/$high');
  assert.equal(leading.reasoning, undefined);
  const app = launch('normal', ['--model', 'account:zai-individual-coding-plan/GLM-5.3$high'],
    { env: { ...process.env, TEST_SCENARIO: 'normal', TEST_REASONING: 'high' } });
  app.child.stdin.end('reasoning prompt\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /Selected: account:zai-individual-coding-plan\/GLM-5\.3 \(reasoning: high\)/);
  assert.match(result.out, /Reply 1/);
});

test('session scope parsing distinguishes omitted and empty lists and rejects incompatible flags', () => {
  assert.deepEqual(parseArgs([]).sessionScope, {});
  assert.deepEqual(parseArgs(['--tool-allowlist', '', '--tool-denylist', '']).sessionScope, { toolAllowlist: [], toolDenylist: [] });
  assert.equal(parseArgs(['--non-interactive']).interactionPolicy, 'block');
  assert.equal(parseArgs(['--thought-level', 'high']).reasoning, 'high');
  assert.equal(parseArgs(['--model', 'GLM-5.3$high', '--reasoning-effort', 'high']).reasoning, 'high');
  for (const args of [
    ['--tool-allowlist', 'Read,,Write'], ['--tool-denylist', '   '], ['--tool-allowlist', '--disable-mcp'],
    ['--non-interactive', '--interaction-policy', 'interactive'], ['--interaction-policy', 'allow'],
    ['--persistence', 'later'], ['--reasoning-effort', ' '], ['--reasoning-effort', ''],
    ['--resume', 's', '--tool-allowlist', ''], ['--resume', 's', '--disable-mcp'],
    ['--model', 'GLM-5.3$low', '--reasoning-effort', 'high'],
  ]) assert.throws(() => parseArgs(args), args.join(' '));
  assert.throws(() => parseArgs(['--model', 'GLM-5.3$low', '--reasoning-effort', 'high']), /Conflicting reasoning effort values/);
  const supported = Array.from({ length: 256 }, () => ['--additional-dir', 'inputs']).flat();
  assert.equal(parseArgs(supported).sessionScope.additionalDirectories.length, 256);
  assert.throws(() => parseArgs([...supported, '--additional-dir', 'outputs']), /at most 256/);
  assert.throws(() => parseArgs(['--additional-dir', 'bad\0path']), /NUL character/);
  assert.deepEqual(parseArgs(['--cwd', '/tmp', '--additional-dir', '  ']).sessionScope.additionalDirectories, ['/tmp/  ']);
});

for (const allowlist of ['', 'Read,Grep,Glob,Write', 'Read,Bash,Write', 'Read,Write']) {
  test(`session scoping sends the exact ${allowlist || 'empty'} allowlist and selected create flags`, async () => {
    const scope = { toolAllowlist: allowlist ? allowlist.split(',') : [], toolDenylist: allowlist ? ['Edit', 'Agent'] : [],
      mcpServers: [], titleGenerationEnabled: false, offPeakToolEnabled: false, dynamicWorkflowEnabled: false,
      additionalDirectories: ['/tmp/inputs', '/tmp/outputs'], persistence: 'deferred' };
    const app = launch('normal', ['--mode', 'yolo', '--tool-allowlist', allowlist, '--tool-denylist', allowlist ? 'Edit, Agent' : '',
      '--disable-mcp', '--disable-title-gen', '--disable-offpeak', '--disable-dynamic-workflow',
      '--additional-dir', 'inputs', '--additional-dir', 'outputs', '--cwd', '/tmp', '--persistence', 'deferred',
      '--auto-resolve-questions'], { env: { TEST_CREATE_SCOPE: JSON.stringify(scope) } });
    app.child.stdin.end('scope fixture\n');
    const result = await app.result; clean(result);
    assert.match(result.out, /Reply 1/);
  });
}

for (const mode of ['--non-interactive', '--preserve-default-model']) {
  test(`${mode} preserves the server model and applies reasoning without session/setModel`, async () => {
    const app = launch('normal', [mode, '--thought-level', 'high'], { env: {
      TEST_CREATE_SCOPE: '{"thoughtLevel":"high"}', TEST_THOUGHT_LEVEL: 'high',
    } });
    app.child.stdin.end('reasoning\n');
    const result = await app.result; clean(result);
    assert.match(result.out, /Selected: server-default\/native-default \(reasoning: high\)/);
    assert.match(result.out, /Reply 1/);
  });
}

test('interactive effort hints at creation and applies to the native TUI model', async () => {
  const app = launch('normal', ['--reasoning-effort', 'high'], { env: {
    TEST_CREATE_SCOPE: '{"thoughtLevel":"high"}', TEST_THOUGHT_LEVEL: 'high',
  } });
  app.child.stdin.end('interactive effort\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /Selected: server-default\/native-default \(reasoning: high\)/);
  assert.match(result.out, /Reply 1/);
});

for (const runtime of ['tui', 'core']) {
  test(`${runtime} keeps the native model and effort when --model is omitted`, async () => {
    const app = launch('normal', ['--runtime', runtime], { env: {
      TEST_DEFAULT_MODEL: JSON.stringify({ providerId: 'account:zai-individual-coding-plan',
        modelId: 'GLM-5.4', options: { reasoningLevel: 'high' } }),
    } });
    app.child.stdin.end('native model\n');
    const result = await app.result;
    if (runtime === 'tui') clean(result);
    else {
      assert.equal(result.code, 0, result.out + '\n' + result.err);
      assert.deepEqual(oscStates(result.out), ['idle', 'working', 'done']);
    }
    assert.match(result.out, /Selected: account:zai-individual-coding-plan\/GLM-5\.4 \(reasoning: high\)/);
    assert.match(result.out, /Reply 1/);
  });
}

test('noninteractive reasoning with an explicit model verifies its model options', async () => {
  const app = launch('normal', ['--non-interactive', '--model', 'account:zai-individual-coding-plan/GLM-5.4',
    '--reasoning-effort', 'max'], { env: { TEST_REASONING: 'max' } });
  app.child.stdin.end('explicit model\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /Selected: account:zai-individual-coding-plan\/GLM-5\.4 \(reasoning: max\)/);
  assert.match(result.out, /Reply 1/);
});

for (const scenario of ['reasoning-response-mismatch', 'reasoning-subscribe-mismatch', 'explicit-reasoning-mismatch', 'explicit-reasoning-subscribe-mismatch']) {
  test(`rejects ${scenario} before sending a prompt`, async () => {
    const explicit = scenario.startsWith('explicit');
    const app = launch(scenario, ['--non-interactive', '--reasoning-effort', 'high',
      ...(explicit ? ['--model', 'account:zai-individual-coding-plan/GLM-5.3'] : [])], { env: explicit ? { TEST_REASONING: 'high' }
      : { TEST_CREATE_SCOPE: '{"thoughtLevel":"high"}', TEST_THOUGHT_LEVEL: 'high' } });
    app.child.stdin.end('never run\n');
    const result = await app.result; clean(result, 1);
    assert.match(result.err, /Selected reasoning level was not applied/);
    assert.doesNotMatch(result.out, /Reply 1|Selected:/);
  });
}

test('an omitted optional independent effort report is not presented as verified', async () => {
  const app = launch('reasoning-unreported', ['--non-interactive', '--reasoning-effort', 'high'], { env: {
    TEST_CREATE_SCOPE: '{"thoughtLevel":"high"}', TEST_THOUGHT_LEVEL: 'high',
  } });
  app.child.stdin.end('unreported\n');
  const result = await app.result; clean(result);
  assert.match(result.out, /^Selected: server-default\/native-default$/m);
  assert.doesNotMatch(result.out, /reasoning: high/);
});

test('noninteractive startup block survives rejection of the in-flight setup RPC', async () => {
  const app = launch('startup-block-before-rejection', ['--runtime', 'core', '--non-interactive', '--reasoning-effort', 'high'], {
    env: { TEST_CREATE_SCOPE: '{"thoughtLevel":"high"}', TEST_THOUGHT_LEVEL: 'high' },
  });
  app.child.stdin.end('never dispatch\n');
  const result = await app.result;
  assert.equal(result.code, 1, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['blocked:kind=question']);
  assert.doesNotMatch(result.out + result.err, /fixture question|turn completed|unconfirmed|Selected:/);
});

for (const kind of ['permission', 'question']) {
  for (const policy of ['deny', 'block']) {
    test(`noninteractive ${policy} responds to ${kind} after piped EOF`, async () => {
      const app = launch(`automation-${kind}`, ['--runtime', 'core', '--non-interactive',
        ...(policy === 'deny' ? ['--interaction-policy', 'deny'] : [])]);
      app.child.stdin.end(policy === 'block' ? 'one prompt\nnever dispatch\n' : 'one prompt\n');
      const result = await app.result;
      assert.equal(result.code, policy === 'deny' ? 0 : 1, result.out + '\n' + result.err);
      assert.deepEqual(oscStates(result.out), ['idle', 'working', policy === 'deny' ? 'done' : `blocked:kind=${kind}`]);
      assert.doesNotMatch(result.out + result.err, /\[permission\]|\[question\]|Type \/help|fixture question|unconfirmed/);
      if (policy === 'block') assert.doesNotMatch(result.out, /provider terminal after decline|turn completed/);
      else assert.match(result.out, /provider terminal after decline/);
    });
  }
}

test('noninteractive block preserves question kind when ZCode announces it as a permission', async () => {
  const app = launch('automation-question', ['--runtime', 'core', '--non-interactive'], {
    env: { TEST_QUESTION_ANNOUNCEMENT: 'McpElicitation' },
  });
  app.child.stdin.end('one prompt\nnever dispatch\n');
  const result = await app.result;
  assert.equal(result.code, 1, result.out + '\n' + result.err);
  assert.deepEqual(oscStates(result.out), ['idle', 'working', 'blocked:kind=question']);
  assert.doesNotMatch(result.out + result.err, /fixture question|provider terminal after decline|turn completed|unconfirmed/);
});

test('noninteractive subscribed snapshots preserve question and genuine permission kinds', async () => {
  for (const [toolName, kind] of [
    ['AskUserQuestion', 'question'], ['McpElicitation', 'question'], ['ExitPlanMode', 'question'], ['Bash', 'permission'],
  ]) {
    const client = new EventEmitter();
    const handlers = new Map();
    client.handle = (method, handler) => handlers.set(method, handler);
    const output = [], states = [];
    const controller = new AppServerController({ client, interactionPolicy: 'block', reportBeforeReady: false,
      output: text => output.push(text), reporter: { report: snapshot => states.push(snapshot) } });
    const request = { sessionId: 's', requestId: 'snapshot-request', toolName, turnId: 'resumed' };
    const snapshot = observedState({ activeTurnId: 'resumed', eventSeq: 1 });
    snapshot.projection.pendingPermissions = [request];
    controller.attach('s', snapshot);
    const method = kind === 'question' ? 'interaction/requestUserInput' : 'interaction/requestPermission';
    const response = handlers.get(method)(request);
    assert.deepEqual(response, kind === 'question' ? { action: 'decline' } : { decision: 'deny', reason: 'Client declined request' });
    await controller.done;
    assert.equal(controller.status().state, 'blocked');
    assert.equal(controller.status().kind, kind, toolName);
    assert.deepEqual(states.map(state => [state.state, state.kind]), [['blocked', kind]], toolName);
    assert.doesNotMatch(output.join(''), /Use \/|Proposed input/);
  }
});

test('noninteractive TTY submits slash prompts literally without interactive chrome', async () => {
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
  input.isTTY = output.isTTY = true;
  const rawModes = [];
  input.setRawMode = value => rawModes.push(value);
  let stdout = '', stderr = '';
  output.on('data', text => { stdout += text; });
  errorOutput.on('data', text => { stderr += text; });
  const adapters = offlineAdapters({ write() {} });
  const prepare = adapters.prepareDesktopRuntime;
  adapters.prepareDesktopRuntime = async options => {
    const runtime = await prepare(options);
    return { ...runtime, env: { ...runtime.env, TEST_SCENARIO: 'automation-literal', TEST_AUTO_RESOLVE_QUESTIONS: '1', TEST_PRESERVE_MODEL: '1' } };
  };
  const pending = main({ argv: ['--non-interactive'], input, output, errorOutput }, adapters);
  input.end('/review src/a.js\n');
  assert.equal(await pending, 0, stdout + stderr);
  assert.match(stdout, /literal prompt accepted/);
  assert.doesNotMatch(stdout, /\x1b\[\?2004[hl]|Type \/help|Unknown command/);
  assert.deepEqual(rawModes, []);
});

test('noninteractive SIGTERM closes through controller state, without submitting /exit', { skip: process.platform === 'win32' }, async () => {
  const app = launch('automation-signal', ['--non-interactive']);
  app.send('/review src/a.js');
  await app.wait('literal prompt accepted');
  assert.ok(app.child.kill('SIGTERM'));
  const result = await app.result; clean(result, 143);
  assert.match(result.out, /stopped by client/);
  assert.doesNotMatch(result.out, /unconfirmed/);
});

function controllerFixture() {
  const client = new EventEmitter();
  client.handlers = new Map();
  client.handle = (method, handler) => client.handlers.set(method, handler);
  client.calls = [];
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    return method === 'session/send' ? { sessionId: 's', accepted: true } : {};
  };
  let out = '';
  const states = [];
  const controller = new AppServerController({ client, output: text => { out += text; }, reporter: { report: state => states.push(state) } });
  controller.attach('s');
  const event = (type, payload = {}, turnId = controller.current?.turnId) => client.emit('message', { method: 'session/event', params: { sessionId: 's', turnId, type, payload } });
  return { controller, client, event, states, output: () => out };
}

test('long-running valid turns have no 120-second lifetime timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, event, output } = controllerFixture();
  controller.input('long prompt');
  event('turn.started', { inputId: controller.current.inputId }, 'long-turn');
  await Promise.resolve();
  context.mock.timers.tick(10 * 60 * 1000);
  assert.equal(controller.state(), 'working');
  assert.doesNotMatch(output(), /timed out|120 seconds/);
  event('turn.completed', { response: 'eventual reply' }, 'long-turn');
  assert.equal(controller.state(), 'idle');
});

test('resolved permission tombstones reject stale reannouncements and stop declines open questions', async () => {
  const { controller, client, event } = controllerFixture();
  controller.input('hello');
  event('turn.started', { inputId: controller.current.inputId }, 't');
  const p = { sessionId: 's', turnId: 't', requestId: 'p', options: [{ optionId: 'only-persistent', kind: 'allow_always', response: { decision: 'allow' } }] };
  const permission = client.handlers.get('interaction/requestPermission')(p);
  controller.input('/allow p');
  assert.equal(controller.state(), 'blocked');
  event('permission.resolved', { requestId: 'p' });
  assert.equal((await permission).decision, 'deny');
  assert.equal((await client.handlers.get('interaction/requestPermission')(p)).decision, 'deny');
  const question = client.handlers.get('interaction/requestUserInput')({ sessionId: 's', requestId: 'q' });
  await controller.stop();
  assert.equal((await question).action, 'decline');
  assert.equal(controller.current.turnId, 't'); // ACK is not completion evidence
});

test('startup snapshot event watermark rejects replay, and a buffered resumed completion drains its own turn', async () => {
  const { controller, client } = controllerFixture();
  controller.ready = false;
  client.emit('message', { method: 'session/event', params: { sessionId: 's', seq: 6, turnId: 'resumed-turn', type: 'turn.completed', payload: { inputId: 'old-input', response: 'resumed completion' } } });
  controller.attach('s', { runtime: { activeTurnId: 'resumed-turn', stateRevision: 4 },
    projection: { sessionId: 's', status: 'running', currentTurnId: 'resumed-turn', pendingPermissions: [], backgroundJobs: [] } }, 5);
  assert.equal(controller.current, null);
  client.emit('message', { method: 'session/event', params: { sessionId: 's', seq: 5, turnId: 'stale', type: 'turn.started' } });
  assert.equal(controller.current, null);
  controller.eof(); await controller.done;
});

test('an approved request cannot silently approve a later stale reannouncement', async () => {
  const { controller, client, event } = controllerFixture();
  controller.input('hello'); event('turn.started', { inputId: controller.current.inputId }, 't');
  const params = { sessionId: 's', turnId: 't', requestId: 'p', options: [{ optionId: 'once', kind: 'allow_once', response: { decision: 'allow' } }] };
  const answer = client.handlers.get('interaction/requestPermission')(params);
  controller.input('/allow p'); assert.equal((await answer).decision, 'allow');
  assert.equal((await client.handlers.get('interaction/requestPermission')(params)).decision, 'deny');
});

test('unexpected model substitution fails instead of silently selecting another model', async () => {
  const app = launch('wrong-model', ['--model', 'account:zai-individual-coding-plan/GLM-5.3']);
  app.child.stdin.end('never run\n');
  const result = await app.result; clean(result, 1);
  assert.doesNotMatch(result.out, /turn completed/);
});

test('direct executable help works without account/bootstrap/Herdr access', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/herdr-zcode-app.mjs', import.meta.url)), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0); assert.match(out, /EOF drains queued work/);
});

test('a stale permission notification and reverse request cannot leave a foreign turn blocked', async () => {
  const { controller, client, event } = controllerFixture();
  controller.input('active prompt'); event('turn.started', { inputId: controller.current.inputId }, 'current');
  event('permission.requested', { requestId: 'stale-permission' }, 'unseen-old-turn');
  const response = await client.handlers.get('interaction/requestPermission')({ sessionId: 's', turnId: 'unseen-old-turn', requestId: 'stale-permission' });
  assert.equal(response.decision, 'deny');
  assert.equal(controller.interactions.size, 0);
  assert.equal(controller.state(), 'working');
  const childQuestion = client.handlers.get('interaction/requestUserInput')({ sessionId: 's', turnId: 'child-turn', requestId: 'child-question', origin: { childSessionId: 'child' } });
  assert.equal(controller.state(), 'blocked');
  controller.input('/deny child-question');
  assert.equal((await childQuestion).action, 'decline');
});

test('all native background terminal states release their own work without completing the parent', async () => {
  const { controller, event } = controllerFixture();
  controller.input('parent'); event('turn.started', { inputId: controller.current.inputId }, 'parent-turn');
  for (const status of ['completed', 'failed', 'cancelled', 'timed_out', 'spawn_error', 'lost']) {
    event('session.updated', { taskId: 'background-task', status: 'running' });
    assert.equal(controller.background.size, 1);
    event('session.updated', { taskId: 'background-task', status });
    assert.equal(controller.background.size, 0);
    assert.equal(controller.current.turnId, 'parent-turn');
  }
});

test('a native execution-model fallback is reported as failure and requires cancellation', async () => {
  const { controller, event, output } = controllerFixture();
  controller.expectedModel = { providerId: 'selected-provider', modelId: 'selected-model' };
  event('session.updated', { toModelSelection: { providerId: 'other', modelId: 'fallback' } });
  await controller.done;
  assert.equal(controller.failed, true);
  assert.equal(controller.state(), 'unknown');
  assert.match(output(), /changed the execution model/);
});

test('main pauses closed input and restores the original tty raw mode', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; output.isTTY = true; output.columns = 80;
  const rawModes = [];
  input.setRawMode = mode => { rawModes.push(mode); input.isRaw = mode; };
  let pauses = 0;
  const pause = input.pause.bind(input);
  input.pause = () => { pauses++; return pause(); };
  output.resume();
  const result = main({ argv: [], input, output, errorOutput: output }, offlineAdapters({ write() {} }));
  input.write('/exit\n');
  assert.equal(await result, 0);
  assert.ok(pauses > 0); assert.equal(input.isPaused(), true);
  assert.ok(rawModes.includes(true)); assert.equal(input.isRaw, false);
  assert.equal(rawModes.at(-1), false);
});

test('foreground-group Ctrl-C stops active work, preserves app-server, and permits another turn', { skip: process.platform === 'win32' }, async () => {
  const app = launch('normal', [], { detached: true }); app.send('hang');
  await app.wait('Type /help');
  process.kill(-app.child.pid, 'SIGINT');
  await app.wait('Stop requested');
  app.send('next prompt'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /stopped by client/);
  assert.match(result.out, /Reply 2/);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`idle ${signal} gracefully closes the child and exits ${code}`, { skip: process.platform === 'win32' }, async () => {
    const app = launch(); await app.wait('Type /help');
    app.child.kill(signal);
    const result = await app.result; clean(result, code);
    assert.match(result.err, /child exited/); assert.match(result.err, /reporter released/);
  });
}
for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`busy ${signal} cancels and shuts down with code ${code}`, { skip: process.platform === 'win32' }, async () => {
    const app = launch(); app.send('hang'); await app.wait('Type /help');
    app.child.kill(signal);
    const result = await app.result; clean(result, code);
    assert.match(result.out, /stopped by client/);
  });
}

test('permission UI shows actual command/file input, child origin, redaction and terminal-safe control characters', async () => {
  const app = launch('permission-preview'); app.send('preview');
  await app.wait('Proposed input');
  app.send('/deny inspect'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /cat config.txt/); assert.match(result.out, /"path": "config.txt"/);
  assert.match(result.out, /Child origin: agent-child \(Explore\); session=session-child/);
  assert.match(result.out, /\[REDACTED\]/);
  assert.doesNotMatch(result.out, /private-key|private-cookie|\x1b|\x07|\u202e/);
  assert.match(result.out, /preview verified/);
});

for (const scenario of ['quota', 'rpc-quota']) test(`${scenario} errors identify usage limit 1308 and HTTP status without leaking details`, async () => {
  const app = launch(scenario); app.child.stdin.end('quota\n');
  const result = await app.result; clean(result, 1);
  assert.match(result.out, /provider_code=1308/); assert.match(result.out, /HTTP 429/);
  assert.match(result.out, /reason=usage limit/);
  assert.doesNotMatch(result.out + result.err, /PRIVATE STACK|private provider failure|"data"|"headers"/);
});

test('--prompt-file sends multiline content as one prompt, including lines that resemble commands', async () => {
  const app = launch('prompt-file', ['--prompt-file', fileURLToPath(new URL('./fixtures/app-server-prompt.txt', import.meta.url))]);
  app.child.stdin.end(); const result = await app.result; clean(result);
  assert.equal(result.out.match(/\[turn completed/g)?.length, 1); assert.match(result.out, /Reply 1/);
});

test('an unreadable TUI prompt file creates and releases no Herdr reporter', async () => {
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
  const calls = [];
  const path = fileURLToPath(new URL('./fixtures/app-server-prompt.txt/child', import.meta.url));
  const code = await main({ argv: ['--prompt-file', path], input, output, errorOutput }, {
    createHerdrReporter() {
      calls.push('create');
      return { report: () => calls.push('report'), close: () => calls.push('release') };
    },
    prepareDesktopRuntime() {
      calls.push('prepare');
      throw new Error('Unexpected bootstrap');
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('--app-bundle is forwarded to the runtime helper', async () => {
  const app = launch('app-bundle', ['--app-bundle', '/fixture/ZCode Custom.app']); app.child.stdin.end('hello\n');
  const result = await app.result; clean(result); assert.match(result.out, /Reply 1/);
});

test('runtime scratch, copy and inspection flags reach the installed app-server path', async () => {
  const app = launch('runtime-flags', ['--runtime-dir', '/fixture runtime', '--no-copy-catalog', '--skip-desktop-inspect']);
  app.child.stdin.end('hello\n');
  const result = await app.result;
  clean(result);
  assert.match(result.out, /Reply 1/);
});

for (const flag of ['--version', '--bridge-help']) test(`${flag} works directly without bootstrap`, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/herdr-zcode-app.mjs', import.meta.url)), flag], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
  assert.match(out, flag === '--version' ? /^herdr-zcode \d+\.\d+\.\d+/ : /--prompt-file/);
});

for (const mode of ['yolo', 'auto']) test(`explicit --mode ${mode} is forwarded unchanged to the native server`, async () => {
  const app = launch('mode-' + mode, ['--mode', mode]); app.child.stdin.end('hello\n');
  const result = await app.result; clean(result); assert.match(result.out, /Reply 1/);
});

test('readline Ctrl-C clears a partial tty draft, cancels the turn and keeps input usable', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; output.isTTY = true; output.columns = 80;
  input.setRawMode = mode => { input.isRaw = mode; };
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const adapters = offlineAdapters({ write() {} });
  const prepare = adapters.prepareDesktopRuntime;
  adapters.prepareDesktopRuntime = async options => {
    const runtime = await prepare(options);
    runtime.env.TEST_SCENARIO = 'tty-interrupt'; return runtime;
  };
  const done = main({ argv: [], input, output, errorOutput: output }, adapters);
  const wait = async needle => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (text.includes(needle)) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    input.write('/exit\n'); throw new Error('Missing ' + needle + '\n' + text);
  };
  input.write('hang\n'); await wait('Type /help');
  input.write('unfinished draft\x03'); await wait('Stop requested');
  input.end('after cancellation\n');
  assert.equal(await done, 0); assert.match(text, /Reply 2/);
  assert.equal(input.isRaw, false); assert.equal(input.isPaused(), true);
});

function observedState({ activeTurnId, eventSeq, status = activeTurnId ? 'running' : 'idle', backgroundJobs = [] } = {}) {
  return { runtime: { activeTurnId, eventSeq, stateRevision: eventSeq },
    projection: { sessionId: 's', status, currentTurnId: activeTurnId || 'last-retained-turn', backgroundJobs, pendingPermissions: [] } };
}

test('new subscription idle snapshot clears an earlier bootstrap/resume observation, including absent activeTurnId', async () => {
  const { controller } = controllerFixture(); controller.ready = false;
  controller.snapshot(observedState({ activeTurnId: 'bootstrap-turn', eventSeq: 1 }));
  assert.equal(controller.current.turnId, 'bootstrap-turn');
  controller.eof();
  controller.attach('s', observedState({ eventSeq: 2 }), 2);
  await controller.done;
  assert.equal(controller.current, null); assert.equal(controller.state(), 'idle');
  controller.snapshot(observedState({ activeTurnId: 'stale-turn', eventSeq: 1 }));
  assert.equal(controller.current, null);
});

test('newer subscription removes obsolete bootstrap-only permissions and admits queued input', async () => {
  const { controller, client, event } = controllerFixture(); controller.ready = false;
  const bootstrap = observedState({ eventSeq: 1 });
  bootstrap.projection.pendingPermissions = [{ requestId: 'expired', toolCallId: 'old-tool', toolName: 'Write' }];
  controller.snapshot(bootstrap);
  controller.input('next prompt');
  assert.equal(controller.state(), 'blocked');
  assert.equal(client.calls.length, 0);
  client.emit('message', { method: 'session/event', params: { sessionId: 's', seq: 2, type: 'permission.resolved', payload: { requestId: 'expired' } } });
  controller.attach('s', observedState({ eventSeq: 3 }), 3);
  await Promise.resolve();
  assert.equal(controller.interactions.size, 0);
  assert.equal(controller.state(), 'working');
  assert.equal(client.calls.filter(call => call.method === 'session/send').length, 1);
  event('turn.started', { inputId: controller.current.inputId }, 'next');
  event('turn.completed', { response: 'done' }, 'next');
});

test('snapshot reconciliation preserves a permission with a live reverse response channel', async () => {
  const { controller, client } = controllerFixture();
  const bootstrap = observedState({ eventSeq: 1 });
  const params = { requestId: 'live', toolCallId: 'tool-live', toolName: 'Write', sessionId: 's', options: [] };
  bootstrap.projection.pendingPermissions = [params];
  controller.snapshot(bootstrap);
  const answer = client.handlers.get('interaction/requestPermission')(params);
  controller.snapshot(observedState({ eventSeq: 2 }));
  assert.equal(controller.state(), 'blocked');
  assert.equal(controller.interactions.get('live').waiters.length, 1);
  controller.input('/deny live');
  assert.equal((await answer).decision, 'deny');
});

test('live permission reannouncement is not removed by a delayed snapshot omission', async () => {
  const { controller, client, event } = controllerFixture();
  const params = { requestId: 'live-event', toolCallId: 'tool-live', toolName: 'Write', sessionId: 's', options: [] };
  const bootstrap = observedState({ eventSeq: 1 }); bootstrap.projection.pendingPermissions = [params];
  controller.snapshot(bootstrap);
  event('permission.requested', params);
  controller.snapshot(observedState({ eventSeq: 2 }));
  assert.equal(controller.state(), 'blocked');
  const answer = client.handlers.get('interaction/requestPermission')(params);
  controller.input('/deny live-event');
  assert.equal((await answer).decision, 'deny');
});

test('missing or stale pending-permission snapshots cannot clear a bootstrap registration', () => {
  const { controller } = controllerFixture();
  const bootstrap = observedState({ eventSeq: 1 });
  bootstrap.projection.pendingPermissions = [{ requestId: 'snapshot-only', toolName: 'Write' }];
  controller.snapshot(bootstrap);
  const partial = observedState({ eventSeq: 2 }); delete partial.projection.pendingPermissions;
  controller.snapshot(partial);
  controller.snapshot(observedState({ eventSeq: 0 }));
  assert.equal(controller.interactions.size, 1);
  controller.snapshot(observedState({ eventSeq: 3 }));
  assert.equal(controller.interactions.size, 0);
  assert.equal(controller.state(), 'idle');
});

test('entrypoint remains interactive after a bootstrap permission disappears from the subscription snapshot', async () => {
  const app = launch('snapshot-permission-reconciled');
  app.send('run after bootstrap');
  await app.wait('Reply 1');
  app.send('/status'); await app.wait('State: idle');
  app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.equal(result.out.match(/\[turn completed/g)?.length, 1);
});

test('snapshot reconciliation preserves a locally submitted current turn and replaces only observed turns', async () => {
  const { controller, event } = controllerFixture();
  controller.input('local prompt'); event('turn.started', { inputId: controller.current.inputId }, 'local-turn');
  controller.snapshot(observedState({ eventSeq: 2 }));
  assert.equal(controller.current.turnId, 'local-turn');
  event('turn.completed', { response: 'done' }, 'local-turn');
  controller.snapshot(observedState({ activeTurnId: 'observed-turn', eventSeq: 3 }));
  assert.equal(controller.current.turnId, 'observed-turn');
  controller.snapshot(observedState({ activeTurnId: 'newer-observed', eventSeq: 4 }));
  assert.equal(controller.current.turnId, 'newer-observed');
  controller.snapshot(observedState({ eventSeq: 5 }));
  assert.equal(controller.current, null);
});

for (const content of ['', 'next prompt\n']) test(`entrypoint drains a reconciled startup observation${content ? ' and submits queued input' : ' at EOF'}`, async () => {
  const app = launch('snapshot-reconciled', ['--resume', 'session-main', '--mode', 'guarded']);
  app.child.stdin.end(content);
  const result = await app.result; clean(result);
  if (content) assert.match(result.out, /Reply 1/);
  else assert.doesNotMatch(result.out, /turn completed/);
});

test('snapshot and live task events share one key and a terminal event drains EOF without clearing other work', async () => {
  const { controller, event } = controllerFixture();
  controller.snapshot(observedState({ backgroundJobs: [{ taskId: 'one', status: 'running' }, { taskId: 'two', status: 'running' }] }));
  event('session.updated', { taskId: 'one', status: 'running' });
  assert.equal(controller.background.size, 2);
  controller.eof();
  event('session.updated', { taskId: 'one', status: 'completed' });
  assert.equal(controller.background.size, 1); assert.equal(controller.state(), 'working');
  event('session.updated', { taskId: 'two', status: 'completed' });
  await controller.done;
  assert.equal(controller.background.size, 0); assert.equal(controller.state(), 'idle');
});

test('entrypoint EOF exits after a snapshot background job completes through a live task event', async () => {
  const app = launch('snapshot-background'); app.child.stdin.end();
  const result = await app.result; clean(result);
  assert.match(result.out, /snapshot-job: completed/);
});

test('every installed error-valued completion result reports failure while success/cancellation remain nonfailures', async () => {
  for (const resultType of ['error_max_turns', 'error_max_budget', 'error_during_execution', 'error_max_tool_calls', 'success', 'cancelled']) {
    const { controller, event, output } = controllerFixture();
    controller.input('run'); event('turn.started', { inputId: controller.current.inputId }, 'turn');
    event('turn.completed', { resultType, response: 'final text' }, 'turn');
    assert.equal(Boolean(controller.failed), resultType.startsWith('error_'), resultType);
    if (resultType.startsWith('error_')) {
      assert.match(output(), /\[turn failed\]/); assert.match(output(), new RegExp(resultType));
      assert.doesNotMatch(output(), /\[turn completed/);
    } else assert.match(output(), /\[turn completed/);
  }
});

test('entrypoint exits unsuccessfully for error_max_tool_calls carried by turn.completed', async () => {
  const app = launch('error-result'); app.child.stdin.end('run\n');
  const result = await app.result; clean(result, 1);
  assert.match(result.out, /\[turn failed\] error_max_tool_calls/);
  assert.doesNotMatch(result.out, /\[turn completed/);
});

function launchTTY(expected) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; output.isTTY = true; output.columns = 80;
  input.setRawMode = mode => { input.isRaw = mode; };
  let text = ''; const reports = [];
  output.on('data', chunk => { text += chunk; });
  const adapters = offlineAdapters({ write: text => reports.push(text) });
  const prepare = adapters.prepareDesktopRuntime;
  adapters.prepareDesktopRuntime = async options => {
    const runtime = await prepare(options);
    runtime.env.TEST_SCENARIO = 'paste'; runtime.env.TEST_EXPECTED_PROMPT = expected;
    return runtime;
  };
  const done = main({ argv: [], input, output, errorOutput: output }, adapters);
  return { input, done, reports, output: () => text, wait: async needle => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (text.includes(needle)) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    input.write('\x03'); input.end(); throw new Error('Missing ' + needle + '\n' + text);
  } };
}

test('TTY bracketed paste preserves multiline input, blank lines, whitespace, Unicode and command-like lines as exactly one turn after Enter', async () => {
  const body = 'Coordinator 日本語 🦦\n\n  indented\ttext\n/exit\n/stop\ntrailing  \n';
  const app = launchTTY('prefix ' + body + 'suffix');
  // Include a paste before bootstrap, split escape markers across chunks, and
  // retain ordinary text typed on either side of the bracketed region.
  app.input.write('prefix \x1b[20'); app.input.write('0~' + body + '\x1b[201'); app.input.write('~suffix');
  await app.wait('Type /help');
  assert.ok(app.output().includes('\x1b[?2004h'));
  assert.equal(app.reports.some(line => line.includes('[report working')), false);
  app.input.end('\r');
  assert.equal(await app.done, 0);
  assert.equal(app.output().match(/\[turn completed/g)?.length, 1);
  assert.match(app.output(), /Reply 1/);
  assert.ok(app.output().includes('\x1b[?2004l'));
  assert.equal(app.input.isPaused(), true); assert.equal(app.input.isRaw, false);
});

test('TTY bracketed CRLF paste normalizes newlines and never submits at paste-end', async () => {
  const app = launchTTY('first\n\nlast\n'); await app.wait('Type /help');
  app.input.write('\x1b[200~first\r\n\r\nlast\r\n\x1b[201~');
  assert.equal(app.reports.some(line => line.includes('[report working')), false);
  app.input.end('\r'); assert.equal(await app.done, 0);
  assert.equal(app.output().match(/\[turn completed/g)?.length, 1);
});

for (const end of ['', '\x1b[201~']) test(`TTY EOF discards ${end ? 'completed' : 'unterminated'} paste draft without submitting it`, async () => {
  const app = launchTTY('must not submit'); await app.wait('Type /help');
  app.input.end('\x1b[200~discard\n/exit\nlast' + end);
  assert.equal(await app.done, 0);
  assert.equal(app.reports.some(line => line.includes('[report working')), false);
  assert.doesNotMatch(app.output(), /turn completed/);
  assert.ok(app.output().includes('\x1b[?2004l'));
});

test('Ctrl-C discards pasted draft while busy; commands and a subsequent multiline turn remain usable', async () => {
  const app = launchTTY('after\ncancellation\n');
  app.input.write('hang\r'); await app.wait('Type /help');
  app.input.write('\x1b[200~discard\n/exit\npartial\x03');
  await app.wait('Stop requested');
  app.input.write('/status\r/help\r'); await app.wait('State: idle');
  assert.match(app.output(), /Prompt text queues a turn/);
  app.input.end('\x1b[200~after\ncancellation\n\x1b[201~\r');
  assert.equal(await app.done, 0); assert.match(app.output(), /Reply 2/);
  assert.equal(app.output().match(/\[turn completed/g)?.length, 2);
  assert.ok(app.output().includes('\x1b[?2004l'));
});

test('single-line bracketed commands wait for Enter and remain responsive during an active turn', async () => {
  const app = launchTTY('must not submit another turn');
  app.input.write('hang\r'); await app.wait('Type /help');
  app.input.write('\x1b[200~/status\x1b[201~');
  assert.doesNotMatch(app.output(), /State: working/);
  app.input.write('\r'); await app.wait('State: working');
  app.input.write('\x1b[200~/stop\x1b[201~\r'); await app.wait('Stop requested');
  app.input.end('/exit\r'); assert.equal(await app.done, 0);
  assert.equal(app.output().match(/\[turn completed/g)?.length, 1);
  assert.ok(app.output().includes('\x1b[?2004l'));
});
