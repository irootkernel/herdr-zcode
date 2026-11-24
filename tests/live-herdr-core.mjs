import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_MODEL, desktopAccount } from '../lib/desktop-account.mjs';
import { createKeychainSource } from '../lib/desktop-keychain.mjs';
import { desktopCatalogCachePath } from '../lib/desktop-runtime.mjs';
import { readToolchains } from '../lib/toolchain.mjs';

const exec = promisify(execFile);
const workingPath = '/usr/bin:/bin';
const statOptions = { bigint: true };
const killBudget = 200;
const epicKillBudget = 150;
const killObservationLimit = 1000;
const installedModel = 'account:zai-individual-coding-plan/GLM-5.4';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

class CheckFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

function publicStatus(observation) {
  const status = observation?.status;
  const { state, kind } = typeof status === 'string' ? { state: status } : status ?? {};
  return {
    state: ['idle', 'working', 'done', 'blocked', 'error'].includes(state) ? state : null,
    kind: ['auth', 'quota', 'rate_limit', 'permission', 'question'].includes(kind) ? kind : null,
    turn: Number.isSafeInteger(observation?.turn) ? observation.turn : null,
  };
}

async function findHc() {
  for (const path of (process.env.PATH || workingPath).split(delimiter).filter(Boolean)) {
    const candidate = resolve(path, 'hc');
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new CheckFailure('hc 0.1.20 must be available on PATH');
}

async function project(source, destination) {
  let bytes;
  try {
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat(statOptions);
      if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
          (before.mode & 0o077n) !== 0n || (before.mode & 0o400n) === 0n ||
          before.size < 1n || before.size > 65536n) throw new Error();
      const size = Number(before.size);
      bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat(statOptions);
      if (offset !== size || after.size !== before.size || after.ctimeNs !== before.ctimeNs ||
          after.mtimeNs !== before.mtimeNs) throw new Error();
      await writeFile(destination, bytes.subarray(0, size), { flag: 'wx', mode: 0o600 });
    } finally {
      await file.close();
    }
  } catch {
    throw new CheckFailure('Live auth source must be a readable, private, single-linked regular file owned by the caller, at most 64 KiB');
  } finally {
    bytes?.fill(0);
  }
}

