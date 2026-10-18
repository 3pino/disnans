import { describe, expect, it } from 'vitest';
import { DEVICE_DEFAULTS, LEGACY, legacyDeviceValues, legacyUserValues, normalizeDevicePrefs, normalizeTheme } from './settingsModel';

/** 手元の localStorage の代わり */
function store(entries: Record<string, string>) {
  return (key: string) => (key in entries ? entries[key] : null);
}

describe('legacyUserValues（以前の localStorage からユーザーごとの値）', () => {
  it('テーマ・選んだテーマ・ナビの項目と表示名を読む', () => {
    const v = legacyUserValues(
      store({
        [LEGACY.theme]: 'dark',
        [LEGACY.customTheme]: 'midnight',
        [LEGACY.navBarItems]: JSON.stringify(['app:open-settings', 'chat', 'settings']),
        [LEGACY.navBarLabels]: JSON.stringify({ chat: 'ホーム', x: 3 }),
      }),
    );
    expect(v.theme).toBe('dark');
    expect(v.customTheme).toBe('midnight');
    expect(v.navBarItems).toEqual(expect.arrayContaining(['chat', 'settings']));
    expect(v.navBarLabels).toEqual({ chat: 'ホーム' });
  });

  it('何も無ければ空（既定はサーバーの側に任せる）', () => {
    expect(legacyUserValues(store({}))).toEqual({});
  });

  it('知らないテーマは入れない', () => {
    expect(legacyUserValues(store({ [LEGACY.theme]: 'pink' }))).toEqual({});
  });

  it('通話の値は、ユーザーごとのものだけ（範囲に収める）', () => {
    const v = legacyUserValues(store({ [LEGACY.call]: JSON.stringify({ joinMuted: true, micVolume: 9, limitDb: -100, inputId: 'mic1', output: null }) }));
    expect(v).toEqual({ joinMuted: true, micVolume: 2, limitDb: -18 });
    expect(v).not.toHaveProperty('inputId');
  });

  it('通話の旧い保存先（voice）は、新しいものが無いときだけ引き継ぐ', () => {
    const old = store({ [LEGACY.callVoice]: JSON.stringify({ limiter: false }) });
    expect(legacyUserValues(old)).toEqual({ limiter: false });
    const both = store({ [LEGACY.call]: JSON.stringify({ limiter: true }), [LEGACY.callVoice]: JSON.stringify({ limiter: false }) });
    expect(legacyUserValues(both)).toEqual({ limiter: true });
  });
});

describe('legacyDeviceValues（以前の localStorage から端末ごとの値）', () => {
  it('ナビバーを隠す（"1" を真偽値に）・向き・端末の種類・プラグイン', () => {
    const v = legacyDeviceValues(
      store({
        [LEGACY.hideNavigationBar]: '1',
        [LEGACY.orientation]: 'media',
        [LEGACY.deviceKind]: 'tablet',
        [LEGACY.pluginsDisabled]: JSON.stringify(['dice', 3]),
        [LEGACY.pluginsDevDir]: '  /home/me/plugins ',
      }),
    );
    expect(v).toEqual({
      hideNavigationBar: true,
      orientation: 'media',
      deviceKind: 'tablet',
      pluginsDisabled: ['dice'],
      pluginsDevDir: '/home/me/plugins',
    });
  });

  it('"1" 以外は偽、知らない値は入れない', () => {
    const v = legacyDeviceValues(store({ [LEGACY.hideNavigationBar]: '0', [LEGACY.deviceKind]: 'phone' }));
    expect(v).toEqual({ hideNavigationBar: false });
  });

  it('通話の機器（入力・出力）は端末ごと', () => {
    const v = legacyDeviceValues(store({ [LEGACY.call]: JSON.stringify({ inputId: 'mic1', output: { id: 'o', kind: 'speaker', label: 'S' } }) }));
    expect(v).toEqual({ inputId: 'mic1', output: { id: 'o', kind: 'speaker', label: 'S' } });
  });
});

describe('normalizeDevicePrefs', () => {
  it('足りないものは既定、型の合わないものは既定に戻す。知らない項目は残す', () => {
    const n = normalizeDevicePrefs({ hideNavigationBar: 'yes', orientation: 'sideways', deviceKind: 'phone', pluginsDisabled: 'x', extra: 1 });
    expect(n).toEqual({ ...DEVICE_DEFAULTS, extra: 1 });
  });

  it('オブジェクトでなければ既定', () => {
    expect(normalizeDevicePrefs(null)).toEqual({ ...DEVICE_DEFAULTS });
    expect(normalizeDevicePrefs('x')).toEqual({ ...DEVICE_DEFAULTS });
  });

  it('正しい値はそのまま', () => {
    const n = normalizeDevicePrefs({ deviceKind: 'laptop', orientation: 'portrait', pluginsDisabled: ['a'], pluginsDevDir: '/x', output: { id: 'o' }, inputId: 'm' });
    expect(n).toMatchObject({ deviceKind: 'laptop', orientation: 'portrait', pluginsDisabled: ['a'], pluginsDevDir: '/x', output: { id: 'o' }, inputId: 'm' });
  });
});

describe('normalizeTheme', () => {
  it('system・light・dark だけ通す', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('blue')).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');
  });
});
