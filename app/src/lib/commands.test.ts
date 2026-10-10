// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  addHotkey,
  commandForKey,
  commandList,
  defaultHotkeys,
  effectiveHotkeys,
  effectiveSlash,
  filterCommands,
  findCommand,
  findHotkeyConflicts,
  hotkeyOverride,
  isHotkeyCustomized,
  normalizeHotkeys,
  registerCommand,
  removeHotkey,
  runCommand,
  setSlashAliasSource,
  type AppCommand,
} from './commands.svelte';
import { findSlashCommand, runSlashCommand } from './slashCommands.svelte';
import { formatHotkey, hotkeyFromEvent, hotkeyId } from './plugins/hotkey';

const cmd = (over: Partial<AppCommand> & { id: string }): AppCommand => ({ name: over.id, run: () => {}, ...over });
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('registry', () => {
  it('登録・同じ ID の上書き・解除', () => {
    const a = cmd({ id: 'test:a', name: 'A' });
    const b = cmd({ id: 'test:a', name: 'B' });
    const offA = registerCommand(a);
    expect(findCommand('test:a')).toBe(a);
    const offB = registerCommand(b);
    expect(findCommand('test:a')).toBe(b);
    expect(commandList().filter((c) => c.id === 'test:a')).toHaveLength(1);
    // 上書きされたものを解除しても、いまのものは残る
    offA();
    expect(findCommand('test:a')).toBe(b);
    offB();
    expect(findCommand('test:a')).toBeUndefined();
  });

  it('slash があればスラッシュコマンドにもなり、解除すると両方消える', async () => {
    const run = vi.fn();
    const off = registerCommand(cmd({ id: 'test:roll', name: 'サイコロ', slash: 'test-roll', args: '[n]', icon: 'dice-5', source: 'テスト', run }));
    const slash = findSlashCommand('test-roll')!;
    expect(slash).toMatchObject({ name: 'test-roll', description: 'サイコロ', args: '[n]', icon: 'dice-5', source: 'テスト' });
    await runSlashCommand('test-roll', '2d6', 't1');
    expect(run).toHaveBeenCalledWith({ args: '2d6', threadId: 't1', via: 'slash' });
    off();
    expect(findSlashCommand('test-roll')).toBeUndefined();
    expect(findCommand('test:roll')).toBeUndefined();
  });

  it('正しくないスラッシュコマンド名・空の ID は登録しない', () => {
    expect(() => registerCommand(cmd({ id: 'test:bad', slash: 'Bad Name' }))).toThrow();
    expect(findCommand('test:bad')).toBeUndefined();
    expect(() => registerCommand(cmd({ id: '' }))).toThrow();
  });

  it('runCommand は失敗を「名前: 理由」にする', async () => {
    const c = cmd({
      id: 'test:fail',
      name: '失敗する',
      run: () => {
        throw new Error('だめ');
      },
    });
    await expect(runCommand(c, { args: '', threadId: null, via: 'palette' })).rejects.toThrow('失敗する: だめ');
  });
});

