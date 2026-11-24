import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { OS_CREDENTIAL_PREFIX } from './desktop-keychain.mjs';
import { CODING_PLAN_ACCESS, codingPlanRule, compatibleCodingPlanRule, matchesAccountAccess } from './desktop-catalog.mjs';

export const DEFAULT_MODEL = 'account:zai-individual-coding-plan/GLM-5.3';
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_AUTH_BYTES = 65536n;

// Share the live credential set with each output stream, including refreshed keys.
export function createStreamRedactor(secrets) {
  let pending = '';
  function render(text, final = false) {
    text = pending + String(text);
    pending = '';
    let output = '', cursor = 0;
    while (cursor < text.length) {
      let next = -1, match;
      for (const secret of secrets) {
        if (!secret) continue;
        const index = text.indexOf(secret, cursor);
        if (index !== -1 && (next === -1 || index < next || (index === next && secret.length > match.length))) {
          next = index; match = secret;
        }
      }
      if (next !== -1) {
        output += text.slice(cursor, next) + '[REDACTED]';
        cursor = next + match.length;
        continue;
      }
      const tail = text.slice(cursor);
      let keep = 0;
      if (!final) for (const secret of secrets) {
        for (let size = Math.min(tail.length, secret.length - 1); size > keep; size--) {
          if (tail.endsWith(secret.slice(0, size))) { keep = size; break; }
        }
      }
      pending = keep ? tail.slice(-keep) : '';
      output += tail.slice(0, tail.length - keep);
      break;
    }
    return output;
  }
  return { write: text => render(text), flush: ({ keepPrefix = false } = {}) => render('', !keepPrefix) };
}

function decrypt(value, { env, home, username }) {
  if (typeof value !== 'string' || !value) throw new Error('Desktop credential is missing');
  if (!value.startsWith('enc:v1:')) {
    if (value.startsWith('enc:')) throw new Error('Unsupported Desktop credential format');
    return value;
  }
  try {
    const parts = value.slice(7).split('.').map(part => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error();
    const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${process.platform}:${home}:${username}`;
    const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), parts[0]);
    cipher.setAuthTag(parts[1]);
    return Buffer.concat([cipher.update(parts[2]), cipher.final()]).toString('utf8');
  } catch { throw new Error('Desktop credential cannot be decrypted; sign in through ZCode Desktop'); }
}

async function readJSON(path, description, signal) {
  try {
    return JSON.parse(await readFile(path, signal ? { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NONBLOCK, signal } : 'utf8'));
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Cannot read ${description}`);
  }
}

function projectedProviderMismatch() {
  return Object.assign(new Error('Projected auth provider does not match the account catalog'), { blockedKind: 'auth' });
}

function accountRule(catalog, providerId) {
  const rules = catalog?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules) || !Number.isInteger(catalog?.revision) || catalog.revision < 1) {
    throw new Error('Unsupported ZCode account catalog');
  }
  const matches = rules.filter(rule => matchesAccountAccess(rule?.config?.access) &&
    (providerId === undefined || rule.providerId === providerId));
  if (providerId !== undefined && !matches.length) {
    throw projectedProviderMismatch();
  }
  if (matches.length !== 1) throw new Error('Unsupported ZCode account catalog');
  return matches[0];
}

function projectedCatalogRule(catalog, bundledCatalog, providerId) {
  const trustedRules = bundledCatalog?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(trustedRules) &&
      !trustedRules.some(rule => rule?.providerId === providerId && matchesAccountAccess(rule.config?.access))) {
    // Classify credentials as foreign only after verifying both catalogs against the trusted rule.
    const trustedProvider = codingPlanRule(bundledCatalog).providerId;
    compatibleCodingPlanRule(catalog, bundledCatalog, trustedProvider);
    throw projectedProviderMismatch();
  }
  return compatibleCodingPlanRule(catalog, bundledCatalog, providerId);
}

