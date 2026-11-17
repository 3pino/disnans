// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { lookupIcon, registerIcon } from './icons.svelte';

// 登録簿そのものの試験は共有の UI 部品（@3pino/ui-kit-web）にある。ここは、本体が決めたことだけを確かめる

describe('本体のアイコン', () => {
  it('ロゴ（disnans-logo）は、Lucide を読み込まずに引ける。プラグインは上書きできない', () => {
    const d = lookupIcon('disnans-logo');
    expect(d).not.toBe('pending');
    expect(d && d !== 'pending' && d.body).toContain('<path');
    expect(() => registerIcon('disnans-logo', '<path/>')).toThrow();
  });
});
