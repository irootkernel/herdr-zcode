import { access, copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectDesktop } from './toolchain.mjs';
import { createKeychainSource } from './desktop-keychain.mjs';

export function appServerEnvironment(env) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HERDR_') || key.startsWith('HC_')) delete childEnv[key];
  }
  return childEnv;
}

/** Bind both provider paths so ZCode does not silently replace the catalog path.
 * The path is part of its revision identity. Only the public catalog is copied;
 * account credentials stay in Desktop storage and are answered over stdio.
 */
export async function prepareDesktopRuntime({
  env = process.env, home = env.ZCODE_DATA_BASE_DIR || homedir(),
  appBundle = env.HERDR_ZCODE_APP_BUNDLE || '/Applications/ZCode.app',
  tmpRoot, copyCatalog = true, skipInspect = false,
} = {}) {
  home = resolve(home);
  appBundle = await realpath(resolve(appBundle));
  const executable = skipInspect ? join(appBundle, 'Contents/MacOS/ZCode') : (await inspectDesktop(appBundle)).executable;
  const launcher = join(appBundle, 'Contents/Resources/glm/zcode.cjs');
  const bundled = resolve(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || join(appBundle, 'Contents/Resources/config/provider/zcode-builtin.json'));
  await Promise.all([access(executable, constants.X_OK), access(launcher), access(bundled)]);
  const withOSCredentialReader = createKeychainSource(appBundle, executable);
  const directory = copyCatalog ? await mkdtemp(join(resolve(tmpRoot || env.TMPDIR || tmpdir()), 'herdr-zcode-')) : undefined;
  const close = async () => { if (directory) await rm(directory, { recursive: true, force: true }); };
  try {
    const configPath = directory ? join(directory, 'zcode-builtin.json') : bundled;
    if (directory) await copyFile(bundled, configPath);
    const childEnv = appServerEnvironment(env);
    childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = configPath;
    childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(home, '.zcode/v2/provider_config.json');
    // App-server owns the session; inherited hook/caller identities do not.
    for (const key of ['ZCODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE']) delete childEnv[key];
    return { executable, args: [launcher, 'app-server', '--stdio'], env: childEnv, home, configPath, withOSCredentialReader, close };
  } catch (error) {
    await close();
    throw error;
  }
}
