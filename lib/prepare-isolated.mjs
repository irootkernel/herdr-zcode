import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readProjectedDesktopLogin } from './desktop-account.mjs';
import { CODING_PLAN_ACCESS, codingPlanRule, compatibleCodingPlanRule, readExplicitCatalog } from './desktop-catalog.mjs';
import { createKeychainSource } from './desktop-keychain.mjs';
import { desktopCatalogCachePath } from './desktop-runtime.mjs';
import { assertNode, inspectDesktop, inspectDesktopMetadata, readToolchains } from './toolchain.mjs';

const messages = {
  invalid_arguments: 'Use prepare-isolated --out-dir <path> with optional --app-bundle and --json.',
  app_bundle_missing: 'ZCode Desktop bundle is missing.',
  app_bundle_invalid: 'ZCode Desktop bundle has missing or invalid required metadata or files.',
  app_version_below_minimum: 'ZCode Desktop version is below the required minimum.',
  embedded_runtime_invalid: 'ZCode Desktop embedded runtime is unavailable or incompatible.',
  output_dir_invalid: 'Use an existing private output directory owned by the invoking user.',
  output_exists: 'One or more prepared input files already exist.',
  desktop_account_unavailable: 'The Z.AI Coding Plan account could not be read.',
  desktop_keychain_unavailable: 'The ZCode Desktop Keychain credential could not be read.',
  catalog_invalid: 'The bundled provider catalog is invalid or incompatible.',
  preparation_timeout: 'Input preparation reached its time limit.',
  preparation_interrupted: 'Input preparation was interrupted.',
  projection_failed: 'Could not write or clean up the prepared inputs.',
};
const prepareDurationMs = 12000;
const cleanupReserveMs = 2000;
const maxAuthBytes = 65536;
const statOptions = { bigint: true };
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(messages[code]), { code });
// Darwin's Node hrtime and the Perl launcher's CLOCK_MONOTONIC_RAW use the same clock.
export const preparationNow = () => Number(process.hrtime.bigint() / 1000000n);

function parsePreparationArgs(argv) {
  let outDir, appBundle, json = false;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--json' && !json) { json = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || value.includes('\0')) throw failure('invalid_arguments');
    if (flag === '--out-dir' && outDir === undefined) outDir = resolve(value);
    else if (flag === '--app-bundle' && appBundle === undefined) appBundle = resolve(value);
    else throw failure('invalid_arguments');
    index++;
  }
  if (outDir === undefined) throw failure('invalid_arguments');
  return { outDir, appBundle: appBundle ?? '/Applications/ZCode.app' };
}

function sameIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function validDirectory(info, uid) {
  return info.isDirectory() && info.uid === uid && (info.mode & 0o7777n) === 0o700n;
}

async function outputDirectory(inputPath) {
  const uid = BigInt(process.getuid());
  let handle;
  try {
    const initial = await lstat(inputPath, statOptions);
    if (!validDirectory(initial, uid)) throw failure('output_dir_invalid');
    handle = await open(inputPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const path = await realpath(inputPath);
    const check = async () => {
      const paths = inputPath === path ? [path] : [path, inputPath];
      const entries = await Promise.all([handle.stat(statOptions), ...paths.map(name => lstat(name, statOptions))]);
      if (entries.some(info => !validDirectory(info, uid) || !sameIdentity(info, initial))) throw failure('output_dir_invalid');
    };
    await check();
    return { path, inputPath, handle, check, uid, identity: initial, entries: [] };
  } catch {
    await handle?.close();
    throw failure('output_dir_invalid');
  }
}

function validOutput(info, uid, size, mode) {
  return info.isFile() && info.uid === uid && info.nlink === 1n && (mode === undefined || (info.mode & 0o7777n) === BigInt(mode)) &&
    (size === undefined || info.size === BigInt(size));
}

async function checkOutput(directory, record, { size, mode = record.mode } = {}) {
  await directory.check();
  const entries = await Promise.all([record.handle.stat(statOptions), lstat(record.path, statOptions)]);
  if (entries.some(info => !sameIdentity(info, record.identity) || !validOutput(info, directory.uid, size, mode))) {
    throw failure('projection_failed');
  }
  await directory.check();
}

async function reserve(directory, name, mode, signal) {
  await directory.check();
  signal.throwIfAborted();
  const path = join(directory.path, name);
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); }
  catch (error) { throw failure(error.code === 'EEXIST' ? 'output_exists' : 'projection_failed'); }
  const record = { name, path, handle, mode, identity: undefined };
  directory.entries.push(record);
  await directory.check();
  record.identity = await handle.stat(statOptions);
  if (!validOutput(record.identity, directory.uid, 0)) throw failure('projection_failed');
  if ((record.identity.mode & 0o7777n) !== BigInt(mode)) await handle.chmod(mode);
  await checkOutput(directory, record, { size: 0 });
  return record;
}

