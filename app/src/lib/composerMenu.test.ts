// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  addComposerMenuCommand,
  composerMenuItems,
  normalizeComposerMenu,
  removeComposerMenuEntry,
  reorderComposerMenuEntry,
  setComposerMenuHidden,
  type ComposerMenuEntry,
  type ComposerMenuPrefs,
} from './composerMenu';

const file: ComposerMenuEntry = { id: 'builtin:file', kind: 'builtin', label: 'ファイルを添付' };
const dice: ComposerMenuEntry = { id: 'action:plugin:dice:roll', kind: 'action', label: 'サイコロ', source: 'Dice' };
const poll: ComposerMenuEntry = { id: 'action:plugin:poll:new', kind: 'action', label: '投票' };
const cmdA: ComposerMenuEntry = { id: 'cmd:app:open-settings', kind: 'command', label: '設定を開く' };
const cmdB: ComposerMenuEntry = { id: 'cmd:dice:quick-roll', kind: 'command', label: '素早く振る', source: 'Dice' };
const available = [file, dice, poll, cmdA, cmdB];
const none: ComposerMenuPrefs = { order: [], hidden: [] };
const ids = (xs: { entry: ComposerMenuEntry }[]) => xs.map((x) => x.entry.id);

describe('normalizeComposerMenu', () => {
  it('読めないものは空の設定', () => {
    expect(normalizeComposerMenu(undefined)).toEqual(none);
    expect(normalizeComposerMenu(null)).toEqual(none);
    expect(normalizeComposerMenu('x')).toEqual(none);
    expect(normalizeComposerMenu([1, 2])).toEqual(none);
    expect(normalizeComposerMenu({ order: 'builtin:file', hidden: 3 })).toEqual(none);
  });

  it('文字列でないものと空・重複を捨て、知らない id は残す', () => {
    expect(
      normalizeComposerMenu({ order: ['cmd:x', 1, null, '', 'cmd:x', 'action:gone'], hidden: ['builtin:file', {}, 'builtin:file'] }),
    ).toEqual({ order: ['cmd:x', 'action:gone'], hidden: ['builtin:file'] });
  });
});

describe('composerMenuItems', () => {
  it('設定がなければ、本体・登録された操作の順で、コマンドは出さない（既定の動作）', () => {
    expect(ids(composerMenuItems(available, none))).toEqual(['builtin:file', 'action:plugin:dice:roll', 'action:plugin:poll:new']);
  });

  it('出さない項目は外れ、includeHidden なら hidden 付きで残る', () => {
    const prefs = { order: [], hidden: ['action:plugin:dice:roll'] };
    expect(ids(composerMenuItems(available, prefs))).toEqual(['builtin:file', 'action:plugin:poll:new']);
    const all = composerMenuItems(available, prefs, { includeHidden: true });
    expect(all.find((x) => x.entry.id === 'action:plugin:dice:roll')?.hidden).toBe(true);
    expect(all.find((x) => x.entry.id === 'builtin:file')?.hidden).toBe(false);
  });

  it('並び順は設定の順が先、残りは既定の順で後ろ', () => {
    const prefs = { order: ['action:plugin:poll:new', 'builtin:file'], hidden: [] };
    expect(ids(composerMenuItems(available, prefs))).toEqual(['action:plugin:poll:new', 'builtin:file', 'action:plugin:dice:roll']);
  });

  it('コマンドは並び順に入っているものだけ出る', () => {
    const prefs = { order: ['cmd:dice:quick-roll'], hidden: [] };
    expect(ids(composerMenuItems(available, prefs))).toEqual(['cmd:dice:quick-roll', 'builtin:file', 'action:plugin:dice:roll', 'action:plugin:poll:new']);
  });

  it('利用できない id（削除したプラグインなど）は無視する', () => {
    const prefs = { order: ['action:plugin:gone:x', 'cmd:gone'], hidden: ['action:plugin:gone:x'] };
    expect(ids(composerMenuItems(available, prefs))).toEqual(['builtin:file', 'action:plugin:dice:roll', 'action:plugin:poll:new']);
    expect(composerMenuItems(available, prefs, { includeHidden: true })).toHaveLength(3);
  });

  it('同じ id が2つあれば、先のものだけ使う', () => {
    const dup = { ...dice, label: '別のサイコロ' };
    const items = composerMenuItems([file, dice, dup], none);
    expect(items.map((x) => x.entry.label)).toEqual(['ファイルを添付', 'サイコロ']);
  });
});

