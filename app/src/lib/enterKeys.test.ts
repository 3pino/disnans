// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTER_KEYS,
  type EnterKeyPrefs,
  enterComboLabel,
  enterComboOf,
  insertNewline,
  insertsNewlineByDefault,
  sendCombos,
} from './enterKeys';

const ev = (over: Partial<KeyboardEventInit> = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });

describe('enterComboOf', () => {
  it('修飾キーが1つまでなら、その組み合わせ', () => {
    expect(enterComboOf(ev())).toBe('enter');
    expect(enterComboOf(ev({ shiftKey: true }))).toBe('shift');
    expect(enterComboOf(ev({ ctrlKey: true }))).toBe('ctrl');
    // Meta（Windows キーなど）は Ctrl とはみなさない
    expect(enterComboOf(ev({ metaKey: true }))).toBe('enter');
    expect(enterComboOf(ev({ altKey: true }))).toBe('alt');
  });

  it('Enter でない・修飾キーが2つ以上なら null', () => {
    expect(enterComboOf(ev({ key: 'a' }))).toBeNull();
    expect(enterComboOf(ev({ ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('既定の挠動作（MessageInput は enterComboOf と prefs.enterKeys で決める）', () => {
  it('既定は Enter・Shift+Enter が改行、Ctrl+Enter・Alt+Enter が送信', () => {
    expect(DEFAULT_ENTER_KEYS.enter).toBe('newline');
    expect(DEFAULT_ENTER_KEYS.shift).toBe('newline');
    expect(DEFAULT_ENTER_KEYS.ctrl).toBe('send');
    expect(DEFAULT_ENTER_KEYS.alt).toBe('send');
    expect(enterComboOf(ev({ altKey: true, shiftKey: true }))).toBeNull();
  });

  it('設定の送信の組み合わせを出す', () => {
    const prefs: EnterKeyPrefs = { enter: 'newline', shift: 'none', ctrl: 'send', alt: 'newline' };
    expect(sendCombos(prefs)).toEqual(['ctrl']);
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
    expect(enterComboLabel('ctrl')).toBe('Ctrl+Enter');
    expect(enterComboLabel('shift')).toBe('Shift+Enter');
  });
});
