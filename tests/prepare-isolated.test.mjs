import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv, createHash } from 'node:crypto';
import fs, { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { CODING_PLAN_ACCESS } from '../lib/desktop-catalog.mjs';
import { desktopCatalogCachePath } from '../lib/desktop-runtime.mjs';
import { preparationNow, projectIsolated, runPreparation } from '../lib/prepare-isolated.mjs';
import { readToolchains } from '../lib/toolchain.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const versions = readToolchains();
const app = '4.0.0';
const providerId = 'account:zai-individual-coding-plan';
const identity = 'fixture-user-visible-only-in-auth-file';
const apiKey = 'fixture-key-visible-only-in-auth-file';
const login = { providerId, identity, apiKey };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";

function catalog(revision, baseUrl = 'https://fixture.invalid/api') {
  const value = { schemaVersion: 1, revision, config: { modelConfigRules: {}, providerConfigRules: {
    providerRules: [{ providerId, config: { access: CODING_PLAN_ACCESS, api: { type: 'anthropic', baseUrl },
      builtinModelIds: revision > 44 ? ['GLM-5.3', 'GLM-5.4'] : ['GLM-5.3'] } }],
  } } };
  return { catalog: value, bytes: Buffer.from(JSON.stringify(value, null, 2) + '\n') };
}

function credentials(profile = JSON.stringify({ id: identity }), key = apiKey) {
  return { 'oauth:zai:user_info': profile,
    [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`]: key };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(process.env.TEST_TMP_ROOT || '/tmp', 'hz-prepare-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = join(root, 'private-output');
  const home = join(root, 'host-home');
  const appBundle = join(root, 'Fixture ZCode.app');
  const account = join(home, '.zcode/v2');
  const creds = join(account, 'credentials.json');
  const bundled = catalog(44);
  const cache = desktopCatalogCachePath(home, app);
  await Promise.all([mkdir(outDir, { mode: 0o700 }), mkdir(appBundle), mkdir(dirname(cache), { recursive: true })]);
  const settings = JSON.stringify({ providerFamilyDomain: 'zai', providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } } });
  const settingsPath = join(account, 'setting.json');
  await writeFile(settingsPath, settings);
  await writeFile(creds, JSON.stringify(credentials()), { mode: 0o600 });
  const inspect = async () => ({ app, bundle: appBundle, minimum: versions.ZCODE_APP_MIN_VERSION, catalogSnapshot: bundled });
  const options = { outDir, appBundle, home, signal: new AbortController().signal, versions };
  return { root, home, appBundle, outDir, creds, settingsPath, settings, cache, bundled, inspect, options };
}

async function run(t, f, { startedAt, project, argv, env } = {}) {
  let stdout = '';
  const args = argv ?? ['prepare-isolated', '--out-dir', f.outDir, '--app-bundle', f.appBundle];
  const output = { write: text => { stdout += text; } };
  const code = await runPreparation({ argv: args, env: env ?? { HOME: f.home }, output, startedAt, project });
  assert.match(stdout, /^[^\n]+\n$/);
  assert.doesNotMatch(stdout, new RegExp(`${identity}|${apiKey}`));
  return { code, json: JSON.parse(stdout) };
}

test('isolated preparation writes exact catalog bytes and verifies login with private modes and a safe receipt', async t => {
  const f = await fixture(t);
  const active = catalog(48);
  await writeFile(f.cache, active.bytes, { mode: 0o644 });
  const expectedCredentials = JSON.stringify(credentials());
  const result = await run(t, f, { project: options => projectIsolated(options, { inspect: f.inspect }) });
  assert.equal(result.code, 0);
  const { authFile, catalogFile } = result.json;
  assert.deepEqual(result.json, { authFile: join(f.outDir, 'auth.json'), catalogFile: join(f.outDir, 'catalog.json'),
    catalogRevision: 48, catalogSHA256: sha256(active.bytes), catalogSource: 'desktop-cache', appVersion: app,
    minZcodeAppVersion: versions.ZCODE_APP_MIN_VERSION, providerId, accountIdentitySHA256: sha256(identity) });
  assert.equal((await lstat(authFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(catalogFile)).mode & 0o777, 0o400);
  assert.deepEqual(await readFile(catalogFile), active.bytes);
  assert.deepEqual(JSON.parse(await readFile(authFile, 'utf8')), { ...login, accountAccess: CODING_PLAN_ACCESS });
  assert.equal(await readFile(f.creds, 'utf8'), expectedCredentials);
  assert.equal(await readFile(f.settingsPath, 'utf8'), f.settings);
  assert.deepEqual(await readFile(f.cache), active.bytes);
});

test('isolated preparation falls back to validated bundled bytes when the cache is absent, invalid or no newer', async t => {
  for (const [name, bytes, mode] of [['absent', null], ['malformed', '{bad JSON'], ['older', catalog(43).bytes],
    ['equal', catalog(44).bytes], ['different API', catalog(48, 'https://different.invalid/api').bytes],
    ['other-writable', catalog(48).bytes, 0o666]]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      if (bytes) {
        await writeFile(f.cache, bytes);
        if (mode) await chmod(f.cache, mode);
      }
      const result = await projectIsolated(f.options, { inspect: f.inspect });
      assert.equal(result.catalogSource, 'bundled');
      assert.equal(result.catalogRevision, 44);
      assert.deepEqual(await readFile(result.catalogFile), f.bundled.bytes);
    });
  }
});

test('isolated preparation removes reservations when projected credentials exceed 64 KiB', async t => {
  const f = await fixture(t);
  const result = await run(t, f, { project: options => projectIsolated(options, {
    inspect: f.inspect,
    readLogin: async () => ({ ...login, apiKey: 'x'.repeat(65536) }),
  }) });
  assert.equal(result.code, 1);
  assert.equal(result.json.reason, 'projection_failed');
  assert.deepEqual(await readdir(f.outDir), []);
});

test('isolated preparation ignores endpoint and credential overrides in the caller environment', async t => {
  const f = await fixture(t);
  const active = catalog(48);
  await writeFile(f.cache, active.bytes);
  const decoy = desktopCatalogCachePath(f.home, app, 'https://decoy.invalid');
  await mkdir(dirname(decoy));
  await writeFile(decoy, catalog(99).bytes);

  const fallback = `zcode-credential-fallback:${process.platform}:${f.home}:${userInfo().username}`;
  const iv = Buffer.alloc(12, 15);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(fallback).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey), cipher.final()]);
  const key = 'enc:v1:' + [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
  await writeFile(f.creds, JSON.stringify(credentials(undefined, key)));
  const previous = process.env.ZCODE_CREDENTIAL_SECRET;
  process.env.ZCODE_CREDENTIAL_SECRET = 'ignore-this-fake-secret';
  try {
    const env = { HOME: f.home + '/', ZCODE_DATA_BASE_DIR: '/nonexistent-host-home', ZCODE_HOME: '/nonexistent-zcode-home',
      ZCODE_BASE_URL: 'https://decoy.invalid', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: decoy, ZCODE_CREDENTIAL_SECRET: 'ignore-this-fake-secret',
      HERDR_ZCODE_APP_BUNDLE: '/nonexistent-app' };
    const result = await run(t, f, { env, project: options => projectIsolated(options, { inspect: async (bundle, versions, { env }) => {
      assert.equal(bundle, f.appBundle);
      assert.deepEqual(env, { HOME: f.home + '/', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' });
      return f.inspect();
    } }) });
    assert.equal(result.code, 0);
    assert.equal(result.json.catalogRevision, 48);
    assert.equal(JSON.parse(await readFile(result.json.authFile, 'utf8')).apiKey, apiKey);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET;
    else process.env.ZCODE_CREDENTIAL_SECRET = previous;
  }
});

test('isolated preparation rejects nonprivate paths before account work and leaves existing outputs untouched', async t => {
  const f = await fixture(t);
  const linked = join(f.root, 'symlink-output');
  await symlink(f.outDir, linked);
  const readLogin = () => assert.fail('account work must not start for refused output');
  const runAt = outDir => projectIsolated({ ...f.options, outDir }, { inspect: f.inspect, readLogin });
  await assert.rejects(runAt(linked), { code: 'output_dir_invalid' });
  await assert.rejects(runAt(join(f.root, 'missing')), { code: 'output_dir_invalid' });
  await chmod(f.outDir, 0o755);
  await assert.rejects(runAt(f.outDir), { code: 'output_dir_invalid' });
  await chmod(f.outDir, 0o700);
  for (const name of ['catalog.json', 'auth.json']) {
    const existing = join(f.outDir, name);
    await writeFile(existing, 'pre-existing');
    await assert.rejects(runAt(f.outDir), { code: 'output_exists' });
    assert.deepEqual(await readdir(f.outDir), [name]);
    assert.equal(await readFile(existing, 'utf8'), 'pre-existing');
    await rm(existing);
  }
});

test('two isolated preparations leave the winner files untouched', async t => {
  const f = await fixture(t);
  let reads = 0;
  const start = () => projectIsolated(f.options, { inspect: f.inspect, readLogin: async () => { reads++; return login; } });
  const results = await Promise.allSettled([start(), start()]);
  const winner = results.find(result => result.status === 'fulfilled');
  const loser = results.find(result => result.status === 'rejected');
  assert.equal(reads, 1);
  assert.equal(loser?.reason.code, 'output_exists');
  assert.deepEqual(await readFile(winner.value.catalogFile), f.bundled.bytes);
  assert.equal(JSON.parse(await readFile(winner.value.authFile, 'utf8')).apiKey, apiKey);
});

test('isolated preparation wipes a partial auth write before removing its own outputs', async t => {
  const f = await fixture(t);
  const auth = join(f.outDir, 'auth.json');
  const open = fs.open, unlink = fs.unlink;
  let writes = 0, wiped;
  const openMock = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (path === auth) {
      const write = handle.write.bind(handle);
      handle.write = (bytes, start, size, offset) => {
        writes++;
        if (writes === 1) return write(bytes, start, Math.min(size, 32), offset);
        if (writes === 2) throw new Error('Fixture write failure: ' + apiKey);
        return write(bytes, start, size, offset);
      };
    }
    return handle;
  });
  const unlinkMock = t.mock.method(fs, 'unlink', async path => {
    if (path === auth) wiped = await readFile(path);
    return unlink(path);
  });
  syncBuiltinESMExports();
  try {
    const outcome = await run(t, f, { project: options => projectIsolated(options, { inspect: f.inspect }) });
    assert.equal(outcome.code, 1);
    assert.equal(outcome.json.reason, 'projection_failed');
    assert.deepEqual(await readdir(f.outDir), []);
    assert.deepEqual(wiped, Buffer.alloc(32));
  } finally {
    openMock.mock.restore();
    unlinkMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('isolated preparation preserves an observed replacement while wiping its original owned auth inode', async t => {
  const f = await fixture(t);
  const auth = join(f.outDir, 'auth.json');
  const moved = join(f.root, 'moved-owned-auth');
  const open = fs.open;
  const openMock = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (path === auth) {
      const write = handle.write.bind(handle);
      let modified = false;
      handle.write = async (...args) => {
        const result = await write(...args);
        if (!modified) {
          modified = true;
          await rename(auth, moved);
          await writeFile(auth, 'replacement');
        }
        return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(projectIsolated(f.options, { inspect: f.inspect }), { code: 'projection_failed' });
    assert.deepEqual(await readdir(f.outDir), ['auth.json']);
    assert.equal(await readFile(auth, 'utf8'), 'replacement');
    const original = await readFile(moved);
    assert.ok(original.length > 0);
    assert.deepEqual(original, Buffer.alloc(original.length));
  } finally { openMock.mock.restore(); syncBuiltinESMExports(); }
});

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

test('isolated preparation uses one deadline through inspection and the signed credential-reader boundary', async t => {
  const f = await fixture(t);
  let workSignal;
  await writeFile(f.creds, JSON.stringify(credentials('enc:v2:os:synthetic')));
  const result = await run(t, f, { startedAt: preparationNow() - 9800, project: options => {
    workSignal = options.signal;
    return projectIsolated(options, { inspect: async (bundle, versions, { signal }) => {
      assert.equal(signal, workSignal);
      return f.inspect();
    }, keychainSource: (bundle, executable, { signal }) => {
      assert.equal(signal, workSignal);
      return async (_, useReader) => useReader(() => waitForAbort(signal));
    } });
  } });
  assert.equal(result.code, 1);
  assert.equal(result.json.reason, 'preparation_timeout');
  assert.deepEqual(await readdir(f.outDir), []);
  assert.equal(workSignal.aborted, true);
});

test('isolated preparation cleans output reservations when interrupted and emits no private exception text', async t => {
  const f = await fixture(t);
  const result = await run(t, f, { project: options => projectIsolated(options, { inspect: f.inspect, readLogin: async () => {
    assert.deepEqual((await readdir(f.outDir)).sort(), ['auth.json', 'catalog.json']);
    process.emit('SIGHUP');
    throw new Error(`private fixture details: ${identity} ${apiKey}`);
  } }) });
  assert.deepEqual(result, { code: 1, json: { reason: 'preparation_interrupted', message: 'Input preparation was interrupted.' } });
  assert.deepEqual(await readdir(f.outDir), []);
});

test('catchable interruption during the last descriptor close wipes both completed outputs before failure', async t => {
  const f = await fixture(t);
  const open = fs.open;
  let interrupted = false;
  const mock = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (path === f.outDir) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (!interrupted) {
          interrupted = true;
          process.emit('SIGTERM');
        }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = await run(t, f, { project: options => projectIsolated(options, { inspect: f.inspect }) });
    assert.equal(interrupted, true);
    assert.equal(result.code, 1);
    assert.equal(result.json.reason, 'preparation_interrupted');
    assert.deepEqual(await readdir(f.outDir), []);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('isolated preparation classifies unavailable account and signed Keychain failures safely', async t => {
  const f = await fixture(t);
  const project = options => projectIsolated(options, { inspect: f.inspect, keychainSource: () => async () => { throw new Error(apiKey); } });
  await writeFile(f.creds, '{bad password fixture');
  assert.equal((await run(t, f, { project })).json.reason, 'desktop_account_unavailable');
  await writeFile(f.creds, JSON.stringify(credentials('enc:v2:os:synthetic')));
  assert.equal((await run(t, f, { project })).json.reason, 'desktop_keychain_unavailable');
  assert.deepEqual(await readdir(f.outDir), []);
});

async function installLauncher(f, { stallProbe = false, runtimeNode } = {}) {
  const packageDir = join(f.root, 'prefix/lib/node_modules/herdr-zcode');
  const binary = join(f.root, 'prefix/bin/herdr-zcode');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const libraries = (await readdir(join(source, 'lib'))).filter(name => name.endsWith('.mjs')).map(name => 'lib/' + name);
  const required = ['bin/herdr-zcode', 'bin/herdr-zcode-app.mjs', 'toolchains.env', 'scripts/toolchain.sh',
    'scripts/tool-bin/npm', 'scripts/tool-bin/npx', 'scripts/desktop-bootstrap.pl', ...libraries];
  for (const runtime of required) assert.ok(manifest.files.includes(runtime), `Missing package runtime file ${runtime}`);
  for (const file of ['package.json', ...manifest.files]) {
    const destination = join(packageDir, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, file), destination);
  }
  await mkdir(dirname(binary), { recursive: true });
  await symlink('../lib/node_modules/herdr-zcode/bin/herdr-zcode', binary);
  const executable = join(f.appBundle, 'Contents/MacOS/ZCode');
  const launcher = join(f.appBundle, 'Contents/Resources/glm/zcode.cjs');
  const catalogPath = join(f.appBundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  const probeMarker = join(f.root, 'probe-pid');
  const bootstrapMarker = join(f.root, 'bootstrap-started');
  const jsExitMarker = join(f.root, 'embedded-js-exit');
  const preload = join(f.root, 'test-electron.mjs');
  await Promise.all([executable, launcher, catalogPath].map(path => mkdir(dirname(path), { recursive: true })));
  await writeFile(join(f.appBundle, 'Contents/Info.plist'),
    '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>4.0.0</string><key>CFBundleVersion</key><string>fixture-1</string></dict></plist>');
  await writeFile(launcher, 'throw new Error("app-server must not start");');
  await writeFile(catalogPath, f.bundled.bytes);
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
Object.defineProperty(process.versions, 'electron', { value: '44.7.0' });
${runtimeNode ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(runtimeNode)} });` : ''}
process.once('exit', code => writeFileSync(${JSON.stringify(jsExitMarker)}, String(code)));
`);
  const probe = stallProbe ? `printf 'partial ${apiKey}' >&2; exec /bin/sleep 60` :
    `printf '%s\\n' ${shell(JSON.stringify({ node: '20.19.0', electron: '44.7.0', execPath: executable }))}`;
  await writeFile(executable, `#!/bin/sh
[ "\${ELECTRON_RUN_AS_NODE:-}" = 1 ] || exit 91
case "\${1:-}" in
  -p) printf '%s' "$$" > ${shell(probeMarker)}; ${probe} ;;
  */bin/herdr-zcode-app.mjs) printf '%s' started > ${shell(bootstrapMarker)}; exec ${shell(process.execPath)} --import ${shell(preload)} "$@" ;;
  *) exit 92 ;;