async function projectDesktopAccount(bundle, executable, destination) {
  let bytes;
  try {
    const account = await desktopAccount(join(bundle, 'Contents/Resources/config/provider/zcode-builtin.json'), {
      model: DEFAULT_MODEL, withOSCredentialReader: createKeychainSource(bundle, executable),
    });
    const { providerId } = account.selection;
    const accountAccess = { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' };
    const headers = await account.runtimeHeaders({ providerId, accountAccess });
    const apiKey = headers.requestAuth?.apiKey;
    if (!headers.headersApplied || typeof apiKey !== 'string' || !apiKey) throw new Error();
    bytes = Buffer.from(JSON.stringify({ providerId, identity: account.config.revision, accountAccess, apiKey }));
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new CheckFailure('Could not project the current Z.AI Coding Plan login. Check ZCode Desktop sign-in or set HERDR_ZCODE_LIVE_AUTH_FILE.');
  } finally {
    bytes?.fill(0);
  }
}

async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function desktopDigests(home, version) {
  const paths = ['setting.json', 'credentials.json'].map(name => join(home, '.zcode/v2', name));
  paths.push(desktopCatalogCachePath(home, version));
  return Promise.all(paths.map(async path => {
    try { return sha256(await readFile(path)); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new CheckFailure('Could not fingerprint native Desktop state');
    }
  }));
}

async function wipeRemainingAuth(path) {
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return; throw new CheckFailure('Could not open remaining projected auth for cleanup'); }
  try {
    const info = await handle.stat();
    check(info.isFile() && info.uid === process.getuid() && info.nlink === 1 && info.size <= 65536, 'Remaining auth file could not be safely wiped');
    const zeros = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < zeros.length) {
      const { bytesWritten } = await handle.write(zeros, offset, zeros.length - offset, offset);
      check(bytesWritten > 0, 'Could not wipe remaining projected auth');
      offset += bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
}

async function prepareInstalledInputs(binary, root, bundle, auth, version, options) {
  const home = process.env.HOME;
  check(home && home.startsWith('/'), 'Installed certification requires the absolute trusted host HOME');
  const env = { HOME: home, PATH: workingPath, TMPDIR: '/tmp' };
  const execInstalled = async args => {
    try {
      const { stdout } = await exec(binary, args, { cwd: '/private/var/empty', env, signal: options.signal, timeout: 15000 });
      return JSON.parse(stdout);
    } catch { throw new CheckFailure('Installed companion CLI did not return a successful JSON result'); }
  };
  const metadata = await execInstalled(['--version', '--json']);
  check(metadata.version === '0.2.0' && Array.isArray(metadata.capabilities) &&
    ['core', 'osc7501', 'catalogFile', 'prepareIsolated', 'checkDesktop'].every(name => metadata.capabilities.includes(name)),
    'Installed companion CLI does not advertise the expected 0.2.0 capabilities');
  const before = await desktopDigests(home, version);
  const receipt = await execInstalled(['prepare-isolated', '--out-dir', root, '--app-bundle', bundle]);
  const catalog = join(root, 'catalog.json');
  const [authInfo, catalogInfo] = await Promise.all([lstat(auth), lstat(catalog)]);
  check(receipt.authFile === auth && receipt.catalogFile === catalog && receipt.appVersion === version &&
    receipt.minZcodeAppVersion === readToolchains().ZCODE_APP_MIN_VERSION &&
    receipt.providerId === 'account:zai-individual-coding-plan' &&
    typeof receipt.accountIdentitySHA256 === 'string' && /^[0-9a-f]{64}$/.test(receipt.accountIdentitySHA256) &&
    ['desktop-cache', 'bundled'].includes(receipt.catalogSource) && Number.isSafeInteger(receipt.catalogRevision) &&
    receipt.catalogRevision > 0 && receipt.catalogSHA256 === sha256(await readFile(catalog)),
    'Prepared receipt does not describe the owned input files');
  check(authInfo.isFile() && (authInfo.mode & 0o7777) === 0o600 &&
    catalogInfo.isFile() && (catalogInfo.mode & 0o7777) === 0o400, 'Prepared inputs do not have the required private modes');
  const publicReceipt = { catalogSource: receipt.catalogSource, catalogRevision: receipt.catalogRevision,
    catalogSHA256: receipt.catalogSHA256, appVersion: receipt.appVersion, minZcodeAppVersion: receipt.minZcodeAppVersion };
  return { before, home, catalog, publicReceipt };
}

async function appServerPid(parent, app, options) {
  const { stdout } = await exec('/usr/bin/pgrep', ['-P', String(parent)], options).catch(error => {
    if (error.code !== 1 || error.killed || error.signal) throw error;
    return { stdout: '' };
  });
  const children = stdout.trim().split(/\s+/).filter(pid => /^[1-9][0-9]*$/.test(pid));
  check(children.length, 'hc terminal did not have a live app-server child');
  const processes = await exec('/bin/ps', ['-p', [parent, ...children].join(','), '-o', 'pid=,ppid=,pgid='], options);
  const rows = processes.stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/)).filter(Boolean);
  const pane = rows.find(([, pid]) => Number(pid) === parent);
  check(pane, 'hc wrapper process disappeared');
  const mappedApp = await realpath(app);
  const matches = [];
  for (const [, pid, ppid, pgid] of rows) {
    if (Number(ppid) !== parent || pgid !== pane[3]) continue;
    // ZCode can replace its argv and process title after launch.
    const { stdout: mapped } = await exec('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'txt', '-Fn'], options);
    if (mapped.split('\n').includes(`n${mappedApp}`)) matches.push(Number(pid));
  }
  check(matches.length === 1,
    'Expected exactly one owned ZCode app-server in the hc terminal process group');
  return matches[0];
}

function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

