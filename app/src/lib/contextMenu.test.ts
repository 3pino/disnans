// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldBlockContextMenu, startContextMenuGuard } from './contextMenu';

function el(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap.firstElementChild!;
}

describe('shouldBlockContextMenu', () => {
  it('入力欄の中では既定のメニューを残す', () => {
    expect(shouldBlockContextMenu(el('<input value="a">'))).toBe(false);
    expect(shouldBlockContextMenu(el('<textarea></textarea>'))).toBe(false);
    expect(shouldBlockContextMenu(el('<div contenteditable="true"><span>x</span></div>'))).toBe(false);
    expect(shouldBlockContextMenu(el('<div contenteditable><span>x</span></div>'))).toBe(false);
  });

  it('それ以外（本文・画像・contenteditable="false"）は止める', () => {
    expect(shouldBlockContextMenu(el('<p>本文</p>'))).toBe(true);
    expect(shouldBlockContextMenu(el('<img alt="">'))).toBe(true);
    expect(shouldBlockContextMenu(el('<div contenteditable="false">x</div>'))).toBe(true);
    expect(shouldBlockContextMenu(document)).toBe(true);
  });
});

describe('startContextMenuGuard', () => {
  it('document で既定の動作を止め、入力欄では止めない。外すと止めない', () => {
    const stop = startContextMenuGuard();
    const p = el('<p>本文</p>');
    const input = el('<input>');

    const onP = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    p.dispatchEvent(onP);
    expect(onP.defaultPrevented).toBe(true);

    const onInput = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(onInput);
    expect(onInput.defaultPrevented).toBe(false);

    stop();
    const after = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    p.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('アプリ自身の contextmenu の処理は、そのまま動く', () => {
    const stop = startContextMenuGuard();
    const node = el('<button>参加者</button>');
    let called = false;
    node.addEventListener('contextmenu', (e) => {
      called = true;
      e.preventDefault();
    });
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(called).toBe(true);
    stop();
  });
});
