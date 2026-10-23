import { describe, expect, it } from 'vitest';
import {
  addNavItem,
  DEFAULT_NAV_ITEMS,
  DEFAULT_NAV_LABELS,
  NAV_CALL_ID,
  NAV_CHAT_ID,
  NAV_REQUIRED_IDS,
  NAV_SEARCH_ID,
  navItemRemovable,
  NAV_SETTINGS_ID,
  NAV_REMOVED_IDS,
  navItemLabel,
  removeNavItem,
  reorderNavItem,
  setNavLabel,
  visibleNavItems,
} from './navBar';

const ALL = new Set([NAV_CHAT_ID, NAV_SETTINGS_ID, 'dice:roll', 'app:next']);

describe('visibleNavItems', () => {
  it('登録されているものだけ、並びの順に出す', () => {
    const list = ['dice:gone', NAV_SETTINGS_ID, 'dice:roll', NAV_CHAT_ID];
    expect(visibleNavItems(list, ALL)).toEqual([NAV_SETTINGS_ID, 'dice:roll', NAV_CHAT_ID]);
  });

  it('本体の2つは登録より前でも出す（登録されるまで空にしない）', () => {
    expect(visibleNavItems(DEFAULT_NAV_ITEMS, new Set())).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('廃止した項目（スレッド）は、保存されていても出さない', () => {
    const list = [NAV_REMOVED_IDS[0], NAV_CHAT_ID, NAV_SETTINGS_ID];
    expect(visibleNavItems(list, ALL)).toEqual([NAV_CHAT_ID, NAV_SETTINGS_ID]);
  });
});

describe('追加・削除・並べ替え', () => {
  it('追加は末尾。もう入っていれば変えない', () => {
    expect(addNavItem(DEFAULT_NAV_ITEMS, 'dice:roll')).toEqual([...DEFAULT_NAV_ITEMS, 'dice:roll']);
    expect(addNavItem(DEFAULT_NAV_ITEMS, NAV_CHAT_ID)).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('削除できるのは必須以外。必須のチャット・設定は外せない', () => {
    expect(removeNavItem(DEFAULT_NAV_ITEMS, 'dice:roll')).toEqual([NAV_CHAT_ID, NAV_SETTINGS_ID]);
    expect(removeNavItem(DEFAULT_NAV_ITEMS, NAV_CHAT_ID)).toEqual(DEFAULT_NAV_ITEMS);
    expect(removeNavItem(DEFAULT_NAV_ITEMS, NAV_SETTINGS_ID)).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('表示の並びの指定した位置に動かす。登録されていない項目は位置を変えずに残す', () => {
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_SETTINGS_ID, 0)).toEqual([NAV_SETTINGS_ID, NAV_CHAT_ID]);
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_CHAT_ID, 1)).toEqual([NAV_SETTINGS_ID, NAV_CHAT_ID]);
    // 範囲外は端に収める
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_CHAT_ID, 99)).toEqual([NAV_SETTINGS_ID, NAV_CHAT_ID]);
    expect(reorderNavItem(DEFAULT_NAV_ITEMS, ALL, NAV_SETTINGS_ID, -5)).toEqual([NAV_SETTINGS_ID, NAV_CHAT_ID]);
    const list = ['dice:gone', NAV_CHAT_ID, 'dice:roll', NAV_SETTINGS_ID];
    expect(reorderNavItem(list, ALL, NAV_SETTINGS_ID, 0)).toEqual(['dice:gone', NAV_SETTINGS_ID, NAV_CHAT_ID, 'dice:roll']);
  });
});

describe('表示名', () => {
  it('既定の短い名前', () => {
    expect(DEFAULT_NAV_LABELS[NAV_CHAT_ID]).toBe('Chat');
    expect(NAV_REMOVED_IDS).toContain('app:open-threads');
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
});

describe('navItemRemovable（左スワイプ・× で外せるか）', () => {
  it('必須（チャット・設定）は外せず、ほかは外せる（removeNavItem と同じ条件）', () => {
    for (const id of NAV_REQUIRED_IDS) expect(navItemRemovable(id)).toBe(false);
    expect(navItemRemovable(NAV_SEARCH_ID)).toBe(true);
  });
});
