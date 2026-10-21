import { readFile } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_MODEL = 'account:zai-individual-coding-plan/GLM-5.3';
const hash = value => createHash('sha256').update(value).digest('hex');

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
  return { write: text => render(text), flush: () => render('', true) };
}

function decrypt(value, { env, home, username }) {
  if (typeof value !== 'string' || !value) throw new Error('Desktop credential is missing');
  if (!value.startsWith('enc:v1:')) return value;
  try {
    const parts = value.slice(7).split('.').map(part => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error();
    const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${process.platform}:${home}:${username}`;
    const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), parts[0]);
    cipher.setAuthTag(parts[1]);
    return Buffer.concat([cipher.update(parts[2]), cipher.final()]).toString('utf8');
  } catch { throw new Error('Desktop credential cannot be decrypted; sign in through ZCode Desktop'); }
}

async function readJSON(path, description) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Cannot read ${description}`); }
}

/** Minimal port of Mulgae's account overlay and on-demand auth response.
 * Never writes Desktop settings, credentials, or persistent model selections.
 */
export async function desktopAccount(configFile, {
  env = process.env, home = env.ZCODE_DATA_BASE_DIR || homedir(),
  model = DEFAULT_MODEL, username = userInfo().username,
} = {}) {
  home = resolve(home);
  const context = { env, home, username };
  const [settings, catalog] = await Promise.all([
    readJSON(join(home, '.zcode/v2/setting.json'), 'ZCode Desktop account settings'),
    readJSON(configFile, 'ZCode provider catalog'),
  ]);
  if (settings.providerFamilyDomain !== 'zai' || settings.providerFamilyConnectionSelections?.zai?.kind !== 'individual-coding-plan') {
    throw new Error('Select the Z.AI Individual Coding Plan in ZCode Desktop');
  }
  const rules = catalog.config?.providerConfigRules?.providerRules;
  const matches = Array.isArray(rules) ? rules.filter(rule => rule.config?.access?.type === 'zhipu-account' && rule.config.access.mode === 'individual-coding-plan' && rule.config.access.accountType === 'zai') : [];
  if (matches.length !== 1 || !Number.isInteger(catalog.revision) || catalog.revision < 1) throw new Error('Unsupported ZCode account catalog');
  const rule = matches[0], providerId = rule.providerId;
  const qualified = typeof model === 'object' ? model : (() => {
    const text = String(model || DEFAULT_MODEL).trim();
    const slash = text.indexOf('/');
    return slash < 0 ? { providerId, modelId: text } : { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
  })();
  if (qualified.providerId !== providerId || !rule.config.builtinModelIds?.includes(qualified.modelId)) {
    throw new Error('Requested model is absent from the Desktop account catalog; no fallback model was selected');
  }
  const selection = { providerId, modelId: qualified.modelId };
  const secrets = new Set();
  async function credential(expectedIdentity) {
    const values = await readJSON(join(home, '.zcode/v2/credentials.json'), 'ZCode Desktop credentials');
    let profile;
    try { profile = JSON.parse(decrypt(values['oauth:zai:user_info'], context)); }
    catch { throw new Error('ZCode Desktop account profile is unavailable'); }
    const identity = String(profile.id || profile.user_id || '').trim();
    if (!identity || (expectedIdentity && identity !== expectedIdentity)) throw new Error('ZCode Desktop account changed; restart this executor');
    const name = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
    const apiKey = decrypt(values[name], context).trim();
    if (!apiKey) throw new Error('ZCode Desktop coding-plan credential is unavailable');
    secrets.add(apiKey);
    return { identity, apiKey };
  }
  const { identity } = await credential();
  // The installed CLI accepts explicit Built-in + Personal paths. Its source
  // revision hashes the resolved active path, not a display name or app version.
  const builtinRevision = `zcode-builtin:${catalog.revision}:${hash(resolve(configFile))}`;
  const config = {
    revision: `herdr-zcode-account:${hash(`${builtinRevision}\0${providerId}\0${identity}`)}`,
    basedOnZCodeBuiltinRevision: builtinRevision,
    providers: { [providerId]: { access: { type: 'zhipu-account', entitled: true } } },
    states: { [providerId]: { availability: 'available', entitled: true, current: true } },
  };
  return {
    selection, config,
    async runtimeHeaders(request) {
      if (request?.providerId !== providerId || request.accountAccess?.type !== 'zhipu-account' || request.accountAccess?.mode !== 'individual-coding-plan' || request.accountAccess?.accountType !== 'zai') {
        return { headersApplied: false, errorMessage: 'Desktop account request identity mismatch' };
      }
      try {
        const { apiKey } = await credential(identity);
        return { headersApplied: true, requestAuth: { apiKey } };
      } catch { return { headersApplied: false, errorMessage: 'Desktop account credential unavailable or changed; restart the executor' }; }
    },
    createStreamRedactor: () => createStreamRedactor(secrets),
    redact(text) {
      const stream = createStreamRedactor(secrets);
      return stream.write(text) + stream.flush();
    },
  };
}
