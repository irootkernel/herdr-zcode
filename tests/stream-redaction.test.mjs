import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { main } from '../bin/herdr-zcode-app.mjs';
import { createStreamRedactor } from '../lib/desktop-account.mjs';

const credential = 'fixture-credential';

test('redacts a known credential at every split, including one character per write', () => {
  for (let split = 0; split <= credential.length; split++) {
    const stream = createStreamRedactor(new Set([credential]));
    assert.equal(stream.write(credential.slice(0, split)) + stream.write(credential.slice(split)) + stream.flush(), '[REDACTED]');
  }
  const stream = createStreamRedactor(new Set([credential]));
  assert.equal([...credential].map(char => stream.write(char)).join('') + stream.flush(), '[REDACTED]');
});

test('streams ordinary text immediately and retains only a possible credential prefix', () => {
  const stream = createStreamRedactor(new Set([credential]));
  assert.equal(stream.write('ordinary text'), 'ordinary text');
  assert.equal(stream.write(' and fixture-'), ' and ');
  assert.equal(stream.write('X'), 'fixture-X');
  assert.equal(stream.write(' more text'), ' more text');
  assert.equal(stream.flush(), '');
});

test('flush emits an incomplete prefix exactly once and rechecks newly known credentials', () => {
  const secrets = new Set([credential]);
  const stream = createStreamRedactor(secrets);
  assert.equal(stream.write('ending fixture-'), 'ending ');
  assert.equal(stream.flush(), 'fixture-');
  assert.equal(stream.flush(), '');
  assert.equal(stream.write('fixture-'), '');
  secrets.add('fixture-');
  assert.equal(stream.flush(), '[REDACTED]');
});

test('overlapping keys and prefixes cannot cause a complete credential to be emitted', () => {
  const stream = createStreamRedactor(new Set(['abcd', 'de', 'abcdef']));
  assert.equal(stream.write('abcd'), '[REDACTED]');
  assert.equal(stream.write(' abcdef de'), ' [REDACTED] [REDACTED]');
  assert.equal(stream.flush(), '');
});

// A real Node child speaks NDJSON to the production client. Its environment and
// account adapter contain only fixtures; no installed app, account or Herdr runs.
const fakeServer = String.raw`
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const sessionId = 'fixture-session';
const model = {providerId:'fixture-provider', modelId:'fixture-model'};
const snapshot = {session:{sessionId}, settings:{model:{current:model, available:[{ref:model}]}}};
let seq = 0;
const event = (type, payload = {}, extra = {}) => send({method:'session/event', params:{sessionId, turnId:'fixture-turn', seq:++seq, type, payload, ...extra}});
const reply = (id, result) => send({id, result});
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const message = JSON.parse(line);
  const {id, method, params} = message;
  if (!method) {
    if (id !== 'fixture-gate') return;
    if (process.env.FIXTURE_SCENARIO === 'split') {
      // Neither a child nor a stale parent completion is a stream boundary.
      event('turn.completed', {source:'subagent', childSessionId:'fixture-child'});
      event('turn.completed', {}, {turnId:'old-turn'});
      event('model.streaming', {kind:'text_delta', delta:'credential tail'});
    }
    event('turn.completed', {response:process.env.FIXTURE_SCENARIO === 'split' ? 'ordinary fixture-credential tail' : 'ordinary fixture-'});
    return;
  }
  switch (method) {
    case 'session/create': case 'session/setModel': reply(id, snapshot); break;
    case 'session/subscribe': reply(id, {snapshot}); break;
    case 'session/send':
      reply(id, {accepted:true, sessionId});
      event('turn.started', {inputId:params.inputId});
      event('model.streaming', {kind:'text_delta', delta:'ordinary '});
      event('model.streaming', {kind:'text_delta', delta:'fixture-'});
      send({id:'fixture-gate', method:'interaction/requestProviderRuntimeHeaders', params:{}});
      break;
    case 'session/close': reply(id, {closed:true}); break;
    default: reply(id, {});
  }
});
`;

async function runEntrypoint(t, scenario) {
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
  let rendered = '', errors = '', release, reachGate, flushes = 0;
  const taskOutput = () => rendered.split('Type /help for commands.\n')[1] ?? '';
  output.on('data', chunk => { rendered += chunk; });
  errorOutput.on('data', chunk => { errors += chunk; });
  const gate = new Promise(resolve => { reachGate = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const run = main({argv:[], env:{}, input, output, errorOutput}, {
    rpcTimeout:3000, exitTimeout:200,
    prepareDesktopRuntime:async () => ({executable:process.execPath,
      args:['--input-type=module', '-e', fakeServer], env:{FIXTURE_SCENARIO:scenario}, home:'/fixture', configPath:'/fixture/catalog'}),
    desktopAccount:async () => ({selection:{providerId:'fixture-provider', modelId:'fixture-model'}, config:{},
      createStreamRedactor() {
        const stream = createStreamRedactor(new Set([credential]));
        return {write:text => stream.write(text), flush:() => { flushes++; return stream.flush(); }};
      },
      async runtimeHeaders() { reachGate(); await held; return {headersApplied:true, requestAuth:{apiKey:credential}}; },
    }),
    createHerdrReporter:() => ({report() {}, async close() {}}),
  });
  t.after(async () => { release(); input.end(); await run; });
  input.write('fixture prompt\n');
  await gate;
  // The server cannot complete until released: ordinary output is already visible
  // and only the possible credential suffix has been held back.
  assert.ok(rendered.endsWith('ordinary '), rendered);
  assert.equal(taskOutput().includes('fixture-'), false);
  assert.equal(rendered.includes('[turn completed]'), false);
  release();
  // Wait for a terminal event while input remains open, exercising turn flush.
  if (!rendered.includes('[turn completed]')) await new Promise(resolve => {
    const onData = () => {
      if (rendered.includes('[turn completed]')) { output.removeListener('data', onData); resolve(); }
    };
    output.on('data', onData);
  });
  assert.ok(flushes >= 1);
  const turnFlushes = flushes;
  input.end();
  assert.equal(await run, 0, errors);
  assert.ok(flushes > turnFlushes, 'shutdown flushes any remaining suffix');
  assert.equal(errors, '');
  return taskOutput();
}

test('production entrypoint masks a fixture credential split across deltas while continuing to stream', {timeout:5000}, async t => {
  const rendered = await runEntrypoint(t, 'split');
  assert.equal(rendered.includes(credential), false);
  assert.match(rendered, /ordinary \[REDACTED\] tail\n\[turn completed\]/);
});

test('production entrypoint preserves a final partial prefix at turn end and shutdown', {timeout:5000}, async t => {
  const rendered = await runEntrypoint(t, 'partial');
  assert.match(rendered, /ordinary fixture-\n\[turn completed\]/);
  assert.equal(rendered.match(/fixture-/g)?.length, 1);
});
