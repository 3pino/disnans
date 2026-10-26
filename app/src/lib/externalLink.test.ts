// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { externalLinkHref } from './externalLink';

function clickOn(el: Element, prevented = false) {
  return { target: el, defaultPrevented: prevented };
}

describe('Tauri で別のアプリで開くリンク', () => {
  const a = document.createElement('a');
  a.href = 'http://100.64.0.1:8080/api/shared/a.pdf';
  const inner = document.createElement('span');
  a.appendChild(inner);

  it('ほかのオリジンの http(s) のリンク（中の要素を押しても）は開く', () => {
    expect(externalLinkHref(clickOn(inner), 'tauri://localhost')).toBe('http://100.64.0.1:8080/api/shared/a.pdf');
  });

  it('押した場所の処理が既定の動作を止めたものは開かない（名前の書き換え・選び直し）', () => {
    expect(externalLinkHref(clickOn(inner, true), 'tauri://localhost')).toBeNull();
  });

  it('同じオリジン・リンクの外は開かない', () => {
    expect(externalLinkHref(clickOn(inner), 'http://100.64.0.1:8080')).toBeNull();
    expect(externalLinkHref(clickOn(document.body), 'tauri://localhost')).toBeNull();
  });
});
