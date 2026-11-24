import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectDesktop, readToolchains } from '../lib/toolchain.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const pins = readToolchains();
const minimum = pins.ZCODE_APP_MIN_VERSION;
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";

const catalog = { schemaVersion: 1, revision: 44, config: { modelConfigRules: {}, providerConfigRules: {
  providerRules: [{ providerId: 'account:zai-individual-coding-plan', config: {
    access: { type: 'zhipu-account', accountType: 'zai', mode: 'individual-coding-plan' },
    api: { type: 'anthropic', baseUrl: 'https://fixture.invalid/coding-plan' }, builtinModelIds: ['GLM-5.3'],
  } }],
} } };

async function installFixture(t) {
  const root = await realpath(await mkdtemp(join(process.env.TEST_TMP_ROOT || '/tmp', 'hz-desktop-check-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'empty-home');
  const packageDir = join(root, 'prefix/lib/node_modules/herdr-zcode');
  const bin = join(root, 'prefix/bin/herdr-zcode');
  const { files } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await Promise.all([mkdir(home), mkdir(dirname(bin), { recursive: true })]);
  for (const path of ['package.json', ...files]) {
    const destination = join(packageDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, path), destination);
  }
  await symlink('../lib/node_modules/herdr-zcode/bin/herdr-zcode', bin);
  return { root, bin, packageDir, entry: join(packageDir, 'bin/herdr-zcode-app.mjs'), env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: root } };
}

async function pinNode(f) {
  const nvm = join(f.root, 'nvm');
  const node = join(nvm, 'versions/node', `v${pins.NODE_VERSION}`, 'bin/node');
  const nodeMarker = join(f.root, 'pinned-node');
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, `#!/bin/sh
[ -z "\${ELECTRON_RUN_AS_NODE:-}" ] || exit 96
printf '%s' pinned > ${shell(nodeMarker)}
exec ${shell(process.execPath)} "$@"
`, { mode: 0o755 });
  return { env: { ...f.env, NVM_DIR: nvm }, nodeMarker };
}

async function bundleFixture(root, name, { app = '4.0.0', build = '<string>fixture-build</string>', guardNode, probeNode = '20.19.0' } = {}) {
  const bundle = join(root, name);
  const executable = join(bundle, 'Contents/MacOS/ZCode');
  const appServer = join(bundle, 'Contents/Resources/glm/zcode.cjs');
  const catalogPath = join(bundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  const marker = join(bundle, 'forbidden-operation');
  const probeMarker = join(bundle, 'embedded-probe');
  const preload = join(await mkdtemp(join(root, 'preload-')), 'fixture-preload.mjs');
  await Promise.all([executable, appServer, catalogPath].map(path => mkdir(dirname(path), { recursive: true })));
  await writeFile(join(bundle, 'Contents/Info.plist'),
    `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${app}</string><key>CFBundleVersion</key>${build}</dict></plist>`);
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(appServer, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'app-server'); process.exit(97);`);
  await writeFile(preload, `import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const forbidden = () => { fs.writeFileSync(${JSON.stringify(marker)}, 'forbidden'); throw new Error('forbidden fixture operation'); };
Object.defineProperty(process.versions, 'electron', { value: '44.7.0' });
${guardNode ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(guardNode)} });` : ''}
for (const key of ['readFile', 'open', 'stat', 'lstat', 'access']) {
  const actual = fs.promises[key];
  fs.promises[key] = (path, ...args) => /\\/\\.zcode\\/|\\/Keychains\\//.test(String(path)) ? forbidden() : actual(path, ...args);
}
const execFile = child.execFile;
const guard = run => (file, ...args) => /\\/(codesign|security)$/.test(file) ? forbidden() : run(file, ...args);
child.execFile = guard(execFile);
Object.defineProperty(child.execFile, promisify.custom, { value: guard(promisify(execFile)) });
net.Socket.prototype.connect = globalThis.fetch = http.request = https.request = forbidden;
syncBuiltinESMExports();
`);
  const probe = JSON.stringify({ node: probeNode, electron: '44.7.0', execPath: executable });
  await writeFile(executable, `#!/bin/sh
[ "\${ELECTRON_RUN_AS_NODE:-}" = 1 ] || exit 89
case "\${1:-}" in
  -p)
    printf '%s' probe > ${shell(probeMarker)}
    printf '%s\\n' ${shell(probe)} ;;
  */bin/herdr-zcode-app.mjs)
    exec ${shell(process.execPath)} --import ${shell(pathToFileURL(preload).href)} "$@" ;;
  *) printf '%s' unexpected > ${shell(marker)}; exit 89 ;;
esac
`, { mode: 0o755 });
  return { bundle, executable, catalogPath, appServer, marker, probeMarker };
}

