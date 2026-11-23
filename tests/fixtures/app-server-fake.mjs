import readline from 'node:readline';
import assert from 'node:assert/strict';
const scenario = process.env.TEST_SCENARIO || 'normal';
if (scenario === 'hang-cleanup' || scenario === 'hang-bootstrap') process.on('SIGTERM', () => {});
const turnFailures = {
  failure: {},
  quota: { code: 'MODEL_RATE_LIMITED', attribution: { providerErrorCode: '1308', statusCode: 429, reason: 'rate_limited' } },
  'rate-limit': { code: 'MODEL_RATE_LIMITED', attribution: { providerErrorCode: '1302', statusCode: 429, reason: 'rate_limited' } },
  'turn-auth': { code: 'MODEL_REQUEST_AUTH_MISSING', attribution: { statusCode: 401, reason: 'auth_failed' } },
};
const sessionId = 'session-main';
let seq = 0, turn = 0, active, waiting = new Map(), closeRequested = false;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const event = (type, payload = {}, extra = {}) => send({ method: 'session/event', params: { sessionId, turnId: active?.turnId, seq: ++seq, type, payload, ...extra } });
const reverse = (method, params, id = `server-${waiting.size + 1}`) => new Promise(resolve => {
  waiting.set(id, resolve); send({ id, method, params });
});
const available = [{ ref: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' }, reasoning: { levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }], defaultLevel: 'max' } }];
const snapshot = () => ({ session: { sessionId }, settings: { model: {
  current: scenario === 'wrong-model' ? { providerId: 'wrong', modelId: 'other' } : available[0].ref,
  available: scenario === 'missing-model' ? [] : available } } });
const observedSnapshot = (activeTurnId, eventSeq, backgroundJobs = []) => ({ ...snapshot(),
  runtime: { activeTurnId, eventSeq, stateRevision: eventSeq },
  projection: { sessionId, status: activeTurnId ? 'running' : 'idle', currentTurnId: activeTurnId || 'previous-turn', pendingPermissions: [], backgroundJobs } });
const complete = (response = `Reply ${turn}`) => {
  event('turn.completed', { response, inputId: active.inputId });
  active = null;
};
const permission = (id, extra = {}) => ({ sessionId, turnId: active.turnId, requestId: id, toolCallId: id,
  toolName: 'Bash', reason: 'Controlled test permission', riskLevel: 'low', input: {},
  options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow', reason: 'Server single-use response' } },
    { optionId: 'project', kind: 'allow_always', name: 'Allow project', response: { decision: 'allow', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }] } },
    { optionId: 'reject', kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
  ], ...extra });