describe('hotkeys', () => {
  const a = cmd({ id: 'app:a', defaultHotkey: 'Mod+Shift+D' });
  const b = cmd({ id: 'dice:b', defaultHotkey: 'Ctrl+Shift+D' });
  const c = cmd({ id: 'dice:c' });
  const d = cmd({ id: 'dice:d', defaultHotkey: 'J' });
  const multi = cmd({ id: 'app:multi', defaultHotkey: ['Mod+P', 'F2'] });

  it('設定があればそれ、なければ既定。空の一覧は「なし」', () => {
    expect(effectiveHotkeys(a, {})).toEqual(['Mod+Shift+D']);
    expect(effectiveHotkeys(a, { 'app:a': ['Mod+K'] })).toEqual(['Mod+K']);
    expect(effectiveHotkeys(a, { 'app:a': [] })).toEqual([]);
    expect(effectiveHotkeys(c, {})).toEqual([]);
    expect(effectiveHotkeys(multi, {})).toEqual(['Mod+P', 'F2']);
    expect(isHotkeyCustomized(a, {})).toBe(false);
    expect(isHotkeyCustomized(a, { 'app:a': ['Mod+Shift+D'] })).toBe(false);
    expect(isHotkeyCustomized(a, { 'app:a': [] })).toBe(true);
    expect(isHotkeyCustomized(c, { 'dice:c': ['Mod+K'] })).toBe(true);
    expect(defaultHotkeys(multi)).toEqual(['Mod+P', 'F2']);
  });

  it('複数のホットキーを足す・外す。同じキーは二重に入らない', () => {
    const list = addHotkey(effectiveHotkeys(a, {}), 'F5');
    expect(list).toEqual(['Mod+Shift+D', 'F5']);
    // 書き方が違っても同じキーなら足さない
    expect(addHotkey(list, 'shift+ctrl+d')).toBe(list);
    expect(removeHotkey(list, 'Mod+Shift+D')).toEqual(['F5']);
    expect(removeHotkey(['F5'], 'F5')).toEqual([]);
  });

  it('既定と同じなら設定を消す（null）。違えば一覧を保存する', () => {
    expect(hotkeyOverride(a, ['Mod+Shift+D'])).toBeNull();
    expect(hotkeyOverride(a, [])).toEqual([]);
    expect(hotkeyOverride(c, [])).toBeNull();
    expect(hotkeyOverride(multi, ['Mod+P'])).toEqual(['Mod+P']);
    expect(hotkeyOverride(multi, ['F2', 'Mod+P'])).toEqual(['F2', 'Mod+P']);
  });

  it('保存値の移行: 古い1つだけの文字列も読み、"" は「なし」。配列はそのまま', () => {
    expect(normalizeHotkeys({ 'app:a': 'Mod+K', 'dice:b': '', 'app:c': ['Mod+P', 'F2', 'F2', ''], bad: 1, 'app:d': 3 })).toEqual({
      'app:a': ['Mod+K'],
      'dice:b': [],
      'app:c': ['Mod+P', 'F2'],
    });
    expect(normalizeHotkeys(null)).toEqual({});
    expect(normalizeHotkeys([1])).toEqual({});
    // 古い形の設定も、いまの効き方のまま
    expect(effectiveHotkeys(a, normalizeHotkeys({ 'app:a': '' }))).toEqual([]);
    expect(effectiveHotkeys(a, normalizeHotkeys({ 'app:a': 'Mod+K' }))).toEqual(['Mod+K']);
  });

  it('同じキーのコマンドを見つける（書き方が違っても同じキーなら。複数のどれかが同じでも）', () => {
    const conflicts = findHotkeyConflicts([a, b, c, d], {}, false);
    expect(conflicts.get('app:a')).toEqual([b]);
    expect(conflicts.get('dice:b')).toEqual([a]);
    expect(conflicts.has('dice:c')).toBe(false);
    // macOS では Mod は Cmd なので、Ctrl とはぶつからない
    expect(findHotkeyConflicts([a, b], {}, true).size).toBe(0);
    // 設定で変えればぶつからない。3つ目が同じキーにすれば、それぞれ2つとぶつかる
    expect(findHotkeyConflicts([a, b], { 'dice:b': ['Mod+K'] }, false).size).toBe(0);
    const three = findHotkeyConflicts([a, b, c], { 'dice:c': ['shift+ctrl+d'] }, false);
    expect(three.get('dice:c')).toEqual([a, b]);
    // 外したものはぶつからない
    expect(findHotkeyConflicts([a, b], { 'app:a': [] }, false).size).toBe(0);
    // 二つ目のキーが同じでもぶつかる
    const xy = cmd({ id: 'x:y' });
    const second = findHotkeyConflicts([a, xy], { 'x:y': ['F9', 'Ctrl+Shift+D'] }, false);
    expect(second.get('x:y')).toEqual([a]);
    expect(second.get('app:a')).toEqual([xy]);
  });

  it('キー入力に合うコマンド。複数のどれでも効く。入力欄では修飾キーのないものは効かない', () => {
    const list = [a, b, c, d, multi];
    const ctrlShiftD = key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });
    // ぶつかっていたら先に登録したもの
    expect(commandForKey(list, {}, ctrlShiftD, { mac: false })).toBe(a);
    expect(commandForKey(list, { 'app:a': [] }, ctrlShiftD, { mac: false })).toBe(b);
    expect(commandForKey(list, { 'dice:c': ['Mod+K'] }, key({ key: 'k', code: 'KeyK', ctrlKey: true }), { mac: false })).toBe(c);
    const j = key({ key: 'j', code: 'KeyJ' });
    expect(commandForKey(list, {}, j, { mac: false })).toBe(d);
    expect(commandForKey(list, {}, j, { mac: false, typing: true })).toBeNull();
    expect(commandForKey(list, {}, ctrlShiftD, { mac: false, typing: true })).toBe(a);
    expect(commandForKey(list, {}, key({ key: 'x', code: 'KeyX' }), { mac: false })).toBeNull();
    // 既定の 2 つ目（F2）でも、1 つ目（Ctrl+P）でも開く
    expect(commandForKey(list, {}, key({ key: 'F2', code: 'F2' }), { mac: false, typing: true })).toBe(multi);
    expect(commandForKey(list, {}, key({ key: 'p', code: 'KeyP', ctrlKey: true }), { mac: false })).toBe(multi);
    // 追加したものでも効く
    const extra = { 'dice:c': ['F7'] };
    expect(commandForKey(list, extra, key({ key: 'F7', code: 'F7' }), { mac: false })).toBe(c);
  });
});