esac
`, { mode: 0o755 });
  return { binary, packageDir, executable, catalogPath, probeMarker, bootstrapMarker, jsExitMarker,
    args: ['prepare-isolated', '--out-dir', f.outDir, '--app-bundle', f.appBundle],
    options: { cwd: '/private/var/empty', env: { HOME: f.home, PATH: '/usr/bin:/bin', TMPDIR: f.root }, timeout: 17000 } };
}

function safeResponse(stdout, stderr) {
  assert.equal(stderr, '');
  assert.match(stdout, /^[^\n]+\n$/);
  assert.doesNotMatch(stdout, new RegExp(`${identity}|${apiKey}`));
  return JSON.parse(stdout);
}

async function launcherFailure(launcher, reason, { executable = launcher.binary, args = launcher.args, env = launcher.options.env } = {}) {
  const outcome = await exec(executable, args, { ...launcher.options, env }).catch(error => {
    if (typeof error.code !== 'number') throw error;
    return error;
  });
  assert.equal(outcome.code, 1);
  const result = safeResponse(outcome.stdout, outcome.stderr);
  assert.deepEqual(Object.keys(result).sort(), ['message', 'reason']);
  assert.equal(result.reason, reason);
  return result;
}

test('installed prepare-isolated produces a private receipt and one safe JSON error for each failure layer', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const call = (...args) => exec(launcher.binary, args, launcher.options).catch(error => {
    if (typeof error.code !== 'number') throw error;
    return error;
  });
  const fail = async (args, reason) => {
    const result = await call(...args);
    assert.equal(result.code, 1);
    const json = safeResponse(result.stdout, result.stderr);
    assert.deepEqual(Object.keys(json).sort(), ['message', 'reason']);
    assert.equal(json.reason, reason);
  };
  for (const args of [['prepare-isolated'], [...launcher.args, '--runtime', 'core'], [...launcher.args, '--out-dir', f.outDir]]) {
    await fail(args, 'invalid_arguments');
  }
  await fail(['prepare-isolated', '--out-dir', f.outDir, '--app-bundle', join(f.root, 'absent.app')], 'app_bundle_missing');
  await fail(['prepare-isolated', '--out-dir', join(f.root, 'missing'), '--app-bundle', f.appBundle], 'output_dir_invalid');
  const result = await call(...launcher.args);
  const receipt = safeResponse(result.stdout, result.stderr);
  assert.equal(receipt.catalogSHA256, sha256(f.bundled.bytes));
  assert.equal(receipt.accountIdentitySHA256, sha256(identity));
  assert.deepEqual(await readdir(f.outDir).then(paths => paths.sort()), ['auth.json', 'catalog.json']);
  await fail([...launcher.args, '--json'], 'output_exists');
  await rm(receipt.authFile);
  await rm(receipt.catalogFile);
  await writeFile(f.creds, 'broken credentials');
  await fail([...launcher.args, '--json'], 'desktop_account_unavailable');
  await writeFile(launcher.catalogPath, '{}');
  await fail(launcher.args, 'catalog_invalid');
  await writeFile(launcher.catalogPath, f.bundled.bytes);
  await writeFile(launcher.executable, '#!/missing-interpreter\nexit 91\n');
  await fail(launcher.args, 'embedded_runtime_invalid');
  assert.deepEqual(await readdir(f.outDir), []);
});

test('installed prepare-isolated --json uses embedded Node even when a pinned nvm executable exists', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const nvm = join(f.root, 'nvm');
  const pinned = join(nvm, 'versions/node', 'v' + versions.NODE_VERSION, 'bin/node');
  await mkdir(dirname(pinned), { recursive: true });
  await writeFile(pinned, '#!/bin/sh\nexit 96\n', { mode: 0o755 });
  const { stdout, stderr } = await exec(launcher.binary, [...launcher.args, '--json'], {
    ...launcher.options, env: { ...launcher.options.env, NVM_DIR: nvm },
  });
  const receipt = safeResponse(stdout, stderr);
  assert.equal(receipt.authFile, join(f.outDir, 'auth.json'));
  assert.equal(receipt.catalogFile, join(f.outDir, 'catalog.json'));
  assert.equal(receipt.catalogSHA256, sha256(f.bundled.bytes));
  assert.equal(await readFile(launcher.bootstrapMarker, 'utf8'), 'started');
});

test('installed preparation reports clock, helper and path-discovery failures before starting the Desktop probe', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const startupFailure = { reason: 'embedded_runtime_invalid', message: 'ZCode Desktop embedded runtime is unavailable or incompatible.' };
  const beforeCredentials = await readFile(f.creds);
  const expectBootstrapFailure = async (env = launcher.options.env) => {
    const outcome = await exec(launcher.binary, launcher.args, { ...launcher.options, env }).catch(error => error);
    assert.equal(outcome.code, 1);
    assert.deepEqual(safeResponse(outcome.stdout, outcome.stderr), startupFailure);
    await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.creds), beforeCredentials);
    assert.deepEqual(await readdir(f.outDir), []);
  };

  const bootstrap = join(launcher.packageDir, 'scripts/desktop-bootstrap.pl');
  const helper = await readFile(bootstrap);
  if (process.getuid() !== 0) {
    await chmod(bootstrap, 0);
    try { await expectBootstrapFailure(); }
    finally { await chmod(bootstrap, 0o644); }
  }
  await rm(bootstrap);
  await expectBootstrapFailure();
  await writeFile(bootstrap, helper);

  const mocks = join(f.root, 'early-shell-fixtures');
  await mkdir(mocks);
  const readlink = join(mocks, 'readlink');
  await writeFile(readlink, `#!/bin/sh\nprintf '%s' ${shell(apiKey)} >&2\nexit 31\n`, { mode: 0o755 });
  await expectBootstrapFailure({ ...launcher.options.env, PATH: `${mocks}:/usr/bin:/bin` });

  // Inject a failing protected clock dependency only into this disposable
  // launcher copy. The product has no environment override for that binary.
  const copiedLauncher = join(launcher.packageDir, 'bin/herdr-zcode');
  const clock = join(mocks, 'clock');
  const shellSource = await readFile(copiedLauncher, 'utf8');
  const clockPrefix = '/usr/bin/perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC_RAW';
  assert.ok(shellSource.includes(clockPrefix));
  await writeFile(copiedLauncher, shellSource.replace(clockPrefix, `${shell(clock)} -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC_RAW`));
  for (const code of [31, 0]) {
    await writeFile(clock, `#!/bin/sh\nprintf '%s' invalid-clock\nprintf '%s' ${shell(apiKey)} >&2\nexit ${code}\n`, { mode: 0o755 });
    await expectBootstrapFailure();
  }
});

