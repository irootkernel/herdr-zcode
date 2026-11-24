import { access, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectDesktop } from './toolchain.mjs';
import { createKeychainSource } from './desktop-keychain.mjs';
import { readBundledCatalog, readExplicitCatalog } from './desktop-catalog.mjs';

export function appServerEnvironment(env) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HERDR_') || key.startsWith('HC_')) delete childEnv[key];
  }
  return childEnv;
}

function catalogRevision(bytes) {
  const catalog = JSON.parse(bytes);
  const modelRules = catalog?.config?.modelConfigRules;
  if (catalog?.schemaVersion === 1 && Number.isSafeInteger(catalog.revision) && catalog.revision > 0 &&
      Array.isArray(catalog.config?.providerConfigRules?.providerRules) &&
      modelRules && typeof modelRules === 'object' && !Array.isArray(modelRules)) {
    return catalog.revision;
  }
}

export function desktopCatalogCachePath(home, appVersion, endpoint = 'https://zcode.z.ai') {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  const endpointKey = createHash('sha256').update(url.origin).digest('hex').slice(0, 32);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch] ?? process.arch;
  return join(home, '.zcode/v2/runtime/provider', `${platform}-${arch}`, appVersion,
    `endpoint-${endpointKey}`, 'zcode-builtin.json');
}

// Match ZCode's version- and endpoint-scoped active catalog before binding it.
async function cachedDesktopCatalog(bundled, home, env, appVersion) {
  if (!appVersion) return;
  const scopedOrigin = env.ZCODE_ENV?.trim().toLowerCase() === 'test'
    ? env.ZCODE_TEST_BASE_URL : env.ZCODE_PRODUCTION_BASE_URL;
  const endpoint = env.ZCODE_BASE_URL?.trim() || env.ZCODE_ENDPOINT_ORIGIN?.trim() || scopedOrigin?.trim() || undefined;
  try {
    const path = desktopCatalogCachePath(home, appVersion, endpoint);
    if (!path) return;
    const bytes = await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK });
    const revision = catalogRevision(bytes);
    const bundledRevision = catalogRevision(await readFile(bundled));
    if (revision > bundledRevision) return { path, bytes };
  } catch {
    // A missing or invalid cache leaves the bundled catalog in use.
  }
}

/** Bind both provider paths so ZCode does not silently replace the catalog path.
 * The path is part of its revision identity. Only the public catalog is copied;
 * account credentials stay in Desktop storage and are answered over stdio.
 */
export async function prepareDesktopRuntime({
  env = process.env, home = env.ZCODE_DATA_BASE_DIR || homedir(),
  appBundle = env.HERDR_ZCODE_APP_BUNDLE || '/Applications/ZCode.app',
  tmpRoot, copyCatalog = true, skipInspect = false, useKeychain = true, catalogFile,
} = {}) {
  if (catalogFile !== undefined && useKeychain) throw new Error('An explicit catalog requires projected auth');
  appBundle = await realpath(resolve(appBundle));
  const desktop = skipInspect ? undefined : await inspectDesktop(appBundle, undefined, { validateBundle: false });
  const executable = desktop?.executable ?? join(appBundle, 'Contents/MacOS/ZCode');
  const launcher = join(appBundle, 'Contents/Resources/glm/zcode.cjs');
  const bundled = join(appBundle, 'Contents/Resources/config/provider/zcode-builtin.json');
  const override = useKeychain && env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const cached = useKeychain && !override ? await cachedDesktopCatalog(bundled, home, env, desktop?.app) : undefined;
  const catalogPath = catalogFile !== undefined ? resolve(catalogFile) : (override ? resolve(override) : cached?.path ?? bundled);
  await Promise.all([access(executable, constants.X_OK), access(launcher)]);
  const [explicitCatalog, bundledCatalog] = catalogFile !== undefined
    ? await Promise.all([readExplicitCatalog(catalogPath), readBundledCatalog(bundled)]) : [];
  if (!explicitCatalog && (!cached || !copyCatalog)) await access(catalogPath);
  const withOSCredentialReader = useKeychain ? createKeychainSource(appBundle, executable) : undefined;
  const directory = copyCatalog || !useKeychain ? await mkdtemp(join(resolve(tmpRoot || env.TMPDIR || tmpdir()), 'herdr-zcode-')) : undefined;
  const close = async () => { if (directory) await rm(directory, { recursive: true, force: true }); };
  try {
    home = useKeychain ? resolve(home) : directory;
    const configPath = copyCatalog ? join(directory, 'zcode-builtin.json') : catalogPath;
    if (copyCatalog) {
      if (explicitCatalog) await writeFile(configPath, explicitCatalog.bytes, { mode: 0o600 });
      else if (cached) await writeFile(configPath, cached.bytes);
      else await copyFile(catalogPath, configPath);
    }
    const childEnv = appServerEnvironment(env);
    childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = configPath;
    const personalCatalog = join(home, '.zcode/v2/provider_config.json');
    childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = (useKeychain && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) || personalCatalog;
    if (!useKeychain) {
      childEnv.HOME = home;
      childEnv.ZCODE_DATA_BASE_DIR = home;
      childEnv.XDG_DATA_HOME = home;
      for (const key of ['ZCODE_HOME', 'ZCODE_STORAGE_DIR', 'ZCODE_CREDENTIAL_SECRET', 'ZCODE_CREDENTIAL_SECRET_FILE']) delete childEnv[key];
    }
    // App-server owns the session; inherited hook/caller identities do not.
    for (const key of ['ZCODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE']) delete childEnv[key];
    return { executable, args: [launcher, 'app-server', '--stdio'], env: childEnv, home, configPath, withOSCredentialReader, close,
      catalog: explicitCatalog?.catalog, bundledCatalog, recheckCatalog: copyCatalog ? undefined : explicitCatalog?.recheck };
  } catch (error) {
    await close();
    throw error;
  }
}
