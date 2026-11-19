import { access, copyFile, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectDesktop } from './toolchain.mjs';
import { createKeychainSource } from './desktop-keychain.mjs';

async function scratchRoot() {
  // A directory left under /Volumes is not evidence that the volume is mounted.
  try {
    const [volume, parent] = await Promise.all([stat('/Volumes/RootKernel'), stat('/Volumes')]);
    if (volume.dev !== parent.dev) {
      await access('/Volumes/RootKernel', constants.W_OK);
      const root = '/Volumes/RootKernel/tmp';
      await mkdir(root, { recursive: true });
      return root;
    }
  } catch { /* Use the platform temporary directory when the volume is absent. */ }
  return tmpdir();
}

/** Bind both provider paths so ZCode does not silently replace the catalog path.
 * The path is part of its revision identity. Only the public catalog is copied;
 * account credentials stay in Desktop storage and are answered over stdio.
 */
export async function prepareDesktopRuntime({
  env = process.env, home = env.ZCODE_DATA_BASE_DIR || homedir(),
  appBundle = env.HERDR_ZCODE_APP_BUNDLE || '/Applications/ZCode.app',
  tmpRoot,
} = {}) {
  home = resolve(home);
  appBundle = await realpath(resolve(appBundle));
  const { executable } = await inspectDesktop(appBundle);
  const launcher = join(appBundle, 'Contents/Resources/glm/zcode.cjs');
  const bundled = resolve(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || join(appBundle, 'Contents/Resources/config/provider/zcode-builtin.json'));
  await Promise.all([access(executable, constants.X_OK), access(launcher), access(bundled)]);
  const withOSCredentialReader = createKeychainSource(appBundle, executable);
  const directory = await mkdtemp(join(tmpRoot || await scratchRoot(), 'herdr-zcode-'));
  try {
    const configPath = join(directory, 'zcode-builtin.json');
    await copyFile(bundled, configPath);
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: configPath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(home, '.zcode/v2/provider_config.json'),
    };
    // App-server owns the session; inherited hook/caller identities do not.
    for (const key of ['HERDR_ZCODE_SOCKET', 'HERDR_ZCODE_TOKEN', 'ZCODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE']) delete childEnv[key];
    return { executable, args: [launcher, 'app-server', '--stdio'], env: childEnv, home, configPath, withOSCredentialReader,
      async close() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
