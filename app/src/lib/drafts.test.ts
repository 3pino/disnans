import { describe, expect, it } from 'vitest';
import { draftKey, draftPlace, loadDraft, saveDraft, type DraftStore } from './drafts';

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      if (v === null) map.delete(k);
      else map.set(k, v);
    },
  };
}

describe('下書きのキー', () => {
  it('メインチャットとスレッドで別のキーになり、ユーザーごとに分かれる', () => {
    expect(draftPlace(null)).toBe('main');
    expect(draftPlace('t1')).toBe('thread:t1');
    expect(draftKey('u1', null)).not.toBe(draftKey('u1', 't1'));
    expect(draftKey('u1', 't1')).not.toBe(draftKey('u2', 't1'));
    expect(draftKey('u1', 't1')).toBe(draftKey('u1', 't1'));
  });
});

describe('下書きの保存と読み込み', () => {
  it('保存した文章を読み直せる（場所を切り替えても別々に残る）', () => {
    const s = memoryStore();
    const main = draftKey('u1', null);
    const thread = draftKey('u1', 'a');
    saveDraft(main, 'メインの文\n二行目', s);
    saveDraft(thread, 'スレッドの文', s);
    expect(loadDraft(main, s)).toBe('メインの文\n二行目');
    expect(loadDraft(thread, s)).toBe('スレッドの文');
  });

  it('保存していなければ空文字', () => {
    expect(loadDraft(draftKey('u1', null), memoryStore())).toBe('');
  });

  it('空や空白だけになったら消す（送信したあとも同じ）', () => {
    const s = memoryStore();
    const key = draftKey('u1', null);
    saveDraft(key, 'あ', s);
    saveDraft(key, '  \n ', s);
    expect(s.map.has(key)).toBe(false);
    expect(loadDraft(key, s)).toBe('');
  });

  it('空白を含む文章はそのまま残す（先頭の空白も消さない）', () => {
    const s = memoryStore();
    saveDraft('k', '  x  ', s);
    expect(loadDraft('k', s)).toBe('  x  ');
  });
});
