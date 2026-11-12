import { readFile, mkdir, mkdtemp, writeFile, cp, rm, rename } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { assertNode, readToolchains, inspectDesktop, root } from '../lib/toolchain.mjs';

assertNode();
const versions = readToolchains();
const project = fileURLToPath(root);
const cache = join(process.env.HERDR_ZCODE_TOOLCHAIN_CACHE || join(process.env.XDG_CACHE_HOME || join(process.env.HOME, '.cache'), 'herdr-zcode/toolchains'),
  'node-' + versions.NODE_VERSION, 'npm-' + versions.NPM_VERSION);
const npm = join(cache, 'package/bin/npm-cli.js');
const env = { ...process.env,
  PATH: [join(project, 'scripts/tool-bin'), dirname(process.execPath), process.env.PATH].join(':') };
function execute(binary, args, cwd = project) {
  const result = spawnSync(binary, args, { env, cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
function checkNpm() {
  if (!existsSync(npm)) throw new Error('Pinned npm is missing. Run ./dev setup (or the setup command from the source checkout).');
  const actual = execFileSync(process.execPath, [npm, '--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
  if (actual !== versions.NPM_VERSION) throw new Error('Expected npm ' + versions.NPM_VERSION + '; actual ' + actual + ' at ' + npm);
  return actual;
}
async function setup() {
  if (existsSync(cache)) { checkNpm(); return; }
  const temporary = await mkdtemp('/tmp/herdr-zcode-toolchain-');
  let pending;
  try {
    const response = await fetch('https://registry.npmjs.org/npm/' + versions.NPM_VERSION, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('npm metadata download failed: ' + response.status);
    const metadata = await response.json();
    if (metadata.name !== 'npm' || metadata.version !== versions.NPM_VERSION ||
        new URL(metadata.dist.tarball).origin !== 'https://registry.npmjs.org') throw new Error('Unexpected npm distribution metadata');
    const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(metadata.dist.integrity);
    if (!integrity) throw new Error('npm distribution has no SHA-512 integrity');
    const archive = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30000) });
    if (!archive.ok) throw new Error('npm archive download failed: ' + archive.status);
    const bytes = Buffer.from(await archive.arrayBuffer());
    if (createHash('sha512').update(bytes).digest('base64') !== integrity[1]) throw new Error('npm archive integrity mismatch');
    const tarball = join(temporary, 'npm.tgz');
    await writeFile(tarball, bytes);
    execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', temporary]);
    await mkdir(dirname(cache), { recursive: true });
    pending = await mkdtemp(cache + '.pending-');
    await cp(join(temporary, 'package'), join(pending, 'package'), { recursive: true });
    await writeFile(join(pending, 'receipt.json'), JSON.stringify({ version: metadata.version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball }, null, 2) + '\n');
    await rename(pending, cache); pending = undefined;
    checkNpm();
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (pending) await rm(pending, { recursive: true, force: true });
  }
}
try {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'setup':
      if (args.length) throw new Error('Usage: ./dev setup');
      await setup(); console.log('Pinned npm ready: ' + npm); break;
    case 'doctor': {
      if (args.length && (args.length !== 1 || args[0] !== '--desktop')) throw new Error('Usage: ./dev doctor [--desktop]');
      console.log(JSON.stringify({ declared: versions, node: { actual: process.versions.node, executable: process.execPath, realPath: realpathSync(process.execPath) },
        npm: { actual: checkNpm(), executable: npm, realPath: realpathSync(npm) },
        ...(args.length ? { desktop: await inspectDesktop(process.env.HERDR_ZCODE_APP_BUNDLE || '/Applications/ZCode.app') } : {}) }, null, 2)); break;
    }
    case 'npm': checkNpm(); execute(process.execPath, [npm, ...args]); break;
    case 'npx': checkNpm(); execute(process.execPath, [join(cache, 'package/bin/npx-cli.js'), ...args]); break;
    case 'test':
      if (args.length) throw new Error('Usage: ./dev test');
      checkNpm(); execute(process.execPath, [npm, 'test']); break;
    case 'pack':
      if (args.length) throw new Error('Usage: ./dev pack');
      checkNpm(); await mkdir(join(project, 'dist'), { recursive: true });
      execute(process.execPath, [npm, 'pack', '--ignore-scripts=false', '--pack-destination', join(project, 'dist')]); break;
    case 'install': {
      if (args.length && (args.length !== 2 || args[0] !== '--prefix' || !args[1])) throw new Error('Usage: ./dev install [--prefix path]');
      checkNpm(); execute(process.execPath, [npm, 'install', '--global', '--prefix', args[1] || join(process.env.HOME, '.local'), '--install-links', project]); break;
    }
    default: throw new Error('Unknown command: ' + command + '. Run ./dev help.');
  }
} catch (error) { console.error('herdr-zcode: ' + error.message); process.exitCode = 1; }
