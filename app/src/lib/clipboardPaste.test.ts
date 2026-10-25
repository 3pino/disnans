import { describe, expect, it } from 'vitest';
import { clipboardTextName, peekClipboard } from './clipboardPaste';

describe('共有フォルダへの貼り付けのクリップボード', () => {
  it('貼り付けた文字のファイル名は、日時つきの .txt', () => {
    expect(clipboardTextName(new Date(2026, 9, 5, 7, 3, 9))).toBe('clipboard-20261005-070309.txt');
  });

  it('クリップボードの API が無ければ、何も無いとみなす（貼り付けを押せないまま）', async () => {
    expect(await peekClipboard()).toEqual({ text: false, image: false });
  });
});
