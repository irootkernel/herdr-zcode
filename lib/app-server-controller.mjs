import { randomUUID } from 'node:crypto';
import { classifyFailure, ERROR_RESULTS } from './error-classification.mjs';
import { INPUT_REQUIRED, mapCanonicalToLegacyState } from './runtime-profile.mjs';

const terminalText = text => String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  .replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
function inputPreview(input) {
  return JSON.stringify(input, (key, value) => {
    if (/password|authorization|cookie|token|secret|api[-_]?key|credential|headers|requestAuth/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return value.replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s'"]+/gi, '$1[REDACTED]')
      .replace(/\b((?:api[-_]?key|password|secret|token)\s*[=:]\s*)[^\s'"]+/gi, '$1[REDACTED]');
    return value;
  }, 2);
}

const HELP = 'Prompt text queues a turn. /help /status /stop /exit\n/allow <id> (once) /deny <id> /choose <id> <option> /answer <id> <text>\nFor multiple questions, /answer <id> {"question text":"answer",...}';
const endedStatus = status => ['completed', 'failed', 'cancelled', 'stopped', 'error', 'timed_out', 'spawn_error', 'lost'].includes(status);
const decline = kind => kind === 'permission' ? { decision: 'deny', reason: 'Client declined request' } : { action: 'decline' };

// The only owner of input admission, session/turn correlation and interactions.
// Output and the asynchronous reporter are adapters; neither owns protocol state.
export class AppServerController {
  constructor({ client, reporter, reportBeforeReady = true, output = text => process.stdout.write(text), rpcTimeout = 15000 }) {
    Object.assign(this, { client, reporter, reportBeforeReady, output, rpcTimeout });
    this.queue = [];
    this.interactions = new Map();
    this.settled = new Map();
    this.finishedTurns = new Set();
    this.background = new Map();
    this.lastOutcome = null;
    this.bufferedEvents = [];
    this.lastSeq = 0;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    client.handle('interaction/requestPermission', params => this.interact('permission', params));
    client.handle('interaction/requestUserInput', params => this.interact('question', params));
    client.on('message', message => this.event(message));
    client.on('closed', error => this.abort('App-server disconnected; cancellation unconfirmed.', error));
  }
  print(text) { this.output(terminalText(text) + '\n'); }
  status() {
    const snapshot = {
      state: 'idle', kind: undefined, message: 'ZCode executor', sessionId: this.sessionId,
      turnId: this.current?.turnId ?? this.lastOutcome?.turnId, diagnostic: '',
    };
    if (this.interactions.size) {
      const kind = [...this.interactions.values()].some(item => item.kind === 'permission') ? 'permission' : 'question';
      return { ...snapshot, state: 'blocked', kind, message: INPUT_REQUIRED };
    }
    if (this.uncertain || this.closing) {
      // An explicit RPC rejection has a terminal outcome even though TUI is
      // no longer accepting input. An ambiguous loss of transport stays unknown.
      if (this.terminalFailure) {
        const { state, kind, diagnostic } = this.terminalFailure;
        return { ...snapshot, state, kind, diagnostic };
      }
      return { ...snapshot, state: 'unknown' };
    }
    if (!this.ready) return { ...snapshot, state: 'starting' };
    if (this.current || this.sending || this.stopping || this.background.size) return { ...snapshot, state: 'working' };
    if (this.lastOutcome) {
      const { state, kind, diagnostic } = this.lastOutcome;
      return { ...snapshot, state, kind, diagnostic };
    }
    return snapshot;
  }
  state() { return mapCanonicalToLegacyState(this.status(), this.uncertain || this.closing); }
  report() {
    if (!this.ready && !this.reportBeforeReady) return;
    // report() is a fire-and-forget enqueue per the reporter interface.
    try { this.reporter?.report(this.status(), this.uncertain || this.closing); } catch { /* reporting cannot interrupt IO */ }
  }
  attach(sessionId, snapshot, eventSeq = 0) {
    this.sessionId = sessionId;
    this.snapshot(snapshot);
    this.lastSeq = Math.max(this.lastSeq, eventSeq);
    this.stateRevision = snapshot?.runtime?.stateRevision ?? -1;
    this.ready = true;
    for (const message of this.bufferedEvents.splice(0)) this.event(message);
    this.print(`ZCode session: ${sessionId}`);
    this.report();
    if (this.stopBeforeReady) void this.stop(false);
    else this.pump();
  }
  snapshot(value) {
    const snapshot = value?.snapshot ?? value;
    const projection = snapshot?.projection;
    if (!projection || projection.sessionId !== this.sessionId) return;
    const { eventSeq, stateRevision } = snapshot.runtime ?? {};
    if ((Number.isInteger(eventSeq) && eventSeq < this.snapshotSeq) ||
        (Number.isInteger(stateRevision) && stateRevision < this.snapshotRevision)) return;
    if (Number.isInteger(eventSeq)) this.snapshotSeq = eventSeq;
    if (Number.isInteger(stateRevision)) this.snapshotRevision = stateRevision;
    if (Array.isArray(projection.backgroundJobs)) {
      for (const [key, item] of this.background) if (item.job || item.task) this.background.delete(key);
      for (const job of projection.backgroundJobs) {
        const id = job.taskId ?? job.id;
        if (id && !endedStatus(job.status)) this.background.set(`task:${id}`, { job: true, task: true, id });
      }
    }
    // A cold-resumed active session is work, not input readiness. Terminal events
    // can finish this observed turn; they cannot finish a different submitted one.
    const activeTurnId = snapshot.runtime ? snapshot.runtime.activeTurnId
      : ['running', 'waiting'].includes(projection.status) ? projection.currentTurnId : undefined;
    if ((!this.current || this.current.resumed) && (snapshot.runtime || typeof projection.status === 'string')) {
      // Absence in a newer authoritative snapshot is an idle observation. Do
      // not preserve an earlier bootstrap turn or clear a locally submitted one.
      if (activeTurnId && activeTurnId !== this.current?.turnId) this.lastOutcome = null;
      this.current = activeTurnId ? (this.current?.turnId === activeTurnId ? this.current
        : { turnId: activeTurnId, text: '', resumed: true }) : null;
    }
    if (Array.isArray(projection.pendingPermissions)) {
      const pendingIds = new Set(projection.pendingPermissions.map(params => params.requestId));
      // Bootstrap observations have no response channel. A newer authoritative
      // list can retire them; a live event/RPC remains owned by its resolution.
      for (const [id, item] of this.interactions) {
        if (item.snapshotOnly && !item.waiters.length && !pendingIds.has(id)) this.settle(id, decline(item.kind));
      }
      for (const params of projection.pendingPermissions) {
        if (!this.ended && !this.closing && !this.settled.has(params.requestId)) this.register('permission', { ...params, sessionId: this.sessionId }, true);
      }
    }
  }
  input(line) {
    if (this.closing) return;
    const text = line.trim();
    if (!text) return;
    if (!text.startsWith('/')) return this.prompt(line);
    if (text === '/help') return this.print(HELP);
    if (text === '/status') return this.print(`State: ${this.state()}; queued: ${this.queue.length}; pending: ${[...this.interactions.keys()].join(', ') || 'none'}; background: ${this.background.size}`);
    if (text === '/exit') { this.closing = true; this.queue.length = 0; this.resolveDone(); this.report(); return; }
    if (text === '/stop') { void this.stop(); return; }
    const match = /^\/(allow|deny|choose|answer)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
    if (!match) return this.print('Unknown command. Use /help.');
    this.respond(match[1], match[2], match[3]);
  }
  prompt(content) {
    if (this.closing || !content.trim()) return;
    this.queue.push(content); this.pump();
  }
  eof() {
    this.ended = true;
    for (const id of [...this.interactions.keys()]) this.settle(id, decline(this.interactions.get(id).kind));
    this.pump();
  }
  checkDrain() {
    if (this.ended && this.ready && !this.current && !this.sending && !this.stopping && !this.queue.length && !this.background.size && !this.interactions.size) this.resolveDone();
  }
  async pump() {
    if (!this.ready || this.closing || this.uncertain || this.stopping || this.sending || this.current || this.interactions.size) return;
    if (!this.queue.length) { this.checkDrain(); return; }
    const turn = { inputId: randomUUID(), content: this.queue.shift(), text: '' };
    this.lastOutcome = null;
    this.current = turn;
    this.sending = true;
    this.report();
    try {
      const response = await this.client.request('session/send', { sessionId: this.sessionId, inputId: turn.inputId, content: turn.content }, this.rpcTimeout);
      if (response?.accepted !== true || response.sessionId !== this.sessionId) throw new Error('Invalid send acknowledgment');
    } catch (error) {
      // A timed-out ACK does not prove the server rejected or stopped the turn.
      this.abort('Prompt submission failed; execution state unknown.', error);
    } finally {
      this.sending = false;
      this.report();
      this.pump();
    }
  }
  register(kind, params, snapshotOnly = false) {
    const id = params.requestId;
    if (!id) return;
    const existing = this.interactions.get(id);
    if (existing) {
      if (!snapshotOnly) existing.snapshotOnly = false;
      return;
    }
    this.interactions.set(id, { kind, params, waiters: [], snapshotOnly });
    this.print(`[${kind}] ${id}: ${params.toolName || ''} ${params.reason || params.prompt || ''}`);
    if (params.origin) {
      const origin = params.origin;
      this.print(`  Child origin: ${origin.agentId || origin.childSessionId || 'subagent'}${origin.agentType ? ' (' + origin.agentType + ')' : ''}; session=${origin.childSessionId || 'unknown'}${origin.description ? '; ' + origin.description : ''}`);
    }
    if (kind === 'permission') {
      this.print(`  Proposed input:\n${inputPreview(params.input) ?? '(not supplied)'}`);
      for (const option of params.options ?? []) this.print(`  ${option.optionId}: ${option.name} (${option.kind})${option.description ? ' — ' + option.description : ''}`);
    } else {
      for (const question of params.questions ?? []) {
        this.print(`  ${question.question}${question.multiSelect ? ' (multiple choices)' : ''}`);
        for (const option of question.options ?? []) this.print(`    ${option.value}: ${option.label}${option.description ? ' — ' + option.description : ''}`);
      }
    }
    this.print(`Use /${kind === 'permission' ? 'choose' : 'answer'} ${id} ... or /deny ${id}`);
    this.report();
  }
  interact(kind, params) {
    if (this.closing || this.stopping || this.ended || params.sessionId !== this.sessionId || !params.requestId) return decline(kind);
    if (!this.interactionBelongs(params)) return decline(kind);
    if (this.settled.has(params.requestId)) return this.settled.get(params.requestId);
    const previous = this.interactions.get(params.requestId);
    this.register(kind, params);
    if (previous && kind === 'permission' && JSON.stringify([previous.params.input, previous.params.origin]) !== JSON.stringify([params.input, params.origin])) {
      this.print(`  Updated proposed input:\n${inputPreview(params.input) ?? '(not supplied)'}`);
      if (params.origin) this.print(`  Child origin: ${params.origin.agentId || params.origin.childSessionId}; session=${params.origin.childSessionId || 'unknown'}`);
    }
    const interaction = this.interactions.get(params.requestId);
    interaction.kind = kind;
    interaction.params = params; // reverse RPC carries the authoritative options
    return new Promise(resolve => interaction.waiters.push(resolve));
  }
  interactionBelongs(params) {
    return params.origin || !params.turnId || (this.current && !this.finishedTurns.has(params.turnId) &&
      (!this.current.turnId || params.turnId === this.current.turnId));
  }
  settle(id, result) {
    const interaction = this.interactions.get(id);
    if (!interaction) return;
    this.interactions.delete(id);
    // A completed request is a tombstone, never a cached approval for a later
    // reverse request. Concurrent wire reannouncements share the live waiters.
    this.settled.set(id, decline(interaction.kind));
    if (this.settled.size > 1000) this.settled.delete(this.settled.keys().next().value);
    for (const resolve of interaction.waiters) resolve(result);
    this.report();
    queueMicrotask(() => this.pump());
  }
  respond(command, id, value) {
    const item = this.interactions.get(id);
    if (!item) return this.print(`Unknown or resolved request: ${id}`);
    // Do not drop a snapshot request before its reverse RPC can receive the answer.
    if (!item.waiters.length) return this.print('Request is waiting for its response channel; retry shortly.');
    if (command === 'deny') {
      const advertised = item.kind === 'permission' && item.params.options?.find(option => option.kind === 'deny' && option.response?.decision === 'deny');
      return this.settle(id, advertised?.response ?? decline(item.kind));
    }
    if (item.kind === 'permission') {
      const options = item.params.options ?? [];
      const option = command === 'allow'
        ? options.find(option => option.kind === 'allow_once' && option.response?.decision === 'allow')
        : command === 'choose' ? options.find(option => option.optionId === value) : undefined;
      if (!option?.response) return this.print('Choose an advertised option; /allow requires an allow_once option.');
      this.settle(id, option.response);
      return;
    }
    const questions = item.params.questions ?? [];
    if (!['answer', 'choose'].includes(command) || !value) return this.print('Use /answer or /choose with a value.');
    let content;
    if (questions.length > 1) {
      try {
        const answers = JSON.parse(value);
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) || questions.some(q => typeof answers[q.question] !== 'string' || !answers[q.question].trim())) throw new Error();
        content = { answers };
      } catch { return this.print('Answer every question using a JSON object keyed by question text.'); }
    } else {
      const question = questions[0];
      const selected = question?.options?.find(option => option.value === value);
      if (command === 'choose' && !selected) return this.print('Choose an advertised question option value.');
      const answer = selected?.value ?? value;
      content = question ? { answer, answers: { [question.question]: answer } } : { answer };
    }
    this.settle(id, { action: 'accept', content });
  }
  event(message) {
    if (!this.ready) {
      if (this.bufferedEvents.length >= 10000) this.abort('Startup event backlog exceeded; execution state unknown.');
      else this.bufferedEvents.push(message);
      return;
    }
    if (message.method === 'state.updated') {
      const state = message.params;
      if (state?.sessionId !== this.sessionId) return;
      if (Number.isInteger(state.revision)) {
        if (state.revision <= this.stateRevision) return;
        this.stateRevision = state.revision;
      }
      const model = state.patch?.model?.current;
      if (model && this.expectedModel && (model.providerId !== this.expectedModel.providerId || model.modelId !== this.expectedModel.modelId)) {
        this.abort('ZCode changed the selected model; execution state unknown.');
        return;
      }
      this.snapshot(state.patch);
      this.report(); this.pump();
      return;
    }
    if (message.method !== 'session/event') return;
    const event = message.params?.event ?? message.params;
    if (!event || event.sessionId !== this.sessionId) return;
    if (Number.isInteger(event.seq)) {
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
    }
    const p = event.payload ?? {};
    if (p.toModelSelection && this.expectedModel &&
        (p.toModelSelection.providerId !== this.expectedModel.providerId || p.toModelSelection.modelId !== this.expectedModel.modelId)) {
      this.abort('ZCode changed the execution model; cancellation required.');
      return;
    }
    const child = p.source === 'subagent' || p.childSessionId || p.parentToolUseId;
    if (event.type === 'permission.resolved' || event.type === 'userInput.resolved') {
      const item = this.interactions.get(p.requestId);
      if (item) this.settle(p.requestId, decline(item.kind));
      return;
    }
    if (event.type === 'permission.requested' || event.type === 'userInput.requested') {
      if (!this.closing && !this.stopping && !this.ended && !this.settled.has(p.requestId) &&
          this.interactionBelongs({ ...p, turnId: event.turnId })) this.register(event.type === 'permission.requested' ? 'permission' : 'question', { ...p, sessionId: event.sessionId, turnId: event.turnId });
      return;
    }
    if (event.type === 'tool.updated') {
      this.print(`[${child ? 'subagent tool' : 'tool'}] ${p.toolName || p.toolCallId || ''}: ${p.kind || 'updated'}`);
      if (p.background && p.toolCallId) {
        const key = `tool:${p.toolCallId}`;
        if (['result', 'error'].includes(p.kind)) this.background.delete(key);
        else this.background.set(key, { id: p.toolCallId });
      }
    }
    if (event.type === 'session.updated') {
      const id = p.taskId ?? p.agentId;
      if (id && p.status) {
        const key = `${p.taskId ? 'task' : 'agent'}:${id}`;
        this.print(`[${p.agentId ? 'subagent' : 'background'}] ${id}: ${p.status}`);
        if (endedStatus(p.status)) this.background.delete(key);
        else if (p.agentId || p.status === 'running') this.background.set(key, { id, task: Boolean(p.taskId) });
      }
    }
    if (child) { this.report(); this.checkDrain(); return; }
    const turn = this.current;
    const inputId = p.inputId ?? p.queryId;
    if (event.type === 'turn.started') {
      if (this.finishedTurns.has(event.turnId)) return;
      if (turn?.inputId && inputId && inputId !== turn.inputId) return;
      if (turn?.turnId && event.turnId && event.turnId !== turn.turnId) return;
      this.lastOutcome = null;
      if (turn) turn.turnId = event.turnId;
      else if (this.ready) this.current = { turnId: event.turnId, inputId, text: '', resumed: true };
      this.report();
      return;
    }
    if (!turn || (turn.inputId && inputId && inputId !== turn.inputId) || (event.turnId && event.turnId !== turn.turnId)) { this.report(); this.checkDrain(); return; }
    if (event.type === 'model.streaming' && p.kind === 'text_delta' && typeof p.delta === 'string') {
      this.output(terminalText(p.delta));
      turn.text += p.delta;
    }
    // Legacy message.upserted has no role or message id. It can represent the
    // user's own input; completion.response is the unambiguous final fallback.
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      if (typeof p.response === 'string' && p.response && !turn.text.endsWith(p.response)) this.print(p.response);
      else if (turn.text) this.output('\n');
      const failed = event.type === 'turn.failed' || (typeof p.resultType === 'string' && p.resultType.startsWith('error_'));
      this.lastOutcome = { turnId: turn.turnId, ...(failed ? classifyFailure(p.error, p.resultType)
        : { state: p.resultType === 'cancelled' ? 'idle' : 'done', diagnostic: '' }) };
      const { diagnostic } = this.lastOutcome;
      const failureReason = ERROR_RESULTS.has(p.resultType) ? p.resultType : 'Provider/runtime failure';
      this.print(failed ? `[turn failed] ${failureReason}.${diagnostic ? ' ' + diagnostic : ''}` : `[turn completed${p.resultType === 'cancelled' ? ': cancelled' : ''}]`);
      if (failed) this.failed = true;
      if (turn.turnId) this.finishedTurns.add(turn.turnId);
      this.current = null;
      // A turn's terminal event never resolves any permission or question.
      this.report(); this.pump();
    }
  }
  abort(message, error) {
    if (this.closing) return;
    const failure = error?.failure ?? classifyFailure(error);
    this.terminalFailure = error?.failure;
    this.lastOutcome = { ...failure, turnId: this.current?.turnId };
    this.print(failure.diagnostic ? `${message} ${failure.diagnostic}` : message);
    this.failed = true; this.uncertain = true; this.closing = true;
    this.queue.length = 0;
    this.report(); this.resolveDone();
  }
  async stop(discardQueued = true) {
    if (discardQueued) this.queue.length = 0;
    if (!this.ready) { this.stopBeforeReady = true; return; }
    if (this.stopping || this.closing) return;
    this.stopping = true;
    for (const [id, item] of this.interactions) this.settle(id, decline(item.kind));
    this.report();
    try {
      await this.client.request('session/stop', { sessionId: this.sessionId }, this.rpcTimeout);
      for (const item of this.background.values()) if (item.job || item.task) await this.client.request('session/cancelBackgroundTask', { sessionId: this.sessionId, taskId: item.id }, this.rpcTimeout);
      this.print('Stop requested; waiting for terminal events.');
    } catch { this.abort('Stop failed or timed out; cancellation unconfirmed.'); }
    finally { this.stopping = false; this.report(); this.pump(); }
  }
  closeInput() {
    this.closing = true;
    this.queue.length = 0;
    for (const [id, item] of this.interactions) this.settle(id, decline(item.kind));
    this.report();
    this.resolveDone();
  }
  async shutdown(rpcTimeout = this.rpcTimeout) {
    this.closeInput();
    if (this.sessionId && !this.client.failure) {
      for (const method of ['session/stop', 'session/close']) {
        try {
          const result = await this.client.request(method, { sessionId: this.sessionId }, rpcTimeout);
          if (method === 'session/close' && result?.closed !== true) throw new Error();
        } catch { this.failed = true; this.print(`${method} unconfirmed.`); }
      }
    }
  }
}