function selectModel(rule, model, accountLabel, revision) {
  if (model === null) return null;
  const { providerId } = rule;
  const qualified = typeof model === 'object' ? model : (() => {
    const text = String(model || DEFAULT_MODEL).trim();
    const slash = text.indexOf('/');
    return slash < 0 ? { providerId, modelId: text } : { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
  })();
  if (qualified.providerId !== providerId || !rule.config.builtinModelIds?.includes(qualified.modelId)) {
    const message = `Requested model is absent from the ${accountLabel} catalog (revision ${revision}). The session stopped with no fallback model.`;
    throw Object.assign(new Error(message), { safeSummary: message });
  }
  return { providerId, modelId: qualified.modelId };
}

function buildAccountOverlay({ configFile, catalog, providerId, identity, selection, secrets, resolveApiKey, accountLabel }) {
  // The installed CLI hashes the resolved active catalog path into its revision.
  const builtinRevision = `zcode-builtin:${catalog.revision}:${hash(resolve(configFile))}`;
  const config = {
    revision: `herdr-zcode-account:${hash(`${builtinRevision}\0${providerId}\0${identity}`)}`,
    basedOnZCodeBuiltinRevision: builtinRevision,
    providers: { [providerId]: { access: { type: CODING_PLAN_ACCESS.type, entitled: true } } },
    states: { [providerId]: { availability: 'available', entitled: true, current: true } },
  };
  return {
    selection, config,
    async runtimeHeaders(request) {
      if (request?.providerId !== providerId || !matchesAccountAccess(request.accountAccess)) {
        return { headersApplied: false, errorMessage: `${accountLabel} request identity mismatch` };
      }
      try {
        const { apiKey } = await resolveApiKey(identity);
        secrets.add(apiKey);
        return { headersApplied: true, requestAuth: { apiKey } };
      } catch { return { headersApplied: false, errorMessage: `${accountLabel} credential unavailable or changed; restart the executor` }; }
    },
    createStreamRedactor: () => createStreamRedactor(secrets),
    redact(text) {
      const stream = createStreamRedactor(secrets);
      return stream.write(text) + stream.flush();
    },
  };
}

async function requireCodingPlanLogin(home, signal) {
  const settings = await readJSON(join(home, '.zcode/v2/setting.json'), 'ZCode Desktop account settings', signal);
  if (settings.providerFamilyDomain !== 'zai' || settings.providerFamilyConnectionSelections?.zai?.kind !== 'individual-coding-plan') {
    throw new Error('Select the Z.AI Individual Coding Plan in ZCode Desktop');
  }
}

function credentialReader(providerId, { home, env, username, withOSCredentialReader, signal }) {
  const credentialPath = join(home, '.zcode/v2/credentials.json');
  function keychainFailure(error) {
    signal?.throwIfAborted();
    if (!signal) throw error;
    throw Object.assign(new Error('ZCode Keychain reader is unavailable'), { code: 'desktop_keychain_unavailable' });
  }
  async function useKeychain(operation) {
    if (!withOSCredentialReader) return keychainFailure(new Error('ZCode Keychain reader is unavailable'));
    let accountFailure;
    try {
      return await withOSCredentialReader(credentialPath, async read => {
        try {
          return await operation(async value => {
            try { return await read(value); }
            catch (error) { return keychainFailure(error); }
          });
        } catch (error) {
          accountFailure = error;
          throw error;
        }
      });
    } catch (error) {
      if (error === accountFailure) throw error;
      return keychainFailure(error);
    }
  }
  const context = { env, home, username };
  return async expectedIdentity => {
    signal?.throwIfAborted();
    const values = await readJSON(credentialPath, 'ZCode Desktop credentials', signal);
    const isOS = value => typeof value === 'string' && value.startsWith(OS_CREDENTIAL_PREFIX);
    const profileValue = values['oauth:zai:user_info'];
    async function readAccount(readOS) {
      let profile;
      try { profile = JSON.parse(isOS(profileValue) ? await readOS(profileValue) : decrypt(profileValue, context)); }
      catch (error) {
        signal?.throwIfAborted();
        if (signal && error.code === 'desktop_keychain_unavailable') throw error;
        throw new Error('ZCode Desktop account profile is unavailable');
      }
      const identity = String(profile.id || profile.user_id || '').trim();
      if (!identity || (expectedIdentity && identity !== expectedIdentity)) throw new Error('ZCode Desktop account changed; restart this executor');
      const name = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
      const value = values[name];
      const apiKey = (isOS(value) ? await readOS(value) : decrypt(value, context)).trim();
      if (!apiKey) throw new Error('ZCode Desktop coding-plan credential is unavailable');
      return { identity, apiKey };
    }
    // A mixed store may use Keychain only for the selected API key.
    const readOnlyKey = value => useKeychain(readOS => readOS(value));
    return isOS(profileValue) && withOSCredentialReader
      ? await useKeychain(readAccount)
      : await readAccount(readOnlyKey);
  };
}

export async function readProjectedDesktopLogin(providerId, { home, signal, withOSCredentialReader }) {
  const context = { home: resolve(home), env: {}, username: userInfo().username, signal, withOSCredentialReader };
  try {
    await requireCodingPlanLogin(context.home, signal);
    return { providerId, ...await credentialReader(providerId, context)() };
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'desktop_keychain_unavailable') throw error;
    throw Object.assign(new Error('ZCode Desktop account is unavailable'), { code: 'desktop_account_unavailable' });
  }
}

/** Minimal port of Mulgae's account overlay and on-demand auth response.
 * Never writes Desktop settings, credentials, or persistent model selections.
 */
