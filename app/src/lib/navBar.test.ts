import { describe, expect, it } from 'vitest';
import {
  addNavItem,
  DEFAULT_NAV_ITEMS,
  DEFAULT_NAV_LABELS,
  NAV_CALL_ID,
  NAV_CHAT_ID,
  NAV_SEARCH_ID,
  NAV_SETTINGS_ID,
  NAV_THREADS_ID,
  navItemLabel,
  normalizeNavItems,
  normalizeNavLabels,
  removeNavItem,
  reorderNavItem,
  setNavLabel,
  visibleNavItems,
} from './navBar';

const ALL = new Set([NAV_CHAT_ID, NAV_THREADS_ID, NAV_SETTINGS_ID, 'dice:roll', 'app:next']);

describe('normalizeNavItems', () => {
  it('配列でなければ既定の並び', () => {
    expect(normalizeNavItems(null)).toEqual(DEFAULT_NAV_ITEMS);
    expect(normalizeNavItems('x')).toEqual(DEFAULT_NAV_ITEMS);
    expect(normalizeNavItems({})).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('文字列でないもの・空・重複は捨てる。知らない ID は残す（入れ直したプラグインのため）', () => {
    expect(normalizeNavItems([1, '', 'dice:roll', 'dice:roll', NAV_CHAT_ID, NAV_SETTINGS_ID])).toEqual(['dice:roll', NAV_CHAT_ID, NAV_SETTINGS_ID]);
  });

  it('必須の項目（チャット・設定）がなければ末尾に足す', () => {
    expect(normalizeNavItems(['dice:roll'])).toEqual(['dice:roll', NAV_CHAT_ID, NAV_SETTINGS_ID]);
    expect(normalizeNavItems([NAV_THREADS_ID])).toEqual([NAV_THREADS_ID, NAV_CHAT_ID, NAV_SETTINGS_ID]);
  });
});

describe('visibleNavItems', () => {
  it('登録されているものだけ、並びの順に出す', () => {
    const list = ['dice:gone', NAV_SETTINGS_ID, 'dice:roll', NAV_CHAT_ID];
    expect(visibleNavItems(list, ALL, { withThreads: true })).toEqual([NAV_SETTINGS_ID, 'dice:roll', NAV_CHAT_ID]);
  });

  it('本体の3つは登録より前でも出す（登録されるまで空にしない）', () => {
    expect(visibleNavItems(DEFAULT_NAV_ITEMS, new Set(), { withThreads: true })).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('デスクトップ（withThreads が false）ではスレッドを出さない', () => {
    expect(visibleNavItems(DEFAULT_NAV_ITEMS, ALL, { withThreads: false })).toEqual([NAV_CHAT_ID, NAV_SETTINGS_ID]);
    expect(visibleNavItems(DEFAULT_NAV_ITEMS, ALL, { withThreads: true })).toEqual([NAV_CHAT_ID, NAV_THREADS_ID, NAV_SETTINGS_ID]);
  });
});

describe('追加・削除・並べ替え', () => {
  it('追加は末尾。もう入っていれば変えない', () => {
    expect(addNavItem(DEFAULT_NAV_ITEMS, 'dice:roll')).toEqual([...DEFAULT_NAV_ITEMS, 'dice:roll']);
    expect(addNavItem(DEFAULT_NAV_ITEMS, NAV_CHAT_ID)).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('削除できるのは必須以外。必須のチャット・設定は外せない', () => {
    expect(removeNavItem(DEFAULT_NAV_ITEMS, NAV_THREADS_ID)).toEqual([NAV_CHAT_ID, NAV_SETTINGS_ID]);
    expect(removeNavItem(DEFAULT_NAV_ITEMS, NAV_CHAT_ID)).toEqual(DEFAULT_NAV_ITEMS);
    expect(removeNavItem(DEFAULT_NAV_ITEMS, NAV_SETTINGS_ID)).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('表示の並びの指定した位置に動かす。登録されていない項目は位置を変えずに残す', () => {
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_SETTINGS_ID, 1)).toEqual([NAV_CHAT_ID, NAV_SETTINGS_ID, NAV_THREADS_ID]);
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_CHAT_ID, 2)).toEqual([NAV_THREADS_ID, NAV_SETTINGS_ID, NAV_CHAT_ID]);
    // 範囲外は端に収める
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_CHAT_ID, 99)).toEqual([NAV_THREADS_ID, NAV_SETTINGS_ID, NAV_CHAT_ID]);
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_SETTINGS_ID, -5)).toEqual([NAV_SETTINGS_ID, NAV_CHAT_ID, NAV_THREADS_ID]);
    const list = ['dice:gone', NAV_CHAT_ID, 'dice:roll', NAV_SETTINGS_ID];
    expect(reorderNavItem(list, ALL, NAV_SETTINGS_ID, 0)).toEqual(['dice:gone', NAV_SETTINGS_ID, NAV_CHAT_ID, 'dice:roll']);
  });
});