async function run(f, args, expectedCode, env = f.env) {
  const { stdout, stderr, code = 0 } = await exec(f.bin, args, { env, cwd: '/private/var/empty', timeout: 20000 })
    .catch(error => {
      if (typeof error.code !== 'number') throw error;
      return error;
    });
  assert.equal(code, expectedCode, stdout + stderr);
  assert.equal(stderr, '');
  assert.match(stdout, /^[^\n]+\n$/);
  return JSON.parse(stdout);
}

async function failure(f, args, reason, appBundle, appVersion, { min = minimum, env = f.env } = {}) {
  const result = await run(f, args, 1, env);
  assert.deepEqual(Object.keys(result).sort(), ['appBundle', 'appVersion', 'compatible', 'message', 'minZcodeAppVersion', 'reason']);
  assert.deepEqual({ ...result, message: undefined }, { compatible: false, reason, appVersion, appBundle, minZcodeAppVersion: min, message: undefined });
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
}

const args = bundle => ['--check-desktop', '--json', '--app-bundle', bundle];

test('installed Desktop check reports compatible from a minimal environment without account or app-server access', async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'ZCode "quoted" \\ unicode-한글\n.app');
  const result = await run(f, args(d.bundle), 0, { ...f.env, HOME: '', HERDR_ZCODE_APP_BUNDLE: '/missing-decoy.app',
    PERL5OPT: '-CA', PERL_UNICODE: 'A' });
  assert.deepEqual(result, { compatible: true, appVersion: '4.0.0', build: 'fixture-build', minZcodeAppVersion: minimum,
    appBundle: d.bundle, nodeVersion: '20.19.0', electronVersion: '44.7.0' });
  await access(d.probeMarker);
  await assert.rejects(access(d.marker), { code: 'ENOENT' });
  assert.equal((await run(f, ['--json', '--check-desktop'], 0, { ...f.env, HERDR_ZCODE_APP_BUNDLE: d.bundle })).appBundle, d.bundle);
});

test('installed Desktop check validates usage and bundle failures in order', async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'Old ZCode.app', { app: '0.0.1' });
  const missing = join(f.root, 'missing "app" \\ unicode-한글\n.app');
  for (const conflicting of [['--runtime', 'core'], ['--version'], ['prepare-isolated'], ['--json'], ['--app-bundle'], ['--app-bundle', d.bundle]]) {
    await failure(f, [...args(d.bundle), ...conflicting], 'invalid_arguments', d.bundle, '0.0.1');
  }
  await failure(f, ['--check-desktop', '--app-bundle', d.bundle], 'invalid_arguments', d.bundle, '0.0.1');
  await failure(f, args(missing), 'app_bundle_missing', missing, null);
  await failure(f, args(d.bundle), 'app_version_below_minimum', d.bundle, '0.0.1');
  await assert.rejects(access(d.probeMarker), { code: 'ENOENT' });
  await writeFile(d.catalogPath, '{invalid');
  await failure(f, args(d.bundle), 'app_bundle_invalid', d.bundle, '0.0.1');
  await rm(d.appServer);
  await failure(f, args(d.bundle), 'app_bundle_invalid', d.bundle, '0.0.1');
  await assert.rejects(access(d.marker), { code: 'ENOENT' });

  const invalidVersion = await bundleFixture(f.root, 'Invalid app version.app', { app: 'invalid-version' });
  await failure(f, args(invalidVersion.bundle), 'app_bundle_invalid', invalidVersion.bundle, null);
  const invalidBuild = await bundleFixture(f.root, 'Invalid build.app', { build: '<integer>19</integer>' });
  await failure(f, args(invalidBuild.bundle), 'app_bundle_invalid', invalidBuild.bundle, '4.0.0');
  const invalidExecutable = await bundleFixture(f.root, 'Invalid executable.app');
  await chmod(invalidExecutable.executable, 0o644);
  await failure(f, args(invalidExecutable.bundle), 'app_bundle_invalid', invalidExecutable.bundle, '4.0.0');
  const invalidRules = await bundleFixture(f.root, 'Missing Coding Plan rule.app');
  const rules = structuredClone(catalog);
  rules.config.providerConfigRules.providerRules = [];
  await writeFile(invalidRules.catalogPath, JSON.stringify(rules));
  await failure(f, args(invalidRules.bundle), 'app_bundle_invalid', invalidRules.bundle, '4.0.0');
});