export async function desktopAccount(configFile, {
  env = process.env, home = env.ZCODE_DATA_BASE_DIR || homedir(),
  model = DEFAULT_MODEL, username = userInfo().username, withOSCredentialReader,
} = {}) {
  home = resolve(home);
  const [, catalog] = await Promise.all([
    requireCodingPlanLogin(home).catch(error => { throw Object.assign(error, { blockedKind: 'auth' }); }),
    readJSON(configFile, 'ZCode provider catalog'),
  ]);
  const rule = accountRule(catalog);
  const { providerId } = rule;
  const accountLabel = 'Desktop account';
  const selection = selectModel(rule, model, accountLabel, catalog.revision);
  const credential = credentialReader(providerId, { env, home, username, withOSCredentialReader });
  const { identity, apiKey } = await credential().catch(error => {
    throw Object.assign(error, { blockedKind: 'auth' });
  });
  return buildAccountOverlay({ configFile, catalog, providerId, identity, selection, secrets: new Set([apiKey]),
    resolveApiKey: credential, accountLabel });
}

const statOptions = { bigint: true };

function validAuthFile(info) {
  return info.isFile() && info.uid === BigInt(process.getuid()) && info.nlink === 1n &&
    (info.mode & 0o077n) === 0n && (info.mode & 0o400n) !== 0n && info.size > 0n && info.size <= MAX_AUTH_BYTES;
}

function sameAuthFile(actual, expected, written = false) {
  return validAuthFile(actual) && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.mode === expected.mode && actual.size === expected.size &&
    (written || (actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs));
}

export async function projectedAccount(configFile, authFile, {
  model = DEFAULT_MODEL, consume = false, catalog: explicitCatalog, bundledCatalog,
} = {}) {
  let failure = 'Cannot read projected auth file';
  try {
    const initial = await lstat(authFile, statOptions);
    if (!validAuthFile(initial)) throw new Error();
    const wipe = consume && Boolean(initial.mode & 0o200n);
    // Pin the verified logical file. Nonblocking open prevents a substituted
    // FIFO from hanging before fstat can reject it. Never open with O_TRUNC.
    const descriptor = await open(authFile, (wipe ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await descriptor.stat(statOptions);
      if (!sameAuthFile(opened, initial)) throw new Error();
      const size = Number(opened.size);
      const bytes = Buffer.alloc(size + 1);
      let credentials;
      try {
        let position = 0;
        while (position < bytes.length) {
          const { bytesRead } = await descriptor.read(bytes, position, bytes.length - position, position);
          if (!bytesRead) break;
          position += bytesRead;
        }
        if (position !== size || !sameAuthFile(await descriptor.stat(statOptions), opened)) throw new Error();
        const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
        const { providerId, identity, apiKey, accountAccess = CODING_PLAN_ACCESS } = document;
        if (![providerId, identity, apiKey].every(value => typeof value === 'string' && value.trim()) ||
            !matchesAccountAccess(accountAccess)) throw new Error();
        credentials = { providerId: providerId.trim(), identity: identity.trim(), apiKey: apiKey.trim() };
      } finally { bytes.fill(0); }
      const { providerId, identity, apiKey } = credentials;
      const secrets = new Set([apiKey]);
      failure = undefined;
      const catalog = explicitCatalog ?? await readJSON(configFile, 'ZCode provider catalog');
      const rule = explicitCatalog ? projectedCatalogRule(catalog, bundledCatalog, providerId) : accountRule(catalog, providerId);
      const accountLabel = 'Projected account';
      const selection = selectModel(rule, model, accountLabel, catalog.revision);
      if (consume) {
        failure = 'Cannot consume projected auth file';
        if (!sameAuthFile(await lstat(authFile, statOptions), opened) ||
            !sameAuthFile(await descriptor.stat(statOptions), opened)) throw new Error();
        // Read-only (0400) files can be unlinked without granting write access.
        if (wipe) {
          let position = 0;
          while (position < size) {
            const { bytesWritten } = await descriptor.write(bytes, position, size - position, position);
            if (!bytesWritten) throw new Error();
            position += bytesWritten;
          }
          await descriptor.sync();
        }
        const after = await descriptor.stat(statOptions);
        if (!sameAuthFile(after, opened, wipe) || !sameAuthFile(await lstat(authFile, statOptions), after)) throw new Error();
        await unlink(authFile);
        // A replacement can be unlinked between the path check and unlink.
        // Report consumption only once the verified inode has no links left.
        if ((await descriptor.stat(statOptions)).nlink !== 0n) throw new Error();
      }
      return buildAccountOverlay({ configFile, catalog, providerId, identity, selection, secrets,
        resolveApiKey: () => ({ apiKey }), accountLabel });
    } finally {
      try { await descriptor.close(); }
      catch (error) { failure = 'Cannot close projected auth file'; throw error; }
    }
  } catch (error) {
    if (!failure) throw error;
    throw Object.assign(new Error(failure), { blockedKind: 'auth' });
  }
}