describe('表示名', () => {
  it('既定の短い名前', () => {
    expect(DEFAULT_NAV_LABELS[NAV_CHAT_ID]).toBe('Chat');
    expect(DEFAULT_NAV_LABELS[NAV_THREADS_ID]).toBe('Threads');
    expect(DEFAULT_NAV_LABELS[NAV_SETTINGS_ID]).toBe('Settings');
    expect(DEFAULT_NAV_LABELS[NAV_CALL_ID]).toBe('Call');
    expect(DEFAULT_NAV_LABELS[NAV_SEARCH_ID]).toBe('Search');
    expect(DEFAULT_NAV_LABELS['dice:roll']).toBeUndefined();
  });

  it('未設定 → 既定の短い名前（なければコマンド名）', () => {
    expect(navItemLabel(NAV_CHAT_ID, 'チャットを開く', {})).toBe('Chat');
    expect(navItemLabel(NAV_CALL_ID, '通話を開く', {})).toBe('Call');
    expect(navItemLabel(NAV_SEARCH_ID, 'メッセージを検索', {})).toBe('Search');
    expect(navItemLabel('dice:roll', 'サイコロ', {})).toBe('サイコロ');
  });

  it('設定済みで空欄 → コマンド名（既定があっても）', () => {
    expect(navItemLabel(NAV_CALL_ID, '通話を開く', { [NAV_CALL_ID]: '' })).toBe('通話を開く');
    expect(navItemLabel(NAV_CHAT_ID, 'チャットを開く', { [NAV_CHAT_ID]: '' })).toBe('チャットを開く');
  });

  it('設定済み → その名前（既定より優先）', () => {
    expect(navItemLabel(NAV_CHAT_ID, 'チャットを開く', { [NAV_CHAT_ID]: '会話' })).toBe('会話');
    expect(navItemLabel('dice:roll', 'サイコロ', { 'dice:roll': 'Dice' })).toBe('Dice');
  });

  it('コマンド名がわからないときは ID（未設定で既定もない）', () => {
    expect(navItemLabel('dice:gone', undefined, {})).toBe('dice:gone');
    expect(navItemLabel(NAV_CHAT_ID, undefined, {})).toBe('Chat');
  });

  it('setNavLabel は前後の空白を除き、空白だけなら空欄（""）として残す。ほかの項目は変えない', () => {
    const base = { [NAV_CALL_ID]: '通話' };
    expect(setNavLabel(base, NAV_CHAT_ID, '  会話 ')).toEqual({ [NAV_CALL_ID]: '通話', [NAV_CHAT_ID]: '会話' });
    expect(setNavLabel(base, NAV_CALL_ID, '   ')).toEqual({ [NAV_CALL_ID]: '' });
    expect(base).toEqual({ [NAV_CALL_ID]: '通話' });
  });

  it('normalizeNavLabels: オブジェクトでなければ空。文字列でない値は捨て、空欄は残す（未設定とは別）', () => {
    expect(normalizeNavLabels(null)).toEqual({});
    expect(normalizeNavLabels(['x'])).toEqual({});
    expect(normalizeNavLabels('x')).toEqual({});
    expect(normalizeNavLabels({ [NAV_CALL_ID]: '', [NAV_CHAT_ID]: 3, 'dice:roll': ' Dice ' })).toEqual({
      [NAV_CALL_ID]: '',
      'dice:roll': 'Dice',
    });
  });
});
