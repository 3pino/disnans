// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTER_KEYS,
  enterComboLabel,
  enterComboOf,
  insertNewline,
  insertsNewlineByDefault,
  normalizeEnterKeys,
  resolveEnterAction,
  sendCombos,
} from './enterKeys';

const ev = (over: Partial<KeyboardEventInit> = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });

describe('enterComboOf', () => {
  it('修飾キーが1つまでなら、その組み合わせ', () => {
    expect(enterComboOf(ev())).toBe('enter');
    expect(enterComboOf(ev({ shiftKey: true }))).toBe('shift');
    expect(enterComboOf(ev({ ctrlKey: true }))).toBe('ctrl');
    // Cmd も Ctrl と同じ
    expect(enterComboOf(ev({ metaKey: true }))).toBe('ctrl');
    expect(enterComboOf(ev({ altKey: true }))).toBe('alt');
  });

  it('Enter でない・修飾キーが2つ以上なら null', () => {
    expect(enterComboOf(ev({ key: 'a' }))).toBeNull();
    expect(enterComboOf(ev({ ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(enterComboOf(ev({ ctrlKey: true, metaKey: true }))).toBeNull();
  });
});

describe('resolveEnterAction', () => {
  it('既定は Enter・Shift+Enter が改行、Ctrl+Enter・Alt+Enter が送信', () => {
    expect(resolveEnterAction(ev(), DEFAULT_ENTER_KEYS)).toBe('newline');
    expect(resolveEnterAction(ev({ shiftKey: true }), DEFAULT_ENTER_KEYS)).toBe('newline');
    expect(resolveEnterAction(ev({ ctrlKey: true }), DEFAULT_ENTER_KEYS)).toBe('send');
    expect(resolveEnterAction(ev({ altKey: true }), DEFAULT_ENTER_KEYS)).toBe('send');
    expect(resolveEnterAction(ev({ altKey: true, shiftKey: true }), DEFAULT_ENTER_KEYS)).toBeNull();
  });

  it('設定に従う', () => {
    const prefs = normalizeEnterKeys({ enter: 'newline', shift: 'none', ctrl: 'send', alt: 'newline' });
    expect(resolveEnterAction(ev(), prefs)).toBe('newline');
    expect(resolveEnterAction(ev({ shiftKey: true }), prefs)).toBe('none');
    expect(resolveEnterAction(ev({ metaKey: true }), prefs)).toBe('send');
    expect(resolveEnterAction(ev({ altKey: true }), prefs)).toBe('newline');
    expect(sendCombos(prefs)).toEqual(['ctrl']);
  });
});

describe('normalizeEnterKeys', () => {
  it('読めない項目は既定', () => {
    expect(normalizeEnterKeys(null)).toEqual(DEFAULT_ENTER_KEYS);
    expect(normalizeEnterKeys('x')).toEqual(DEFAULT_ENTER_KEYS);
    expect(normalizeEnterKeys({ enter: 'newline', shift: 'explode', ctrl: 1 })).toEqual({ ...DEFAULT_ENTER_KEYS, enter: 'newline' });
    // 送信に使うキーがなくてもよい（送信ボタンがある）
    expect(sendCombos(normalizeEnterKeys({ enter: 'none', ctrl: 'none', alt: 'none' }))).toEqual([]);
  });
});

describe('改行', () => {
  it('Enter と Shift+Enter はブラウザーに任せ、ほかは自分で入れる', () => {
    expect(insertsNewlineByDefault('enter')).toBe(true);
    expect(insertsNewlineByDefault('shift')).toBe(true);
    expect(insertsNewlineByDefault('ctrl')).toBe(false);
    expect(insertsNewlineByDefault('alt')).toBe(false);
  });

  it('insertNewline はキャレットの位置に改行を入れ、input イベントを起こす', () => {
    const ta = document.createElement('textarea');
    document.body.append(ta);
    ta.value = 'abcd';
    ta.setSelectionRange(2, 3);
    let inputs = 0;
    ta.addEventListener('input', () => inputs++);
    insertNewline(ta);
    expect(ta.value).toBe('ab\nd');
    expect(ta.selectionStart).toBe(3);
    expect(inputs).toBe(1);
    ta.remove();
  });

  it('表示用の名前', () => {
    expect(enterComboLabel('ctrl', false)).toBe('Ctrl+Enter');
    expect(enterComboLabel('ctrl', true)).toBe('⌘+Enter');
    expect(enterComboLabel('shift', false)).toBe('Shift+Enter');
  });
});
