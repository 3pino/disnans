import { setServerUrl } from './config';
import { capabilities, supportsDesktopStoragePlatform } from './platform';

// 判定の本体は platform.ts（Rust の値を優先し、無ければ UA）。ここからも従来どおり読めるように再エクスポートする
export { supportsDesktopStoragePlatform };
import { createSharedStorage, type LegacyStoragePort, type SaveResult, type SharedFilePort, type SharedKey, type SharedStorage, type SharedValue } from './sharedStorage';

type StorageState = { state: 'missing' } | { state: 'value'; value: string } | { state: 'cleared' };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const invokeTauri: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
};

/** Shared-file storage is enabled only for Windows/Linux desktop builds (platform.ts). */
export function isDesktopStorageSupported(): boolean {
  return capabilities().sharedStorage;
}

function fromState(result: StorageState): SharedValue {
  if (!result || typeof result !== 'object') throw new Error('Invalid client storage response');
  switch (result.state) {
    case 'missing': return undefined;
    case 'cleared': return null;
    case 'value':
      if (typeof result.value !== 'string') throw new Error('Invalid client storage value');
      return result.value;
    default: throw new Error('Unknown client storage state');
  }
}

/** Strict localStorage adapter used only for migration/fallback; write errors propagate. */
export const strictLegacyStorage: LegacyStoragePort = {
  get(key) {
    if (typeof window === 'undefined') throw new Error('localStorage unavailable');
    return window.localStorage.getItem(key);
  },
  set(key, value) {
    if (typeof window === 'undefined') throw new Error('localStorage unavailable');
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  },
};

export function createDesktopSharedStorage(
  call: Invoke = invokeTauri,
  legacy: LegacyStoragePort = strictLegacyStorage,
): SharedStorage {
  const files: SharedFilePort = {
    async read(key: SharedKey) {
      return fromState(await call<StorageState>('client_storage_read', { key }));
    },
    async write(key: SharedKey, value: string | null) {
      await call<StorageState>('client_storage_write', { args: { key, value } });
    },
    async importIfMissing(key: SharedKey, value: SharedValue) {
      const args: { key: SharedKey; value?: SharedValue } = { key };
      if (value !== undefined) args.value = value;
      return fromState(await call<StorageState>('client_storage_import', { args }));
    },
  };
  return createSharedStorage({ enabled: true, files, legacy });
}

let desktopShared: SharedStorage | null = null;
let serverReadUsedLegacyFallback = false;

/** Initialize the desktop shared-file adapter once, then resolve/import the server before boot. */
export async function initializeDesktopStorage(): Promise<string | null> {
  if (!isDesktopStorageSupported()) return null;
  desktopShared ??= createDesktopSharedStorage();
  const result = await desktopShared.getServerWithStatus();
  serverReadUsedLegacyFallback = result.status === 'legacy-fallback';
  return result.value;
}

export function didInitializeWithLegacyFallback(): boolean {
  return serverReadUsedLegacyFallback;
}

export function getDesktopSharedStorage(): SharedStorage | null {
  if (!isDesktopStorageSupported()) return null;
  desktopShared ??= createDesktopSharedStorage();
  return desktopShared;
}

/** Persist a server choice; browser/Android keep the existing synchronous localStorage path. */
export async function saveServerUrl(url: string | null): Promise<SaveResult | { status: 'local' }> {
  if (!isDesktopStorageSupported()) {
    setServerUrl(url);
    return { status: 'local' };
  }
  const shared = getDesktopSharedStorage();
  if (!shared) throw new Error('Desktop shared storage unavailable');
  return shared.setServer(url);
}