test('installed Desktop check treats a literal 0 bundle environment path as a path', async t => {
  const f = await installFixture(t);
  await failure(f, ['--check-desktop', '--json'], 'app_bundle_missing', '/private/var/empty/0', null, {
    env: { ...f.env, HERDR_ZCODE_APP_BUNDLE: '0' },
  });
});

test('installed Desktop check handles unavailable, below-floor and noisy embedded runtimes', async t => {
  const f = await installFixture(t);
  const unlaunchable = await bundleFixture(f.root, 'Unlaunchable ZCode.app');
  await writeFile(unlaunchable.executable, '#!/missing-interpreter\nexit 99\n');
  await failure(f, args(unlaunchable.bundle), 'embedded_runtime_invalid', unlaunchable.bundle, '4.0.0');
  const spoofed = await bundleFixture(f.root, 'Malformed success.app');
  await writeFile(spoofed.executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"compatible":true}\'\n');
  await failure(f, args(spoofed.bundle), 'embedded_runtime_invalid', spoofed.bundle, '4.0.0');

  const guard = await bundleFixture(f.root, 'Old bootstrap Node.app', { guardNode: '19.9.0' });
  await failure(f, args(guard.bundle), 'embedded_runtime_invalid', guard.bundle, '4.0.0');
  await assert.rejects(access(guard.probeMarker), { code: 'ENOENT' });
  const oldProbe = await bundleFixture(f.root, 'Old probe Node.app', { probeNode: '19.9.0' });
  await failure(f, args(oldProbe.bundle), 'embedded_runtime_invalid', oldProbe.bundle, '4.0.0');
  await access(oldProbe.probeMarker);

  const stalled = await bundleFixture(f.root, 'Stalled ZCode.app');
  const pidFile = join(f.root, 'bootstrap-pid');
  await writeFile(stalled.executable, `#!/bin/sh
printf '%s' "$$" > ${shell(pidFile)}
printf 'untrusted partial output'
printf 'untrusted error' >&2
trap '' TERM
/bin/sleep 60
`);
  await failure(f, args(stalled.bundle), 'embedded_runtime_invalid', stalled.bundle, '4.0.0');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('unreadable app-server entry takes precedence over a below-minimum app version', { skip: process.getuid() === 0 }, async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'Unreadable entry.app', { app: '0.0.1' });
  await chmod(d.appServer, 0);
  await assert.rejects(inspectDesktop(d.bundle), { reason: 'app_bundle_invalid', app: '0.0.1' });
  await failure(f, args(d.bundle), 'app_bundle_invalid', d.bundle, '0.0.1');
  await assert.rejects(access(d.probeMarker), { code: 'ENOENT' });
});

test('installed bootstrap reports an unreadable bundled catalog before the version floor when embedded JS is unavailable', {
  skip: process.getuid() === 0,
}, async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'Unreadable catalog.app', { app: '0.0.1' });
  await writeFile(d.executable, '#!/missing-interpreter\nexit 99\n');
  await failure(f, args(d.bundle), 'app_version_below_minimum', d.bundle, '0.0.1');
  await chmod(d.catalogPath, 0);
  await failure(f, args(d.bundle), 'app_bundle_invalid', d.bundle, '0.0.1');
});

test('installed bootstrap rejects spoofed result fields with non-string JSON types or blank Electron version', async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'Typed JSON fields.app', { build: '<string>42</string>' });
  const success = { compatible: true, appVersion: '4.0.0', build: '42', minZcodeAppVersion: minimum,
    appBundle: d.bundle, nodeVersion: '20.19.0', electronVersion: '44.7.0' };
  async function spoof(result, code) {
    await writeFile(d.executable, `#!/bin/sh\nprintf '%s\\n' ${shell(JSON.stringify(result))}\nexit ${code}\n`);
    await failure(f, args(d.bundle), 'embedded_runtime_invalid', d.bundle, '4.0.0');
  }
  for (const override of [{ build: 42 }, { electronVersion: true }, { electronVersion: {} }, { electronVersion: ' \uFEFF ' }]) {
    await spoof({ ...success, ...override }, 0);
  }
  await spoof({ compatible: false, reason: 'app_bundle_invalid', message: 'ZCode Desktop bundle has missing or invalid required metadata or files.',
    appVersion: '4.0.0', minZcodeAppVersion: minimum, appBundle: d.bundle, extra: 'unsolicited' }, 1);
});

