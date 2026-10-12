import { normalizeServerUrl } from './config';
import { getItem, setItem } from './storage';

/** Core file key: implementations must encode IDs safely rather than use them as raw paths. */
export type SharedKey =
  | { kind: 'server' }
  | { kind: 'draft'; serverUrl: string; userId: string; place: string };

/** undefined means absent; null is an explicit clear (tombstone). */
export type SharedValue = string | null | undefined;

/**
 * Async shared-file port. `write` must be an atomic per-key update. `importIfMissing`
 * must check and optionally create while holding the same inter-process lock as writes.
 * It returns the authoritative value (including an existing tombstone); undefined means
 * the key is still absent. The core must preserve later external saves on readback mismatch.
 */
export interface SharedFilePort {
  read(key: SharedKey): Promise<SharedValue>;
  write(key: SharedKey, value: string | null): Promise<void>;
  importIfMissing(key: SharedKey, value: SharedValue): Promise<SharedValue>;
}

/** Legacy WebView storage port, kept injectable for tests and platform fallback. */
export interface LegacyStoragePort {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export type SharedStorageOptions = {
  /** false for browser development and Android: use the existing localStorage only */
  enabled: boolean;
  files: SharedFilePort;
  legacy?: LegacyStoragePort;
};

export type SaveResult =
  | { status: 'shared' }
  | { status: 'legacy-fallback' }
  | { status: 'superseded'; value: string | null };

export type SharedStorage = {
  /** Read current server URL. null means explicitly unset or unavailable. */
  getServer(): Promise<string | null>;
  /** The result identifies localStorage fallback or a later external save. */
  setServer(value: string | null): Promise<SaveResult>;
  /** Read/save one draft. place is `main` or `thread:<id>`. */
  getDraft(serverUrl: string, userId: string, place: string): Promise<string | null>;
  /** Whitespace-only bodies are saved as an explicit clear. */
  setDraft(serverUrl: string, userId: string, place: string, value: string | null): Promise<SaveResult>;
};

const SERVER_LEGACY_KEY = 'disnans.server';
const DRAFT_PREFIX = 'disnans.draft.';

const localStoragePort: LegacyStoragePort = {
  get: (key) => getItem(key),
  set: (key, value) => setItem(key, value),
};

function canonicalServer(value: string): string {
  return normalizeServerUrl(value);
}

function draftLegacyKey(userId: string, place: string): string {
  return `${DRAFT_PREFIX}${userId}.${place}`;
}

function keyId(key: SharedKey): string {
  return key.kind === 'server'
    ? 'server'
    : JSON.stringify(['draft', key.serverUrl, key.userId, key.place]);
}

/**
 * Boundary adapter for the future Tauri/core file store. It is deliberately not
 * wired into application startup yet. The host must await operations before use.
 */
export function createSharedStorage(options: SharedStorageOptions): SharedStorage {
  const legacy = options.legacy ?? localStoragePort;
  // Legacy draft keys lack a server namespace. Capture the old association before
  // setServer can change the active endpoint; only migrate drafts for this server.
  const legacyServerRaw = legacy.get(SERVER_LEGACY_KEY);
  const normalizedLegacyServer = legacyServerRaw ? canonicalServer(legacyServerRaw) : '';
  const legacyServer = normalizedLegacyServer || null;
  const queues = new Map<string, Promise<void>>();

  function serial<T>(key: SharedKey, work: () => Promise<T>): Promise<T> {
    const id = keyId(key);
    const previous = queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(id, settled);
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return result;
  }

  function legacyValue(key: SharedKey): string | null {
    if (key.kind === 'server') {
      const value = legacy.get(SERVER_LEGACY_KEY);
      return value === null ? null : canonicalServer(value) || null;
    }
    if (legacyServer !== key.serverUrl) return null;
    return legacy.get(draftLegacyKey(key.userId, key.place));
  }

  function clearLegacy(key: SharedKey): void {
    if (key.kind === 'server') return; // Keep the old endpoint as draft migration provenance.
    if (legacyServer === key.serverUrl) legacy.set(draftLegacyKey(key.userId, key.place), null);
  }

  async function readShared(key: SharedKey): Promise<string | null> {
    try {
      const current = await options.files.read(key);
      if (current !== undefined) return current;

      const oldValue = legacyValue(key);
      const imported = await options.files.importIfMissing(key, oldValue === null ? undefined : oldValue);
      // A concurrent save/clear may win between the first read and import. Never
      // overwrite it with old localStorage data; use the file's authoritative value.
      const verified = await options.files.read(key);
      if (verified !== undefined) {
        if (oldValue !== null && verified === oldValue && imported === oldValue) clearLegacy(key);
        return verified;
      }
      // A disappearing/unverifiable file store is a failure; retain the old value.
      return oldValue;
    } catch {
      return legacyValue(key);
    }
  }

  async function writeShared(key: SharedKey, value: string | null): Promise<SaveResult> {
    if (!options.enabled) {
      if (key.kind === 'server') legacy.set(SERVER_LEGACY_KEY, value);
      else legacy.set(draftLegacyKey(key.userId, key.place), value);
      return { status: 'legacy-fallback' };
    }

    try {
      await options.files.write(key, value);
    } catch (error) {
      // Fallback is safe only if this legacy key is known to belong to this server.
      if (key.kind === 'server') legacy.set(SERVER_LEGACY_KEY, value);
      else if (legacyServer === key.serverUrl) legacy.set(draftLegacyKey(key.userId, key.place), value);
      else throw error;
      return { status: 'legacy-fallback' };
    }

    // A mismatch may be a newer save from another process. Never copy our stale
    // value back to either store; report the authoritative value to the caller.
    const verified = await options.files.read(key);
    if (verified === undefined) throw new Error('Shared storage write could not be verified');
    if (verified !== value) return { status: 'superseded', value: verified };
    clearLegacy(key);
    return { status: 'shared' };
  }

  return {
    getServer: () => serial({ kind: 'server' }, () => options.enabled
      ? readShared({ kind: 'server' })
      : Promise.resolve(legacy.get(SERVER_LEGACY_KEY))),
    setServer: (value) => {
      const normalized = value === null ? null : canonicalServer(value) || null;
      return serial({ kind: 'server' }, () => writeShared({ kind: 'server' }, normalized));
    },
    getDraft: (serverUrl, userId, place) => {
      const key: SharedKey = { kind: 'draft', serverUrl: canonicalServer(serverUrl), userId, place };
      return serial(key, () => options.enabled
        ? readShared(key)
        : Promise.resolve(legacy.get(draftLegacyKey(userId, place))));
    },
    setDraft: (serverUrl, userId, place, value) => {
      const key: SharedKey = { kind: 'draft', serverUrl: canonicalServer(serverUrl), userId, place };
      const normalized = value === null || value.trim() === '' ? null : value;
      return serial(key, () => writeShared(key, normalized));
    },
  };
}
