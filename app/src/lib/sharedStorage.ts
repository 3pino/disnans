import { canonicalServerUrl, normalizeServerUrl } from './config';
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

/** `legacy-fallback` is not shared success; enabled desktop hosts never copy failed server writes to localStorage, preserving draft provenance. */
export type SaveResult =
  | { status: 'shared' }
  | { status: 'legacy-fallback' }
  | { status: 'superseded'; value: string | null };

export type SharedReadResult = { value: string | null; status: 'shared' | 'legacy-fallback' };

export type SharedStorage = {
  /** Read current server URL. null means explicitly unset or unavailable. */
  getServer(): Promise<string | null>;
  /** Read with an explicit signal when the value came from localStorage fallback. */
  getServerWithStatus(): Promise<SharedReadResult>;
  /** A legacy-fallback result is not persisted on desktop; hosts must not treat it as a successful server change. */
  setServer(value: string | null): Promise<SaveResult>;
  /** Read/save one draft. place is `main`. */
  getDraft(serverUrl: string, userId: string, place: string): Promise<string | null>;
  /** Optional for older injected ports; desktop adapters expose read failures separately from an empty draft. */
  getDraftWithStatus?(serverUrl: string, userId: string, place: string): Promise<SharedReadResult>;
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
  try {
    return canonicalServerUrl(value);
  } catch {
    // Preserve invalid legacy URLs for existing GUI behavior; Tauri IPC validates imports.
    const normalized = normalizeServerUrl(value);
    try {
      // Some invalid old values normalize to a valid HTTP URL used by browser URL resolution.
      return canonicalServerUrl(normalized);
    } catch {
      return normalized;
    }
  }
}

function canonicalValue(key: SharedKey, value: SharedValue): SharedValue {
  return key.kind === 'server' && typeof value === 'string' ? canonicalServer(value) : value;
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
 * Boundary adapter for Tauri/core shared storage. The host must await saves and
 * inspect SaveResult rather than treating a legacy-only fallback as shared success.
 */
export function createSharedStorage(options: SharedStorageOptions): SharedStorage {
  const legacy = options.legacy ?? localStoragePort;
  // Legacy draft keys lack a server namespace. Capture the old association before
  // setServer can change the active endpoint; only migrate drafts for this server.
  let legacyServerRaw: string | null = null;
  try {
    legacyServerRaw = legacy.get(SERVER_LEGACY_KEY);
  } catch {
    // Shared-file operations can still work if localStorage is unavailable.
  }
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
    try {
      if (key.kind === 'server') {
        const value = legacy.get(SERVER_LEGACY_KEY);
        return value === null ? null : canonicalServer(value) || null;
      }
      if (legacyServer !== key.serverUrl) return null;
      return legacy.get(draftLegacyKey(key.userId, key.place));
    } catch {
      return null;
    }
  }

  function legacyImportValue(key: SharedKey): SharedValue {
    if (key.kind !== 'server') {
      const value = legacyValue(key);
      return value === null ? undefined : value;
    }
    try {
      const raw = legacy.get(SERVER_LEGACY_KEY);
      return raw === null || normalizeServerUrl(raw) === '' ? undefined : raw;
    } catch {
      return undefined;
    }
  }

  function clearLegacy(key: SharedKey): void {
    if (key.kind === 'server') return; // Keep the old endpoint as draft migration provenance.
    if (legacyServer !== key.serverUrl) return;
    try {
      legacy.set(draftLegacyKey(key.userId, key.place), null);
    } catch {
      // The verified shared value is authoritative; failed cleanup only retains a stale backup.
    }
  }

  async function readSharedWithStatus(key: SharedKey): Promise<SharedReadResult> {
    try {
      const current = await options.files.read(key);
      if (current !== undefined) return { value: canonicalValue(key, current) as string | null, status: 'shared' };

      const oldValue = legacyValue(key);
      // Import the original server text so core validation can reject malformed legacy URLs;
      // only the fallback value is normalized for the still-running GUI.
      const importedRaw = await options.files.importIfMissing(key, legacyImportValue(key));
      const imported = canonicalValue(key, importedRaw);
      // A concurrent save/clear may win between the first read and import. Never
      // overwrite it with old localStorage data; use the file's authoritative value.
      const verifiedRaw = await options.files.read(key);
      const verified = canonicalValue(key, verifiedRaw);
      if (verified !== undefined) {
        if (oldValue !== null && verified === oldValue && imported === oldValue) clearLegacy(key);
        return { value: verified, status: 'shared' };
      }
      // A fresh install with no legacy value and an atomic no-op import is a valid unset server.
      if (oldValue === null && imported === undefined) return { value: null, status: 'shared' };
      // A disappearing/unverifiable file store is a failure; retain the old value.
      return { value: oldValue, status: 'legacy-fallback' };
    } catch {
      return { value: legacyValue(key), status: 'legacy-fallback' };
    }
  }

  async function readShared(key: SharedKey): Promise<string | null> {
    return (await readSharedWithStatus(key)).value;
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
      // A desktop server fallback must not rewrite the legacy endpoint: it is the
      // provenance key for drafts that have not migrated yet.
      if (key.kind === 'server') return { status: 'legacy-fallback' };
      // A draft fallback is safe only if this legacy key is known to belong to this server.
      if (legacyServer === key.serverUrl) legacy.set(draftLegacyKey(key.userId, key.place), value);
      else throw error;
      return { status: 'legacy-fallback' };
    }

    // A mismatch may be a newer save from another process. Never copy our stale
    // value back to either store; report the authoritative value to the caller.
    const verifiedRaw = await options.files.read(key);
    const verified = canonicalValue(key, verifiedRaw);
    if (verified === undefined) throw new Error('Shared storage write could not be verified');
    if (verified !== value) return { status: 'superseded', value: verified };
    clearLegacy(key);
    return { status: 'shared' };
  }

  return {
    getServer: () => serial({ kind: 'server' }, () => options.enabled
      ? readShared({ kind: 'server' })
      : Promise.resolve(legacy.get(SERVER_LEGACY_KEY))),
    getServerWithStatus: () => serial({ kind: 'server' }, () => options.enabled
      ? readSharedWithStatus({ kind: 'server' })
      : Promise.resolve({ value: legacy.get(SERVER_LEGACY_KEY), status: 'legacy-fallback' as const })),
    setServer: (value) => {
      const normalized = value === null ? null : (options.enabled ? canonicalServerUrl(value) : normalizeServerUrl(value)) || null;
      return serial({ kind: 'server' }, () => writeShared({ kind: 'server' }, normalized));
    },
    getDraft: (serverUrl, userId, place) => {
      const key: SharedKey = { kind: 'draft', serverUrl: canonicalServer(serverUrl), userId, place };
      return serial(key, () => options.enabled
        ? readShared(key)
        : Promise.resolve(legacy.get(draftLegacyKey(userId, place))));
    },
    getDraftWithStatus: (serverUrl, userId, place) => {
      const key: SharedKey = { kind: 'draft', serverUrl: canonicalServer(serverUrl), userId, place };
      return serial(key, () => options.enabled
        ? readSharedWithStatus(key)
        : Promise.resolve({ value: legacy.get(draftLegacyKey(userId, place)), status: 'legacy-fallback' as const }));
    },
    setDraft: (serverUrl, userId, place, value) => {
      const key: SharedKey = { kind: 'draft', serverUrl: canonicalServer(serverUrl), userId, place };
      const normalized = value === null || value.trim() === '' ? null : value;
      return serial(key, () => writeShared(key, normalized));
    },
  };
}
