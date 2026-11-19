import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { desktopAccount, DEFAULT_MODEL } from '../lib/desktop-account.mjs';
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
