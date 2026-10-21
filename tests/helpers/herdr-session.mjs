import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;

// An explicit disposable-server integration test, not focused-session control.
export async function testHerdrSession() {
  const directory = await mkdtemp(join(process.env.TEST_TMP_ROOT || tmpdir(), 'hz-herdr-test-'));
  const name = 'hz-test-' + randomUUID().slice(0, 12);
  const sessionDeadline = performance.now() + 250000;
  const binary = process.env.HERDR_TEST_BIN || '/Users/draccoon/.local/bin/herdr';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
  env.HERDR_CONFIG_PATH = join(directory, 'herdr.toml');
  await writeFile(env.HERDR_CONFIG_PATH, '[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
  let serverOutput = '';
  const server = spawn(binary, ['--session', name, 'server'], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverClosed = once(server, 'close');
  server.on('error', () => {});
  serverClosed.catch(() => {});
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data.toString()).slice(-8000); });
  async function raw(args, timeout = 15000) {
    const { stdout } = await exec(binary, ['--session', name, ...args], { env, cwd: directory, timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  async function call(...args) { return JSON.parse(await raw(args)).result; }
  async function until(check, timeout = 15000, description = 'condition') {
    const end = Math.min(performance.now() + timeout, sessionDeadline);
    let latest;
    while (performance.now() < end) {
      try { latest = await check(); if (latest) return latest; } catch (error) { if (error.fatal) throw error; latest = error.message; }
      await delay(100);
    }
    throw new Error(`Herdr test timed out: ${description}; last=${String(latest).slice(0, 400)}`);
  }
  let cleaned = false;
  async function close() {
    if (cleaned) return;
    cleaned = true;
    try { await raw(['session', 'stop', name, '--json']); } catch { server.kill('SIGTERM'); }
    let timer;
    await Promise.race([serverClosed.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); clearTimeout(timer);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await serverClosed.catch(() => {}); }
    try { await raw(['session', 'delete', name, '--json']); } catch { /* Report cleanup via the driver if the session directory cannot be removed. */ }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await until(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Test server exited: ' + serverOutput);
      return call('api', 'snapshot');
    }, 12000, 'disposable server startup');
  } catch (error) { await close(); throw error; }
  return { name, directory, raw, call, until, close,
    async pane(cwd, label) { return (await call('workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus')).root_pane.pane_id; },
    async run(pane, argv) { await raw(['pane', 'run', pane, argv.map(quote).join(' ')]); },
    async send(pane, text) { await raw(['pane', 'send-text', pane, text]); await raw(['pane', 'send-keys', pane, 'enter']); },
    async screen(pane) { return raw(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '160']); },
    async agents() { return (await call('api', 'snapshot')).snapshot.agents; },
  };
}