async function runPrompt(p, id) {
  assert.equal(active, null, 'overlapping parent turns');
  active = { inputId: p.inputId, turnId: `turn-${++turn}` };
  if (scenario === 'tty-interrupt' && turn === 2) assert.equal(p.content, 'after cancellation');
  if (scenario.startsWith('mode-')) assert.equal(turn, 1);
  assert.ok(p.inputId);
  if (scenario === 'paste' && p.content !== 'hang') assert.equal(p.content, process.env.TEST_EXPECTED_PROMPT);
  if (scenario === 'prompt-file') assert.equal(p.content, 'Coordinator task\n/exit\nKeep this as one multiline prompt.\n');
  if (scenario === 'crash') { process.stderr.write('header-secret authorization: private-error\n'); process.exit(9); }
  event('turn.started', { inputId: p.inputId, input: p.content });
  if (scenario === 'rpc-quota') {
    send({ id, error: { code: -32001, message: 'header-secret private provider failure', data: { attribution: { providerErrorCode: '1308', statusCode: 429, reason: 'rate_limited' }, headers: 'header-secret' } } });
    return;
  }
  if (scenario !== 'slow-ack') reply(id, { accepted: true, sessionId });
  if (p.content === 'hang' || scenario === 'hang-cleanup') return;
  if (scenario === 'error-result') {
    event('turn.completed', { response: 'Tool limit reached', inputId: p.inputId, resultType: 'error_max_tool_calls' });
    active = null; return;
  }
  if (scenario === 'permission-preview') {
    const params = permission('inspect', { input: { command: 'cat config.txt\nprintf header-secret', path: 'config.txt', apiKey: 'private-key', headers: { cookie: 'private-cookie' }, content: '\u001b]52;c;clipboard\u0007\u202e' }, origin: { kind: 'subagent', agentId: 'agent-child', agentType: 'Explore', childSessionId: 'session-child', description: 'Inspect configuration' } });
    assert.equal((await reverse('interaction/requestPermission', params)).decision, 'deny');
    complete('preview verified'); return;
  }
  if (scenario === 'permissions') {
    const first = permission('p1'), second = permission('p2');
    event('permission.requested', first);
    const a = reverse('interaction/requestPermission', first);
    const b = reverse('interaction/requestPermission', second);
    // Duplicate reannouncement uses a different wire id but the same request id.
    const again = reverse('interaction/requestPermission', first, 'server-reannounced');
    const results = await Promise.all([a, b, again]);
    assert.deepEqual(results[0], { decision: 'allow', reason: 'Server single-use response' });
    assert.equal(results[1].decision, 'deny');
    assert.deepEqual(results[0], results[2]);
    event('permission.resolved', { requestId: 'p1' });
    event('permission.resolved', { requestId: 'p2' });
    complete('permission responses verified');
    return;
  }
  if (scenario === 'choose') {
    const result = await reverse('interaction/requestPermission', permission('project-request'));
    assert.ok(result.permissionUpdates?.length);
    complete('advertised response preserved'); return;
  }
  if (scenario === 'question' || scenario === 'multi-question') {
    const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Blue', value: 'blue' }] }];
    if (scenario === 'multi-question') questions.push({ question: 'Which size?', header: 'Size', options: [{ label: 'Small', value: 'small' }] });
    const result = await reverse('interaction/requestUserInput', { sessionId, turnId: active.turnId, requestId: 'q1', prompt: 'Choose preferences', questions });
    assert.equal(result.action, 'accept');
    assert.equal(result.content.answers['Which color?'], 'blue');
    if (scenario === 'multi-question') assert.equal(result.content.answers['Which size?'], 'small');
    event('userInput.resolved', { requestId: 'q1' });
    complete('question response verified'); return;
  }
  if (scenario === 'eof-interaction') {
    const result = await reverse('interaction/requestPermission', permission('eof-p'));
    assert.equal(result.decision, 'deny');
    const question = await reverse('interaction/requestUserInput', { sessionId, requestId: 'eof-q' });
    assert.equal(question.action, 'decline');
    complete('EOF defaults verified'); return;
  }
  if (scenario === 'blocked-terminal') {
    const result = reverse('interaction/requestPermission', permission('pending-p'));
    event('turn.completed', { response: 'parent terminal', inputId: p.inputId });
    active = null;
    assert.equal((await result).decision, 'deny');
    event('permission.resolved', { requestId: 'pending-p' });
    return;
  }
  if (scenario === 'stale') {
    event('turn.completed', { response: 'FOREIGN SECRET' }, { sessionId: 'other-session', turnId: active.turnId });
    event('turn.completed', { response: 'STALE REPLY' }, { turnId: 'old-turn' });
    event('turn.completed', { response: 'CHILD REPLY', source: 'subagent', childSessionId: 'child' });
    const denied = await reverse('interaction/requestPermission', permission('foreign-p', { sessionId: 'other-session' }));
    assert.equal(denied.decision, 'deny');
    event('session.updated', { agentId: 'child-1', childSessionId: 'child', status: 'running' });
    event('tool.updated', { source: 'subagent', toolName: 'Read', toolCallId: 'child-tool', kind: 'started' });
    await new Promise(resolve => setTimeout(resolve, 35));
    complete('parent verified');
    setTimeout(() => event('session.updated', { agentId: 'child-1', childSessionId: 'child', status: 'completed' }, { turnId: undefined }), 40);
    return;
  }
  if (scenario === 'slow-ack') {
    // Reverse auth must complete while session/send itself is still pending.
    const result = await reverse('interaction/requestProviderRuntimeHeaders', { sessionId });
    assert.equal(result.requestAuth.apiKey, 'header-secret');
    reply(id, { accepted: true, sessionId });
  }
  if (Object.hasOwn(turnFailures, scenario)) {
    event('turn.failed', { inputId: p.inputId, error: { ...turnFailures[scenario],
      message: 'header-secret private provider failure', stack: 'PRIVATE STACK', data: { authorization: 'header-secret' } } });
    active = null; return;
  }
  event('message.upserted', { content: p.content });
  const text = `Reply ${turn}`;
  event('model.streaming', { kind: 'reasoning_delta', delta: 'PRIVATE REASONING' });
  event('model.streaming', { kind: 'tool_input_delta', delta: '{"authorization":"header-secret"}' });
  event('model.streaming', { kind: 'text_delta', delta: 'Reply ' });
  await new Promise(resolve => setTimeout(resolve, 25));
  event('model.streaming', { kind: 'text_delta', delta: String(turn) });
  event('message.upserted', { content: text });
  complete(text);
}
active = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) {
    const resolve = waiting.get(m.id);
    if (resolve) { waiting.delete(m.id); resolve(m.result); }
    return;
  }
  void (async () => {
    const p = m.params;
    switch (m.method) {
      case 'provider/updateAccountConfig': {
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(process.env.HERDR_ZCODE_TOKEN, undefined);
        assert.equal(process.env.HERDR_ZCODE_SOCKET, undefined);
        assert.equal(p.basedOnZCodeBuiltinRevision, 'zcode-builtin:7:active-path-digest');
        const prefs = await reverse('session/requestRuntimePreferences', {}, m.id);
        assert.equal(prefs.askUserQuestionAutoResolutionEnabled, false);
        const auth = await reverse('interaction/requestProviderRuntimeHeaders', {});
        assert.equal(auth.requestAuth.apiKey, 'header-secret');
        if (scenario === 'startup-auth') {
          send({ id: m.id, error: { code: -32001, data: { attribution: { statusCode: 401, reason: 'auth_failed' } }, message: 'header-secret auth body' } });
          return;
        }
        if (scenario === 'hang-bootstrap') return;
        reply(m.id, {}); break;
      }
      case 'session/create': case 'session/resume':
        if (scenario.startsWith('mode-')) assert.equal(p.mode, scenario.slice(5));
        if (scenario === 'resume') { assert.equal(m.method, 'session/resume'); assert.equal(p.sessionId, sessionId); }
        assert.ok(p.workspace.workspacePath);
        if (scenario === 'snapshot-permission-reconciled') {
          const bootstrap = observedSnapshot(undefined, 1);
          bootstrap.projection.pendingPermissions = [{ requestId: 'expired-bootstrap', toolCallId: 'expired-tool', toolName: 'Write', options: [] }];
          reply(m.id, bootstrap);
        } else if (scenario === 'snapshot-reconciled' || scenario === 'startup-auth-with-provisional-turn') {
          reply(m.id, observedSnapshot('bootstrap-turn', 1));
        } else reply(m.id, snapshot());
        break;
      case 'session/setModel':
        assert.equal(p.persistAsWorkspaceLastUsed, false);
        assert.equal(p.model.options.reasoningLevel, process.env.TEST_REASONING || 'max');
        if (scenario === 'startup-auth-with-provisional-turn') {
          send({ id: m.id, error: { code: -32001, data: { attribution: { statusCode: 401, reason: 'auth_failed' } } } });
          break;
        }
        reply(m.id, snapshot()); break;
      case 'session/setMode': assert.equal(p.mode, 'guarded'); reply(m.id, {}); break;
      case 'session/subscribe':
        assert.equal(p.includeSnapshot, true);
        if (scenario === 'snapshot-reconciled' || scenario === 'snapshot-permission-reconciled') {
          seq = 2; reply(m.id, { snapshot: observedSnapshot(undefined, seq) });
        } else if (scenario === 'snapshot-background') {
          seq = 1; reply(m.id, { snapshot: observedSnapshot(undefined, seq, [{ taskId: 'snapshot-job', status: 'running' }]) });
          setTimeout(() => event('session.updated', { taskId: 'snapshot-job', status: 'completed' }), 20);
        } else reply(m.id, { snapshot: snapshot() });
        break;
      case 'session/send': await runPrompt(p, m.id); break;
      case 'session/stop':
        if (scenario === 'hang-cleanup') return;
        if (active) complete('stopped by client');
        reply(m.id, {}); break;
      case 'session/close':
        if (scenario === 'hang-cleanup') return;
        closeRequested = true; reply(m.id, { closed: true }); break;
      default: reply(m.id, {});
    }
  })().catch(error => { process.stderr.write('fixture assertion failed: ' + error.message); process.exit(2); });
});
rl.on('close', () => {
  if (scenario === 'hang-cleanup' || scenario === 'hang-bootstrap') { setInterval(() => {}, 1000); return; }
  if (scenario === 'startup-auth') return;
  assert.ok(closeRequested, 'session not closed before stdin EOF');
});
