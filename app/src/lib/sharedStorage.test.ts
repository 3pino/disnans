import { describe, expect, it } from 'vitest';
import {
  createSharedStorage,
  type LegacyStoragePort,
  type SharedFilePort,
  type SharedKey,
} from './sharedStorage';

function legacyStore(seed: Record<string, string> = {}): LegacyStoragePort & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
}

function fileStore(): SharedFilePort & {
  values: Map<string, string | null>;
  failRead: boolean;
  failWrite: boolean;
  onImport?: (key: SharedKey) => void;
} {
  const values = new Map<string, string | null>();
  const id = (key: SharedKey) => JSON.stringify(key);
  return {
    values,
    failRead: false,
    failWrite: false,
    read(key) {
      if (this.failRead) throw new Error('read failed');
      return Promise.resolve(values.has(id(key)) ? values.get(id(key))! : undefined);
    },
    write(key, value) {
      if (this.failWrite) throw new Error('write failed');
      values.set(id(key), value);
      return Promise.resolve();
    },
    importIfMissing(key, value) {
      this.onImport?.(key);
      // Models the core contract: test and optional write are atomic under its lock.
      if (!values.has(id(key)) && value !== undefined) values.set(id(key), value);
      return Promise.resolve(values.has(id(key)) ? values.get(id(key))! : undefined);
    },
  };
}

const SERVER_KEY = 'disnans.server';
const OLD_DRAFT = 'disnans.draft.u1.main';
const SERVER = 'http://example.test:8080';

