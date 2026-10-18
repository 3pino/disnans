// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { applyServerUrl, getServerUrl } from './config';
import { createDesktopSharedStorage, saveServerUrl } from './desktopStorage';
import { draftLocation, flushDraftSaves, loadDraftAt, saveDraftAt } from './drafts';
import { createSharedStorage, type LegacyStoragePort, type SharedFilePort, type SharedKey } from './sharedStorage';

type FileState = { state: 'missing' } | { state: 'value'; value: string } | { state: 'cleared' };

const server = 'https://chat.example';
const otherServer = 'https://other.example';

function memoryLegacy(seed: Record<string, string> = {}): LegacyStoragePort {
  const values = new Map(Object.entries(seed));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
}

function keyId(key: SharedKey): string {
  return JSON.stringify(key);
}

function installDesktopGlobals(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Linux x86_64' });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
}

async function freshDesktopModules() {
  vi.resetModules();
  const [config, desktopStorage, drafts] = await Promise.all([
    import('./config'),
    import('./desktopStorage'),
    import('./drafts'),
  ]);
  return { config, desktopStorage, drafts };
}

function installStorageInvoke(initial: Record<string, string | null> = {}) {
  const files = new Map(Object.entries(initial));
  invokeMock.mockImplementation(async (command: string, input?: Record<string, unknown>): Promise<FileState> => {
    const nested = input?.args as { key: SharedKey; value?: string | null } | undefined;
    const key = (command === 'client_storage_read' ? input?.key : nested?.key) as SharedKey;
    const id = keyId(key);
    if (command === 'client_storage_read') {
      if (!files.has(id)) return { state: 'missing' };
      const value = files.get(id);
      return value === null ? { state: 'cleared' } : { state: 'value', value: value! };
    }
    if (command === 'client_storage_write') {
      files.set(id, nested!.value ?? null);
      return nested!.value === null ? { state: 'cleared' } : { state: 'value', value: nested!.value! };
    }
    if (command === 'client_storage_import') {
      if (!files.has(id) && nested?.value !== undefined) files.set(id, nested.value);
      if (!files.has(id)) return { state: 'missing' };
      const value = files.get(id);
      return value === null ? { state: 'cleared' } : { state: 'value', value: value! };
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  return files;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  installDesktopGlobals();
  applyServerUrl(null);
});

describe('desktop shared storage integration', () => {
  it('does not apply the shared server before its asynchronous file read completes', async () => {
    let releaseGate!: (value: string | null | undefined) => void;
    const gate = new Promise<string | null | undefined>((resolve) => { releaseGate = resolve; });
    const readKeys: SharedKey[] = [];
    const fileReads: Array<string | null | undefined> = [];
    const files: SharedFilePort = {
      read: async (key) => {
        readKeys.push(key);
        const value = await gate;
        fileReads.push(value);
        return value;
      },
      write: async () => undefined,
      importIfMissing: async (_key, value) => value,
    };
    applyServerUrl('http://legacy.example');
    const storage = createSharedStorage({ enabled: true, files, legacy: memoryLegacy({ 'disnans.server': 'http://legacy.example' }) });

    let initialized = false;
    let resolvedServer: string | null = null;
    let readStatus = '';
    const initialization = storage.getServerWithStatus().then((result) => {
      readStatus = result.status;
      resolvedServer = result.value;
      applyServerUrl(result.value);
      initialized = true;
    });
    await Promise.resolve();
    expect(initialized).toBe(false);
    expect(getServerUrl()).toBe('http://legacy.example');

    releaseGate(server);
    await initialization;
    expect(initialized).toBe(true);
    expect(readKeys).toEqual([{ kind: 'server' }]);
    expect(fileReads).toEqual([server]);
    expect(readStatus).toBe('shared');
    expect(resolvedServer).toBe(server);
    expect(getServerUrl()).toBe(server);
  });

  it('gates actual desktop initialization on the IPC read before applying server configuration', async () => {
    let releaseInitRead!: (value: FileState) => void;
    const gate = new Promise<FileState>((resolve) => { releaseInitRead = resolve; });
    invokeMock.mockImplementation((command: string) => {
      expect(command).toBe('client_storage_read');
      return gate;
    });
    const { config, desktopStorage } = await freshDesktopModules();
    config.applyServerUrl('http://legacy.example');

    let completed = false;
    const boot = desktopStorage.initializeDesktopStorage().then((url) => {
      config.applyServerUrl(url);
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(config.getServerUrl()).toBe('http://legacy.example');

    releaseInitRead({ state: 'value', value: server });
    await boot;
    expect(completed).toBe(true);
    expect(config.getServerUrl()).toBe(server);
    expect(invokeMock).toHaveBeenCalledWith('client_storage_read', { key: { kind: 'server' } });
  });

  it('treats missing storage with no legacy server as an unset server, not a legacy fallback', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'client_storage_read' || command === 'client_storage_import') return { state: 'missing' } satisfies FileState;
      throw new Error(`unexpected IPC command: ${command}`);
    });
    const { desktopStorage } = await freshDesktopModules();

    expect(await desktopStorage.initializeDesktopStorage()).toBeNull();
    expect(desktopStorage.didInitializeWithLegacyFallback()).toBe(false);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'client_storage_read',
      'client_storage_import',
      'client_storage_read',
    ]);
    expect(invokeMock).toHaveBeenCalledWith('client_storage_import', { args: { key: { kind: 'server' } } });
  });

  it('does not turn an unreadable draft without backup into an empty editor, but restores an available backup', async () => {
    const failReads = async <T>(): Promise<T> => { throw new Error('IPC unavailable'); };
    const noBackup = createDesktopSharedStorage(failReads, memoryLegacy());
    const missingLocation = draftLocation(server, 'unreadable-user');
    await expect(loadDraftAt(missingLocation, noBackup)).rejects.toThrow('共有下書きを読み込めず');

    const backupLocation = draftLocation(server, 'backup-user');
    const backup = createDesktopSharedStorage(failReads, memoryLegacy({
      'disnans.server': server,
      'disnans.draft.backup-user.main': 'recoverable legacy draft',
    }));
    expect(await loadDraftAt(backupLocation, backup)).toBe('recoverable legacy draft');
  });

  it('prefers a desktop clear tombstone and retains legacy data after import or readback failures', async () => {
    const tombstoneLegacy = memoryLegacy({
      'disnans.server': server,
      'disnans.draft.user-a.main': 'must not return',
    });
    const tombstoneCall = async <T>(command: string): Promise<T> => {
      if (command === 'client_storage_read') return { state: 'cleared' } as T;
      throw new Error(`unexpected IPC command: ${command}`);
    };
    const cleared = createDesktopSharedStorage(tombstoneCall, tombstoneLegacy);
    expect(await cleared.getDraft(server, 'user-a', 'main')).toBeNull();
    expect(tombstoneLegacy.get('disnans.draft.user-a.main')).toBe('must not return');

    for (const failAt of ['import', 'readback'] as const) {
      const legacy = memoryLegacy({
        'disnans.server': server,
        'disnans.draft.user-a.main': 'legacy stays',
      });
      let reads = 0;
      const call = async <T>(command: string): Promise<T> => {
        if (command === 'client_storage_read') {
          reads++;
          if (failAt === 'readback' && reads > 1) return { state: 'missing' } as T;
          return { state: 'missing' } as T;
        }
        if (command === 'client_storage_import') {
          if (failAt === 'import') throw new Error('import failed');
          return { state: 'value', value: 'legacy stays' } as T;
        }
        throw new Error(`unexpected IPC command: ${command}`);
      };
      const storage = createDesktopSharedStorage(call, legacy);
      expect(await storage.getDraft(server, 'user-a', 'main')).toBe('legacy stays');
      expect(legacy.get('disnans.draft.user-a.main')).toBe('legacy stays');
    }
  });

  it('keeps server, user, and place draft namespaces distinct and clears only the captured location', async () => {
    const files = installStorageInvoke();
    const shared = createDesktopSharedStorage(invokeMock, memoryLegacy());
    const original = draftLocation(server, 'user-a');
    const otherLocation = draftLocation(otherServer, 'user-a');
    const anotherUser = draftLocation(server, 'user-b');

    applyServerUrl(otherServer);
    expect(await saveDraftAt(original, 'before switching server', shared)).toEqual({ status: 'shared' });
    expect(await saveDraftAt(otherLocation, 'other server', shared)).toEqual({ status: 'shared' });
    expect(await saveDraftAt(anotherUser, 'other user', shared)).toEqual({ status: 'shared' });
    expect(await saveDraftAt(original, '', shared)).toEqual({ status: 'shared' });

    expect(await loadDraftAt(original, shared)).toBe('');
    expect(await loadDraftAt(otherLocation, shared)).toBe('other server');
    expect(await loadDraftAt(anotherUser, shared)).toBe('other user');
    expect(files.get(keyId({ kind: 'draft', serverUrl: server, userId: 'user-a', place: 'main' }))).toBeNull();
    expect(files.get(keyId({ kind: 'draft', serverUrl: otherServer, userId: 'user-a', place: 'main' }))).toBe('other server');
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('retains failed desktop draft saves in-session and blocks a reload flush', async () => {
    const legacy = memoryLegacy({ 'disnans.server': 'https://legacy.example' });
    const shared = createDesktopSharedStorage(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'client_storage_write') throw new Error('IPC unavailable');
      return invokeMock(command, args) as Promise<T>;
    }, legacy);
    installStorageInvoke();
    const location = draftLocation(server, 'user-a');

    await expect(saveDraftAt(location, 'keep this body', shared)).rejects.toThrow('IPC unavailable');
    expect(await loadDraftAt(location, shared)).toBe('keep this body');
    await expect(flushDraftSaves()).rejects.toThrow('not saved to shared storage');

    const retryStorage = createDesktopSharedStorage(invokeMock, legacy);
    expect(await saveDraftAt(location, 'keep this body', retryStorage)).toEqual({ status: 'shared' });
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('retains a superseded draft in-session, blocks reload, then clears pending state after a successful retry', async () => {
    const { drafts } = await freshDesktopModules();
    const location = drafts.draftLocation(server, 'superseded-user');
    const files = new Map<string, string | null>();
    let supersedeNextReadback = true;
    invokeMock.mockImplementation(async (command: string, input?: Record<string, unknown>): Promise<FileState> => {
      const nested = input?.args as { key: SharedKey; value?: string | null } | undefined;
      if (command === 'client_storage_write') {
        files.set(keyId(nested!.key), nested!.value ?? null);
        return { state: 'value', value: nested!.value! };
      }
      if (command === 'client_storage_read') {
        const readKey = input?.key as SharedKey;
        let value = files.get(keyId(readKey));
        if (supersedeNextReadback && readKey.kind === 'draft' && value === 'local edit') {
          supersedeNextReadback = false;
          value = 'newer external edit';
          files.set(keyId(readKey), value);
        }
        return value === undefined ? { state: 'missing' } : value === null ? { state: 'cleared' } : { state: 'value', value };
      }
      throw new Error(`unexpected IPC command: ${command}`);
    });
    const shared = createDesktopSharedStorage(invokeMock, memoryLegacy());

    expect(await drafts.saveDraftAt(location, 'local edit', shared)).toEqual({ status: 'superseded', value: 'newer external edit' });
    expect(await drafts.loadDraftAt(location, shared)).toBe('local edit');
    await expect(drafts.flushDraftSaves()).rejects.toThrow('not saved to shared storage');

    expect(await drafts.saveDraftAt(location, 'local edit', shared)).toEqual({ status: 'shared' });
    await expect(drafts.flushDraftSaves()).resolves.toBeUndefined();
  });

  it('keeps browser and macOS server writes local without calling Tauri IPC', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Chrome browser' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    expect(await saveServerUrl(server)).toEqual({ status: 'local' });
    expect(invokeMock).not.toHaveBeenCalled();

    installDesktopGlobals();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Mac OS X' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    expect(await saveServerUrl(server)).toEqual({ status: 'local' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Android: a legacy draft is imported into the Rust store once; later reads use Rust (step6 (3))', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Linux; Android 14' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux armv8l' });
    localStorage.setItem('disnans.server', server);
    localStorage.setItem('disnans.draft.user-a.main', 'from legacy');
    const files = installStorageInvoke();
    const { desktopStorage } = await freshDesktopModules();
    const shared = desktopStorage.getDesktopSharedStorage()!;
    expect(await shared.getDraft(server, 'user-a', 'main')).toBe('from legacy');
    expect(files.get(keyId({ kind: 'draft', serverUrl: server, userId: 'user-a', place: 'main' }))).toBe('from legacy');
    // 取り込みを確かめたので、localStorage の下書きは消す（サーバーの値は消さない）
    expect(localStorage.getItem('disnans.draft.user-a.main')).toBeNull();
    expect(localStorage.getItem('disnans.server')).toBe(server);

    // 二回目以降は Rust の値が正（localStorage を変えても読まない）
    localStorage.setItem('disnans.draft.user-a.main', 'changed legacy');
    const again = (await freshDesktopModules()).desktopStorage.getDesktopSharedStorage()!;
    expect(await again.getDraft(server, 'user-a', 'main')).toBe('from legacy');
  });

  it('Android: when the Rust store cannot be read, the legacy draft is kept and shown (not deleted)', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Linux; Android 14' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux armv8l' });
    localStorage.setItem('disnans.server', server);
    localStorage.setItem('disnans.draft.user-a.main', 'keep me');
    invokeMock.mockRejectedValue(new Error('storage unavailable'));
    const { desktopStorage } = await freshDesktopModules();
    const shared = desktopStorage.getDesktopSharedStorage()!;
    expect(await shared.getDraft(server, 'user-a', 'main')).toBe('keep me');
    expect(localStorage.getItem('disnans.draft.user-a.main')).toBe('keep me');
  });

  it('Android (Tauri) saves the server through the Rust shared store (step6 (3))', async () => {
    installStorageInvoke();
    installDesktopGlobals();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla Android 14' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux armv8l' });
    expect(await saveServerUrl(server)).toEqual({ status: 'shared' });
    expect(invokeMock.mock.calls[0][0]).toBe('client_storage_write');
  });
});