test('direct JS Desktop check reports invalid arguments, malformed pins, and metadata before its mismatched Node guard', async t => {
  const f = await installFixture(t);
  const direct = { ...f, bin: process.execPath };
  const d = await bundleFixture(f.root, 'Direct JS.app');
  const old = await bundleFixture(f.root, 'Direct JS old.app', { app: '0.0.1' });
  const command = bundle => [f.entry, ...args(bundle)];
  await failure(direct, [...command(d.bundle), '--runtime', 'core'], 'invalid_arguments', d.bundle, '4.0.0');

  const pinsPath = join(f.packageDir, 'toolchains.env');
  const declarations = await readFile(pinsPath, 'utf8');
  await writeFile(pinsPath, 'NODE_VERSION=invalid\n');
  await failure(direct, command(d.bundle), 'embedded_runtime_invalid', d.bundle, '4.0.0', { min: null });
  await writeFile(pinsPath, declarations.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=0.0.0'));
  await failure(direct, command(d.bundle), 'embedded_runtime_invalid', d.bundle, '4.0.0');
  await failure(direct, command(old.bundle), 'app_version_below_minimum', old.bundle, '0.0.1');
  await writeFile(old.catalogPath, '{invalid');
  await failure(direct, command(old.bundle), 'app_bundle_invalid', old.bundle, '0.0.1');
  await assert.rejects(access(d.probeMarker), { code: 'ENOENT' });
  await assert.rejects(access(old.probeMarker), { code: 'ENOENT' });
});

test('installed pinned nvm and dev doctor share compatible and failing Desktop checks', async t => {
  const f = await installFixture(t);
  const { env, nodeMarker } = await pinNode(f);
  const d = await bundleFixture(f.root, 'Pinned nvm.app');
  const old = await bundleFixture(f.root, 'Pinned nvm old Electron.app', { probeNode: '19.9.0' });
  const npmCache = join(f.root, 'npm-cache');
  const npm = join(npmCache, `node-${pins.NODE_VERSION}`, `npm-${pins.NPM_VERSION}`, 'package/bin/npm-cli.js');
  await mkdir(dirname(npm), { recursive: true });
  await writeFile(npm, `console.log(${JSON.stringify(pins.NPM_VERSION)});\n`);
  const doctor = bundle => exec(join(source, 'dev'), ['doctor', '--desktop'], { cwd: '/private/var/empty',
    env: { ...env, HERDR_ZCODE_TOOLCHAIN_CACHE: npmCache, HERDR_ZCODE_APP_BUNDLE: bundle }, timeout: 20000 });

  const installed = await run(f, args(d.bundle), 0, { ...env, ELECTRON_RUN_AS_NODE: '1' });
  await access(nodeMarker);
  const observed = JSON.parse((await doctor(d.bundle)).stdout).desktop;
  assert.deepEqual([observed.app, observed.build, observed.minimum, observed.bundle, observed.node, observed.electron],
    [installed.appVersion, installed.build, installed.minZcodeAppVersion, installed.appBundle, installed.nodeVersion, installed.electronVersion]);

  await writeFile(d.catalogPath, '{invalid');
  await failure(f, args(d.bundle), 'app_bundle_invalid', d.bundle, '4.0.0', { env });
  await assert.rejects(doctor(d.bundle), /missing or invalid required metadata or files/);
  await failure(f, args(old.bundle), 'embedded_runtime_invalid', old.bundle, '4.0.0', { env });
  await assert.rejects(doctor(old.bundle), /embedded runtime is unavailable or incompatible/);
});

test('direct Desktop check suppresses partial output and reaps a stalled embedded -p probe', async t => {
  const f = await installFixture(t);
  const d = await bundleFixture(f.root, 'Stalled probe.app');
  await writeFile(d.executable, `#!/bin/sh
[ "\${1:-}" = -p ] || exit 90
printf '%s' "$$" > ${shell(d.probeMarker)}
printf 'partial-probe-output'
printf 'partial-probe-error' >&2
trap '' TERM
exec /bin/sleep 60
`);
  await failure({ ...f, bin: process.execPath }, [f.entry, ...args(d.bundle)], 'embedded_runtime_invalid', d.bundle, '4.0.0');
  const pid = Number(await readFile(d.probeMarker, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
