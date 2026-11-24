import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolchains } from '../lib/toolchain.mjs';
const exec = promisify(execFile);
test('npm-style executable symlink dispatches version/help without account access', async t => {
  const root = await mkdtemp(join(process.env.TEST_TMP_ROOT || tmpdir(), 'hz-bin-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'herdr-zcode');
  await symlink(fileURLToPath(new URL('../bin/herdr-zcode', import.meta.url)), link);
  const env = { PATH: '/usr/bin:/bin', HOME: root, HERDR_ZCODE_APP_BUNDLE: join(root, 'missing-app'),
    NVM_DIR: dirname(dirname(dirname(dirname(dirname(process.execPath))))) };
  const version = await exec(link, ['--version'], { env, cwd: root, timeout: 4000 });
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.stdout, `herdr-zcode ${metadata.version}\n`);
  const help = await exec(link, ['--help'], { env, cwd: root, timeout: 4000 });
  assert.match(help.stdout, /--prompt-file/);
});

test('standalone symlinks fall back to the selected embedded Node with scrubbed environment', async t => {
  const root = await mkdtemp(join(process.env.TEST_TMP_ROOT || tmpdir(), 'hz-bin-embedded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'empty home'), decoys = join(root, 'decoys');
  const bundle = join(root, 'Custom ZCode.app'), executable = join(bundle, 'Contents/MacOS/ZCode');
  await Promise.all([mkdir(home), mkdir(decoys), mkdir(dirname(executable), { recursive: true })]);
  const directLink = join(root, 'direct');
  const link = join(root, 'herdr-zcode');
  await symlink(fileURLToPath(new URL('../bin/herdr-zcode', import.meta.url)), directLink);
  await symlink('direct', link);
  const preload = join(root, 'embedded.mjs');
  await writeFile(preload, "Object.defineProperty(process.versions, 'electron', { value: '44.7.0' });\n");
  await writeFile(join(decoys, 'node'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(executable, [
    '#!/bin/sh', 'set -eu',
    '[ "$ELECTRON_RUN_AS_NODE" = 1 ] && [ -z "${NODE_OPTIONS+x}${NODE_PATH+x}" ] || exit 92',
    'case "$1" in */bin/herdr-zcode-app.mjs) ;; *) exit 93 ;; esac',
    `exec ${quote(process.execPath)} --import ${quote(preload)} "$@"`,
  ].join('\n') + '\n', { mode: 0o755 });
  const invalidBundle = join(root, 'missing-app');
  const env = { PATH: '/usr/bin:/bin', HOME: home, HERDR_ZCODE_APP_BUNDLE: bundle,
    NODE_OPTIONS: '--this-would-fail-node', NODE_PATH: join(root, 'foreign-modules') };
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = await exec(link, ['--app-bundle', invalidBundle, '--app-bundle', './Custom ZCode.app', '--version'],
    { env: { ...env, PATH: `${decoys}:/usr/bin:/bin`, HERDR_ZCODE_APP_BUNDLE: invalidBundle }, cwd: root });
  assert.equal(version.stdout, `herdr-zcode ${metadata.version}\n`);
  const json = await exec(link, ['--version', '--json'], { env, cwd: root });
  assert.deepEqual(JSON.parse(json.stdout), { name: 'herdr-zcode', version: metadata.version,
    runtimes: ['tui', 'core'], osc7501: true, minZcodeAppVersion: readToolchains().ZCODE_APP_MIN_VERSION,
    capabilities: ['core', 'osc7501', 'catalogFile', 'prepareIsolated', 'checkDesktop'] });
  const { HOME, ...withoutHome } = env;
  const help = await exec(link, ['--help'], { env: withoutHome, cwd: root });
  assert.match(help.stdout, /--runtime-dir.*--skip-desktop-inspect/);
  for (const args of [['--runtime-dir'], ['--runtime-dir', '--version'], ['--app-bundle'], ['--app-bundle', '--help']]) {
    await assert.rejects(exec(link, args, { env, cwd: root }), { code: 1, stderr: /Invalid command arguments/ });
  }
  await assert.rejects(exec(link, ['--json'], { env, cwd: root }), { code: 1, stderr: /--json requires --version/ });
  await assert.rejects(exec(link, ['--version'], { env: { ...env, PATH: `${decoys}:/usr/bin:/bin`,
    HERDR_ZCODE_APP_BUNDLE: invalidBundle }, cwd: root }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /unavailable through nvm and no ZCode executable/);
    return true;
  });
});
