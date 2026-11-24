import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';

export const CODING_PLAN_ACCESS = Object.freeze({ type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' });
const MAX_CATALOG_BYTES = 4n * 1024n * 1024n;
const statOptions = { bigint: true };

export function matchesAccountAccess(access) {
  return access?.type === CODING_PLAN_ACCESS.type && access.mode === CODING_PLAN_ACCESS.mode &&
    access.accountType === CODING_PLAN_ACCESS.accountType;
}

function catalogInvalid() {
  const message = 'catalog_invalid: The provider catalog is invalid or incompatible with the bundled Coding Plan API.';
  return Object.assign(new Error(message), { code: 'catalog_invalid', safeSummary: message, failure: { state: 'error' } });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseProviderCatalog(bytes) {
  let catalog;
  try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw catalogInvalid(); }
  if (!isObject(catalog) || catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.revision) || catalog.revision < 1 ||
      !isObject(catalog.config?.modelConfigRules) || !Array.isArray(catalog.config?.providerConfigRules?.providerRules)) {
    throw catalogInvalid();
  }
  return catalog;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
}

export function codingPlanRule(catalog, providerId) {
  const rules = catalog?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) throw catalogInvalid();
  const matches = rules.filter(rule => providerId === undefined ? matchesAccountAccess(rule?.config?.access) : rule?.providerId === providerId);
  const rule = matches[0];
  const { access, builtinModelIds, api } = rule?.config ?? {};
  if (matches.length !== 1 || !matchesAccountAccess(access) || typeof rule.providerId !== 'string' || !rule.providerId.trim() ||
      !Array.isArray(builtinModelIds) || !builtinModelIds.length ||
      !builtinModelIds.every(id => typeof id === 'string' && id.trim()) || new Set(builtinModelIds).size !== builtinModelIds.length ||
      typeof api?.type !== 'string' || !api.type.trim() || !isHttpsUrl(api.baseUrl)) {
    throw catalogInvalid();
  }
  return rule;
}

export function compatibleCodingPlanRule(catalog, bundledCatalog, providerId) {
  const rule = codingPlanRule(catalog, providerId);
  const { api } = codingPlanRule(bundledCatalog, providerId).config;
  if (rule.config.api.type !== api.type || rule.config.api.baseUrl !== api.baseUrl) throw catalogInvalid();
  return rule;
}

export async function readBundledCatalog(path) {
  try { return parseProviderCatalog(await readFile(path)); }
  catch { throw catalogInvalid(); }
}

function validCatalogFile(info) {
  return info.isFile() && info.uid === BigInt(process.getuid()) && info.nlink === 1n &&
    (info.mode & 0o022n) === 0n && info.size > 0n && info.size <= MAX_CATALOG_BYTES;
}

function sameCatalogFile(actual, expected) {
  return validCatalogFile(actual) && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.mode === expected.mode && actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs;
}

export async function readExplicitCatalog(path) {
  try {
    const initial = await lstat(path, statOptions);
    if (!validCatalogFile(initial)) throw catalogInvalid();
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await descriptor.stat(statOptions);
      if (!sameCatalogFile(opened, initial)) throw catalogInvalid();
      const size = Number(opened.size);
      const buffer = Buffer.alloc(size + 1);
      let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await descriptor.read(buffer, position, buffer.length - position, position);
        if (!bytesRead) break;
        position += bytesRead;
      }
      if (position !== size || !sameCatalogFile(await descriptor.stat(statOptions), opened)) throw catalogInvalid();
      const bytes = buffer.subarray(0, size);
      return {
        bytes,
        catalog: parseProviderCatalog(bytes),
        async recheck() {
          try {
            if (!sameCatalogFile(await lstat(path, statOptions), opened)) throw catalogInvalid();
          } catch { throw catalogInvalid(); }
        },
      };
    } finally {
      await descriptor.close();
    }
  } catch { throw catalogInvalid(); }
}
