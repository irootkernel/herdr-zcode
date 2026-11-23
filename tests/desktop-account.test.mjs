import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod, link, open, realpath, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { main, parseArgs } from '../bin/herdr-zcode-app.mjs';
import { desktopAccount, projectedAccount, DEFAULT_MODEL } from '../lib/desktop-account.mjs';
import { prepareDesktopRuntime } from '../lib/desktop-runtime.mjs';
import { keychainCipherScript, OS_CREDENTIAL_PREFIX } from '../lib/desktop-keychain.mjs';
import { readToolchains } from '../lib/toolchain.mjs';

const providerId = 'account:zai-individual-coding-plan';
const selected = { providerId, modelId: 'GLM-5.3' };
const request = { providerId, accountAccess: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' } };
const digest = text => createHash('sha256').update(text).digest('hex');
function encrypted(text, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
  return 'enc:v1:' + [iv, cipher.getAuthTag(), bytes].map(value => value.toString('base64url')).join('.');
}
async function fixture(t) {
  const root = await mkdtemp(join(process.env.TEST_TMP_ROOT || tmpdir(), 'hz-account-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), appBundle = join(root, 'ZCode Test.app');
  const directory = join(home, '.zcode/v2');
  const catalogPath = join(appBundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  for (const dir of [directory, join(appBundle, 'Contents/MacOS'), join(appBundle, 'Contents/Resources/glm'), join(appBundle, 'Contents/Resources/config/provider')]) await mkdir(dir, { recursive: true });
  const pins = readToolchains();
  const executable = join(appBundle, 'Contents/MacOS/ZCode');
  const runtime = JSON.stringify({ node: '24.21.0', electron: '44.7.0', execPath: executable });
  await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' \'' + runtime.replaceAll("'", "'\\''") + "'\n", { mode: 0o755 });
  await writeFile(join(appBundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' + pins.ZCODE_APP_MIN_VERSION + '</string><key>CFBundleVersion</key><string>fixture-build</string></dict></plist>');
  await writeFile(join(appBundle, 'Contents/Resources/glm/zcode.cjs'), '// test');
  const catalog = { revision: 31, config: { providerConfigRules: { providerRules: [{ providerId, config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'], access: request.accountAccess } }] } } };
  await writeFile(catalogPath, JSON.stringify(catalog));
  const setting = { providerFamilyDomain: 'zai', providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } } };
  await writeFile(join(directory, 'setting.json'), JSON.stringify(setting));
  const credentialsPath = join(directory, 'credentials.json');
  const env = { ZCODE_CREDENTIAL_SECRET: 'fixture-credential-secret', HERDR_ZCODE_TOKEN: 'inherited', HERDR_ZCODE_SOCKET: '/old.sock', CODEX_THREAD_ID: 'foreign-caller' };
  async function credentials(identity = 'user-fixture', apiKey = 'fixture-api-secret', secret = env.ZCODE_CREDENTIAL_SECRET) {
    const values = {
      'oauth:zai:user_info': encrypted(JSON.stringify({ id: identity }), secret),
      [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`]: encrypted(apiKey, secret),
    };
    await writeFile(credentialsPath, JSON.stringify(values), { mode: 0o600 });
  }
  await credentials();
  return { root, home, appBundle, env, catalog, catalogPath, credentialsPath, credentials, settingPath: join(directory, 'setting.json'), options: { home, env, username: 'fixture-user' } };
}

test('Desktop account uses exact model and path-qualified catalog revision without exposing credentials', async t => {
  const f = await fixture(t);
  const before = await readFile(f.credentialsPath, 'utf8');
  const account = await desktopAccount(f.catalogPath, f.options);
  assert.deepEqual(account.selection, selected);
  assert.equal(DEFAULT_MODEL, providerId + '/GLM-5.3');
  assert.equal(account.config.basedOnZCodeBuiltinRevision, `zcode-builtin:31:${digest(resolve(f.catalogPath))}`);
  assert.equal(JSON.stringify(account.config).includes('fixture-api-secret'), false);
  assert.deepEqual(await account.runtimeHeaders(request), { headersApplied: true, requestAuth: { apiKey: 'fixture-api-secret' } });
  assert.equal(account.redact('before fixture-api-secret after'), 'before [REDACTED] after');
  assert.equal(await readFile(f.credentialsPath, 'utf8'), before);
});

test('wrong provider or account access never receives the credential', async t => {
  const f = await fixture(t), account = await desktopAccount(f.catalogPath, f.options);
  for (const value of [undefined, {}, { ...request, providerId: 'foreign' }, { ...request, accountAccess: { ...request.accountAccess, accountType: 'bigmodel' } }]) {
    const response = await account.runtimeHeaders(value);
    assert.equal(response.headersApplied, false);
    assert.equal(response.requestAuth, undefined);
  }
});

test('credentials refresh on request but a different Desktop identity is rejected', async t => {
  const f = await fixture(t), account = await desktopAccount(f.catalogPath, f.options);
  await f.credentials('user-fixture', 'fresh-secret');
  assert.equal((await account.runtimeHeaders(request)).requestAuth.apiKey, 'fresh-secret');
  await f.credentials('another-account', 'different-secret');
  assert.equal((await account.runtimeHeaders(request)).headersApplied, false);
  assert.equal(account.redact('fresh-secret fixture-api-secret'), '[REDACTED] [REDACTED]');
});

test('existing output streams protect refreshed and previous fixture credentials', async t => {
  const f = await fixture(t), account = await desktopAccount(f.catalogPath, f.options);
  const stream = account.createStreamRedactor();
  assert.equal(stream.write('ordinary text '), 'ordinary text ');
  assert.equal(stream.write('fixture-api-'), '');
  await f.credentials('user-fixture', 'refreshed-fixture-key');
  assert.equal((await account.runtimeHeaders(request)).headersApplied, true);
  assert.equal(stream.write('secret refreshed-fixture-'), '[REDACTED] ');
  assert.equal(stream.write('key'), '[REDACTED]');
  assert.equal(stream.write(' final fixture-api-'), ' final ');
  assert.equal(stream.flush(), 'fixture-api-');
  assert.equal(stream.flush(), '');
});

test('absent requested model is not silently replaced by the first catalog model', async t => {
  const f = await fixture(t);
  await assert.rejects(desktopAccount(f.catalogPath, { ...f.options, model: 'GLM-unknown' }), /no fallback/);
  await assert.rejects(desktopAccount(f.catalogPath, { ...f.options, model: 'other-provider/GLM-5.3' }), /no fallback/);
  const flash = await desktopAccount(f.catalogPath, { ...f.options, model: 'GLM-5.3-Flash' });
  assert.equal(flash.selection.modelId, 'GLM-5.3-Flash');
});

test('Desktop account and encrypted credential failures are concise and secret-free', async t => {
  const f = await fixture(t);
  await writeFile(f.credentialsPath, '{invalid fixture-api-secret');
  await assert.rejects(desktopAccount(f.catalogPath, f.options), error => !error.message.includes('fixture-api-secret') && /Cannot read/.test(error.message));
  await f.credentials();
  await assert.rejects(desktopAccount(f.catalogPath, { ...f.options, env: { ZCODE_CREDENTIAL_SECRET: 'incorrect' } }), /profile is unavailable/);
  await writeFile(f.settingPath, JSON.stringify({ providerFamilyDomain: 'bigmodel' }));
  await assert.rejects(desktopAccount(f.catalogPath, f.options), /Individual Coding Plan/);
});

test('native Desktop credential fallback matches platform, native home and username', async t => {
  const f = await fixture(t);
  const secret = `zcode-credential-fallback:${process.platform}:${f.home}:fixture-user`;
  await f.credentials('user/with space', 'native-fallback-key', secret);
  const account = await desktopAccount(f.catalogPath, { ...f.options, env: {} });
  assert.equal((await account.runtimeHeaders(request)).requestAuth.apiKey, 'native-fallback-key');
});

const fixtureKey = Buffer.alloc(32, 0x42);
function keychainEnvelope(text, { invalidTag = false, fingerprint = digest(fixtureKey).slice(0, 24) } = {}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fixtureKey, iv);
  const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (invalidTag) tag[0] ^= 1;
  return OS_CREDENTIAL_PREFIX + fingerprint + ':' + [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

function runKeychainCipher(ciphertext, readKey = '() => process.argv[1]') {
  const script = keychainCipherScript + `readCredential(${readKey}).catch(() => { process.exitCode = 1; });`;
  return spawnSync(process.execPath, ['-e', script, fixtureKey.toString('base64url')], {
    input: ciphertext, encoding: 'utf8', timeout: 3000, env: {},
  });
}

test('Keychain cipher returns plaintext only when the envelope and key authenticate', () => {
  const secret = 'synthetic-coding-plan-secret';
  const good = keychainEnvelope(secret);
  const decrypted = runKeychainCipher(good);
  assert.equal(decrypted.status, 0);
  assert.equal(decrypted.stdout, secret);
  for (const [ciphertext, keyReader] of [
    [good + '\n'],
    [keychainEnvelope(secret, { fingerprint: '0'.repeat(24) })],
    [keychainEnvelope(secret, { invalidTag: true })],
    [good, '() => { throw new Error(process.argv[1]); }'],
  ]) {
    const denied = runKeychainCipher(ciphertext, keyReader);
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout + denied.stderr, '');
  }
});

test('Keychain credentials bind the account, refresh and redact keys, and reject unavailable auth', async t => {
  const f = await fixture(t);
  const reads = [];
  const withOSCredentialReader = async (path, useReader) => {
    assert.equal(path, f.credentialsPath);
    const transaction = [];
    reads.push(transaction);
    return useReader(async value => {
      transaction.push(value);
      const result = runKeychainCipher(value);
      if (result.status !== 0) throw new Error('Authentication failed');
      return result.stdout;
    });
  };
  const set = async (identity, key, profile = keychainEnvelope(JSON.stringify({ id: identity }))) => {
    await writeFile(f.credentialsPath, JSON.stringify({
      'oauth:zai:user_info': profile,
      [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`]: key,
    }));
  };
  await set('fixture/account', keychainEnvelope('previous-key'));
  await assert.rejects(desktopAccount(f.catalogPath, f.options), /profile is unavailable/);
  const account = await desktopAccount(f.catalogPath, { ...f.options, withOSCredentialReader });
  assert.deepEqual(reads.map(batch => batch.length), [2]);
  assert.equal(JSON.stringify(account.config).includes('previous-key'), false);
  assert.equal((await account.runtimeHeaders({ ...request, providerId: 'wrong-provider' })).headersApplied, false);
  assert.equal(reads.length, 1);
  await set('fixture/account', keychainEnvelope('rotated-key'), JSON.stringify({ id: 'fixture/account' }));
  assert.deepEqual(await account.runtimeHeaders(request), { headersApplied: true, requestAuth: { apiKey: 'rotated-key' } });
  assert.equal(account.redact('previous-key rotated-key'), '[REDACTED] [REDACTED]');
  assert.equal(reads.at(-1).length, 1);
  await set('fixture/account', keychainEnvelope('bad-tag', { invalidTag: true }));
  assert.equal((await account.runtimeHeaders(request)).requestAuth, undefined);
  await set('fixture/account', 'enc:v99:unrecognized');
  assert.equal((await account.runtimeHeaders(request)).requestAuth, undefined);
  await set('new-account', keychainEnvelope('other-key'));
  assert.equal((await account.runtimeHeaders(request)).requestAuth, undefined);
  assert.equal(reads.at(-1).length, 1);
});

test('runtime binds a per-executor public catalog path and cleans up without touching Desktop files', async t => {
  const f = await fixture(t);
  const originalCatalog = await readFile(f.catalogPath, 'utf8');
  const originalCredential = await readFile(f.credentialsPath, 'utf8');
  const first = await prepareDesktopRuntime({ env: f.env, home: f.home, appBundle: f.appBundle, tmpRoot: f.root });
  const second = await prepareDesktopRuntime({ env: f.env, home: f.home, appBundle: f.appBundle, tmpRoot: f.root });
  try {
    assert.notEqual(first.configPath, second.configPath);
    assert.equal(first.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, first.configPath);
    assert.equal(first.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(f.home, '.zcode/v2/provider_config.json'));
    assert.equal(first.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(first.env.HERDR_ZCODE_TOKEN, undefined);
    assert.equal(first.env.HERDR_ZCODE_SOCKET, undefined);
    assert.equal(first.env.CODEX_THREAD_ID, undefined);
    assert.deepEqual(first.args.slice(-2), ['app-server', '--stdio']);
    assert.equal(await readFile(first.configPath, 'utf8'), originalCatalog);
    const account = await desktopAccount(first.configPath, f.options);
    assert.ok(account.config.basedOnZCodeBuiltinRevision.endsWith(digest(first.configPath)));
    if (first.withOSCredentialReader) {
      await assert.rejects(first.withOSCredentialReader(f.credentialsPath, () => {
        assert.fail('Unsigned Desktop bundle cannot read Keychain credentials');
      }), /Keychain signature verification failed/);
    }
    await first.close();
    await assert.rejects(access(first.configPath));
    await access(second.configPath);
  } finally { await first.close(); await second.close(); }
  assert.equal(await readFile(f.catalogPath, 'utf8'), originalCatalog);
  assert.equal(await readFile(f.credentialsPath, 'utf8'), originalCredential);
});

const projection = { providerId, identity: 'user-fixture', apiKey: 'header-secret' };

test('projected account shares exact overlay, model validation and stream redaction', async t => {
  const f = await fixture(t);
  const authPath = join(f.root, 'auth.json');
  await writeFile(authPath, JSON.stringify(projection), { mode: 0o700 });
  const account = await projectedAccount(f.catalogPath, authPath);
  const desktop = await desktopAccount(f.catalogPath, f.options);
  assert.deepEqual(account.config, desktop.config);
  assert.deepEqual(account.selection, selected);
  assert.doesNotMatch(JSON.stringify(account.config), /header-secret|user-fixture/);
  assert.deepEqual(await account.runtimeHeaders(request), { headersApplied: true, requestAuth: { apiKey: 'header-secret' } });
  for (const wrong of [{ ...request, providerId: 'foreign' }, { ...request, accountAccess: { ...request.accountAccess, mode: 'foreign' } }]) {
    const headers = await account.runtimeHeaders(wrong);
    assert.equal(headers.headersApplied, false);
    assert.equal(headers.requestAuth, undefined);
  }
  const stream = account.createStreamRedactor();
  assert.equal(stream.write('fixture header-'), 'fixture ');
  assert.equal(stream.write('secret end') + stream.flush(), '[REDACTED] end');
  assert.equal((await projectedAccount(f.catalogPath, authPath, { model: 'GLM-5.3-Flash' })).selection.modelId, 'GLM-5.3-Flash');
  assert.equal((await projectedAccount(f.catalogPath, authPath, { model: null })).selection, null);
  await assert.rejects(projectedAccount(f.catalogPath, authPath, { model: 'foreign/GLM-5.3', consume: true }), /no fallback model/);
  assert.equal(await readFile(authPath, 'utf8'), JSON.stringify(projection));
});

test('projected auth rejects unsafe files and invalid or foreign projections without consuming them', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'auth.json');
  const payload = JSON.stringify(projection);
  const reject = target => assert.rejects(projectedAccount(f.catalogPath, target, { consume: true }), error =>
    error.blockedKind === 'auth' && /projected auth/i.test(error.message) && !error.message.includes(projection.apiKey));
  await writeFile(path, payload, { mode: 0o644 }); await reject(path);
  await chmod(path, 0o200); await reject(path);
  await chmod(path, 0o600);
  const symlinkPath = join(f.root, 'sym.json'), hardlinkPath = join(f.root, 'link.json');
  await symlink(path, symlinkPath); await reject(symlinkPath);
  await link(path, hardlinkPath); await reject(path);
  assert.equal(await readFile(path, 'utf8'), payload);
  await rm(hardlinkPath);
  await reject(f.root);
  const fifo = join(f.root, 'fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  await reject(fifo);
  const invalidEncoding = Buffer.from(payload);
  invalidEncoding[invalidEncoding.indexOf(projection.apiKey)] = 0xff;
  for (const invalid of ['', invalidEncoding, '{"apiKey":"header-secret"', '{}', JSON.stringify({ ...projection, identity: ' ' }),
    JSON.stringify({ ...projection, accountAccess: { ...request.accountAccess, accountType: 'foreign' } }),
    JSON.stringify({ ...projection, providerId: 'foreign' }), 'x'.repeat(65537)]) {
    await writeFile(path, invalid);
    await reject(path);
    assert.deepEqual(await readFile(path), Buffer.from(invalid));
  }
});

test('projected auth wipes an open writable inode before unlink and unlinks an intact read-only input', async t => {
  const f = await fixture(t);
  const payload = JSON.stringify(projection);
  for (const mode of [0o600, 0o400]) {
    const path = join(f.root, `auth-${mode}.json`);
    await writeFile(path, payload, { mode });
    const observer = await open(path, 'r');
    try {
      const account = await projectedAccount(f.catalogPath, path, { consume: true });
      await assert.rejects(access(path), { code: 'ENOENT' });
      const remaining = await observer.readFile();
      assert.deepEqual(remaining, mode === 0o600 ? Buffer.alloc(payload.length) : Buffer.from(payload));
      assert.equal((await account.runtimeHeaders(request)).requestAuth.apiKey, projection.apiKey);
    } finally { await observer.close(); }
  }
});

async function projectedEntrypoint(t, { unremovable = false, replaceAtUnlink = false, nonInteractive = false } = {}) {
  const f = await fixture(t);
  const source = join(f.root, 'projection');
  await mkdir(source);
  const authPath = join(source, 'auth.json');
  const backup = join(source, 'renamed-auth.json');
  await writeFile(authPath, JSON.stringify(projection), { mode: replaceAtUnlink ? 0o400 : 0o600 });
  if (unremovable) await chmod(source, 0o500);
  const nativeHome = join(f.root, 'nonexistent-desktop-home');
  const env = { TMPDIR: f.root, HOME: nativeHome, ZCODE_DATA_BASE_DIR: nativeHome, XDG_DATA_HOME: nativeHome,
    ZCODE_HOME: nativeHome, ZCODE_STORAGE_DIR: nativeHome, ZCODE_CREDENTIAL_SECRET: 'fixture-legacy-secret',
    ZCODE_CREDENTIAL_SECRET_FILE: join(nativeHome, 'credential-secret'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(nativeHome, '.zcode/v2/personal.json'),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(nativeHome, '.zcode/v2/builtin.json') };
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
  let transcript = '', errors = '', launches = 0, desktopReads = 0, keychainReads = 0, replacements = 0, runtime, authError;
  output.on('data', chunk => { transcript += chunk; });
  errorOutput.on('data', chunk => { errors += chunk; });
  const fake = fileURLToPath(new URL('./fixtures/app-server-fake.mjs', import.meta.url));
  input.end('fixture prompt\n');
  let unlinkMock;
  if (replaceAtUnlink) {
    const unlink = fs.unlink;
    unlinkMock = t.mock.method(fs, 'unlink', async target => {
      if (target === authPath) {
        replacements++;
        await fs.rename(authPath, backup);
        await writeFile(authPath, 'concurrent replacement', { mode: 0o600 });
      }
      return unlink(target);
    });
    syncBuiltinESMExports();
  }
  try {
    const code = await main({ env, input, output, errorOutput, argv: [
      '--runtime', 'core', '--cwd', f.root, '--app-bundle', f.appBundle, '--skip-desktop-inspect',
      '--no-copy-catalog', '--auth-file', 'projection/auth.json', '--consume-auth-file',
      ...(nonInteractive ? ['--non-interactive'] : []),
    ] }, {
      rpcTimeout: 3000, exitTimeout: 200,
      async prepareDesktopRuntime(options) {
        assert.equal(options.useKeychain, false);
        runtime = await prepareDesktopRuntime(options);
        assert.equal(runtime.withOSCredentialReader, undefined);
        return { ...runtime, withOSCredentialReader() { keychainReads++; throw new Error('Unexpected Keychain read'); } };
      },
      desktopAccount() { desktopReads++; throw new Error('Unexpected Desktop account read'); },
      async projectedAccount(...args) {
        try { return await projectedAccount(...args); }
        catch (error) { authError = error; throw error; }
      },
      launch(executable, args, options) {
        assert.equal(existsSync(authPath), false);
        launches++;
        const child = spawn(process.execPath, [fake], { ...options, env: { ...options.env,
          TEST_SCENARIO: 'projected-auth', TEST_PROJECTED_AUTH_FILE: authPath } });
        return child;
      },
    });
    assert.equal(keychainReads, 0);
    assert.equal(desktopReads, 0);
    assert.doesNotMatch(transcript + errors, /header-secret|fixture-legacy-secret/);
    assert.equal(runtime.configPath, await realpath(f.catalogPath));
    assert.equal(runtime.env.HOME, runtime.home);
    assert.equal(runtime.env.ZCODE_DATA_BASE_DIR, runtime.home);
    assert.equal(runtime.env.XDG_DATA_HOME, runtime.home);
    assert.equal(runtime.env.TMPDIR, env.TMPDIR);
    assert.equal(runtime.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(runtime.home, '.zcode/v2/provider_config.json'));
    assert.ok(runtime.home.startsWith(f.root + '/herdr-zcode-'));
    for (const key of ['ZCODE_HOME', 'ZCODE_STORAGE_DIR', 'ZCODE_CREDENTIAL_SECRET', 'ZCODE_CREDENTIAL_SECRET_FILE']) {
      assert.equal(runtime.env[key], undefined, key);
    }
    await assert.rejects(access(runtime.home), { code: 'ENOENT' });
    await assert.rejects(access(nativeHome), { code: 'ENOENT' });
    await access(f.catalogPath);
    return { code, transcript, errors, launches, authPath, authError, backup, replacements };
  } finally {
    if (unlinkMock) {
      unlinkMock.mock.restore();
      syncBuiltinESMExports();
    }
    if (unremovable) await chmod(source, 0o700);
  }
}

test('projected Core launch consumes the file before spawn and isolates the child with direct catalog reuse', async t => {
  const { code, transcript, errors, launches, authPath } = await projectedEntrypoint(t);
  assert.equal(code, 0, transcript + errors);
  assert.equal(launches, 1);
  assert.match(transcript, /Reply 1/);
  await assert.rejects(access(authPath), { code: 'ENOENT' });
});

test('failed projected consumption withholds spawn', { skip: process.getuid() === 0 }, async t => {
  const { code, launches, authPath } = await projectedEntrypoint(t, { unremovable: true });
  assert.equal(code, 1);
  assert.equal(launches, 0);
  assert.deepEqual(await readFile(authPath), Buffer.alloc(JSON.stringify(projection).length));
});

test('replacing the projected path at unlink reports blocked auth and withholds spawn', async t => {
  const { code, transcript, launches, authPath, authError, backup, replacements } = await projectedEntrypoint(t,
    { replaceAtUnlink: true, nonInteractive: true });
  assert.equal(replacements, 1);
  await assert.rejects(access(authPath), { code: 'ENOENT' });
  assert.equal(await readFile(backup, 'utf8'), JSON.stringify(projection));
  assert.equal(code, 1);
  assert.equal(launches, 0);
  assert.equal(authError?.blockedKind, 'auth');
  assert.equal(authError?.message, 'Cannot consume projected auth file');
  assert.match(transcript, /\x1b\]7501;state=blocked:kind=auth\x07/);
});

test('--consume-auth-file requires the explicit input path', () => {
  assert.throws(() => parseArgs(['--consume-auth-file']), /requires --auth-file/);
});
