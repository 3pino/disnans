import { getItem, setItem } from './storage';

// 打ちかけの文章（下書き）。メインチャットとスレッドごと、ユーザーごとに localStorage へ残す。
// 画面やスレッドを切り替えても、アプリを再起動しても残る。送信したら消す

const PREFIX = 'disnans.draft.';

/** 下書きの置き場所の名前。メインチャットは main、スレッドは thread:<スレッド ID> */
export function draftPlace(threadId: string | null): string {
  return threadId === null ? 'main' : `thread:${threadId}`;
}

/** 下書きを保存するキー（ユーザーごと・場所ごと） */
export function draftKey(userId: string, threadId: string | null): string {
  return `${PREFIX}${userId}.${draftPlace(threadId)}`;
}

export type DraftStore = { get(key: string): string | null; set(key: string, value: string | null): void };

const localStore: DraftStore = {
  get: (key) => getItem(key),
  set: (key, value) => setItem(key, value),
};

/** 保存してある下書き（なければ空文字） */
export function loadDraft(key: string, store: DraftStore = localStore): string {
  return store.get(key) ?? '';
}

/** 下書きを保存する。空（空白だけ）になったら消す */
export function saveDraft(key: string, body: string, store: DraftStore = localStore): void {
  store.set(key, body.trim() === '' ? null : body);
}
