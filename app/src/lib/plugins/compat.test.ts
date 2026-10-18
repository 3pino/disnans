import { describe, expect, it } from 'vitest';
import { API_CHANGES, apiWarnings, targetApiVersion } from './compat';
import { API_VERSION } from './types';

describe('API_CHANGES', () => {
  it('版の順に並び、本体の版を超えない', () => {
    const versions = API_CHANGES.map((c) => c.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(Math.max(...versions)).toBeLessThanOrEqual(API_VERSION);
  });

  it('13 はスレッド、14 はエラーの形', () => {
    expect(API_CHANGES.find((c) => c.version === 13)?.text).toContain('スレッド');
    expect(API_CHANGES.find((c) => c.version === 14)?.text).toContain('PluginError');
  });
});

describe('targetApiVersion', () => {
  it('apiVersion があればそれ、なければ minApiVersion', () => {
    expect(targetApiVersion({ minApiVersion: 12, apiVersion: 14 })).toBe(14);
    expect(targetApiVersion({ minApiVersion: 12 })).toBe(12);
  });
});

describe('apiWarnings', () => {
  it('対象の版より新しい削除があれば、例の文を返す', () => {
    expect(apiWarnings({ minApiVersion: 12 }, 13)).toEqual(['このプラグインは v12 向けです。v13 でスレッドの API が削除されました']);
  });

  it('複数あれば、版の順に続けて書く', () => {
    const w = apiWarnings({ minApiVersion: 12 }, 14);
    expect(w).toHaveLength(1);
    expect(w[0]).toBe(
      'このプラグインは v12 向けです。v13 でスレッドの API が削除されました。v14 でエラーの形が変わりました（disnans.PluginError と code）',
    );
  });

  it('対象の版が本体と同じか新しければ、警告はない', () => {
    expect(apiWarnings({ minApiVersion: 1, apiVersion: 14 }, 14)).toEqual([]);
    expect(apiWarnings({ minApiVersion: 14 }, 14)).toEqual([]);
  });

  it('本体の版より新しい変更は含めない（本体が知らないもの）', () => {
    expect(apiWarnings({ minApiVersion: 12 }, 13, [{ version: 13, text: 'A' }, { version: 14, text: 'B' }])).toEqual([
      'このプラグインは v12 向けです。v13 でA',
    ]);
  });

  it('apiVersion で対象を明示すると、その版より新しいものだけ', () => {
    expect(apiWarnings({ minApiVersion: 1, apiVersion: 13 }, 14)).toEqual(['このプラグインは v13 向けです。v14 でエラーの形が変わりました（disnans.PluginError と code）']);
  });
});
