import { constants, readFileSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { codingPlanRule, readBundledCatalogSnapshot } from './desktop-catalog.mjs';

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
export function assertNode({ allowEmbeddedElectron = false } = {}) {
  const expected = readToolchains().NODE_VERSION;
  if (allowEmbeddedElectron && process.env.ELECTRON_RUN_AS_NODE === '1' &&
      typeof process.versions.electron === 'string' && process.versions.electron.length > 0) {
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(major) || major < 20) {
      throw new Error(`Unsupported ZCode embedded Node ${process.versions.node}; requires >= 20.`);
    }
    return;
  }
  if (process.versions.node !== expected) throw new Error(
    'Expected Node ' + expected + '; actual ' + process.versions.node + ' at ' + process.execPath + '. Use ./dev or the installed herdr-zcode launcher.');
}
const desktopMessages = {
  app_bundle_missing: 'ZCode Desktop bundle is missing.',
  app_bundle_invalid: 'ZCode Desktop bundle has missing or invalid required metadata or files.',
  app_version_below_minimum: 'ZCode Desktop version is below the required minimum.',
  embedded_runtime_invalid: 'ZCode Desktop embedded runtime is unavailable or incompatible.',
  invalid_arguments: 'Use --check-desktop --json with an optional --app-bundle path.',
};
const subprocessLimits = { timeout: 10000, maxBuffer: 65536, killSignal: 'SIGKILL' };

export class DesktopInspectionError extends Error {
  constructor(reason, { bundle, app = null, minimum = null }, message = desktopMessages[reason]) {
    super(message);
    this.reason = reason;
    this.bundle = bundle;
    this.app = app;
    this.minimum = minimum;
  }

  toCheckResult() {
    return { compatible: false, reason: this.reason, message: desktopMessages[this.reason],
      appVersion: this.app, minZcodeAppVersion: this.minimum, appBundle: this.bundle };
  }
}

async function plistString(bundle, key, options) {
  const plist = join(bundle, 'Contents/Info.plist');
  await requireBundleFile(plist);
  options.signal?.throwIfAborted();
  const { stdout } = await execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-expect', 'string', '-o', '-', plist], options);
  return stdout.trim();
}

export async function desktopAppVersion(bundle, options = subprocessLimits) {
  try {
    const app = await plistString(bundle, 'CFBundleShortVersionString', options);
    return versionPattern.test(app) ? app : null;
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

async function requireBundleFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error('Invalid bundle file');
}

export async function inspectDesktopMetadata(appBundle, versions = readToolchains(), {
  validateBundle = true, includeBundledCatalog = false, signal,
} = {}) {
  signal?.throwIfAborted();
  const bundle = resolve(appBundle);
  const minimum = versions.ZCODE_APP_MIN_VERSION;
  const executable = join(bundle, 'Contents/MacOS/ZCode');
  const options = { ...subprocessLimits, signal };
  const metadata = { bundle, minimum, app: null };
  let build, catalogSnapshot;
  try {
    if (!(await stat(bundle)).isDirectory()) throw new Error();
  } catch (error) {
    throw new DesktopInspectionError(error.code === 'ENOENT' ? 'app_bundle_missing' : 'app_bundle_invalid', metadata);
  }
  metadata.app = await desktopAppVersion(bundle, options);
  const { app } = metadata;
  if (!app) throw new DesktopInspectionError('app_bundle_invalid', metadata, 'Invalid ZCode Desktop version');
  try {
    build = await plistString(bundle, 'CFBundleVersion', options);
    if (!build) throw new Error('Missing ZCode Desktop build');
    if (validateBundle) {
      const launcher = join(bundle, 'Contents/Resources/glm/zcode.cjs');
      const catalog = join(bundle, 'Contents/Resources/config/provider/zcode-builtin.json');
      await Promise.all([requireBundleFile(executable), access(executable, constants.X_OK), requireBundleFile(launcher), access(launcher, constants.R_OK)]);
      catalogSnapshot = await readBundledCatalogSnapshot(catalog);
      codingPlanRule(catalogSnapshot.catalog);
    }
  } catch (cause) {
    signal?.throwIfAborted();
    const error = new DesktopInspectionError('app_bundle_invalid', metadata);
    error.cause = cause;
    throw error;
  }
  const installed = app.split('.').map(BigInt), required = minimum.split('.').map(BigInt);
  const difference = installed.findIndex((part, index) => part !== required[index]);
  if (difference >= 0 && installed[difference] < required[difference]) {
    throw new DesktopInspectionError('app_version_below_minimum', metadata,
      `ZCode Desktop requires ${minimum} or newer; found ${app} at ${executable}`);
  }
  signal?.throwIfAborted();
  return { ...metadata, build, executable, ...(includeBundledCatalog ? { catalogSnapshot } : {}) };
}

export async function inspectDesktop(appBundle, versions = readToolchains(), {
  env = process.env, signal, validateBundle = true, includeBundledCatalog = false,
} = {}) {
  const metadata = await inspectDesktopMetadata(appBundle, versions, { signal, validateBundle, includeBundledCatalog });
  const { executable } = metadata;
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  try {
    signal?.throwIfAborted();
    const { stdout } = await execFile(executable,
      ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath})'],
      { ...subprocessLimits, env: childEnv, signal });
    const { node, electron, execPath } = JSON.parse(stdout);
    if (typeof node !== 'string' || !node || typeof electron !== 'string' || !electron || typeof execPath !== 'string') throw new Error();
    if (validateBundle && (!versionPattern.test(node) || BigInt(node.split('.')[0]) < 20n || !electron.trim())) throw new Error();
    const realPath = realpathSync(executable);
    if (realpathSync(execPath) !== realPath) throw new Error();
    return { ...metadata, node, electron, execPath, realPath };
  } catch {
    signal?.throwIfAborted();
    throw new DesktopInspectionError('embedded_runtime_invalid', metadata);
  }
}