describe('createSharedStorage', () => {
  it('browser/Android fallback stays on localStorage and never calls files', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'old draft' });
    const files = fileStore();
    let imported = false;
    files.onImport = () => (imported = true);
    const shared = createSharedStorage({ enabled: false, files, legacy });

    expect(await shared.getServer()).toBe(SERVER);
    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('old draft');
    expect(await shared.setDraft(SERVER, 'u1', 'main', 'new draft')).toEqual({ status: 'legacy-fallback' });
    expect(legacy.values.get(OLD_DRAFT)).toBe('new draft');
    expect(imported).toBe(false);
  });

  it('imports server and an unambiguously-associated legacy draft, verifies, then clears draft legacy value', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'local draft' });
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getServer()).toBe(SERVER);
    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('local draft');
    expect(legacy.values.has(OLD_DRAFT)).toBe(false);
    expect(files.values.get(JSON.stringify({ kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' }))).toBe('local draft');
  });

  it('existing file value takes precedence over localStorage', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'stale' });
    const files = fileStore();
    const key: SharedKey = { kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' };
    files.values.set(JSON.stringify(key), 'from CLI');
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('from CLI');
    expect(legacy.values.get(OLD_DRAFT)).toBe('stale');
  });

  it('explicit file tombstone wins over legacy value and is not resurrected', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'must not return' });
    const files = fileStore();
    const key: SharedKey = { kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' };
    files.values.set(JSON.stringify(key), null);
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBeNull();
    expect(legacy.values.get(OLD_DRAFT)).toBe('must not return');
  });

  it('a concurrent file save that wins import-if-missing is returned, never overwritten by legacy', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'legacy' });
    const files = fileStore();
    const key: SharedKey = { kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' };
    files.onImport = () => files.values.set(JSON.stringify(key), 'newer CLI save');
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('newer CLI save');
    expect(files.values.get(JSON.stringify(key))).toBe('newer CLI save');
    expect(legacy.values.get(OLD_DRAFT)).toBe('legacy');
  });

  it('never imports a legacy draft for a different server', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: 'http://old.test:8080', [OLD_DRAFT]: 'old server draft' });
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBeNull();
    expect(files.values.size).toBe(0);
    expect(legacy.values.get(OLD_DRAFT)).toBe('old server draft');
  });

  it('canonicalizes an existing server value before returning it to the GUI', async () => {
    const files = fileStore();
    files.values.set(JSON.stringify({ kind: 'server' }), 'HTTP://HOST:80/');
    const shared = createSharedStorage({ enabled: true, files, legacy: legacyStore() });

    expect(await shared.getServer()).toBe('http://host');
  });

  it('canonicalizes legacy server provenance and desktop server writes', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: 'HTTP://HOST:80/', [OLD_DRAFT]: 'from canonical host' });
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getServer()).toBe('http://host');
    expect(await shared.getDraft('http://host', 'u1', 'main')).toBe('from canonical host');
    expect(await shared.setServer('HTTP://HOST:80/')).toEqual({ status: 'shared' });
    expect(files.values.get(JSON.stringify({ kind: 'server' }))).toBe('http://host');
  });

  it('legacy draft provenance is captured before the active server changes', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: 'http://old.test:8080', [OLD_DRAFT]: 'belongs to old' });
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy });
    expect(await shared.setServer(SERVER)).toEqual({ status: 'shared' });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBeNull();
    expect(await shared.getDraft('http://old.test:8080', 'u1', 'main')).toBe('belongs to old');
  });

  it('keeps an invalid legacy server as a visible fallback while passing its original text to core validation', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: 'ftp://legacy.example' });
    const files = fileStore();
    const imports: Array<{ key: SharedKey; value: string | null | undefined }> = [];
    files.importIfMissing = async (key, value) => {
      imports.push({ key, value });
      throw new Error('invalid stored URL');
    };
    const shared = createSharedStorage({ enabled: true, files, legacy });

    const result = await shared.getServerWithStatus();
    expect(result).toEqual({ value: 'http://ftp//legacy.example', status: 'legacy-fallback' });
    expect(imports).toEqual([{ key: { kind: 'server' }, value: 'ftp://legacy.example' }]);
  });

  it('reports server reads that fell back to localStorage', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER });
    const files = fileStore();
    files.failRead = true;
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getServerWithStatus()).toEqual({ value: SERVER, status: 'legacy-fallback' });
  });

  it('retains legacy data and falls back if file import/readback fails', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'safe copy' });
    const files = fileStore();
    files.failRead = true;
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('safe copy');
    expect(legacy.values.get(OLD_DRAFT)).toBe('safe copy');
  });

  it('does not change legacy server provenance when a desktop server write falls back', async () => {
    const oldServer = 'http://old.test:8080';
    const legacy = legacyStore({ [SERVER_KEY]: oldServer, [OLD_DRAFT]: 'belongs to old server' });
    const files = fileStore();
    files.failWrite = true;
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.setServer(SERVER)).toEqual({ status: 'legacy-fallback' });
    expect(legacy.values.get(SERVER_KEY)).toBe(oldServer);
    const afterRestart = createSharedStorage({ enabled: true, files: fileStore(), legacy });
    expect(await afterRestart.getDraft(oldServer, 'u1', 'main')).toBe('belongs to old server');
    expect(await afterRestart.getDraft(SERVER, 'u1', 'main')).toBeNull();
  });

  it('does not clear legacy data after write/readback failure', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'backup' });
    const files = fileStore();
    files.failWrite = true;
    const shared = createSharedStorage({ enabled: true, files, legacy });
    expect(await shared.setDraft(SERVER, 'u1', 'main', 'new')).toEqual({ status: 'legacy-fallback' });
    expect(legacy.values.get(OLD_DRAFT)).toBe('new');
  });

  it('does not overwrite a later external save when write readback differs', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER, [OLD_DRAFT]: 'legacy backup' });
    const files = fileStore();
    const key: SharedKey = { kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' };
    const originalRead = files.read.bind(files);
    files.read = async (k) => {
      const value = await originalRead(k);
      if (k.kind === 'draft' && value === 'mine') files.values.set(JSON.stringify(key), 'later external save');
      return k.kind === 'draft' ? originalRead(k) : value;
    };
    const shared = createSharedStorage({ enabled: true, files, legacy });
    expect(await shared.setDraft(SERVER, 'u1', 'main', 'mine')).toEqual({ status: 'superseded', value: 'later external save' });

    expect(files.values.get(JSON.stringify(key))).toBe('later external save');
    expect(legacy.values.get(OLD_DRAFT)).toBe('legacy backup');
  });

  it('does not write a failed save to an ambiguous legacy draft key for another server', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: 'http://old.test:8080', [OLD_DRAFT]: 'old server draft' });
    const files = fileStore();
    files.failWrite = true;
    const shared = createSharedStorage({ enabled: true, files, legacy });

    await expect(shared.setDraft(SERVER, 'u1', 'main', 'new server draft')).rejects.toThrow('write failed');
    expect(legacy.values.get(OLD_DRAFT)).toBe('old server draft');
  });

  it('serializes same-key saves so the later call wins', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER });
    const files = fileStore();
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => (releaseFirst = resolve));
    const write = files.write.bind(files);
    let first = true;
    files.write = async (key, value) => {
      if (first) {
        first = false;
        await firstWrite;
      }
      await write(key, value);
    };
    const shared = createSharedStorage({ enabled: true, files, legacy });

    const firstSave = shared.setDraft(SERVER, 'u1', 'main', 'first');
    const secondSave = shared.setDraft(SERVER, 'u1', 'main', 'second');
    releaseFirst();
    expect(await Promise.all([firstSave, secondSave])).toEqual([{ status: 'shared' }, { status: 'shared' }]);
    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('second');
  });

  it('keeps distinct server/user/place drafts isolated', async () => {
    const shared = createSharedStorage({ enabled: true, files: fileStore(), legacy: legacyStore() });
    await shared.setDraft(SERVER, 'u1', 'main', 'main');
    await shared.setDraft(SERVER, 'u1', 'thread:t1', 'thread');
    await shared.setDraft('http://other.test', 'u1', 'main', 'other server');
    await shared.setDraft(SERVER, 'u2', 'main', 'other user');

    expect(await shared.getDraft(SERVER, 'u1', 'main')).toBe('main');
    expect(await shared.getDraft(SERVER, 'u1', 'thread:t1')).toBe('thread');
    expect(await shared.getDraft('http://other.test', 'u1', 'main')).toBe('other server');
    expect(await shared.getDraft(SERVER, 'u2', 'main')).toBe('other user');
  });

  it('canonicalizes hosts, default ports, IDNs, and base paths before shared writes', async () => {
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy: legacyStore() });

    expect(await shared.setServer('https://Bücher.Example:443/Base Path/')).toEqual({ status: 'shared' });
    expect(files.values.get(JSON.stringify({ kind: 'server' }))).toBe('https://xn--bcher-kva.example/Base%20Path');
  });

  it('normalizes server writes and stores empty URLs as tombstones', async () => {
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy: legacyStore() });
    const serverKey = JSON.stringify({ kind: 'server' });

    expect(await shared.setServer(' homeserver:8080/ ')).toEqual({ status: 'shared' });
    expect(files.values.get(serverKey)).toBe('http://homeserver:8080');
    expect(await shared.setServer('  ')).toEqual({ status: 'shared' });
    expect(files.values.get(serverKey)).toBeNull();
  });

  it('stores whitespace-only draft as an explicit tombstone', async () => {
    const files = fileStore();
    const shared = createSharedStorage({ enabled: true, files, legacy: legacyStore() });
    const key: SharedKey = { kind: 'draft', serverUrl: SERVER, userId: 'u1', place: 'main' };

    expect(await shared.setDraft(SERVER, 'u1', 'main', '  \n ')).toEqual({ status: 'shared' });
    expect(files.values.get(JSON.stringify(key))).toBeNull();
  });

  it('keeps server tombstone from reviving the old local endpoint', async () => {
    const legacy = legacyStore({ [SERVER_KEY]: SERVER });
    const files = fileStore();
    files.values.set(JSON.stringify({ kind: 'server' }), null);
    const shared = createSharedStorage({ enabled: true, files, legacy });

    expect(await shared.getServer()).toBeNull();
    expect(legacy.values.get(SERVER_KEY)).toBe(SERVER);
  });
});
