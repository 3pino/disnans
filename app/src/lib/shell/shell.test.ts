import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Shell } from './shell.svelte';

type Item = { src: string };

let shell: Shell<string, Item>;

beforeEach(() => {
  vi.useFakeTimers();
  shell = new Shell<string, Item>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Shell.toast', () => {
  it('出して id を返し、既定の 5 秒で消える', () => {
    const id = shell.toast('こんにちは', 'info', undefined, 5000, 'avatar');
    expect(shell.toasts).toEqual([{ id, text: 'こんにちは', kind: 'info', action: undefined, avatar: 'avatar' }]);
    vi.advanceTimersByTime(4999);
    expect(shell.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shell.toasts).toHaveLength(0);
  });

  it('ms が null なら、dismiss するまで消えない', () => {
    const id = shell.toast('進行中', 'info', undefined, null);
    vi.advanceTimersByTime(60_000);
    expect(shell.toasts.map((t) => t.id)).toEqual([id]);
    shell.dismiss(id);
    expect(shell.toasts).toHaveLength(0);
  });

  it('id は出すたびに増える（消えた後も同じ id を使わない）', () => {
    const a = shell.toast('a');
    const b = shell.toast('b', 'error');
    expect(b).toBe(a + 1);
    expect(shell.toasts[1].kind).toBe('error');
  });
});

describe('Shell.confirm', () => {
  it('ok を解決して、確認を閉じる', async () => {
    const p = shell.confirm({ title: '消しますか', okLabel: '消す', danger: true });
    expect(shell.confirmReq?.title).toBe('消しますか');
    shell.confirmReq?.resolve(true);
    await expect(p).resolves.toBe(true);
    expect(shell.confirmReq).toBeNull();
  });

  it('取り消しでも閉じる', async () => {
    const p = shell.confirm({ title: 'x', okLabel: 'ok' });
    shell.confirmReq?.resolve(false);
    await expect(p).resolves.toBe(false);
    expect(shell.confirmReq).toBeNull();
  });
});

describe('Shell.openLightbox', () => {
  it('1 枚だけ開くと、前後の一覧はない', () => {
    shell.openLightbox({ src: 'a' });
    expect(shell.lightbox).toEqual({ src: 'a' });
    expect(shell.lightboxGallery).toBeNull();
  });

  it('一覧を渡すと、その一覧を保つ', () => {
    const gallery = () => [{ src: 'a' }, { src: 'b' }];
    shell.openLightbox({ src: 'a' }, gallery);
    expect(shell.lightboxGallery).toBe(gallery);
  });
});

describe('Shell.back（戻る操作の順）', () => {
  it('画像 → プラグインの層（新しい順）→ nav の順に 1 つずつ戻る', () => {
    const nav = vi.fn(() => true);
    const older = vi.fn();
    const newer = vi.fn();
    shell.addPluginBack(older);
    shell.addPluginBack(newer);
    shell.openLightbox({ src: 'a' });

    expect(shell.backDepth(1)).toBe(4);
    expect(shell.back(nav)).toBe(true);
    expect(shell.lightbox).toBeNull();
    expect(nav).not.toHaveBeenCalled();

    expect(shell.back(nav)).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();

    expect(shell.back(nav)).toBe(true);
    expect(older).toHaveBeenCalledTimes(1);

    expect(shell.back(nav)).toBe(true);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it('プラグインの層は、呼んだときに外れる（外し忘れても空回りしない）', () => {
    shell.addPluginBack(() => {});
    expect(shell.back(() => false)).toBe(true);
    expect(shell.pluginBack).toHaveLength(0);
  });

  it('プラグインの戻る操作が例外を投げても、戻る操作は成功として扱い、外れている', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    shell.addPluginBack(() => {
      throw new Error('x');
    });
    expect(shell.back(() => false)).toBe(true);
    expect(err).toHaveBeenCalled();
    expect(shell.pluginBack).toHaveLength(0);
    err.mockRestore();
  });

  it('返り値の関数で外した層は、戻る操作から外れる（残りの順は保つ）', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = shell.addPluginBack(a);
    shell.addPluginBack(b);
    offA();
    expect(shell.back(() => false)).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('何もなければ nav の結果をそのまま返す（false なら戻る先なし）', () => {
    expect(shell.back(() => false)).toBe(false);
    expect(shell.backDepth(0)).toBe(0);
  });
});
