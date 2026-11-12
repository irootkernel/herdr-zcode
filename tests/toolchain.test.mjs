import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { readToolchains } from '../lib/toolchain.mjs';
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
  for (const invalid of [original.replace(/^NODE_VERSION=.*\n/m, ''), original.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=latest'), original + 'NODE_VERSION=1.2.3\n']) {
    await writeFile(manifest, invalid);
    assert.throws(() => readToolchains(manifest));
    await assert.rejects(exec(join(f.root, 'dev'), ['run', '--version'], { env: f.env }), /toolchain|exact version/);
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
test('Desktop mismatch is rejected before any temporary catalog is created', async t => {
  const f = await fixture(t);
  const bundle = join(f.root, 'ZCode.app'); await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  const pins = readToolchains(), executable = join(bundle, 'Contents/MacOS/ZCode');
  await writeFile(join(bundle, 'Contents/Info.plist'), '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' + pins.ZCODE_APP_VERSION + '</string><key>CFBundleVersion</key><string>' + pins.ZCODE_APP_BUILD + '</string></dict></plist>');
  for (const mismatch of [
    { node: '0.0.0', electron: pins.ZCODE_ELECTRON_VERSION },
    { node: pins.ZCODE_NODE_VERSION, electron: '0.0.0' },
    { node: pins.ZCODE_NODE_VERSION, electron: pins.ZCODE_ELECTRON_VERSION, app: '0.0.0' },
    { node: pins.ZCODE_NODE_VERSION, electron: pins.ZCODE_ELECTRON_VERSION, build: '0.0.0.0' },
  ]) {
    await writeFile(join(bundle, 'Contents/Info.plist'), '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' + (mismatch.app || pins.ZCODE_APP_VERSION) + '</string><key>CFBundleVersion</key><string>' + (mismatch.build || pins.ZCODE_APP_BUILD) + '</string></dict></plist>');
    await writeFile(executable, '#!/bin/sh\ncat <<\'JSON\'\n' + JSON.stringify({ ...mismatch, execPath: executable }) + '\nJSON\n', { mode: 0o755 });
    const { prepareDesktopRuntime } = await import('../lib/desktop-runtime.mjs');
    const before = await readdir(f.root);
    await assert.rejects(prepareDesktopRuntime({ appBundle: bundle, tmpRoot: f.root }), /ZCode (app|build|node|electron): expected/);
    assert.deepEqual(await readdir(f.root), before);
  }
});
