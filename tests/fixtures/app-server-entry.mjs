// Launch the production entrypoint with explicit, offline bootstrap adapters.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/herdr-zcode-app.mjs';
export function offlineAdapters({ write = text => process.stderr.write(text) } = {}) {
let child;
return {
  // Parallel suites launch several real Node children. Process startup is not
  // a 300ms protocol deadline; reserve the short timeout for the hung-RPC test.
  rpcTimeout: process.env.TEST_SCENARIO === 'hang-cleanup' ? 300 : 3000,
  exitTimeout: 200,
  prepareDesktopRuntime: async ({ appBundle, tmpRoot, copyCatalog, skipInspect }) => {
    if (process.env.TEST_SCENARIO === 'app-bundle' && appBundle !== '/fixture/ZCode Custom.app') throw new Error('App bundle not forwarded');
    if (process.env.TEST_SCENARIO === 'runtime-flags' && (tmpRoot !== '/fixture runtime' || copyCatalog !== false || skipInspect !== true)) {
      throw new Error('Runtime options not forwarded');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    return { executable: process.execPath,
      args: [fileURLToPath(new URL('./app-server-fake.mjs', import.meta.url))],
      env: { ...process.env, HERDR_ZCODE_TOKEN: 'legacy-secret', HERDR_ZCODE_SOCKET: '/secret/socket',
        HC_TERMINAL_ID: 'fixture-terminal', HC_SOCKET: '/secret/core.sock', HC_TERMINAL_SOCKET: '/secret/terminal.sock' },
      home: '/fixture-home', configPath: '/fixture-active/catalog.json',
      close: async () => write('[runtime released]\n') };
  },
  desktopAccount: async (path, { home, model }) => {
    if (path !== '/fixture-active/catalog.json' || home !== '/fixture-home') throw new Error('Bad bootstrap');
    const selection = model ? { providerId: model.slice(0, model.indexOf('/')), modelId: model.slice(model.indexOf('/') + 1) }
      : { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' };
    return { selection, redact: text => text.replaceAll('header-secret', '[REDACTED]'), config: { revision: 'fixture-account', basedOnZCodeBuiltinRevision: 'zcode-builtin:7:active-path-digest' },
      runtimeHeaders: async () => {
        if (process.env.TEST_CAPTURE_CHILD_SCOPE === '1') write('[child runtime headers requested]\n');
        await new Promise(resolve => setTimeout(resolve, 10));
        return { headersApplied: true, requestAuth: { apiKey: 'header-secret' } };
      } };
  },
  launch: (...args) => {
    child = spawn(...args);
    if (process.env.TEST_CAPTURE_CHILD_SCOPE === '1') {
      write(`[child pid ${child.pid}]\n`);
      child.once('close', (code, signal) => write(`[child status ${code ?? signal}]\n`));
    }
    child.once('close', () => write('[child exited]\n'));
    return child;
  },
  createHerdrReporter: () => ({
    report: (state, message, sessionId) => write(`[report ${state} ${sessionId || '-'}]\n`),
    close: async () => {
      if (child && child.exitCode === null && child.signalCode === null) throw new Error('Release before exit');
      write('[reporter released]\n');
    },
  }),
};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main({}, offlineAdapters());