test('installed preparation emits one safe fallback when the bootstrap exec handoff fails', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const copiedLauncher = join(launcher.packageDir, 'bin/herdr-zcode');
  const original = await readFile(copiedLauncher, 'utf8');
  const takeover = 'command exec /usr/bin/perl /dev/fd/3';
  const fallback = `printf '%s\\n' '{"reason":"embedded_runtime_invalid"`;
  assert.ok(original.includes(takeover) && original.includes(fallback));
  // Fail the actual exec call without tampering with the protected interpreter
  // or its availability check, and deliver extra catchable signals at emission.
  await writeFile(copiedLauncher, original.replace(takeover, `command exec ${shell(join(f.root, 'missing-perl'))} /dev/fd/3`)
    .replace(fallback, () => `kill -TERM "$$"; kill -HUP "$$"; kill -INT "$$"\n    ${fallback}`));
  assert.deepEqual(await launcherFailure(launcher, 'embedded_runtime_invalid'), {
    reason: 'embedded_runtime_invalid', message: 'ZCode Desktop embedded runtime is unavailable or incompatible.',
  });
  await assert.rejects(lstat(launcher.bootstrapMarker), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.outDir), []);
});

test('installed preparation emits one typed error for shell interruption during symlink resolution', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const mocks = join(f.root, 'shell-resolution-fixtures');
  await mkdir(mocks);
  const marker = join(mocks, 'readlink-entered');
  const release = join(mocks, 'release-readlink');
  const readlink = join(mocks, 'readlink');
  await writeFile(readlink, `#!/bin/sh
printf '%s' waiting > ${shell(marker)}
while [ ! -f ${shell(release)} ]; do /bin/sleep 0.01; done
exec /usr/bin/readlink "$@"
`, { mode: 0o755 });
  const beforeCredentials = await readFile(f.creds);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    await t.test(signal, async () => {
      await rm(marker, { force: true });
      await rm(release, { force: true });
      const child = spawn(launcher.binary, launcher.args, { cwd: launcher.options.cwd,
        env: { ...launcher.options.env, PATH: `${mocks}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false;
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const exit = once(child, 'close').then(result => { settled = true; return result; });
      try {
        const until = Date.now() + 5000;
        let observed = false;
        while (!settled && !observed && Date.now() < until) {
          observed = await lstat(marker).then(() => true, error => {
            if (error.code === 'ENOENT') return false;
            throw error;
          });
          if (!observed) await pause(15);
        }
        assert.equal(observed, true);
        assert.equal(child.kill(signal), true);
        for (const extra of ['SIGINT', 'SIGTERM', 'SIGHUP'].filter(value => value !== signal)) child.kill(extra);
        await writeFile(release, 'continue');
        assert.deepEqual(await exit, [1, null]);
        assert.deepEqual(safeResponse(stdout, stderr), { reason: 'preparation_interrupted', message: 'Input preparation was interrupted.' });
        await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });
        assert.deepEqual(await readFile(f.creds), beforeCredentials);
        assert.deepEqual(await readdir(f.outDir), []);
      } finally {
        await writeFile(release, 'continue');
        if (!settled) { child.kill('SIGTERM'); await exit; }
      }
    });
  }
});

test('prepare-isolated reports embedded and pinned JS guard and Desktop metadata failures without producing inputs', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f, { runtimeNode: '19.0.0' });
  const before = await readFile(f.creds);
  await launcherFailure(launcher, 'embedded_runtime_invalid');
  await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });

  const pinsFile = join(launcher.packageDir, 'toolchains.env');
  const declarations = await readFile(pinsFile, 'utf8');
  const direct = { executable: process.execPath, args: [join(launcher.packageDir, 'bin/herdr-zcode-app.mjs'), ...launcher.args] };
  await writeFile(pinsFile, 'NODE_VERSION=invalid\n');
  await launcherFailure(launcher, 'embedded_runtime_invalid', direct);
  await writeFile(pinsFile, declarations.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=0.0.0'));
  await launcherFailure(launcher, 'embedded_runtime_invalid', direct);
  await writeFile(pinsFile, declarations);

  const plistPath = join(f.appBundle, 'Contents/Info.plist');
  const plist = await readFile(plistPath, 'utf8');
  await writeFile(plistPath, '{invalid plist');
  await launcherFailure(launcher, 'app_bundle_invalid');
  await launcherFailure(launcher, 'app_bundle_invalid', direct);
  await writeFile(plistPath, plist.replace(`<string>${app}</string>`, '<string>0.0.1</string>'));
  await launcherFailure(launcher, 'app_version_below_minimum');
  await launcherFailure(launcher, 'app_version_below_minimum', direct);
  await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.outDir), []);
  assert.deepEqual(await readFile(f.creds), before);
});

test('prepare-isolated ignores HERDR_ZCODE_APP_BUNDLE in installed and direct JS paths without --app-bundle', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const defaultBundle = join(f.root, 'Absent default.app');
  const helper = join(launcher.packageDir, 'scripts/desktop-bootstrap.pl');
  const projection = join(launcher.packageDir, 'lib/prepare-isolated.mjs');
  for (const path of [helper, projection]) {
    const original = await readFile(path, 'utf8');
    assert.ok(original.includes('/Applications/ZCode.app'));
    await writeFile(path, original.replace('/Applications/ZCode.app', defaultBundle));
  }
  const args = ['prepare-isolated', '--out-dir', f.outDir];
  const env = { ...launcher.options.env, HERDR_ZCODE_APP_BUNDLE: f.appBundle };
  const before = await readFile(f.creds);
  await launcherFailure(launcher, 'app_bundle_missing', { args, env });
  await launcherFailure(launcher, 'app_bundle_missing', { executable: process.execPath,
    args: [join(launcher.packageDir, 'bin/herdr-zcode-app.mjs'), ...args], env });
  await assert.rejects(lstat(launcher.bootstrapMarker), { code: 'ENOENT' });
  await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.outDir), []);
  assert.deepEqual(await readFile(f.creds), before);
});

test('installed prepare-isolated carries elapsed launcher time into graceful JS work-deadline cleanup', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f, { stallProbe: true });
  const copiedLauncher = join(launcher.packageDir, 'bin/herdr-zcode');
  const original = await readFile(copiedLauncher, 'utf8');
  const clock = 'clock_gettime(CLOCK_MONOTONIC_RAW) * 1000';
  assert.ok(original.includes(clock));
  // The scoped fixture age leaves JS about two seconds of work before the
  // shell's hard deadline. A SIGKILL cannot create the JS process exit marker.
  await writeFile(copiedLauncher, original.replace(clock, `${clock} - 8000`));
  await launcherFailure(launcher, 'preparation_timeout');
  assert.equal(await readFile(launcher.jsExitMarker, 'utf8'), '1');
  const pid = Number(await readFile(launcher.probeMarker, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readdir(f.outDir), []);
});

test('prepare-isolated reaps a stalled embedded probe when the shared work deadline expires', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f, { stallProbe: true });
  const result = await run(t, f, { startedAt: preparationNow() - 9000 });
  assert.equal(result.code, 1);
  assert.equal(result.json.reason, 'preparation_timeout');
  const pid = Number(await readFile(launcher.probeMarker, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readdir(f.outDir), []);
});

test('installed preparation stops before Node when interrupted between fork and child signal reset', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f);
  const bootstrap = join(launcher.packageDir, 'scripts/desktop-bootstrap.pl');
  const original = await readFile(bootstrap, 'utf8');
  const forkChild = 'if ($pid == 0) {';
  assert.ok(original.includes(forkChild));

  for (const signal of ['INT', 'TERM', 'HUP']) {
    await t.test(signal, async () => {
      // Inject into the installed fixture at the otherwise timing-dependent fork boundary.
      const interrupt = "        kill '" + signal + "', $$ if $forward_signals;";
      await writeFile(bootstrap, original.replace(forkChild, () => forkChild + '\n' + interrupt));
      await launcherFailure(launcher, 'preparation_interrupted');
      await assert.rejects(lstat(launcher.bootstrapMarker), { code: 'ENOENT' });
      await assert.rejects(lstat(launcher.probeMarker), { code: 'ENOENT' });
      assert.deepEqual(await readdir(f.outDir), []);
    });
  }
});

test('installed prepare-isolated forwards catchable interruption to its active embedded JS process', async t => {
  const f = await fixture(t);
  const launcher = await installLauncher(f, { stallProbe: true });
  const child = spawn(launcher.binary, launcher.args, { ...launcher.options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'close').then(result => { settled = true; return result; });
  try {
    const until = Date.now() + 5000;
    let mark;
    while (!settled && !mark && Date.now() < until) {
      mark = await readFile(launcher.probeMarker, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!mark) await pause(15);
    }
    const pid = Number(mark);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await exit, [1, null]);
    assert.equal(safeResponse(stdout, stderr).reason, 'preparation_interrupted');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(f.outDir), []);
  } finally {
    if (!settled) { child.kill('SIGTERM'); await exit; }
  }
});
