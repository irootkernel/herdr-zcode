import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, mkdtemp, rm, cp, readFile, writeFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectDesktop, readToolchains } from '../lib/toolchain.mjs';
const exec = promisify(callback);
const source = fileURLToPath(new URL('../', import.meta.url));
const nvm = dirname(dirname(dirname(dirname(dirname(process.execPath)))));
async function fixture(t) {
  const root = await mkdtemp('/tmp/herdr-zcode-pins-');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['dev', 'bin', 'scripts', 'lib', 'toolchains.env', 'package.json']) await cp(join(source, path), join(root, path), { recursive: true });
  return { root, env: { ...process.env, NVM_DIR: nvm, HERDR_ZCODE_TOOLCHAIN_CACHE: join(root, 'cache') } };
}
test('launcher ignores ambient Node/npm and keeps help/account access separate', async t => {
  const f = await fixture(t);
  const decoys = join(f.root, 'decoys'); await mkdir(decoys);
  for (const tool of ['node', 'npm']) await writeFile(join(decoys, tool), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  f.env.PATH = decoys + ':/usr/bin:/bin';
  f.env.HERDR_ZCODE_APP_BUNDLE = '/missing-desktop';
  const version = await exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env, cwd: '/tmp' });
  assert.match(version.stdout, /^herdr-zcode /);
  const help = await exec(join(f.root, 'dev'), ['run', '--help'], { env: f.env });
  assert.match(help.stdout, /--app-bundle/);
  await assert.rejects(exec(join(f.root, 'dev'), ['doctor'], { env: f.env }), /Pinned npm is missing/);
  const child = await exec(join(f.root, 'dev'), ['node', '--input-type=module', '-e',
    'import {spawnSync} from "node:child_process"; const r=spawnSync("npm",["--version"],{encoding:"utf8"}); if(r.status===0 || !r.stderr.includes("Pinned npm is missing")) process.exit(1); console.log("guarded")'], { env: f.env });
  assert.match(child.stdout, /guarded/);
});
test('missing or malformed declarations fail without inherited environment fallback', async t => {
  const f = await fixture(t), manifest = join(f.root, 'toolchains.env');
  const original = await readFile(manifest, 'utf8');
  for (const invalid of [original.replace(/^NODE_VERSION=.*\n/m, ''), original.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=latest'),
    original + 'NODE_VERSION=1.2.3\n', original.replace(/^ZCODE_APP_MIN_VERSION=(.+)$/m, 'ZCODE_APP_MIN_VERSION=>=$1')]) {
    await writeFile(manifest, invalid);
    assert.throws(() => readToolchains(manifest));
    await assert.rejects(exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env }), /toolchain|Invalid version/);
  }
  await rm(manifest);
  await assert.rejects(exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env }), /Missing toolchains.env/);
});
test('missing and mismatched selected Node fail before the product starts', async t => {
  const f = await fixture(t); f.env.NVM_DIR = join(f.root, 'nvm');
  await assert.rejects(exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env }), /nvm install/);
  const bin = join(f.env.NVM_DIR, 'versions/node/v' + readToolchains().NODE_VERSION, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'node'), '#!/bin/sh\necho 0.0.0\n', { mode: 0o755 });
  await assert.rejects(exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env }), /Expected Node .*actual 0.0.0/);
});
test('direct entry and npm lifecycle guard reject wrong tool versions', async t => {
  const f = await fixture(t), manifest = join(f.root, 'toolchains.env');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, original.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=0.0.0'));
  await assert.rejects(exec(process.execPath, [join(f.root, 'bin/herdr-zcode-app.mjs'), '--version'], { env: f.env }), /Expected Node 0.0.0/);
  await writeFile(manifest, original);
  const fakeNpm = join(f.root, 'fake-npm.cjs'); await writeFile(fakeNpm, 'console.log("0.0.0")');
  await assert.rejects(exec(process.execPath, [join(f.root, 'scripts/check-toolchain.mjs')], {
    env: { ...f.env, npm_execpath: fakeNpm, npm_node_execpath: process.execPath },
  }), /Expected npm .*actual 0.0.0/);
});
test('Desktop minimum gates startup and newer builds keep their reported runtime versions', async t => {
  const f = await fixture(t);
  const bundle = join(f.root, 'ZCode.app'); await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  const executable = join(bundle, 'Contents/MacOS/ZCode');
  const launcher = join(bundle, 'Contents/Resources/glm/zcode.cjs');
  const catalog = join(bundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(catalog), { recursive: true });
  await writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(launcher, '// Offline fixture');
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, revision: 1, config: { modelConfigRules: {},
    providerConfigRules: { providerRules: [{ providerId: 'account:zai-individual-coding-plan', config: {
      access: { type: 'zhipu-account', accountType: 'zai', mode: 'individual-coding-plan' },
      api: { type: 'anthropic', baseUrl: 'https://fixture.invalid/api' }, builtinModelIds: ['GLM-5.3'],
    } }] },
  } }));
  const { ZCODE_APP_MIN_VERSION: minimum } = readToolchains();
  const [major, minor, patch] = minimum.split('.').map(BigInt);
  const writeVersion = (app, build) => writeFile(join(bundle, 'Contents/Info.plist'),
    `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${app}</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`);
  const { prepareDesktopRuntime } = await import('../lib/desktop-runtime.mjs');
  const before = await readdir(f.root);
  await writeVersion('0.0.0', '1');
  await assert.rejects(prepareDesktopRuntime({ appBundle: bundle, tmpRoot: f.root }), /ZCode Desktop requires .* or newer/);
  assert.deepEqual(await readdir(f.root), before);
  for (const app of ['3.9.99', '3.17.2', '3.18.1']) {
    await writeVersion(app, '1');
    await assert.rejects(inspectDesktop(bundle), { message: `ZCode Desktop requires ${minimum} or newer; found ${app} at ${executable}` });
  }
  for (const [app, build, node, electron] of [
    [minimum, '10443', '24.21.0', '44.7.0'],
    [`${major}.${minor}.${patch + 1n}`, '10444', '25.0.0', '45.0.0'],
    [`${major}.${minor + 100n}.0`, 'future-build', '30.0.0', '50.0.0'],
  ]) {
    await writeVersion(app, build);
    await writeFile(executable, '#!/bin/sh\ncat <<\'JSON\'\n' + JSON.stringify({ node, electron, execPath: executable }) + '\nJSON\n', { mode: 0o755 });
    const observed = await inspectDesktop(bundle);
    assert.deepEqual([observed.minimum, observed.app, observed.build, observed.node, observed.electron], [minimum, app, build, node, electron]);
  }
  await writeVersion(minimum, 'legacy-build');
  for (const node of ['19.0.0', 'legacy-node-version']) {
    const probe = JSON.stringify({ node, electron: 'legacy-electron-version', execPath: executable });
    await writeFile(executable, '#!/bin/sh\ncat <<\'JSON\'\n' + probe + '\nJSON\n');
    const runtime = await prepareDesktopRuntime({ appBundle: bundle, copyCatalog: false });
    try { assert.equal(runtime.executable, await realpath(executable)); }
    finally { await runtime.close(); }
    await assert.rejects(inspectDesktop(bundle), { reason: 'embedded_runtime_invalid' });
  }
});

