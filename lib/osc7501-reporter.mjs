const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const BLOCKED_KINDS = new Set(['auth', 'quota', 'rate_limit', 'permission', 'question']);

export function formatOsc7501({ state, kind }) {
  if (!STATES.has(state)) return;
  const detail = state === 'blocked' && BLOCKED_KINDS.has(kind) ? `:kind=${kind}` : '';
  return `\x1b]7501;state=${state}${detail}\x07`;
}

export function createOsc7501Reporter({ writeRaw, flushOutput }) {
  let lastFrame, lastTurnId;
  return {
    report(snapshot) {
      const frame = formatOsc7501(snapshot);
      if (!frame) return;
      const { turnId } = snapshot;
      if (frame === lastFrame && (turnId === lastTurnId || !turnId || !lastTurnId)) {
        lastTurnId ??= turnId;
        return;
      }
      flushOutput();
      writeRaw(frame);
      lastFrame = frame;
      lastTurnId = turnId;
    },
    async close() {},
  };
}
