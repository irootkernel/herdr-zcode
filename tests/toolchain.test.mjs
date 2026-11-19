import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});
