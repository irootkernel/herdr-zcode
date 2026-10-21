import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 8 * 1024 * 1024;
const frame = message => JSON.stringify(message) + '\n';
const PUBLIC_CODES = new Set(('invalid_model_selection model_config_missing provider_not_found provider_not_configured model_not_found invalid_model_request invalid_model_response model_request_failed model_request_auth_missing model_request_cancelled model_request_timeout model_rate_limited model_context_exceeded model_error model_timeout configuration_error permission_denied permission_timeout tool_execution_failed turn_cancelled cancelled unknown_error insufficient_quota rate_limit_exceeded invalid_api_key').split(' '));
const PUBLIC_REASONS = new Set(['rate_limited', 'auth_failed', 'invalid_request', 'context_exceeded', 'server_error', 'network_error', 'timeout', 'stream_idle_timeout', 'provider_overloaded', 'provider_not_configured', 'stale_connection', 'auth_refresh', 'offpeak_queued', 'reasoning_signature_repair', 'cancelled', 'tls_error', 'proxy_error', 'unknown']);

// Only public diagnostic fields cross into terminal output. Never forward the
// provider's message/body, which can contain a request, headers or credentials.
export function safeErrorSummary(error) {
  const attribution = error?.attribution ?? error?.data?.attribution ?? {};
  const code = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' && (/^-?\d{1,8}$/.test(value) || PUBLIC_CODES.has(value.toLowerCase())) ? value : undefined;
  const providerCode = code(attribution.providerErrorCode ?? error?.providerCode ?? error?.data?.providerCode ?? error?.data?.providerErrorCode);
  const status = attribution.statusCode ?? error?.statusCode ?? error?.data?.statusCode;
  const reason = attribution.reason ?? error?.reason ?? error?.data?.reason;
  // Older bundles may retain the business code only in an error description.
  const messageCode = typeof error?.message === 'string' ? /\b(?:code|limit)\s*[:=]?\s*["']?(\d{3,8})\b/i.exec(error.message)?.[1] : undefined;
  const businessCode = providerCode ?? messageCode;
  const errorCode = code(error?.code ?? error?.type);
  return [errorCode && `code=${errorCode}`, businessCode && `provider_code=${businessCode}`,
    Number.isInteger(status) && status >= 100 && status <= 599 && `HTTP ${status}`,
    businessCode === '1308' ? 'reason=usage limit' : PUBLIC_REASONS.has(reason) && `reason=${reason.replaceAll('_', ' ')}`].filter(Boolean).join('; ');
}

// NDJSON transport. Reverse requests run independently, even while a normal RPC
// is awaiting its response. Neither stderr nor remote error objects are logs.
export class AppServerClient extends EventEmitter {
  constructor({ executable = '/Applications/ZCode.app/Contents/MacOS/ZCode',
    args = ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'app-server', '--stdio'],
    env = process.env, cwd = process.cwd(), launch = spawn, requestTimeout = 15000,
    platform = process.platform, signalProcess = process.kill.bind(process) } = {}) {
    super();
    Object.assign(this, { executable, args, env, cwd, launch, requestTimeout, platform, signalProcess });
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.buffer = '';
  }
  handle(method, handler) { this.handlers.set(method, handler); return this; }
  start() {
    if (this.child) throw new Error('App-server already started');
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    const detached = this.platform !== 'win32';
    this.child = this.launch(this.executable, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached });
    // Only the child launched above with setsid may be a group signal target.
    if (detached && Number.isInteger(this.child.pid) && this.child.pid > 1) this.groupPid = this.child.pid;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stdout.on('error', () => this.fail(new Error('App-server output failed')));
    this.child.stdin.on('error', () => this.fail(new Error('App-server input failed')));
    this.child.stderr.resume();
    this.child.on('error', () => this.fail(new Error('App-server launch failed')));
    this.child.once('close', (code, signal) => {
      this.exited = true;
      this.resolveExit({ code, signal });
      this.fail(new Error('App-server disconnected'));
      this.emit('exit', { code, signal });
    });
    return this;
  }
  receive(chunk) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      if (end > MAX_FRAME) return this.fail(new Error('App-server frame too large'));
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('Invalid app-server frame')); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail(new Error('Invalid app-server frame'));
      this.dispatch(message);
    }
    if (this.buffer.length > MAX_FRAME) this.fail(new Error('App-server frame too large'));
  }
  dispatch(message) {
    // A reverse request's id belongs to the server's namespace.
    if (typeof message.method === 'string') {
      if (message.id === undefined) { this.emit('message', message); return; }
      let replied = false;
      const reply = (result, error) => {
        if (replied) return;
        replied = true;
        this.write(error ? { id: message.id, error } : { id: message.id, result });
      };
      const handler = this.handlers.get(message.method);
      if (!handler) { reply(undefined, { code: -32601, message: 'Unsupported client request' }); return; }
      // Admit interactions in wire order, before a later terminal notification
      // from the same stdout chunk. Await only their responses asynchronously.
      let result;
      try { result = handler(message.params ?? {}, message); }
      catch { reply(undefined, { code: -32603, message: 'Client request failed' }); return; }
      Promise.resolve(result).then(
        result => reply(result),
        () => reply(undefined, { code: -32603, message: 'Client request failed' }),
      );
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(`${pending.method} rejected`);
      error.code = typeof message.error.code === 'number' ? message.error.code : undefined;
      error.safeSummary = safeErrorSummary(message.error);
      pending.reject(error);
    } else pending.resolve(message.result);
  }
  write(message) {
    if (this.failure || !this.child?.stdin.writable) return false;
    try { this.child.stdin.write(frame(message)); return true; }
    catch { this.fail(new Error('App-server input failed')); return false; }
  }
  request(method, params = {}, timeout = this.requestTimeout) {
    if (this.failure || !this.child?.stdin.writable) return Promise.reject(new Error('App-server unavailable'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      if (!this.write({ id, method, params })) {
        clearTimeout(timer); this.pending.delete(id); reject(new Error('App-server unavailable'));
      }
    });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }
  async terminate(timeout = 1500) {
    if (!this.child) return;
    const wait = async () => {
      const deadline = performance.now() + timeout;
      for (;;) {
        // Leader close releases its pipes, not necessarily its process group.
        // Probe only the group created by our detached spawn; ESRCH is the sole
        // evidence of absence. Latch it so a recycled group id is never signaled.
        let groupGone = false, probeError;
        try { groupGone = this.ownedGroupGone(); }
        catch (error) { probeError = error; }
        if (this.exited && groupGone) return true;
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          // Teardown can briefly make the probe indeterminate. Retry within the
          // same budget, but never escalate or claim absence from that state.
          if (probeError) throw probeError;
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
      }
    };
    if (this.child.stdin.writable) this.child.stdin.end();
    if (await wait()) return;
    this.signalOwned('SIGTERM');
    if (await wait()) return;
    this.signalOwned('SIGKILL');
    if (!await wait()) throw new Error('App-server leader or owned process group exit not observed');
  }
  ownedGroupGone() {
    if (!this.groupPid || this.groupGone) return true;
    try { this.signalProcess(-this.groupPid, 0); return false; }
    catch (error) {
      if (error.code !== 'ESRCH') throw new Error('Owned app-server process group state unavailable', { cause: error });
      this.groupGone = true;
      return true;
    }
  }
  signalOwned(signal) {
    if (this.groupPid && !this.groupGone) {
      try { this.signalProcess(-this.groupPid, signal); return; }
      catch (error) {
        if (error.code !== 'ESRCH') throw new Error('Owned app-server process group signal failed', { cause: error });
        this.groupGone = true;
      }
    }
    if (!this.exited && this.child.exitCode == null && this.child.signalCode == null) this.child.kill(signal);
  }
}