describe('composer menu edits', () => {
  it('表示の並びの指定した位置に動かす。範囲外は端に収める', () => {
    const next = reorderComposerMenuEntry(none, available, 'action:plugin:dice:roll', 2);
    expect(ids(composerMenuItems(available, next))).toEqual(['builtin:file', 'action:plugin:poll:new', 'action:plugin:dice:roll']);
    const first = reorderComposerMenuEntry(none, available, 'action:plugin:poll:new', -5);
    expect(ids(composerMenuItems(available, first))[0]).toBe('action:plugin:poll:new');
    const last = reorderComposerMenuEntry(none, available, 'builtin:file', 99);
    expect(ids(composerMenuItems(available, last)).at(-1)).toBe('builtin:file');
  });

  it('同じ位置なら同じ設定を返す。知らない id も同じ設定', () => {
    expect(reorderComposerMenuEntry(none, available, 'builtin:file', 0)).toBe(none);
    expect(reorderComposerMenuEntry(none, available, 'action:gone', 1)).toBe(none);
  });

  it('動かすと、知らない id は後ろに残る', () => {
    const prefs = { order: ['action:plugin:gone:x'], hidden: [] };
    const next = reorderComposerMenuEntry(prefs, available, 'builtin:file', 1);
    expect(next.order).toEqual(['action:plugin:dice:roll', 'builtin:file', 'action:plugin:poll:new', 'action:plugin:gone:x']);
  });

  it('出さない項目も並びの中で数える（隠れた項目を飛び越えて動く）', () => {
    const prefs = { order: [], hidden: ['action:plugin:dice:roll'] };
    const next = reorderComposerMenuEntry(prefs, available, 'builtin:file', 1);
    expect(ids(composerMenuItems(available, next, { includeHidden: true })).slice(0, 2)).toEqual(['action:plugin:dice:roll', 'builtin:file']);
    expect(next.hidden).toEqual(['action:plugin:dice:roll']);
  });

  it('出す・出さないを切り替える', () => {
    const hidden = setComposerMenuHidden(none, 'builtin:file', true);
    expect(hidden.hidden).toEqual(['builtin:file']);
    expect(setComposerMenuHidden(hidden, 'builtin:file', false).hidden).toEqual([]);
  });

  it('コマンドを足す（出す状態・末尾）と、外す', () => {
    const hidden = setComposerMenuHidden(none, 'cmd:dice:quick-roll', true);
    const added = addComposerMenuCommand(hidden, available, 'cmd:dice:quick-roll');
    expect(added.hidden).toEqual([]);
    expect(ids(composerMenuItems(available, added))).toEqual(['builtin:file', 'action:plugin:dice:roll', 'action:plugin:poll:new', 'cmd:dice:quick-roll']);
    const removed = removeComposerMenuEntry(added, 'cmd:dice:quick-roll');
    expect(ids(composerMenuItems(available, removed))).toEqual(['builtin:file', 'action:plugin:dice:roll', 'action:plugin:poll:new']);
  });
});

describe('コマンドを「＋」メニューに追加する（再発防止）', () => {
  it('設定が空でも、追加したコマンドは「＋」の表示（出す項目だけの一覧）に出る', () => {
    // 設定の画面で「コマンドを追加」→ 選んだ結果が、実際の「＋」メニューに出ること
    const next = addComposerMenuCommand(none, available, 'cmd:app:open-settings');
    const shown = composerMenuItems(available, next).map((x) => x.entry.id);
    expect(shown).toContain('cmd:app:open-settings');
    expect(shown.at(-1)).toBe('cmd:app:open-settings');
  });

  it('追加しても、既存の並びと知らない id（入れ直したプラグインなど）は保たれる', () => {
    const prefs = { order: ['action:plugin:poll:new', 'action:plugin:gone:x'], hidden: [] };
    const next = addComposerMenuCommand(prefs, available, 'cmd:dice:quick-roll');
    expect(next.order.slice(0, 3)).toEqual(['action:plugin:poll:new', 'builtin:file', 'action:plugin:dice:roll']);
    expect(next.order).toContain('cmd:dice:quick-roll');
    expect(next.order).toContain('action:plugin:gone:x');
    expect(ids(composerMenuItems(available, next))).toContain('cmd:dice:quick-roll');
  });

  it('追加の結果は保存しても読み直せる（JSON の往復で同じ並びになる）', () => {
    const added = addComposerMenuCommand(none, available, 'cmd:app:open-settings');
    const reloaded = normalizeComposerMenu(JSON.parse(JSON.stringify(added)));
    expect(ids(composerMenuItems(available, reloaded))).toEqual(ids(composerMenuItems(available, added)));
  });
});
