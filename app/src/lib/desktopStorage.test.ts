import { describe, expect, it } from 'vitest';
import { createDesktopSharedStorage, supportsDesktopStoragePlatform } from './desktopStorage';
import type { LegacyStoragePort } from './sharedStorage';

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

describe('desktop storage IPC adapter', () => {
  it('enables only Windows/Linux desktop user agents', () => {
    expect(supportsDesktopStoragePlatform('Mozilla Windows NT 10.0', 'Win32')).toBe(true);
    expect(supportsDesktopStoragePlatform('Mozilla X11 Linux x86_64', 'Linux x86_64')).toBe(true);
    expect(supportsDesktopStoragePlatform('Mozilla Mac OS X', 'MacIntel')).toBe(false);
    expect(supportsDesktopStoragePlatform('Mozilla Linux Android 14', 'Linux armv8l')).toBe(false);
    expect(supportsDesktopStoragePlatform('Mozilla Chrome browser', '')).toBe(false);
  });
  it('maps read states and sends a locked missing-only import request', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const server = 'https://chat.example';
    const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === 'client_storage_read') return { state: 'missing' } as T;
      if (command === 'client_storage_import') return { state: 'value', value: server } as T;
      throw new Error(`unexpected IPC: ${command}`);
    };
    const storage = createDesktopSharedStorage(call, memoryLegacy({ 'disnans.server': server }));

    expect(await storage.getServer()).toBe(server);
    expect(calls.map((entry) => entry.command)).toEqual([
      'client_storage_read',
      'client_storage_import',
      'client_storage_read',
    ]);
    expect(calls[1].args).toEqual({ args: { key: { kind: 'server' }, value: server } });
  });

  it('treats a clean install with no shared or legacy server as a healthy unset state', async () => {
    const call = async <T>(command: string): Promise<T> => {
      if (command === 'client_storage_read' || command === 'client_storage_import') return { state: 'missing' } as T;
      throw new Error(`unexpected IPC: ${command}`);
    };
    const storage = createDesktopSharedStorage(call, memoryLegacy());

    expect(await storage.getServerWithStatus()).toEqual({ value: null, status: 'shared' });
  });

  it('preserves missing, string value, and explicit tombstone response states', async () => {
    const states = [
      { state: 'missing' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'value', value: 'draft' },
      { state: 'cleared' },
    ];
    let stateIndex = 0;
    const call = async <T>(): Promise<T> => states[stateIndex++] as T;
    const storage = createDesktopSharedStorage(call, memoryLegacy());

    expect(await storage.getDraft('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main')).toBeNull();
    // First missing read and no legacy import performs an authoritative import/readback pair.
    expect(await storage.getDraft('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main')).toBe('draft');
    expect(await storage.getDraft('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main')).toBeNull();
  });

  it('serializes null write as JSON null and rejects IPC errors', async () => {
    const sent: unknown[] = [];
    let failWrite = false;
    const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      sent.push({ command, args });
      if (command === 'client_storage_write' && failWrite) throw new Error('IPC unavailable');
      if (command === 'client_storage_write') return { state: 'cleared' } as T;
      if (command === 'client_storage_read') return { state: 'cleared' } as T;
      throw new Error('IPC unavailable');
    };
    const storage = createDesktopSharedStorage(call, memoryLegacy());

    await storage.setDraft('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main', null);
    expect(sent[0]).toEqual({
      command: 'client_storage_write',
      args: {
        args: {
          key: { kind: 'draft', serverUrl: 'https://chat.example', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', place: 'main' },
          value: null,
        },
      },
    });
    failWrite = true;
    await expect(storage.setDraft('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main', 'body')).rejects.toThrow('IPC unavailable');
  });
});