async function writeAll(handle, bytes, signal) {
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw failure('projection_failed');
    offset += bytesWritten;
  }
  signal?.throwIfAborted();
  await handle.sync();
}

async function cleanOutputs(directory) {
  let problem = false;
  for (const record of [...directory.entries].reverse()) {
    if (record.name === 'auth.json') {
      let reopened;
      try {
        let handle = record.handle;
        if (handle.fd === -1) {
          // A cancellation while closing can leave the original descriptor
          // closed. Reopen only a confirmed owned inode within the held directory.
          await directory.check();
          const named = await lstat(record.path, statOptions);
          if (!sameIdentity(named, record.identity) || !validOutput(named, directory.uid)) throw failure('projection_failed');
          reopened = await open(record.path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          handle = reopened;
          const opened = await handle.stat(statOptions);
          if (!sameIdentity(opened, record.identity) || !validOutput(opened, directory.uid)) throw failure('projection_failed');
          await directory.check();
        }
        const { size } = await handle.stat(statOptions);
        if (size) await writeAll(handle, Buffer.alloc(size > BigInt(maxAuthBytes) ? maxAuthBytes : Number(size)));
      } catch { problem = true; }
      finally {
        try { await reopened?.close(); } catch { problem = true; }
      }
    }
    try {
      // Compare ownership without requiring the final output mode so a failed
      // reservation can remove its own empty inode after a restrictive umask.
      record.identity ??= await record.handle.stat(statOptions);
      await directory.check();
      const named = await lstat(record.path, statOptions).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!named) continue;
      if (!sameIdentity(named, record.identity) || !validOutput(named, directory.uid)) throw failure('projection_failed');
      await directory.check();
      await unlink(record.path);
      await directory.check();
      if (record.handle.fd !== -1 && (await record.handle.stat(statOptions)).nlink !== 0n) throw failure('projection_failed');
    } catch { problem = true; }
  }
  if (problem) throw failure('projection_failed');
}

async function selectCatalog(home, appVersion, bundled, providerId) {
  try {
    const active = await readExplicitCatalog(desktopCatalogCachePath(home, appVersion));
    compatibleCodingPlanRule(active.catalog, bundled.catalog, providerId);
    if (active.catalog.revision > bundled.catalog.revision) return { ...active, source: 'desktop-cache' };
  } catch { /* A rejected cache leaves the validated bundle in use. */ }
  return { ...bundled, source: 'bundled' };
}

