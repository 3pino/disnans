// @vitest-environment jsdom
// 設定の「通話」の画面共有の行: FPS・画質・色数（次に共有を始めたときから）と、プレビュー（押したときだけ撮り、今の設定で符号化して見せる）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareSettings from './ScreenShareSettings.svelte';
import type { ScreenSettingsPort, ScreenSettingsValue, ScreenSnapshot } from '../lib/call/screen/types';

const preview = vi.hoisted(() => ({ load: vi.fn(), canvases: 0 }));
vi.mock('../lib/call/screen/preview', async (orig) => {
  const real = await orig<typeof import('../lib/call/screen/preview')>();
  return {
    ...real,
    loadSnapshotCanvas: preview.load,
    // jsdom は canvas の描画を持たない。符号化の結果だけ作る偽物（形式ごとの長さは画質で変える）
    newCanvas: () => {
      preview.canvases++;
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {} }),
        toDataURL: (type: string, quality = 1) => `data:${type};base64,/9j/${'QUJD'.repeat(Math.round(quality * 1000))}`,
      };
    },
  };
});

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

function port(init: Partial<ScreenSettingsValue> = {}) {
  // 変えるたびに新しい値の物を作る（本物の設定と同じ。同じ物だと画面は変わったと気づかない）
  let current: ScreenSettingsValue = { fps: 5, quality: 'p720', color: 'full', ...init };
  const listeners = new Set<() => void>();
  const patch = vi.fn((p: Partial<ScreenSettingsValue>) => {
    current = { ...current, ...p };
    for (const fn of listeners) fn();
  });
  const sp: ScreenSettingsPort & { patch: typeof patch } = {
    get value() {
      return current;
    },
    patch,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return sp;
}
function render(props: object): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ScreenShareSettings as unknown as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  flushSync();
  return target;
}
const segment = (el: HTMLElement, group: string, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] button`)].find((b) => b.textContent?.trim() === text);
const takeButton = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => /プレビュー|撮り直す/.test(b.textContent ?? ''))!;

const SNAP: ScreenSnapshot = { dataUrl: 'data:image/jpeg;base64,QUJD', width: 1920, height: 1080, source: 'screen' };
const LOADED = { canvas: {} as HTMLCanvasElement, width: 1920, height: 1080 };

afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  preview.load.mockReset();
  preview.canvases = 0;
});

describe('画面共有の設定', () => {
  it('FPS・画質・色数の選択は、設定へ渡す（数の値は数に戻す）', () => {
    const p = port();
    const el = render({ settings: p, snapshot: null });
    segment(el, '画面共有のフレームレート', '20 fps')!.click();
    expect(p.patch).toHaveBeenLastCalledWith({ fps: 20 });
    segment(el, '画面共有の画質', '1080p')!.click();
    expect(p.patch).toHaveBeenLastCalledWith({ quality: 'p1080' });
    segment(el, '画面共有の色数', '256 色')!.click();
    expect(p.patch).toHaveBeenLastCalledWith({ color: 'c256' });
  });

  it('今の値を選んだままのときは、設定へ渡さない', () => {
    const p = port();
    const el = render({ settings: p, snapshot: null });
    segment(el, '画面共有のフレームレート', '5 fps')!.click();
    expect(p.patch).not.toHaveBeenCalled();
  });
});

describe('プレビュー', () => {
  it('開いただけでは撮らない。押したら撮って、今の設定で符号化した見本と大きさ・帯域を出す', async () => {
    const snapshot = vi.fn(async () => SNAP);
    preview.load.mockResolvedValue(LOADED);
    const el = render({ settings: port(), snapshot });
    expect(snapshot).not.toHaveBeenCalled();
    takeButton(el).click();
    await vi.waitFor(() => expect(el.querySelector('figure img')).not.toBeNull());
    expect(snapshot).toHaveBeenCalledOnce();
    expect(el.querySelector<HTMLImageElement>('figure img')!.src).toContain('data:image/jpeg;base64,');
    const text = el.querySelector('figcaption')!.textContent ?? '';
    expect(text).toContain('1280×720');
    expect(text).toMatch(/1 枚 約 .+ KB・動き続けると約 .+\/秒/);
  });

  it('設定を変えると、撮ってある 1 枚を符号化し直す（撮り直さない）。画質で大きさが変わり、FPS で帯域が変わる', async () => {
    const snapshot = vi.fn(async () => SNAP);
    preview.load.mockResolvedValue(LOADED);
    const p = port();
    const el = render({ settings: p, snapshot });
    takeButton(el).click();
    await vi.waitFor(() => expect(el.querySelector('figcaption')).not.toBeNull());
    const first = el.querySelector('figcaption')!.textContent ?? '';
    segment(el, '画面共有の画質', '480p')!.click();
    flushSync();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(preview.load).toHaveBeenCalledOnce();
    const low = el.querySelector('figcaption')!.textContent ?? '';
    expect(low).toContain('854×480');
    expect(low).not.toBe(first);
    const fpsBefore = low.split('動き続けると約')[1];
    segment(el, '画面共有のフレームレート', '20 fps')!.click();
    flushSync();
    expect(el.querySelector('figcaption')!.textContent).not.toBe(low);
    expect(el.querySelector('figcaption')!.textContent!.split('動き続けると約')[1]).not.toBe(fpsBefore);
  });

  it('撮れないときは理由だけ出す（例外の中身は出さない）。snapshot が無い環境ではプレビューの行を出さない', async () => {
    const snapshot = vi.fn(async () => {
      throw new Error('secret detail');
    });
    const el = render({ settings: port(), snapshot });
    takeButton(el).click();
    await vi.waitFor(() => expect(el.textContent).toContain('この環境では画面のプレビューを撮れません'));
    expect(el.textContent).not.toContain('secret detail');
    instance = undefined;
    target?.remove();
    const none = render({ settings: port(), snapshot: null });
    expect([...none.querySelectorAll('button')].some((b) => /プレビュー/.test(b.textContent ?? ''))).toBe(false);
  });

  it('画像を読み込んでいるあいだに閉じたら、読み終えても符号化しない', async () => {
    let finishLoad: (v: typeof LOADED) => void = () => {};
    preview.load.mockImplementation(() => new Promise((r) => (finishLoad = r)));
    const el = render({ settings: port(), snapshot: vi.fn(async () => SNAP) });
    takeButton(el).click();
    await vi.waitFor(() => expect(preview.load).toHaveBeenCalled());
    await unmount(instance!);
    instance = undefined;
    target?.remove();
    finishLoad(LOADED);
    await Promise.resolve();
    expect(preview.canvases).toBe(0);
  });

  it('撮っているあいだに閉じたら、遅れて届いた画像は表示も符号化もしない', async () => {
    let finish: (v: ScreenSnapshot) => void = () => {};
    const snapshot = vi.fn(() => new Promise<ScreenSnapshot>((r) => (finish = r)));
    const el = render({ settings: port(), snapshot });
    takeButton(el).click();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    await unmount(instance!);
    instance = undefined;
    target?.remove();
    finish(SNAP);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.load).not.toHaveBeenCalled();
    expect(preview.canvases).toBe(0);
  });
});

describe('設定の見た目の構成（見出し・共通の一文・説明なし・短い名前）', () => {
  it('「画面共有」の見出しの下に、共通の一文を一つだけ置き、行ごとの説明は出さない', () => {
    const el = render({ settings: port(), snapshot: null });
    const h2 = el.querySelector('h2');
    expect(h2?.textContent).toBe('画面共有');
    expect(el.querySelectorAll('.screen-share-settings-note')).toHaveLength(1);
    expect(el.querySelector('.screen-share-settings-note')!.textContent).toBe('次に共有を始めたときから使われます');
    expect(el.querySelector('.setting-row-description')).toBeNull();
  });
  it('行の名前は短い名前（画面共有の接頭辞なし）', () => {
    const el = render({ settings: port(), snapshot: vi.fn() });
    const names = [...el.querySelectorAll('.setting-row-name')].map((n) => n.textContent);
    expect(names).toEqual(['フレームレート', '画質', '色数', 'プレビュー']);
  });
  it('選択の読み上げの名前は、画面共有の名前のまま', () => {
    const el = render({ settings: port(), snapshot: null });
    expect(el.querySelector('[role="radiogroup"][aria-label="画面共有の色数"]')).not.toBeNull();
  });
});