describe('スラッシュコマンドの別名', () => {
  it('別名があれば、その名前で登録される（元の名前は使えない）。解除すると元に戻る', async () => {
    let aliases: Record<string, string> = {};
    setSlashAliasSource(() => aliases);
    const run = vi.fn();
    const c = cmd({ id: 'test:alias', name: '別名のテスト', slash: 'alias-orig', run });
    expect(effectiveSlash(c)).toBe('alias-orig');
    const off = registerCommand(c);
    expect(findSlashCommand('alias-orig')).toBeDefined();
    // 設定で変えたら、その場で反映される
    aliases = { 'test:alias': 'alias-new' };
    expect(findSlashCommand('alias-orig')).toBeUndefined();
    expect(findSlashCommand('alias-new')).toBeDefined();
    await runSlashCommand('alias-new', 'x', null);
    expect(run).toHaveBeenCalledWith({ args: 'x', threadId: null, via: 'slash' });
    // 元に戻す
    aliases = {};
    expect(findSlashCommand('alias-orig')).toBeDefined();
    off();
    setSlashAliasSource(() => ({}));
  });

  it('別名は slash のないコマンドには付かない。検索にも別名を使う', () => {
    setSlashAliasSource(() => ({ 'test:none': 'zz', 'test:named': 'nyan' }));
    expect(effectiveSlash(cmd({ id: 'test:none' }))).toBeUndefined();
    expect(effectiveSlash(cmd({ id: 'test:named', slash: 'neko' }))).toBe('nyan');
    expect(filterCommands([cmd({ id: 'test:named', name: 'なにか', slash: 'neko' })], '/nyan').map((x) => x.id)).toEqual(['test:named']);
    setSlashAliasSource(() => ({}));
  });
});

describe('hotkey の記録と表示', () => {
  it('押したキーを Mod 形式にする（修飾キーだけなら null）', () => {
    expect(hotkeyFromEvent(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+D');
    expect(hotkeyFromEvent(key({ key: 'd', code: 'KeyD', metaKey: true }), true)).toBe('Mod+D');
    expect(hotkeyFromEvent(key({ key: 'd', code: 'KeyD', ctrlKey: true }), true)).toBe('Ctrl+D');
    expect(hotkeyFromEvent(key({ key: '!', code: 'Digit1', shiftKey: true, altKey: true }), false)).toBe('Alt+Shift+1');
    expect(hotkeyFromEvent(key({ key: ',', code: 'Comma', ctrlKey: true }), false)).toBe('Mod+,');
    expect(hotkeyFromEvent(key({ key: ' ', code: 'Space', ctrlKey: true }), false)).toBe('Mod+Space');
    expect(hotkeyFromEvent(key({ key: 'F5', code: 'F5' }), false)).toBe('F5');
    expect(hotkeyFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), false)).toBeNull();
    expect(hotkeyFromEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false)).toBeNull();
    // 記録したものは読めて、同じキーとして比べられる
    expect(hotkeyId('Mod+Shift+D', false)).toBe(hotkeyId('shift+ctrl+d', false));
    expect(hotkeyId('Mod+Space', false)).toBe('ctrl+ ');
    expect(hotkeyId('Mod+Plus', false)).toBe('ctrl++');
  });

  it('表示用の文字列', () => {
    expect(formatHotkey('Mod+Shift+D', false)).toBe('Ctrl+Shift+D');
    expect(formatHotkey('Mod+Shift+D', true)).toBe('⇧⌘D');
    expect(formatHotkey('Mod+,', false)).toBe('Ctrl+,');
    expect(formatHotkey('Alt+ArrowUp', false)).toBe('Alt+↑');
    expect(formatHotkey('f5', false)).toBe('F5');
    expect(formatHotkey('Foo+X', false)).toBe('Foo+X');
  });
});

describe('filterCommands', () => {
  const list = [
    cmd({ id: 'dice:roll', name: 'サイコロを用意する', slash: 'dice', source: 'ダイス' }),
    cmd({ id: 'app:open-settings', name: '設定を開く' }),
    cmd({ id: 'app:open-chat', name: 'チャットを開く' }),
    cmd({ id: 'app:focus-input', name: '入力欄にフォーカス' }),
  ];
  const names = (q: string) => filterCommands(list, q).map((c) => c.id);

  it('空なら本体のもの → プラグインのもの、それぞれ名前順', () => {
    expect(names('').slice(0, 3).sort()).toEqual(['app:focus-input', 'app:open-chat', 'app:open-settings']);
    expect(names('').at(-1)).toBe('dice:roll');
  });

  it('前方一致 → 部分一致 → あいまい一致。スラッシュコマンド名・出どころも見る', () => {
    expect(names('設定')).toEqual(['app:open-settings']);
    expect(names('開く')).toEqual(['app:open-chat', 'app:open-settings']);
    expect(names('dice')).toEqual(['dice:roll']);
    expect(names('/dic')).toEqual(['dice:roll']);
    expect(names('ダイス')).toEqual(['dice:roll']);
    // カタカナはひらがなでも引ける
    expect(names('さいころ')).toEqual(['dice:roll']);
    // 文字が順に出てくれば合う
    expect(names('サイ用')).toEqual(['dice:roll']);
    // 空白で区切ると、すべての語を含むもの
    expect(names('チャット 開')).toEqual(['app:open-chat']);
    expect(names('zzz')).toEqual([]);
  });
});