test('only explicitly allowed Electron Node mode can bypass the exact development pin', async t => {
  const f = await fixture(t);
  const manifest = join(f.root, 'toolchains.env');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=0.0.0'));
  const module = pathToFileURL(join(f.root, 'lib/toolchain.mjs')).href;
  const verify = ({ electron, node = '24.21.0', allow = true, runAsNode = '1' }) => {
    const script = `import { assertNode } from ${JSON.stringify(module)};
      Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(node)} });
      if (${JSON.stringify(Boolean(electron))}) Object.defineProperty(process.versions, 'electron', { value: '44.7.0' });
      assertNode({ allowEmbeddedElectron: ${allow} });`;
    return exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...f.env, ELECTRON_RUN_AS_NODE: runAsNode } });
  };
  await verify({ electron: true });
  await assert.rejects(verify({ electron: false }), /Expected Node 0\.0\.0/);
  await assert.rejects(verify({ electron: true, allow: false }), /Expected Node 0\.0\.0/);
  await assert.rejects(verify({ electron: true, runAsNode: '0' }), /Expected Node 0\.0\.0/);
  await assert.rejects(verify({ electron: true, node: '19.0.0' }), /Unsupported ZCode embedded Node 19\.0\.0/);
});

test('runtime scratch preference and direct catalog reuse avoid inspection and strip terminal routing', async t => {
  const f = await fixture(t);
  const root = await realpath(f.root);
  const appBundle = join(root, 'ZCode.app');
  const executable = join(appBundle, 'Contents/MacOS/ZCode');
  const launcher = join(appBundle, 'Contents/Resources/glm/zcode.cjs');
  const catalog = join(appBundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  const tmp = join(root, 'incoming tmp'), explicit = join(root, 'explicit runtime');
  await Promise.all([executable, launcher, catalog].map(path => mkdir(dirname(path), { recursive: true })));
  await Promise.all([mkdir(tmp), mkdir(explicit), writeFile(executable, '#!/bin/sh\nexit 97\n', { mode: 0o755 }),
    writeFile(launcher, ''), writeFile(catalog, '{"revision":1}')]);
  const { prepareDesktopRuntime } = await import('../lib/desktop-runtime.mjs');
  const env = { TMPDIR: tmp + '/', HC_TERMINAL_ID: 'fixture', HC_SOCKET: 'fixture', HC_TERMINAL_SOCKET: 'fixture',
    HERDR_ZCODE_TOKEN: 'fixture', HERDR_ENV: '1', KEEP_ENV: 'fixture' };
  const options = { appBundle, env, home: root, skipInspect: true };
  const fromEnv = await prepareDesktopRuntime(options);
  const fromFlag = await prepareDesktopRuntime({ ...options, tmpRoot: explicit });
  t.after(async () => { await fromEnv.close(); await fromFlag.close(); });
  assert.equal(dirname(dirname(fromEnv.configPath)), tmp);
  assert.equal(dirname(dirname(fromFlag.configPath)), explicit);
  assert.equal(fromFlag.executable, executable);
  assert.deepEqual(fromFlag.args, [launcher, 'app-server', '--stdio']);
  assert.equal(await readFile(fromFlag.configPath, 'utf8'), '{"revision":1}');
  assert.equal(fromFlag.env.TMPDIR, env.TMPDIR);
  assert.equal(fromFlag.env.KEEP_ENV, 'fixture');
  assert.ok(Object.keys(fromFlag.env).every(key => !key.startsWith('HC_') && !key.startsWith('HERDR_')));
  assert.equal(env.HC_SOCKET, 'fixture');

  const direct = await prepareDesktopRuntime({ ...options, copyCatalog: false, tmpRoot: join(root, 'missing directory') });
  assert.equal(direct.configPath, catalog);
  assert.equal(direct.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, catalog);
  await direct.close();
  assert.equal(await readFile(catalog, 'utf8'), '{"revision":1}');
  await fromEnv.close(); await fromFlag.close();
  assert.deepEqual(await readdir(tmp), []);
  assert.deepEqual(await readdir(explicit), []);

  await t.test('without a scratch override use the OS temporary directory without a volume probe', async t => {
    const volumeProbes = [];
    const { stat } = fs;
    const mock = t.mock.method(fs, 'stat', async (path, ...args) => {
      if (path === '/Volumes' || path === '/Volumes/RootKernel') {
        volumeProbes.push(path);
        throw Object.assign(new Error('Fixture denies the volume probe'), { code: 'EPERM' });
      }
      return stat(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      const runtime = await prepareDesktopRuntime({ ...options, env: {} });
      try {
        assert.equal(dirname(dirname(runtime.configPath)), resolve(tmpdir()));
        assert.deepEqual(volumeProbes, []);
      } finally { await runtime.close(); }
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });

  await chmod(executable, 0o600);
  await assert.rejects(prepareDesktopRuntime(options), { code: 'EACCES', path: executable });
  await chmod(executable, 0o755);
  for (const path of [launcher, catalog]) {
    await rm(path);
    await assert.rejects(prepareDesktopRuntime(options), { code: 'ENOENT', path });
    await writeFile(path, '');
  }
});