async function killAndMeasure(hcCommand, address, wrapperPid, appServerPid) {
  const pids = { wrapper: wrapperPid, appServer: appServerPid };
  check(Object.values(pids).every(pid => !gone(pid)), 'Both owned processes must be alive before the teardown check');
  const started = performance.now();
  const result = hcCommand(['kill', '--json', address], 'hc kill failed', { cleanup: true, timeout: 10000 })
    .then(() => true, () => false);
  const firstEsrchMs = { wrapper: null, appServer: null };
  while (performance.now() - started < killObservationLimit) {
    for (const [name, pid] of Object.entries(pids)) {
      if (firstEsrchMs[name] === null && gone(pid)) firstEsrchMs[name] = performance.now() - started;
    }
    if (Object.values(firstEsrchMs).every(value => value !== null)) break;
    await pause(1);
  }
  const timing = JSON.stringify(firstEsrchMs);
  check(await result, `hc kill failed. First ESRCH in ms ${timing}`);
  check(Object.values(firstEsrchMs).every(value => value !== null && value < killBudget),
    `Both owned processes must reach ESRCH within ${killBudget} ms. First ESRCH in ms ${timing}`);
  const elapsed = Math.max(...Object.values(firstEsrchMs));
  check(elapsed < epicKillBudget, `Both owned processes must reach ESRCH within ${epicKillBudget} ms. First ESRCH in ms ${timing}`);
  return { elapsed, firstEsrchMs };
}

