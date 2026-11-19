import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const maxBytes = 4 * 1024 * 1024;
const helperCwd = '/private/var/empty';
const addonPath = 'Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const OS_CREDENTIAL_PREFIX = 'enc:v2:os:';

// Run the same cipher code in the signed runtime and the offline fixtures.
export const keychainCipherScript = String.raw`
const { readFileSync } = require('node:fs');
const { createHash, createDecipheriv } = require('node:crypto');
async function readCredential(readKey) {
  const value = readFileSync(0, 'utf8');
  const match = /^enc:v2:os:([a-f0-9]{24}):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || match[0] !== value) throw new Error();
  const [iv, tag, ciphertext] = match.slice(2).map(part => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error();
  const encoded = await readKey();
  if (typeof encoded !== 'string' || encoded.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
  const key = Buffer.from(encoded, 'base64url');
  let plaintext;
  try {
    if (key.length !== 32 || createHash('sha256').update(key).digest('hex').slice(0, 24) !== match[1]) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = decipher.update(ciphertext);
    const tail = decipher.final();
    const result = Buffer.concat([plaintext, tail]);
    tail.fill(0);
    process.stdout.write(result, () => result.fill(0));
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}
`;
const keychainScript = keychainCipherScript + `
readCredential(() => {
  const native = { exports: {} };
  process.dlopen(native, '/dev/fd/3');
  return new native.exports.AsyncEntry('ZCode Credential Encryption', process.argv[1]).getPassword();
}).catch(() => { process.exitCode = 1; });
`;

async function readBundleFile(path) {
  if (await realpath(path) !== path) throw new Error('ZCode bundle file path changed');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o022) || (info.uid !== 0 && info.uid !== process.getuid())) {
      throw new Error('Invalid ZCode bundle file');
    }
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await file.read({ buffer: bytes, position: 0 });
    const after = await file.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('ZCode bundle file changed');
    return bytes;
  } finally { await file.close(); }
}

async function verifySignature(path, identifier, signal, deep = false) {
  const requirement = `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "8A5X4JJ39T"`;
  const args = ['--verify', '--strict', ...(deep ? ['--deep'] : []), `-R=${requirement}`, path];
  try { await execFile('/usr/bin/codesign', args, { cwd: helperCwd, env: {}, signal, killSignal: 'SIGKILL', maxBuffer: 65536 }); }
  catch { throw new Error('ZCode Keychain signature verification failed'); }
}

async function verifyModule(path, file, expected) {
  const [named, opened] = await Promise.all([lstat(path, { bigint: true }), file.stat({ bigint: true })]);
  for (const info of [named, opened]) {
    if (!info.isFile() || info.mode !== 0o100400n || info.nlink !== 1n || info.dev !== expected.dev ||
        info.ino !== expected.ino || info.size !== expected.size || info.ctimeNs !== expected.ctimeNs) {
      throw new Error('ZCode Keychain module identity changed');
    }
  }
}

function readWithKeychain(executable, fd, account, ciphertext, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-e', keychainScript, account], {
      cwd: helperCwd, env: { ELECTRON_RUN_AS_NODE: '1' }, signal, killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'ignore', fd],
    });
    const chunks = [];
    let size = 0, failed = false;
    const fail = () => { failed = true; };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        fail();
        chunk.fill(0);
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.once('close', code => {
      const result = !failed && !signal.aborted && code === 0 && size > 0 ? Buffer.concat(chunks, size) : undefined;
      for (const chunk of chunks) chunk.fill(0);
      if (!result) return reject(new Error('ZCode Keychain credential could not be read or authenticated'));
      const text = result.toString('utf8');
      result.fill(0);
      resolve(text);
    });
    child.stdin.end(ciphertext);
  });
}

export function createKeychainSource(bundle, executable) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  const plist = join(bundle, 'Contents/Info.plist');
  const bindings = [executable, plist];
  const identities = () => Promise.all(bindings.map(async path => digest(await readBundleFile(path))));
  let pinned;

  return async (credentialPath, useReader) => {
    const signal = AbortSignal.timeout(10000);
    const account = digest(credentialPath);
    const observed = await identities();
    await verifySignature(bundle, 'dev.zcode.app', signal, true);
    const expectedRuntime = pinned ??= observed;
    const addon = await readBundleFile(join(bundle, addonPath));
    const directory = await mkdtemp(join(await realpath('/tmp'), 'herdr-zcode-keychain-'));
    const modulePath = join(directory, 'keyring.node');
    let module;
    try {
      await writeFile(modulePath, addon, { flag: 'wx', mode: 0o400 });
      module = await open(modulePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const expected = await module.stat({ bigint: true });
      await verifySignature(modulePath, 'keyring.darwin-arm64', signal);
      return await useReader(async ciphertext => {
        if (Buffer.byteLength(ciphertext) > maxBytes) throw new Error('ZCode Keychain ciphertext exceeds credential limit');
        const current = await identities();
        if (current.some((hash, index) => hash !== expectedRuntime[index])) throw new Error('ZCode Keychain runtime identity changed');
        await verifyModule(modulePath, module, expected);
        return readWithKeychain(executable, module.fd, account, ciphertext, signal);
      });
    } finally {
      try { await module?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
}
