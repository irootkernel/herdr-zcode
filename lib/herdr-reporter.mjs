import { spawn } from 'node:child_process';

const SOURCE = 'custom:herdr-zcode-app';
const STATES = new Set(['idle', 'working', 'blocked', 'unknown']);

// Timing overrides are local to this reporter; tests may also supply timer functions.
export function createHerdrReporter({ env = process.env, timing = {} } = {}) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_BIN_PATH ||
      !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) {
    return { report() {}, close: () => Promise.resolve() };
  }
  const childEnv = { ...env };
  const binary = childEnv.HERDR_BIN_PATH;
  const pane = childEnv.HERDR_PANE_ID;
  const timeoutMs = timing.timeoutMs ?? 750;
  const retryBaseMs = timing.retryBaseMs ?? 5_000;
  const retryMaxMs = Math.max(retryBaseMs, timing.retryMaxMs ?? 30_000);
  const later = timing.setTimeout ?? setTimeout;
  const cancel = timing.clearTimeout ?? clearTimeout;
  const now = timing.now ?? Date.now;
  let sessionId;
  let latest;
  let acknowledged;
  // Epoch microsecond scale fits safely in a JS integer and carries ordering
  // across wrapper restarts. The local counter also tolerates clock rollback.
  let sequence = now() * 1_000;
  let active;
  let retryTimer;
  let retryDelay = retryBaseMs;
  let warned = false;
  let closed = false;
  let closePromise;

  function warn() {
    if (warned) return;
    warned = true;
    // Never forward command output, error objects, environment, or session data.
    process.stderr.write('herdr-zcode: Herdr reporting unavailable; ZCode continues.\n');
  }

  function invoke(command, report) {
    sequence = Math.max(sequence + 1, now() * 1_000);
    const args = ['pane', command, pane, '--source', SOURCE, '--agent', 'zcode',
      '--seq', String(sequence)];
    if (command === 'report-agent' && sessionId) args.push('--agent-session-id', sessionId);
    if (report) args.push('--state', report.state, '--message', report.message);
    let child;
    let deadline;
    let failed = false;
    const kill = () => {
      failed = true;
      child?.kill('SIGKILL');
    };
    const promise = new Promise(resolve => {
      try {
        child = spawn(binary, args, { env: childEnv, stdio: 'ignore', shell: false });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => { failed = true; });
      // Wait for close even after an error/timeout: no overlapping writers or
      // late write completing after ownership has been released.
      child.once('close', (code, signal) => {
        cancel(deadline);
        resolve(!failed && code === 0 && signal === null);
      });
      deadline = later(kill, timeoutMs);
    });
    return { promise, kill };
  }

  function pump() {
    if (closed || active || retryTimer !== undefined || !latest ||
        latest.key === acknowledged) return;
    const sent = latest;
    const attempt = invoke('report-agent', sent);
    active = attempt;
    void attempt.promise.then(ok => {
      if (active !== attempt) return;
      active = undefined;
      if (closed) return;
      if (ok) {
        acknowledged = sent.key;
        retryDelay = retryBaseMs;
        pump();
      } else {
        // Even a failed/timed-out RPC may have applied. Reassert the latest
        // state on recovery, including a return to the last acknowledged state.
        acknowledged = undefined;
        warn();
        retryTimer = later(() => {
          retryTimer = undefined;
          pump();
        }, retryDelay);
        retryTimer?.unref?.();
        retryDelay = Math.min(retryDelay * 2, retryMaxMs);
      }
    });
  }

  return {
    report(state, message, agentSessionId) {
      if (closed || !STATES.has(state)) return;
      if (agentSessionId !== undefined) {
        if (typeof agentSessionId !== 'string' || !agentSessionId ||
            agentSessionId.length > 256) return;
        if (sessionId && sessionId !== agentSessionId) return;
        sessionId = agentSessionId;
      }
      const text = String(message || 'ZCode executor').slice(0, 256);
      latest = { state, message: text, key: JSON.stringify([state, text, sessionId]) };
      pump();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      latest = undefined;
      cancel(retryTimer);
      retryTimer = undefined;
      closePromise = (async () => {
        const pending = active;
        pending?.kill();
        await pending?.promise;
        // The caller has already awaited the actual ZCode child exit. Release
        // once even during cooldown, with the same route and a newer sequence.
        const release = invoke('release-agent');
        active = release;
        if (!await release.promise) warn();
        active = undefined;
      })();
      return closePromise;
    },
  };
}