async function run(signal) {
  const args = process.argv.slice(2);
  const installed = args.length === 3 && args[1] === '--scenario' && args[2] === 'installed-candidate';
  check(args[0] === '--authorize-live' && (args.length === 1 || installed),
    'Pass --authorize-live, optionally with --scenario installed-candidate, to run the real herdr-core and Z.AI test');
  const authSource = process.env.HERDR_ZCODE_LIVE_AUTH_FILE;
  check(process.platform === 'darwin', 'The live herdr-core test requires macOS and ZCode Desktop');
  const checkoutBinary = fileURLToPath(new URL('../bin/herdr-zcode', import.meta.url));
  const binary = process.env.HERDR_ZCODE_LIVE_BINARY ? resolve(process.env.HERDR_ZCODE_LIVE_BINARY) : checkoutBinary;
  const hc = await findHc();
  await access(binary, constants.X_OK);
  if (installed) {
    check(authSource === undefined && await realpath(binary) !== await realpath(checkoutBinary),
      'Installed certification requires HERDR_ZCODE_LIVE_BINARY to select the installed package and uses native host preparation');
  }
  process.umask(0o077);
  const root = await mkdtemp(join(await realpath('/tmp'), 'hz6.'));
  const cwd = join(root, 'cwd');
  const scratch = join(root, 'scratch');
  const input = join(scratch, 'input/prompt.md');
  const output = join(scratch, 'output/result.txt');
  const auth = join(root, 'auth.json');
  const env = {
    HOME: join(root, 'home'), PATH: workingPath, TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'cfg'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run'), XDG_STATE_HOME: join(root, 'state'),
  };
  const session = `hz6-${randomUUID().slice(0, 18)}`;
  const options = { cwd, env: { ...env, HC_SESSION: session, SHELL: '/bin/sh' }, signal, timeout: 5000 };
  async function hcCommand(args, message, { cleanup = false, timeout = options.timeout } = {}) {
    try {
      const { stdout } = await exec(hc, args, { ...options, signal: cleanup ? undefined : signal, timeout });
      return JSON.parse(stdout);
    } catch {
      throw new CheckFailure(message);
    }
  }

  let serverAttempted = false;
  let serverPid;
  let address;
  let killed = false;
  let result;
  let prepared;
  try {
    await Promise.all([cwd, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME,
      env.XDG_RUNTIME_DIR, env.XDG_STATE_HOME, join(scratch, 'input'), join(scratch, 'output')]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    if (!installed && authSource !== undefined) await project(resolve(authSource), auth);
    const expected = Buffer.from(`herdr-zcode Core fixture ${randomUUID()}\n`);
    await writeFile(input, expected, { flag: 'wx', mode: 0o600 });
    const { stdout: version } = await exec(hc, ['--version'], options);
    check(version.trim() === 'hc 0.1.20', 'The live herdr-core test requires hc 0.1.20');
    const bundle = await realpath('/Applications/ZCode.app');
    const executable = join(bundle, 'Contents/MacOS/ZCode');
    const { stdout: appVersion } = await exec('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'Contents/Info.plist')], options);
    // The launcher enforces the pinned minimum before a session can report idle.
    check(/^\d+\.\d+\.\d+$/.test(appVersion.trim()), 'Could not read the installed ZCode Desktop version');
    if (installed) {
      check(appVersion.trim() === '4.0.0', 'Installed candidate certification requires ZCode Desktop 4.0.0');
      prepared = await prepareInstalledInputs(binary, root, bundle, auth, appVersion.trim(), options);
    } else if (authSource === undefined) await projectDesktopAccount(bundle, executable, auth);
    signal.throwIfAborted();

    serverAttempted = true;
    const server = await hcCommand(['server', '--json', 'start'], 'Could not start the isolated hc server');
    check(Number.isSafeInteger(server.pid) && server.pid > 1 && server.live === 0 && server.finished === 0,
      'The isolated hc server did not report an empty terminal state');
    serverPid = server.pid;
    const terminalEnv = Object.entries(env).map(([name, value]) => `${name}=${value}`);
    const terminal = await hcCommand(['run', '--bg', '--json', '--cwd', cwd, '--no-parent', '--no-notify', '--',
      '/usr/bin/env', '-i', ...terminalEnv, binary,
      '--runtime', 'core', '--non-interactive', '--model', installed ? installedModel : DEFAULT_MODEL, '--mode', 'yolo', '--disable-mcp', '--disable-title-gen',
      '--disable-offpeak', '--disable-dynamic-workflow',
      '--tool-allowlist', 'Read,Write', '--additional-dir', scratch, '--cwd', cwd,
      '--auth-file', auth, '--consume-auth-file', ...(installed ? [
        '--catalog-file', prepared.catalog, '--no-copy-catalog', '--skip-desktop-inspect', '--reasoning-effort', 'max',
      ] : [])], 'Could not launch the isolated herdr-zcode terminal');
    check(typeof terminal.address === 'string' && terminal.address, 'hc run did not return a terminal address');
    address = terminal.address;
    const get = () => hcCommand(['get', '--json', address], 'Could not read the isolated hc terminal');
    let ready;
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      ready = await get();
      const state = ready.status?.state;
      check(ready.state === 'live' && state !== 'blocked' && state !== 'error', 'Core startup stopped before reporting idle');
      if (ready.reported === true && state === 'idle') break;
      await pause(100, undefined, { signal });
    }
    check(ready?.reported === true && ready.status?.state === 'idle', 'Core did not report idle before the startup deadline');
    check(ready.turn === 0, 'The reported Core terminal already ran a turn before prompt delivery');
    check(await absent(auth), 'Projected auth duplicate still existed before prompt delivery');
    if (installed) {
      const screen = await hcCommand(['read', '--json', '--lines', '20', address], 'Could not read the installed candidate model selection');
      check(JSON.stringify(screen).includes(`Selected: ${installedModel} (reasoning: max)`), 'Installed candidate did not report GLM-5.4 with max reasoning');
    }
    check(Number.isSafeInteger(ready.pid) && ready.pid > 1, 'hc get did not identify the wrapper PID');
    const childPid = await appServerPid(ready.pid, executable, options);

    const prompt = `Use the Read tool on ${input}, then use the Write tool to copy its exact contents to ${output}, including the final newline. Do not change the input file.`;
    const sent = await hcCommand(['send', '--json', '--if', 'idle', '--wait', '--timeout', '120', address, prompt],
      'hc send did not complete its guarded turn', { timeout: 125000 });
    const sentStatus = publicStatus(sent.wait);
    if (sentStatus.state !== 'done' || !sent.wait?.ended || sentStatus.turn === null || sentStatus.turn < 1) {
      const current = await get().catch(() => null);
      const screen = await hcCommand(['read', '--json', '--lines', '12', address],
        'Could not read isolated terminal diagnostics').catch(() => null);
      const screenText = JSON.stringify(screen);
      const signals = ['model_request_auth_missing', 'model_request_failed', 'model_rate_limited',
        'error_max_turns', 'error_max_tool_calls', 'HTTP 401', 'HTTP 429', 'provider_code=1308',
        'Prompt submission failed', 'App-server disconnected'].filter(marker => screenText.includes(marker));
      throw new CheckFailure(`Guarded hc turn did not complete: ${JSON.stringify({
        send: publicStatus(sent), wait: sentStatus, terminal: publicStatus(current), signals,
      })}`);
    }
    const waited = await hcCommand(['wait', '--json', '--timeout', '5', address], 'hc wait did not return final state', { timeout: 8000 });
    const done = await get();
    check(publicStatus(waited).state === 'done' && waited.ended && waited.turn === sent.wait.turn &&
      done.reported === true && done.status?.state === 'done' && done.turn === waited.turn && done.pid === ready.pid,
      'hc wait and hc get did not agree on the completed turn');
    const outputInfo = await lstat(output);
    check(outputInfo.isFile() && outputInfo.size === expected.length &&
      (await readFile(output)).equals(expected) && (await readFile(input)).equals(expected),
      'The out-of-cwd result did not match the unchanged input fixture');

    check(await appServerPid(ready.pid, executable, options) === childPid,
      'The owned app-server PID changed during the turn');
    const { elapsed, firstEsrchMs } = await killAndMeasure(hcCommand, address, ready.pid, childPid);
    killed = true;
    if (installed) {
      const after = await desktopDigests(prepared.home, appVersion.trim());
      check(after.every((digest, index) => digest === prepared.before[index]),
        'Native Desktop state comparison is inconclusive because the settings, credentials, or catalog bytes changed');
    }
    result = {
      hc: '0.1.20', desktop: appVersion.trim(), reported: done.reported, ready: 'idle', completed: 'done', turn: done.turn,
      authSource: installed ? 'prepare-isolated' : authSource === undefined ? 'desktop' : 'explicit-file',
      projectedAuthConsumedBeforePrompt: true, exactScopedResult: true, wrapperPid: ready.pid, appServerPid: childPid,
      bothPidsESRCH: true, observedTeardownMs: elapsed, firstEsrchMs,
      epicTeardownBudgetMs: epicKillBudget, taskTeardownBudgetMs: killBudget,
      ...(installed ? { scenario: 'installed-candidate', model: installedModel, reasoning: 'max', desktopStateUnchanged: true,
        receipt: prepared.publicReceipt } : {}),
    };
  } finally {
    if (address && !killed) {
      await hcCommand(['kill', '--json', address], 'hc terminal cleanup failed', { cleanup: true, timeout: 10000 }).catch(() => {});
    }
    if (serverAttempted) {
      try {
        const stopped = await hcCommand(['server', '--json', 'stop'],
          'Isolated hc server cleanup failed', { cleanup: true, timeout: 10000 });
        check(typeof stopped.stopped === 'boolean', 'hc stop returned an unexpected result');
        if (serverPid) {
          const deadline = performance.now() + 2000;
          while (!gone(serverPid) && performance.now() < deadline) await pause(20);
          check(gone(serverPid), 'Isolated hc server PID survived cleanup');
        }
      } catch {
        await wipeRemainingAuth(auth).catch(() => {});
        await rm(auth, { force: true }).catch(() => {});
        throw new CheckFailure(`Isolated hc server cleanup failed for ${session}. Routing files kept at ${root}`);
      }
    }
    await wipeRemainingAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
  if (installed) result.hcSupervisorESRCH = true;
  console.log(JSON.stringify(result));
}

const abort = new AbortController();
const interrupted = () => abort.abort();
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, interrupted);
try {
  await run(abort.signal);
} catch (error) {
  console.error(error instanceof CheckFailure ? error.message : abort.signal.aborted ? 'Live herdr-core test interrupted' :
    'Live herdr-core test failed while preparing or inspecting the isolated run');
  process.exitCode = 1;
} finally {
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.off(signal, interrupted);
}