export async function projectIsolated({ outDir, appBundle, home, signal, versions }, {
  inspect = inspectDesktop, readLogin = readProjectedDesktopLogin, keychainSource = createKeychainSource,
} = {}) {
  signal.throwIfAborted();
  let directory = await outputDirectory(outDir);
  let authBytes;
  try {
    signal.throwIfAborted();
    const desktop = await inspect(appBundle, versions, { env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: '/tmp' },
      signal, includeBundledCatalog: true });
    signal.throwIfAborted();
    if (!home || !isAbsolute(home)) throw failure('desktop_account_unavailable');
    const bundled = desktop.catalogSnapshot;
    const { providerId } = codingPlanRule(bundled.catalog);
    const selected = await selectCatalog(home, desktop.app, bundled, providerId);
    const catalog = await reserve(directory, 'catalog.json', 0o400, signal);
    const auth = await reserve(directory, 'auth.json', 0o600, signal);

    const trustedBundle = await realpath(desktop.bundle);
    const executable = join(trustedBundle, 'Contents/MacOS/ZCode');
    await directory.check();
    signal.throwIfAborted();
    const login = await readLogin(providerId, { home, signal, withOSCredentialReader: keychainSource(trustedBundle, executable, { signal }) });
    signal.throwIfAborted();
    if (login.providerId !== providerId || typeof login.identity !== 'string' || !login.identity.trim() ||
        typeof login.apiKey !== 'string' || !login.apiKey.trim()) throw failure('desktop_account_unavailable');
    authBytes = Buffer.from(JSON.stringify({ providerId, identity: login.identity, apiKey: login.apiKey, accountAccess: CODING_PLAN_ACCESS }));
    if (authBytes.length > maxAuthBytes) throw failure('projection_failed');

    await checkOutput(directory, catalog, { size: 0 });
    await writeAll(catalog.handle, selected.bytes, signal);
    await checkOutput(directory, auth, { size: 0 });
    await writeAll(auth.handle, authBytes, signal);
    await checkOutput(directory, catalog, { size: selected.bytes.length });
    await checkOutput(directory, auth, { size: authBytes.length });
    signal.throwIfAborted();
    const result = { authFile: auth.path, catalogFile: catalog.path, catalogRevision: selected.catalog.revision,
      catalogSHA256: sha256(selected.bytes), catalogSource: selected.source, appVersion: desktop.app,
      minZcodeAppVersion: desktop.minimum, providerId, accountIdentitySHA256: sha256(login.identity) };
    await catalog.handle.close();
    await auth.handle.close();
    await directory.handle.close();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (directory.handle.fd === -1) {
      const restored = await outputDirectory(directory.inputPath).catch(() => { throw failure('projection_failed'); });
      if (!sameIdentity(restored.identity, directory.identity)) {
        await restored.handle.close();
        throw failure('projection_failed');
      }
      directory = { ...restored, entries: directory.entries };
    }
    await cleanOutputs(directory);
    signal.throwIfAborted();
    throw error;
  } finally {
    authBytes?.fill(0);
    const handles = directory.entries.map(entry => entry.handle).concat(directory.handle);
    const openHandles = handles.filter(handle => handle.fd !== -1);
    if (openHandles.length) {
      const closed = await Promise.allSettled(openHandles.map(handle => handle.close()));
      if (closed.some(entry => entry.status === 'rejected')) throw failure('projection_failed');
    }
  }
}

export async function runPreparation({ argv, env, output, startedAt = preparationNow(), project = projectIsolated }) {
  const controller = new AbortController();
  const interrupted = () => controller.abort(failure('preparation_interrupted'));
  for (const signal of signals) process.on(signal, interrupted);
  const workRemaining = startedAt + prepareDurationMs - cleanupReserveMs - preparationNow();
  const timeout = () => controller.abort(failure('preparation_timeout'));
  const timer = setTimeout(timeout, Math.max(0, workRemaining));
  if (workRemaining <= 0) timeout();
  const signal = controller.signal;
  try {
    const options = parsePreparationArgs(argv);
    signal.throwIfAborted();
    let versions;
    try { versions = readToolchains(); } catch { throw failure('embedded_runtime_invalid'); }
    try { assertNode({ allowEmbeddedElectron: true }); }
    catch {
      await inspectDesktopMetadata(options.appBundle, versions, { signal });
      throw failure('embedded_runtime_invalid');
    }
    const result = await project({ ...options, home: env.HOME ?? '', versions, signal });
    output.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    const code = error.cause?.code === 'catalog_invalid' ? 'catalog_invalid' : error.code ?? error.reason;
    const reason = Object.hasOwn(messages, code) ? code : 'projection_failed';
    output.write(JSON.stringify({ reason, message: messages[reason] }) + '\n');
    return 1;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.removeListener(signal, interrupted);
  }
}
