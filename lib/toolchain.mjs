import { readFileSync, realpathSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFile = promisify(execFileCallback);
export const root = new URL('../', import.meta.url);
const versionPattern = /^\d+\.\d+\.\d+$/;
export function readToolchains(file = new URL('../toolchains.env', import.meta.url)) {
  const keys = ['NODE_VERSION', 'NPM_VERSION', 'ZCODE_APP_MIN_VERSION'];
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.+)$/.exec(line);
    if (!match || !keys.includes(match[1]) || Object.hasOwn(values, match[1]) ||
        !versionPattern.test(match[2])) throw new Error('Invalid or duplicate toolchain declaration');
    values[match[1]] = match[2];
  }
  for (const key of keys) if (!values[key]) throw new Error('Missing toolchain key: ' + key);
  return values;
}
export function assertNode() {
  const expected = readToolchains().NODE_VERSION;
  if (process.versions.node !== expected) throw new Error(
    'Expected Node ' + expected + '; actual ' + process.versions.node + ' at ' + process.execPath + '. Use ./dev or the installed herdr-zcode launcher.');
}
export async function inspectDesktop(appBundle, versions = readToolchains()) {
  const bundle = resolve(appBundle);
  const executable = join(bundle, 'Contents/MacOS/ZCode');
  const plist = join(bundle, 'Contents/Info.plist');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const options = { env, timeout: 10000, maxBuffer: 65536 };
  const { stdout: shortVersion } = await execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], options);
  const app = shortVersion.trim(), minimum = versions.ZCODE_APP_MIN_VERSION;
  if (!versionPattern.test(app)) throw new Error('Invalid ZCode Desktop version');
  const installed = app.split('.').map(BigInt), required = minimum.split('.').map(BigInt);
  const difference = installed.findIndex((part, index) => part !== required[index]);
  if (difference >= 0 && installed[difference] < required[difference]) {
    throw new Error(`ZCode Desktop requires ${minimum} or newer; found ${app} at ${executable}`);
  }
  const [{ stdout: build }, { stdout: runtime }] = await Promise.all([
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], options),
    execFile(executable, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath})'], options),
  ]);
  const { node, electron, execPath } = JSON.parse(runtime);
  if (typeof node !== 'string' || !node || typeof electron !== 'string' || !electron || typeof execPath !== 'string') {
    throw new Error('Invalid ZCode embedded runtime');
  }
  const realPath = realpathSync(executable);
  if (realpathSync(execPath) !== realPath) throw new Error('ZCode executable path mismatch');
  return { minimum, app, build: build.trim(), node, electron, execPath, executable, realPath };
}
