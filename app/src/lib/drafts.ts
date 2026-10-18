import { getItem, setItem } from './storage';
import type { SaveResult, SharedStorage } from './sharedStorage';

// 打ちかけの文章（下書き）。メインチャットのぶんを、ユーザーごとに localStorage へ残す。
// 画面を切り替えても、アプリを再起動しても残る。送信したら消す

const PREFIX = 'disnans.draft.';

/** 下書きの置き場所の名前（メインチャットは main。保存の形は従来どおり） */
export const DRAFT_PLACE = 'main';

/** 下書きを保存するキー（ユーザーごと） */
export function draftKey(userId: string): string {
  return `${PREFIX}${userId}.${DRAFT_PLACE}`;
}

/** Desktop shared-file draft identity plus the legacy key used by browser/Android. */
export type DraftLocation = {
  serverUrl: string;
  userId: string;
  place: string;
  legacyKey: string;
};

export function draftLocation(serverUrl: string, userId: string): DraftLocation {
  return { serverUrl, userId, place: DRAFT_PLACE, legacyKey: draftKey(userId) };
}

export type DraftStore = { get(key: string): string | null; set(key: string, value: string | null): void };

const localStore: DraftStore = {
  get: (key) => getItem(key),
  set: (key, value) => setItem(key, value),
};

// Keep a failed desktop save available when the composer is switched/unmounted in this session.
const pendingSharedDrafts = new Map<string, { version: number; value: string | null }>();
const latestSharedDrafts = new Map<string, { version: number; value: string | null }>();
let draftSaveVersion = 0;
const inFlightDraftSaves = new Set<Promise<SaveResult>>();
const unresolvedSharedDrafts = new Set<string>();
const draftFlushers = new Set<() => Promise<void>>();

function sharedDraftIdentity(location: DraftLocation): string {
  return JSON.stringify([location.serverUrl, location.userId, location.place]);
}

/** 保存してある下書き（なければ空文字） */
export function loadDraft(key: string, store: DraftStore = localStore): string {
  return store.get(key) ?? '';
}

/** 下書きを保存する。空（空白だけ）になったら消す */
export function saveDraft(key: string, body: string, store: DraftStore = localStore): void {
  store.set(key, body.trim() === '' ? null : body);
}

/** Awaitable loader; a desktop read can migrate legacy content before returning. */
export async function loadDraftAt(location: DraftLocation, shared?: SharedStorage): Promise<string> {
  if (!shared) return loadDraft(location.legacyKey);
  const id = sharedDraftIdentity(location);
  const readVersion = latestSharedDrafts.get(id)?.version ?? 0;
  const pending = pendingSharedDrafts.get(id);
  if (pending) return pending.value ?? '';
  const result = shared.getDraftWithStatus
    ? await shared.getDraftWithStatus(location.serverUrl, location.userId, location.place)
    : { value: await shared.getDraft(location.serverUrl, location.userId, location.place), status: 'shared' as const };
  // A save can start and finish during the async read; its newer body/tombstone
  // wins even after the pending entry has been removed by successful persistence.
  const latest = latestSharedDrafts.get(id);
  if (latest && latest.version !== readVersion) return latest.value ?? '';
  if (result.status === 'legacy-fallback' && result.value === null) {
    throw new Error('共有下書きを読み込めず、復元できるデバイス内の下書きもありません');
  }
  return result.value ?? '';
}

/** Shared saves expose their persistence result; local browser saves retain their old API. */
export async function saveDraftAt(
  location: DraftLocation,
  body: string,
  shared?: SharedStorage,
): Promise<SaveResult | { status: 'local' }> {
  if (!shared) {
    saveDraft(location.legacyKey, body);
    return { status: 'local' };
  }

  const id = sharedDraftIdentity(location);
  const entry = { version: ++draftSaveVersion, value: body.trim() === '' ? null : body };
  latestSharedDrafts.set(id, entry);
  pendingSharedDrafts.set(id, entry);
  // Defer the port call one microtask so the pending value/in-flight promise are registered
  // even if a mock or future implementation throws synchronously.
  const write = Promise.resolve().then(() => shared.setDraft(location.serverUrl, location.userId, location.place, body));
  inFlightDraftSaves.add(write);
  try {
    const result = await write;
    if (pendingSharedDrafts.get(id)?.version === entry.version) {
      if (result.status === 'shared') {
        unresolvedSharedDrafts.delete(id);
        pendingSharedDrafts.delete(id);
      } else {
        unresolvedSharedDrafts.add(id);
      }
    }
    return result;
  } catch (error) {
    if (pendingSharedDrafts.get(id)?.version === entry.version) unresolvedSharedDrafts.add(id);
    throw error;
  } finally {
    inFlightDraftSaves.delete(write);
  }
}

/** Register the active Composer's raw editor body so reload cannot outrun a pending input event. */
export function registerDraftFlusher(flush: () => Promise<void>): () => void {
  draftFlushers.add(flush);
  return () => draftFlushers.delete(flush);
}

/** Wait until active editor bodies and all autosaves have reached shared storage. */
export async function flushDraftSaves(): Promise<void> {
  const flushResults = await Promise.allSettled([...draftFlushers].map((flush) => flush()));
  while (inFlightDraftSaves.size > 0) {
    await Promise.allSettled([...inFlightDraftSaves]);
  }
  // Judge each key's latest autosave outcome; an earlier failed attempt may have been retried.
  if (flushResults.some((result) => result.status === 'rejected') || unresolvedSharedDrafts.size > 0) {
    throw new Error('A draft was not saved to shared storage');
  }
}
