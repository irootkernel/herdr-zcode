import { createHerdrReporter } from './herdr-reporter.mjs';

export const RUNTIMES = Object.freeze(['tui', 'core']);
export const INPUT_REQUIRED = 'ZCode input required';

export function mapCanonicalToLegacyState(snapshot, unavailable) {
  if (snapshot.state === 'blocked' && snapshot.message === INPUT_REQUIRED) return 'blocked';
  if (unavailable || snapshot.state === 'starting') return 'unknown';
  if (snapshot.state === 'done' || snapshot.state === 'error') return 'idle';
  // TUI reports input readiness. A failed turn is distinct from a pending
  // interaction, including a turn that failed for lack of permission.
  if (snapshot.state === 'blocked') return 'idle';
  return snapshot.state;
}

export function adaptLegacyReporter(reporter) {
  return {
    report: (snapshot, unavailable) => reporter.report(mapCanonicalToLegacyState(snapshot, unavailable), snapshot.message, snapshot.sessionId),
    close: () => reporter.close(),
  };
}

export function createRuntimeProfile(runtime, { env, output, flushOutput, adapters = {} } = {}) {
  if (runtime === 'tui') {
    const createReporter = adapters.createHerdrReporter ?? createHerdrReporter;
    return { name: runtime, detached: true, fastTeardown: false, defaultModelEnabled: true,
      createReporter: () => adaptLegacyReporter(createReporter({ env })) };
  }
  if (runtime === 'core') {
    return { name: runtime, detached: false, fastTeardown: true, defaultModelEnabled: true,
      createReporter: () => adapters.createOsc7501Reporter?.({ writeRaw: text => output.write(text), flushOutput })
        ?? { report() {}, close() {} } };
  }
  throw new Error('Use runtime tui or core');
}
