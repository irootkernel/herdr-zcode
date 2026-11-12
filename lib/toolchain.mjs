import { readFileSync, realpathSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFile = promisify(execFileCallback);
export const root = new URL('../', import.meta.url);
export function readToolchains(file = new URL('../toolchains.env', import.meta.url)) {
  const schema = { NODE_VERSION: 3, NPM_VERSION: 3, ZCODE_APP_VERSION: 3,
    ZCODE_APP_BUILD: 4, ZCODE_NODE_VERSION: 3, ZCODE_ELECTRON_VERSION: 3 };
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([0-9]+(?:\.[0-9]+)+)$/.exec(line);
    if (!match || !Object.hasOwn(schema, match[1]) || Object.hasOwn(values, match[1]) ||
        match[2].split('.').length !== schema[match[1]]) throw new Error('Invalid or duplicate toolchain declaration');
    values[match[1]] = match[2];
  }
  for (const key of Object.keys(schema)) if (!values[key]) throw new Error('Missing toolchain key: ' + key);
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
  const [{ stdout: app }, { stdout: build }, { stdout: runtime }] = await Promise.all([
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], options),
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], options),
    execFile(executable, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath})'], options),
  ]);
  const actual = { app: app.trim(), build: build.trim(), ...JSON.parse(runtime) };
  for (const [field, key] of Object.entries({ app: 'ZCODE_APP_VERSION', build: 'ZCODE_APP_BUILD',
    node: 'ZCODE_NODE_VERSION', electron: 'ZCODE_ELECTRON_VERSION' })) {
    if (actual[field] !== versions[key]) throw new Error('ZCode ' + field + ': expected ' + versions[key] +
      '; actual ' + actual[field] + ' at ' + executable);
  }
  if (realpathSync(actual.execPath) !== realpathSync(executable)) throw new Error('ZCode executable path mismatch');
  return { ...actual, executable, realPath: realpathSync(executable) };
}
