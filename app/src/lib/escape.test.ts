import { describe, expect, it } from 'vitest';
import { escapeClosesPanel } from './escape';

// Esc の順番: 上に開いているもの（メニュー・ダイアログ・拡大・候補）が先。何も無いときだけパネルを閉じる
describe('escapeClosesPanel', () => {
  it('何も開いていなければ閉じる', () => {
    expect(escapeClosesPanel({ defaultPrevented: false, overlayOpen: false })).toBe(true);
  });
  it('上に開いているもの（メニュー・ダイアログなど）があれば、閉じない（それが先に閉じる）', () => {
    expect(escapeClosesPanel({ defaultPrevented: false, overlayOpen: true })).toBe(false);
  });
  it('入力欄の候補などが Esc を使ったら（既に処理済み）、閉じない', () => {
    expect(escapeClosesPanel({ defaultPrevented: true, overlayOpen: false })).toBe(false);
  });
});
