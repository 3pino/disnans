// @vitest-environment jsdom
// examples/screenshare をそのまま読み込んで、純粋な関数（分割・組み立て・調整）とプラグインの動きを確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { createUi } from './ui';
import { setLucideForTest } from '../icons.svelte';
import { API_VERSION, type HostServices, type PluginClass } from './types';
import { PluginError, VersionConflictError } from './errors';
import { toCaptureError, toSnapshotError } from './nativeScreen';

type Mod = typeof import('../../../../examples/screenshare/main.js');
const load = () => import('../../../../examples/screenshare/main.js') as Promise<Mod & { default: PluginClass }>;

/** 通話の画面の領域に出ている、自分の映像（舞台の箱の中）と、その右上のカメラ切り替え */
const selfVideo = (s: { panel: { el: HTMLElement } }) => s.panel.el.querySelector<HTMLVideoElement>('.screenshare-img video');
const switchEl = (s: { panel: { el: HTMLElement } }) => s.panel.el.querySelector<HTMLButtonElement>('.screenshare-switch');

// main.js は読み込み時に disnans.Plugin と ui を覚える。call はプラグインの onload で読むので、テストごとに差し替える
(globalThis as unknown as { disnans: Partial<Disnans.Host> }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({
    toast: (text, kind) => hooks.toast(text, kind),
    confirm: async () => true,
    onBack: (run) => hooks.onBack(run),
    setImmersive: (on) => hooks.setImmersive(on),
  }),
  PluginError,
  VersionConflictError,
};

// ui.onBack / ui.setImmersive の差し替え（main.js は読み込み時の ui を使うので、ここを書き換える）
const hooks = {
  toast: (_text: string, _kind?: 'info' | 'error'): void => {},
  onBack: (_run: () => void): (() => void) => () => {},
  setImmersive: async (_on: boolean): Promise<boolean> => false,
};

// ---- 純粋な関数 ----

describe('フレームの分割と組み立て', () => {
  it('分割して順不同に渡しても、元の文字列に戻る', async () => {
    const { splitFrame, FrameAssembler } = await load();
    const b64 = 'ABCDEFGHIJ'.repeat(25);
    const chunks = splitFrame(7, b64, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.d.length <= 100 && c.f === 7 && c.n === 3)).toBe(true);
    const a = new FrameAssembler();
    expect(a.push(chunks[2])).toBeNull();
    expect(a.push(chunks[0])).toBeNull();
    expect(a.push(chunks[0])).toBeNull(); // 重複は無視
    expect(a.push(chunks[1])).toBe(b64);
  });

  it('既定の分割は 1 回の payload を 64 KB に収める', async () => {
    const { splitFrame, CHUNK_CHARS } = await load();
    const chunks = splitFrame(1, 'x'.repeat(CHUNK_CHARS * 2 + 5));
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(64 * 1024);
  });

  it('欠けたフレームは、新しいフレームが来たら捨てる', async () => {
    const { splitFrame, FrameAssembler } = await load();
    const a = new FrameAssembler();
    const old = splitFrame(1, 'a'.repeat(250), 100);
    a.push(old[0]);
    a.push(old[1]); // 2 番目が欠けたまま
    const next = splitFrame(2, 'b'.repeat(150), 100);
    expect(a.push(next[0])).toBeNull();
    expect(a.push(old[2])).toBeNull(); // 古いかけらは無視
    expect(a.push(next[1])).toBe('b'.repeat(150));
    // 完成済みの番号のかけらは無視する
    expect(a.push(next[0])).toBeNull();
  });

  it('parseChunk は不正な形を弾く', async () => {
    const { parseChunk } = await load();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 'AA' })).toEqual({ f: 1, i: 0, n: 1, d: 'AA' });
    expect(parseChunk(null)).toBeNull();
    expect(parseChunk({ f: 1, i: 1, n: 1, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1000, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1.5, i: 0, n: 1, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 5 })).toBeNull();
  });
});

describe('間隔・画質の調整', () => {
  it('fitSize は長辺を収め、拡大しない', async () => {
    const { fitSize } = await load();
    expect(fitSize(2560, 1440, 1280)).toEqual({ w: 1280, h: 720 });
    expect(fitSize(800, 600, 1280)).toEqual({ w: 800, h: 600 });
    expect(fitSize(2560, 1440, 1280, 0.5)).toEqual({ w: 640, h: 360 });
  });

  it('nextInterval は fps の上限と予算の長いほうを選び、上限を超えない', async () => {
    const { nextInterval, MAX_DELAY_MS } = await load();
    // 3 fps・予算 100 で、軽い（10）フレームは fps が決める
    expect(nextInterval({ fps: 3, weight: 10, budgetKBps: 100 })).toBeCloseTo(333.3, 0);
    // 20 fps は 50ms ごと。予算 2400 なら 100 KB のフレームでも間に合う
    expect(nextInterval({ fps: 20, weight: 100, budgetKBps: 2400 })).toBe(50);
    // 重さ 100 のフレームは毎秒 100 の予算では 1 秒空ける
    expect(nextInterval({ fps: 3, weight: 100, budgetKBps: 100 })).toBe(1000);
    expect(nextInterval({ fps: 3, weight: 100000, budgetKBps: 100 })).toBe(MAX_DELAY_MS);
  });

  it('frameWeight は分割の回数と KB の和（サーバーの重さと同じ）', async () => {
    const { frameWeight } = await load();
    expect(frameWeight(2048, 2)).toBe(4);
  });

  it('tuneQuality は大きければ quality、次に scale を下げ、小さければ戻す', async () => {
    const { tuneQuality, QUALITY_PRESETS } = await load();
    const p = QUALITY_PRESETS.p720;
    const big = 2400 * 1024; // 予算 2400 KB/s の 6 割（1474560 文字）を超える
    const small = 1000;
    let t = { quality: 0.6, scale: 1 };
    t = tuneQuality(t, big, p);
    expect(t).toEqual({ quality: 0.5, scale: 1 });
    for (let i = 0; i < 5; i++) t = tuneQuality(t, big, p);
    expect(t.quality).toBe(0.35);
    expect(t.scale).toBeLessThan(1);
    for (let i = 0; i < 20; i++) t = tuneQuality(t, big, p);
    expect(t.scale).toBe(0.4); // 下限
    // 小さいフレームが続けば戻る（scale が先、その次に quality。もとの quality まで）
    for (let i = 0; i < 40; i++) t = tuneQuality(t, small, p);
    expect(t).toEqual({ quality: 0.6, scale: 1 });
    // 中くらいなら動かさない
    expect(tuneQuality(t, 1000 * 1024, p)).toEqual(t);
  });

  it('frameDiff / shouldSend: 変化が無ければ送らず、しばらくたつか強制なら送る', async () => {
    const { frameDiff, shouldSend, KEEPALIVE_FRAME_MS } = await load();
    const a = new Uint8ClampedArray(16);
    const b = new Uint8ClampedArray(16);
    expect(frameDiff(a, b)).toBe(0);
    expect(frameDiff(null, b)).toBe(Infinity);
    b[0] = 255; // 12 色のうち 1 つが 255 差
    expect(frameDiff(a, b)).toBeCloseTo(255 / 12);
    b[3] = 200; // 透明度は見ない
    expect(frameDiff(a, b)).toBeCloseTo(255 / 12);
    expect(shouldSend({ diff: 0, sinceSentMs: 100, force: false })).toBe(false);
    expect(shouldSend({ diff: 10, sinceSentMs: 100, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: KEEPALIVE_FRAME_MS, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: 100, force: true })).toBe(true);
  });

  it('framePeakDiff / shouldSend: 平均では埋もれる小さな変化（1 画素）も送る', async () => {
    const { frameDiff, framePeakDiff, shouldSend, PEAK_THRESHOLD } = await load();
    const a = new Uint8ClampedArray(64 * 36 * 4);
    const b = a.slice();
    b[0] = b[1] = b[2] = 200; // 1 画素だけ大きく変わる（文字の入力など）
    expect(frameDiff(a, b)).toBeLessThan(1);
    expect(framePeakDiff(a, b)).toBe(200);
    expect(framePeakDiff(null, b)).toBe(Infinity);
    expect(shouldSend({ diff: frameDiff(a, b), peak: framePeakDiff(a, b), sinceSentMs: 100, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, peak: PEAK_THRESHOLD, sinceSentMs: 100, force: false })).toBe(false);
  });

  it('isBlankFrame: 全部透明なら空', async () => {
    const { isBlankFrame } = await load();
    expect(isBlankFrame(new Uint8ClampedArray(16))).toBe(true);
    expect(isBlankFrame(new Uint8ClampedArray([0, 0, 0, 255]))).toBe(false);
  });

  it('isCancelError: 選択・許可のキャンセルだけを見分ける', async () => {
    const { isCancelError, describeError } = await load();
    expect(isCancelError(new DOMException('x', 'NotAllowedError'))).toBe(true);
    expect(isCancelError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isCancelError(new Error('x'))).toBe(false);
    expect(isCancelError({ message: 'x' })).toBe(false);
    expect(describeError(new DOMException('だめ', 'NotReadableError'))).toBe('NotReadableError: だめ');
    expect(describeError({ message: 'native' })).toBe('native');
  });

  it('snapshotFailureReason: 本体の「画面を撮れませんでした（理由）」から理由だけを取り出す', async () => {
    const { snapshotFailureReason } = await load();
    expect(snapshotFailureReason(new Error('画面を撮れませんでした（PixelCopy が失敗: 時間切れ (ERROR_TIMEOUT)）'))).toBe(
      'PixelCopy が失敗: 時間切れ (ERROR_TIMEOUT)',
    );
    expect(snapshotFailureReason(new Error('この環境では画面を撮れません'))).toBe('この環境では画面を撮れません');
  });

  it('canShareCamera / parseSource / sourceLabel', async () => {
    const { canShareCamera, parseSource, sourceLabel } = await load();
    expect(canShareCamera(undefined)).toBe(false);
    expect(canShareCamera({ mediaDevices: {} })).toBe(false);
    expect(canShareCamera({ mediaDevices: { getUserMedia: () => {} } })).toBe(true);
    expect(parseSource({ on: true, source: 'camera' })).toBe('camera');
    // source の無い前の版・知らない値は画面
    expect(parseSource({ on: true })).toBe('screen');
    expect(parseSource({ on: true, source: 'x' })).toBe('screen');
    expect(parseSource(null)).toBe('screen');
    expect(sourceLabel('camera')).toBe('カメラ');
    expect(sourceLabel('screen')).toBe('画面');
  });

  it('hasAudience / canShareScreen / parseSettings', async () => {
    const { hasAudience, canShareScreen, parseSettings } = await load();
    expect(hasAudience([{ self: true }])).toBe(false);
    expect(hasAudience([{ self: true }, { self: false }])).toBe(true);
    expect(canShareScreen(undefined)).toBe(false);
    expect(canShareScreen({})).toBe(false);
    expect(canShareScreen({ mediaDevices: {} })).toBe(false);
    expect(canShareScreen({ mediaDevices: { getDisplayMedia: () => {} } })).toBe(true);
    expect(parseSettings(null)).toEqual({ fps: 5, quality: 'p720', color: 'full' });
    expect(parseSettings({ fps: 20, quality: 'p1080', color: 'gray' })).toEqual({ fps: 20, quality: 'p1080', color: 'gray' });
    expect(parseSettings({ fps: 99, quality: 'toString', color: 'constructor' })).toEqual({ fps: 5, quality: 'p720', color: 'full' });
    // 前の版の保存値は読み替える
    expect(parseSettings({ fps: 3, quality: 'high' })).toEqual({ fps: 5, quality: 'p1080', color: 'full' });
    expect(parseSettings({ quality: 'low' }).quality).toBe('p480');
  });
});

describe('画像の形式・色数・見積もり', () => {
  it('sniffImageMime は JPEG・PNG・WebP だけを見分ける', async () => {
    const { sniffImageMime } = await load();
    const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
    expect(sniffImageMime(b64([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe('image/jpeg');
    expect(sniffImageMime(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    const riff = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50];
    expect(sniffImageMime(b64(riff))).toBe('image/webp');
    expect(sniffImageMime(b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20, 0, 0]))).toBeNull(); // RIFF だが WebP ではない
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))).toBeNull();
  });

  it('applyColorMode: c256 は 256 色相当に、gray は R=G=B にする', async () => {
    const { applyColorMode } = await load();
    const px = new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const c = px.slice();
    applyColorMode(c, 'c256');
    expect([...c.slice(0, 4)]).toEqual([219, 109, 0, 255]); // R は 8 段階（200→219）、G は 8 段階（100→109）、B は 4 段階（50→0）
    expect([...c.slice(4, 8)]).toEqual([0, 0, 0, 255]);
    expect([...c.slice(8, 12)]).toEqual([255, 255, 255, 255]);
    // 色の種類は 256 以内
    const many = new Uint8ClampedArray(4 * 5000);
    for (let i = 0; i < many.length; i++) many[i] = (i * 37) % 256;
    applyColorMode(many, 'c256');
    const kinds = new Set<string>();
    for (let i = 0; i < many.length; i += 4) kinds.add(`${many[i]},${many[i + 1]},${many[i + 2]}`);
    expect(kinds.size).toBeLessThanOrEqual(256);
    const g = px.slice();
    applyColorMode(g, 'gray');
    expect(g[0]).toBe(g[1]);
    expect(g[1]).toBe(g[2]);
    expect(g[3]).toBe(255);
    expect(g[0]).toBeGreaterThan(100);
    expect(g[0]).toBeLessThan(150);
    // full は触らない
    const f = px.slice();
    applyColorMode(f, 'full');
    expect([...f]).toEqual([...px]);
  });

  it('candidateFormats / pickSmallest: 減色は PNG・WebP も試し、小さいものを選ぶ', async () => {
    const { candidateFormats, pickSmallest } = await load();
    expect(candidateFormats('full')).toEqual(['image/jpeg']);
    expect(candidateFormats('c256')).toContain('image/png');
    expect(candidateFormats('c256')).not.toContain('image/jpeg');
    expect(candidateFormats('gray')).toContain('image/jpeg');
    expect(pickSmallest({ 'image/png': 300, 'image/webp': 120, 'image/jpeg': 200 })).toBe('image/webp');
    expect(pickSmallest({ 'image/jpeg': 100, 'image/webp': 100 })).toBe('image/jpeg');
    expect(pickSmallest({})).toBeNull();
  });

  it('estimateBandwidth / formatBytes', async () => {
    const { estimateBandwidth, formatBytes } = await load();
    // 100 KB（base64 で約 133 KB）を 5 fps
    const e = estimateBandwidth(Math.round((100 * 1024 * 4) / 3), 5);
    expect(e.imageBytes).toBeCloseTo(100 * 1024, -2);
    expect(e.capped).toBe(false);
    expect(e.bytesPerSec).toBeCloseTo(5 * 133 * 1024, -4);
    // 予算（2400 KB/s）を超える分は頭打ち
    const big = estimateBandwidth(400 * 1024, 20);
    expect(big.capped).toBe(true);
    expect(big.bytesPerSec).toBe(2400 * 1024);
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(85 * 1024)).toBe('85 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('shareBackend: ネイティブを優先し、無ければ getDisplayMedia', async () => {
    const { shareBackend } = await load();
    const web = { mediaDevices: { getDisplayMedia: () => {} } };
    expect(shareBackend(web, { supported: true })).toBe('native');
    expect(shareBackend(web, { supported: false })).toBe('web');
    expect(shareBackend({}, { supported: true })).toBe('native');
    expect(shareBackend({}, { supported: false })).toBeNull();
    expect(shareBackend({}, undefined)).toBeNull();
  });

  it('canWebPip は PiP と captureStream の両方が要る', async () => {
    const { canWebPip } = await load();
    const v = { requestPictureInPicture: () => {} };
    const c = { captureStream: () => {} };
    expect(canWebPip({ pictureInPictureEnabled: true }, v, c)).toBe(true);
    expect(canWebPip({ pictureInPictureEnabled: false }, v, c)).toBe(false);
    expect(canWebPip({ pictureInPictureEnabled: true }, {}, c)).toBe(false);
    expect(canWebPip({ pictureInPictureEnabled: true }, v, {})).toBe(false);
    expect(canWebPip(undefined, v, c)).toBe(false);
  });
});

describe('本体: ネイティブの取得のエラー', () => {
  it('toCaptureError: キャンセル（code: cancelled）は AbortError、ほかは message の Error にする', () => {
    const c = toCaptureError({ message: '画面の共有がキャンセルされました (cancelled)', code: 'cancelled' });
    expect(c).toBeInstanceOf(Error);
    expect(c.name).toBe('AbortError');
    // 古い版のネイティブ（code なし・denied）もキャンセル扱い
    expect(toCaptureError({ message: '画面の共有が許可されませんでした (denied)' }).name).toBe('AbortError');
    const other = toCaptureError({ message: 'サービスを始められません' });
    expect(other.name).toBe('Error');
    expect(other.message).toBe('サービスを始められません');
    expect(toCaptureError('文字列').message).toBe('文字列');
  });

  it('toSnapshotError: ネイティブの理由はそのまま、Tauri の英語のエラーは利用者向けに言い換える', () => {
    expect(toSnapshotError({ message: '画面を撮れませんでした（PixelCopy が失敗: 時間切れ (ERROR_TIMEOUT)）' }).message).toBe(
      '画面を撮れませんでした（PixelCopy が失敗: 時間切れ (ERROR_TIMEOUT)）',
    );
    expect(toSnapshotError('screen.snapshot not allowed. Command not found').message).toMatch(/^この版のアプリは画面の静止画に対応していません/);
    expect(toSnapshotError({ message: 'No command snapshot found for plugin dev.disnans.screen.ScreenPlugin' }).message).toMatch(/アプリを更新/);
    expect(toSnapshotError(new Error('boom')).message).toBe('画面を撮れませんでした（boom）');
  });
});

describe('拡大縮小・パン', () => {
  const stage = { w: 800, h: 600 };
  const img = { w: 800, h: 450 };

  it('zoomAt は指定した点が動かない', async () => {
    const { zoomAt } = await load();
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // 点 (100, 50) は、拡大前の画像の座標 (100, 50) → 拡大後 (100*2 + -100, 50*2 + -50) = (100, 50)
    expect(100 * 2 + v.x).toBe(100);
    // 範囲外は丸める
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 100, 0, 0).scale).toBe(8);
    expect(zoomAt({ scale: 2, x: 0, y: 0 }, 0.1, 0, 0).scale).toBe(1);
  });

  it('pinchView: 指を広げると拡大し、中点の下の点が追従する', async () => {
    const { pinchView } = await load();
    const v0 = { scale: 1, x: 0, y: 0 };
    // 中点 (0, 0) で間隔が 2 倍
    expect(pinchView(v0, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 200)).toEqual({ scale: 2, x: 0, y: 0 });
    // 間隔が同じで中点が動けばパン
    expect(pinchView({ scale: 2, x: 10, y: 0 }, { x: 0, y: 0 }, 1, { x: 30, y: -20 }, 1)).toEqual({ scale: 2, x: 40, y: -20 });
    // 中点が動きながら拡大: 始めの中点 (50, 0) の下にあった点が、いまの中点 (80, 0) の下に来る
    const v = pinchView(v0, { x: 50, y: 0 }, 100, { x: 80, y: 0 }, 300);
    expect(v.scale).toBe(3);
    expect(50 * 3 + v.x).toBe(80);
    // 縮めすぎない
    expect(pinchView(v0, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 10).scale).toBe(1);
  });

  it('clampView: 画像がはみ出さない範囲に収め、等倍では中央に戻す', async () => {
    const { clampView } = await load();
    expect(clampView({ scale: 1, x: 50, y: 50 }, stage, img)).toEqual({ scale: 1, x: 0, y: 0 });
    // 2 倍: 横は (800*2-800)/2 = 400、縦は (450*2-600)/2 = 150 まで
    expect(clampView({ scale: 2, x: 999, y: -999 }, stage, img)).toEqual({ scale: 2, x: 400, y: -150 });
    expect(clampView({ scale: 2, x: 100, y: 20 }, stage, img)).toEqual({ scale: 2, x: 100, y: 20 });
    expect(clampView({ scale: 20, x: 0, y: 0 }, stage, img).scale).toBe(8);
  });

  it('containSize: 縦長の画面も全体が収まる（はみ出さない）', async () => {
    const { containSize } = await load();
    // スマホの縦長（720×1600）を横長の舞台（1200×700）に: 高さで合わせる
    const s = containSize({ w: 720, h: 1600 }, { w: 1200, h: 700 });
    expect(s.h).toBe(700);
    expect(s.w).toBeCloseTo(315);
    // 横長は幅で合わせる。小さい画像は舞台いっぱいまで広げる
    expect(containSize({ w: 640, h: 360 }, { w: 1280, h: 1000 })).toEqual({ w: 1280, h: 720 });
    expect(containSize({ w: 0, h: 0 }, { w: 100, h: 100 })).toEqual({ w: 0, h: 0 });
  });

  it('wheelAction: Ctrl+ホイール（ピンチ）は拡大縮小、拡大中のホイールは移動、等倍で上に回すと拡大', async () => {
    const { wheelAction } = await load();
    const ev = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) => ({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...o,
    });
    const at = (scale: number, embedded = false) => ({ scale, embedded, pageHeight: 800 });
    const pinch = wheelAction(ev({ deltaY: -10, ctrlKey: true }), at(1));
    expect(pinch).toMatchObject({ kind: 'zoom' });
    expect((pinch as { factor: number }).factor).toBeGreaterThan(1.05);
    // マウスの Ctrl+ホイール（大きな delta）でも、1 回で極端に動かない
    expect((wheelAction(ev({ deltaY: 100, ctrlKey: true }), at(2)) as { factor: number }).factor).toBeGreaterThan(0.7);
    expect(wheelAction(ev({ deltaX: 5, deltaY: 20 }), at(2))).toEqual({ kind: 'pan', dx: 5, dy: 20 });
    // Shift は横に
    expect(wheelAction(ev({ deltaY: 30, shiftKey: true }), at(2))).toEqual({ kind: 'pan', dx: 30, dy: 0 });
    // 行単位はピクセルに
    expect(wheelAction(ev({ deltaY: 3, deltaMode: 1 }), at(2))).toEqual({ kind: 'pan', dx: 0, dy: 48 });
    // 等倍: 上で拡大、下は何もしない。埋め込みの表示ではページのスクロールに譲る
    expect(wheelAction(ev({ deltaY: -100 }), at(1))).toMatchObject({ kind: 'zoom' });
    expect(wheelAction(ev({ deltaY: 100 }), at(1))).toBeNull();
    expect(wheelAction(ev({ deltaY: -100 }), at(1, true))).toBeNull();
    expect(wheelAction(ev({ deltaY: -10, ctrlKey: true }), at(1, true))).toMatchObject({ kind: 'zoom' });
  });

  it('isDoubleTap は短い間隔で近い 2 回のタップ', async () => {
    const { isDoubleTap } = await load();
    expect(isDoubleTap(null, { t: 100, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 5, y: 5 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 600, x: 5, y: 5 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 100, y: 0 })).toBe(false);
  });
});

// ---- プラグインの動き ----

type Handler = (e: { peer: string; user: Disnans.User; payload: unknown }) => void;
const users: Record<string, Disnans.User> = {
  a: { id: 'ua', login_name: 'a', display_name: 'アリス', avatar_url: null },
  b: { id: 'ub', login_name: 'b', display_name: 'ボブ', avatar_url: null },
};

function makeCall() {
  const handlers = new Map<string, Handler>();
  let change: () => void = () => {};
  let buttonOpts: Disnans.CallButtonOptions | null = null;
  let cameraOpts: Disnans.CallButtonOptions | null = null;
  const panelEl = document.createElement('div');
  const panel = {
    el: panelEl,
    mounted: false,
    visible: false,
    setVisible(v: boolean) {
      panel.visible = v;
    },
    onMount: vi.fn(() => () => {}),
    remove: vi.fn(),
  };
  const call = {
    joined: true,
    bufferedAmount: 0,
    addPanel: vi.fn(() => panel),
    participants: [
      { peer: 'me', self: true },
      { peer: 'pa', self: false },
    ] as { peer: string; self: boolean }[],
    emit: vi.fn(),
    onEvent: (name: string, cb: Handler) => {
      handlers.set(name, cb);
      return () => handlers.delete(name);
    },
    onChange: (cb: () => void) => {
      change = cb;
      return () => {};
    },
    addButton: vi.fn((o: Disnans.CallButtonOptions) => {
      // 画面の共有ボタンとカメラのボタンを、作ったときのアイコンで分ける
      const opts = { ...o };
      if (o.icon === 'video') cameraOpts = opts;
      else buttonOpts = opts;
      return {
        update: (p: Partial<Disnans.CallButtonOptions>) => Object.assign(opts, p),
        remove: vi.fn(),
      };
    }),
    join: async () => {},
    leave: () => {},
  };
  return {
    call,
    panel,
    button: () => buttonOpts,
    cameraButton: () => cameraOpts,
    fire: (name: string, peer: string, userKey: 'a' | 'b', payload: unknown) => handlers.get(name)!({ peer, user: users[userKey], payload }),
    files: { api: {} as never, onChanged: () => () => {} },
    changed: () => change(),
  };
}

const g = globalThis as unknown as { disnans: Partial<Disnans.Host> };
const nav = navigator as unknown as { mediaDevices?: unknown };

function fakeStream() {
  const listeners: Record<string, () => void> = {};
  const track = { stop: vi.fn(), addEventListener: (ev: string, cb: () => void) => (listeners[ev] = cb) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, track, end: () => listeners.ended() };
}

/** jsdom は画像を読み込まないので、src を入れたら決めた大きさで onload を呼ぶ Image に差し替える。戻り値で戻す */
function fakeImageLoad(width: number, height: number): () => void {
  const proto = HTMLImageElement.prototype;
  const saved = (['src', 'naturalWidth', 'naturalHeight'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  const desc = saved[0][1]!;
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => height });
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: desc.get,
    set(this: HTMLImageElement, v: string) {
      desc.set!.call(this, v);
      queueMicrotask(() => this.onload?.(new Event('load')));
    },
  });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else Reflect.deleteProperty(proto, k);
    }
  };
}

async function setup(opts: { display: boolean; camera?: boolean; cameras?: number; native?: Partial<Disnans.ScreenCapture>; pip?: Partial<Disnans.Pip> }) {
  const c = makeCall();
  (g.disnans as { call: unknown }).call = c.call;
  (g.disnans as { screenCapture: unknown }).screenCapture = opts.native;
  (g.disnans as { pip: unknown }).pip = opts.pip;
  const fs = fakeStream();
  const getDisplayMedia = vi.fn(async () => fs.stream);
  const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => fs.stream);
  // 前後のカメラの数（cameras があるときだけ、向きの対応と数を知らせる）
  const devices = {
    ...(opts.cameras !== undefined
      ? {
          getSupportedConstraints: () => ({ facingMode: true }),
          enumerateDevices: async () => Array.from({ length: opts.cameras! }, () => ({ kind: 'videoinput' })),
        }
      : {}),
  };
  const media = { ...(opts.display ? { getDisplayMedia } : {}), ...(opts.camera ? { getUserMedia } : {}), ...devices };
  Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: opts.display || opts.camera ? media : undefined });
  const status: HTMLElement[] = [];
  const toast = vi.fn();
  hooks.toast = toast;
  const services = {
    app: { me: { id: 'u1' }, users: [], user: () => undefined, nameOf: () => '', isMobile: false, theme: 'light' },
    api: {},
    send: () => {},
    closePanel: () => {},
    openPanel: () => {},
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: () => () => {},
    toast,
    storage: { get: () => null, set: () => {} },
    pluginIcon: () => 'monitor-up',
    registerIcon: () => () => {},
    registerStatusItem: (_id: string, el: HTMLElement) => {
      status.push(el);
      document.body.append(el);
      return () => el.remove();
    },
    holdBackground: async () => Object.assign(() => {}, { update: () => {} }),
    files: { api: {} as never, onChanged: () => () => {} },
    changed: () => {},
  } as unknown as HostServices;
  const r = new PluginRuntime(
    { id: 'screenshare', name: '画面共有', version: '0.1.0', description: '', author: '', minApiVersion: 9 },
    services,
  );
  const mod = await load();
  await r.start(mod.default);
  // 読み込んだときに、共有中の人を問い合わせる（screen.query）。ほかのテストの邪魔にならないよう、ここで確かめて消す
  expect(c.call.emit).toHaveBeenCalledWith('screen.query', {});
  c.call.emit.mockClear();
  return { ...c, r, fs, getDisplayMedia, getUserMedia, status: () => status[0], toast };
}

const emitted = (c: ReturnType<typeof makeCall>['call'], name: string) =>
  c.emit.mock.calls.filter((a) => a[0] === name).map((a) => a[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
  setLucideForTest({} as never);
  // 取り込んだ画像は不透明（全部透明だと「映像が空」として送らない）
  const ctx = { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(255) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/QUJDRA==');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  // 自分のカメラの枠を外すときの pause（jsdom は未実装で、stderr に出るため）
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLucideForTest(null);
  document.body.replaceChildren();
  Reflect.deleteProperty(nav, 'mediaDevices');
  hooks.onBack = () => () => {};
  hooks.setImmersive = async () => false;
});

describe('examples/screenshare', () => {
  it('取得の失敗: 許可・カメラなし・使用中で文言を分ける', async () => {
    const { cameraFailureText } = await load();
    expect(cameraFailureText(new DOMException('x', 'NotFoundError'))).toBe('カメラが見つかりません');
    expect(cameraFailureText(new DOMException('x', 'NotReadableError'))).toContain('ほかのアプリ');
    expect(cameraFailureText(new DOMException('x', 'OtherError'))).toBe('カメラを取得できませんでした（OtherError: x）');
  });

  it('カメラの共有中に画面に切り替えても、受け手には止まったと出さない。画面が取れなければ止まったと知らせる', async () => {
    const s = await setup({ display: true, camera: true });
    s.getDisplayMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted(s.call, 'screen.state')).toEqual([{ on: true, source: 'camera' }, { on: false }]);
    s.r.stop();
  });

  it('許可の選択の途中でもう一度押すと取り消し、取れた映像は使わない', async () => {
    const s = await setup({ display: true });
    let resolve: (v: unknown) => void = () => {};
    s.getDisplayMedia.mockReturnValueOnce(new Promise((r) => (resolve = r as (v: unknown) => void)) as never);
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.button()!.onClick();
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop, addEventListener: () => {} }], getVideoTracks: () => [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalled();
    expect(s.button()!.active).toBeFalsy();
    expect(emitted(s.call, 'screen.state')).toHaveLength(0);
    s.r.stop();
  });

  it('共有ボタンは通話の全画面だけに置く', async () => {
    const s = await setup({ display: true });
    expect(s.button()?.location).toBe('view');
    s.r.stop();
  });

  it('参加直後に問い合わせを再送し、退出したら止める', async () => {
    const s = await setup({ display: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted(s.call, 'screen.query')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted(s.call, 'screen.query')).toHaveLength(2);
    s.call.participants.push({ peer: 'pb', self: false });
    s.changed();
    expect(emitted(s.call, 'screen.query')).toHaveLength(3);
    s.call.joined = false;
    s.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted(s.call, 'screen.query')).toHaveLength(3);
    s.r.stop();
  });

  it('ネイティブの最初のフレームが start の応答より早くても捨てず、web の取得を使わない', async () => {
    const start = vi.fn(async (_opts: Disnans.ScreenCaptureOptions, onFrame: (f: Disnans.ScreenCaptureFrame) => void) => {
      onFrame({ data: '/9j/QUJDRA==', mime: 'image/jpeg', width: 1280, height: 720 });
    });
    const s = await setup({ display: true, native: { supported: true, start, stop: vi.fn(async () => {}), update: vi.fn(async () => {}) } });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getDisplayMedia).not.toHaveBeenCalled();
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    expect(s.button()?.active).toBe(true);
    s.r.stop();
  });

  it('ネイティブの許可待ち中に退出したら、開始も取り消して共有中にしない', async () => {
    let release!: () => void;
    const start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = vi.fn(async () => {});
    const s = await setup({ display: true, native: { supported: true, start, stop, update: vi.fn(async () => {}) } });
    s.button()!.onClick();
    expect(start).toHaveBeenCalledOnce();
    s.call.joined = false;
    s.changed();
    expect(stop).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.button()?.active).not.toBe(true);
    expect(emitted(s.call, 'screen.state')).toHaveLength(0);
    s.r.stop();
  });

  it('getDisplayMedia が無い環境では共有ボタンを出さず、見ることはできる', async () => {
    const s = await setup({ display: false });
    expect(s.call.addButton).not.toHaveBeenCalled();
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: '/9j/QUJDRA==' });
    const btn = s.status().querySelector('button')!;
    expect(btn.textContent).toContain('アリス');
    btn.click();
    const img = document.querySelector<HTMLImageElement>('.screenshare-overlay img')!;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/QUJDRA==');
    s.r.stop();
  });

  it('共有を始めるとフレームを送り、同じボタンで止まる', async () => {
    const s = await setup({ display: true });
    expect(s.button()!.active).toBeFalsy();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getDisplayMedia).toHaveBeenCalledOnce();
    expect(emitted(s.call, 'screen.state')[0]).toEqual({ on: true, source: 'screen' });
    expect(s.button()!.active).toBe(true);
    const frames = emitted(s.call, 'screen.frame');
    expect(frames).toEqual([{ f: 0, i: 0, n: 1, d: '/9j/QUJDRA==' }]);

    // 画面が変わらないので、しばらくは送らない
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);

    s.button()!.onClick();
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    expect(s.button()!.active).toBe(false);
    s.call.emit.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('カメラを共有すると getUserMedia の映像を送り、同じボタンで止まる', async () => {
    const s = await setup({ display: true, camera: true });
    expect(s.cameraButton()).toMatchObject({ icon: 'video', label: 'カメラを共有', location: 'view' });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getUserMedia).toHaveBeenCalledOnce();
    expect(s.getUserMedia.mock.calls[0]![0]).toMatchObject({ audio: false });
    expect(s.getDisplayMedia).not.toHaveBeenCalled();
    expect(emitted(s.call, 'screen.state')[0]).toEqual({ on: true, source: 'camera' });
    expect(s.cameraButton()).toMatchObject({ active: true, icon: 'video-off' });
    expect(s.button()!.active).toBeFalsy();
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    s.cameraButton()!.onClick();
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    expect(s.cameraButton()).toMatchObject({ active: false, icon: 'video' });
    s.r.stop();
  });

  it('カメラの共有中に画面の共有を押すと、画面に切り替わる', async () => {
    const s = await setup({ display: true, camera: true });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getDisplayMedia).toHaveBeenCalledOnce();
    // 切り替えは止めたことを知らせない（受け手の表示を閉じないように、新しい source で続ける）
    expect(emitted(s.call, 'screen.state')).toEqual([{ on: true, source: 'camera' }, { on: true, source: 'screen' }]);
    expect(s.cameraButton()!.active).toBe(false);
    expect(s.button()!.active).toBe(true);
    s.r.stop();
  });

  it('カメラを開けなければ知らせて、共有中にしない（許可されていない・カメラがない・使用中で文言を分ける）', async () => {
    const s = await setup({ display: false, camera: true });
    s.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('カメラの使用が許可されていません'), 'error');
    expect(s.cameraButton()!.active).toBeFalsy();
    expect(emitted(s.call, 'screen.state')).toHaveLength(0);
    s.r.stop();
  });

  it('カメラの共有は「○○のカメラを見る」と出る', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true, source: 'camera' });
    expect(s.status().querySelector('button')!.textContent).toContain('アリス のカメラを見る');
    s.fire('screen.state', 'pa', 'a', { on: true });
    expect(s.status().querySelector('button')!.textContent).toContain('アリス の画面を見る');
    s.r.stop();
  });

  it('見ている人がいない（自分だけ）ときは送らない', async () => {
    const s = await setup({ display: true });
    s.call.participants = [{ peer: 'me', self: true }];
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(0);
    s.r.stop();
  });

  it('OS 側でトラックが終わったら止まる', async () => {
    const s = await setup({ display: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.fs.end();
    expect(s.button()!.active).toBe(false);
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    s.r.stop();
  });

  it('通話から抜けたら共有を止め、見ていた表示も消す', async () => {
    const s = await setup({ display: true });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    expect(document.querySelector('.screenshare-overlay')).not.toBeNull();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);

    s.call.joined = false;
    s.changed();
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(s.button()!.active).toBe(false);
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    // 抜けたあとは state も送らない（送ると例外になる）
    expect(emitted(s.call, 'screen.state').filter((p) => p.on === false)).toHaveLength(0);
    s.r.stop();
  });

  it('許可待ちのあいだに通話を抜けたら、取得した画面を捨てる', async () => {
    const s = await setup({ display: true });
    s.getDisplayMedia.mockImplementationOnce(async () => {
      s.call.joined = false;
      return s.fs.stream;
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('複数人が共有したら切り替えられ、止めた人・抜けた人は消える', async () => {
    const s = await setup({ display: false });
    s.call.participants.push({ peer: 'pb', self: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.state', 'pb', 'b', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: '/9j/QUFB' });
    s.fire('screen.frame', 'pb', 'b', { f: 0, i: 0, n: 1, d: '/9j/QkJC' });
    const buttons = s.status().querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    const src = () => document.querySelector<HTMLImageElement>('.screenshare-overlay img')?.getAttribute('src');
    expect(src()).toContain('QUFB');
    // 上のタブでボブに切り替える
    document.querySelectorAll<HTMLButtonElement>('.screenshare-tab')[1].click();
    expect(src()).toContain('QkJC');

    // 見ているボブが止めたら、アリスに移る
    s.fire('screen.state', 'pb', 'b', { on: false });
    expect(src()).toContain('QUFB');
    // アリスが通話から抜けたら、表示ごと消える
    s.call.participants = [{ peer: 'me', self: true }];
    s.changed();
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    expect(s.status().querySelectorAll('button')).toHaveLength(0);
    s.r.stop();
  });

  it('音沙汰のない共有者は一定時間で消える', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    expect(s.status().querySelectorAll('button')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12000);
    expect(s.status().querySelectorAll('button')).toHaveLength(0);
    s.r.stop();
  });

  it('Esc で閉じる', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    s.r.stop();
  });

  it('ステータス欄に「共有中（止める）」は出ず、共有の開始を知らせるトーストも出ない', async () => {
    const s = await setup({ display: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status().textContent).not.toContain('止める');
    expect(s.status().querySelectorAll('button')).toHaveLength(0);
    s.fire('screen.state', 'pa', 'a', { on: true });
    expect(s.toast).not.toHaveBeenCalled();
    expect(s.status().querySelectorAll('button')).toHaveLength(1);
    s.r.stop();
  });

  it('画像でない（SVG など）フレームは表示しない', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: Buffer.from('<svg xmlns="x"/>').toString('base64') });
    s.status().querySelector('button')!.click();
    expect(document.querySelector('.screenshare-overlay img')).toBeNull();
    // PNG は表示できる（形式は画像から読む）
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    s.fire('screen.frame', 'pa', 'a', { f: 1, i: 0, n: 1, d: png });
    expect(document.querySelector('.screenshare-overlay img')!.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
    s.r.stop();
  });

  it('閲覧の表示には拡大縮小のボタンが無く、戻る操作（ui.onBack）で閉じる', async () => {
    const backs: (() => void)[] = [];
    hooks.onBack = (run) => {
      backs.push(run);
      return () => {
        backs.splice(backs.indexOf(run), 1);
      };
    };
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    const labels = [...document.querySelectorAll('.screenshare-bar button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).not.toContain('原寸で見る');
    expect(labels).toContain('全画面');
    expect(backs).toHaveLength(1);
    backs[0]();
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    expect(backs).toHaveLength(0);
    s.r.stop();
  });

  it('Android: 全画面は没入モードにし、戻る操作でまず全画面を解除する（Fullscreen API を使わない）', async () => {
    const backs: (() => void)[] = [];
    hooks.onBack = (run) => {
      backs.push(run);
      return () => {
        backs.splice(backs.indexOf(run), 1);
      };
    };
    const immersive = vi.fn(async () => true);
    hooks.setImmersive = immersive;
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="全画面"]')!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(immersive).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('.screenshare-overlay')!.classList.contains('screenshare-fullscreen')).toBe(true);
    expect(s.toast).not.toHaveBeenCalled();
    expect(backs).toHaveLength(2);
    // 戻る: 全画面だけ解除して、閲覧は残る
    backs[backs.length - 1]();
    expect(immersive).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('.screenshare-overlay')!.classList.contains('screenshare-fullscreen')).toBe(false);
    expect(backs).toHaveLength(1);
    // もう一度戻ると閲覧が閉じる
    backs[0]();
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    s.r.stop();
  });

  it('閲覧を閉じるとき、全画面なら没入モードも戻す', async () => {
    hooks.onBack = () => () => {};
    const immersive = vi.fn(async () => true);
    hooks.setImmersive = immersive;
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="全画面"]')!.click();
    await vi.advanceTimersByTimeAsync(1);
    document.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click();
    expect(immersive).toHaveBeenLastCalledWith(false);
    s.r.stop();
  });

  it('Android の PiP のボタンは pip.enter を呼び、小窓の間は画像だけの表示にする', async () => {
    let change: (a: boolean) => void = () => {};
    const enter = vi.fn(async () => true);
    const s = await setup({
      display: false,
      pip: { supported: true, enter, onChange: (cb: (a: boolean) => void) => ((change = cb), () => {}) },
    });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="PiP（小窓）で見る"]')!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(enter).toHaveBeenCalled();
    change(true);
    expect(document.querySelector('.screenshare-overlay')!.classList.contains('screenshare-pip')).toBe(true);
    change(false);
    expect(document.querySelector('.screenshare-overlay')!.classList.contains('screenshare-pip')).toBe(false);
    s.r.stop();
  });

  it('getDisplayMedia が無くても、ネイティブの取得があれば共有できる（Android）', async () => {
    let onFrame: (f: Disnans.ScreenCaptureFrame) => void = () => {};
    let opts: Disnans.ScreenCaptureOptions | null = null;
    const start = vi.fn(async (o: Disnans.ScreenCaptureOptions, cb: (f: Disnans.ScreenCaptureFrame) => void) => {
      opts = o;
      onFrame = cb;
    });
    const stop = vi.fn(async () => {});
    const update = vi.fn(async () => {});
    const s = await setup({ display: false, native: { supported: true, start, stop, update } });
    expect(s.call.addButton).toHaveBeenCalledOnce();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledOnce();
    expect(opts).toMatchObject({ maxEdge: 1280, fps: 5, color: 'full', format: 'jpeg' });
    expect(s.button()!.active).toBe(true);
    expect(emitted(s.call, 'screen.state')[0]).toEqual({ on: true, source: 'screen' });

    onFrame({ data: '/9j/QUJDRA==', mime: 'image/jpeg', width: 1280, height: 720 });
    expect(emitted(s.call, 'screen.frame')).toEqual([{ f: 0, i: 0, n: 1, d: '/9j/QUJDRA==' }]);

    // 予算の間隔が空いていなくても、新しいフレームは捨てずに予約される（最新の 1 枚だけ）
    onFrame({ data: '/9j/QUFB', mime: 'image/jpeg', width: 1280, height: 720 });
    onFrame({ data: '/9j/QkJC', mime: 'image/jpeg', width: 1280, height: 720 });
    await vi.advanceTimersByTimeAsync(300);
    const sent = emitted(s.call, 'screen.frame').map((c) => c.d);
    expect(sent).toEqual(['/9j/QUJDRA==', '/9j/QkJC']);

    // 止めるとネイティブも止まる
    s.button()!.onClick();
    expect(stop).toHaveBeenCalled();
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    s.r.stop();
  });

  it('ネイティブの取得が OS 側で終わったら止まる', async () => {
    let opts: Disnans.ScreenCaptureOptions | null = null;
    const s = await setup({
      display: false,
      native: { supported: true, start: async (o: Disnans.ScreenCaptureOptions) => void (opts = o), stop: async () => {}, update: async () => {} },
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.button()!.active).toBe(true);
    (opts as unknown as Disnans.ScreenCaptureOptions).onEnd!();
    expect(s.button()!.active).toBe(false);
    s.r.stop();
  });

  it('ネイティブの許可を断ったら共有は始まらない', async () => {
    const s = await setup({
      display: false,
      native: { supported: true, start: async () => Promise.reject(new Error('permission denied')), stop: async () => {}, update: async () => {} },
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.button()!.active).toBeFalsy();
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('設定画面: 説明は無く、FPS は 5 と 20、画質は解像度と品質、色数を選べる。snapshot で自分の画面を撮ってプレビューを出す（選択のダイアログは出さない）', async () => {
    const snapshot = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,/9j/QUJD', width: 1920, height: 1080, source: 'screen' as const }));
    const s = await setup({ display: true, native: { supported: false, snapshot } });
    const restoreImage = fakeImageLoad(1920, 1080);
    const container = document.createElement('div');
    document.body.append(container);
    // 設定タブの描画（addSettingTab で登録されたもの）。プレビューの符号化は jsdom の canvas に合わせて差し替える
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:image/jpeg;base64,/9j/' + 'A'.repeat(1000));
    const ctx = new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : () => ({ addColorStop: () => {} })), set: () => true });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as never);
    s.r.settingTabs[0].display(container);
    expect(container.querySelector('.setting-row-description')).toBeNull();
    const names = [...container.querySelectorAll('.setting-row-name')].map((n) => n.textContent);
    expect(names).toEqual(['FPS', '画質', '色数']);
    const options = (i: number) => [...container.querySelectorAll('.setting-row')[i].querySelectorAll('.segmented-option')].map((b) => b.textContent);
    expect(options(0)).toEqual(['5', '20']);
    expect(options(1)).toEqual(['480p・品質 50%', '720p・品質 60%', '1080p・品質 80%']);
    expect(options(2)).toEqual(['フルカラー', '256 色', 'グレースケール']);
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshot).toHaveBeenCalledOnce();
    // getDisplayMedia（画面の選択のダイアログ）は使わない
    expect(s.getDisplayMedia).not.toHaveBeenCalled();
    expect(container.querySelector('.screenshare-preview-info')).toBeNull();
    expect(container.querySelector<HTMLImageElement>('.screenshare-preview-img')!.hidden).toBe(false);
    // 開き直すと撮り直す（ダイアログは出ないので毎回でよい）
    container.replaceChildren();
    s.r.settingTabs[0].display(container);
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(s.getDisplayMedia).not.toHaveBeenCalled();
    restoreImage();
    s.r.stop();
  });

  it('設定画面: snapshot が失敗したらプレビューは無いと書く（ダイアログは出さない）', async () => {
    const snapshot = vi.fn(async () => Promise.reject(new Error('この環境では画面を撮れません')));
    const s = await setup({ display: true, native: { supported: false, snapshot } });
    const container = document.createElement('div');
    document.body.append(container);
    s.r.settingTabs[0].display(container);
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(s.getDisplayMedia).not.toHaveBeenCalled();
    expect(container.querySelector('.screenshare-preview-info')).toBeNull();
    expect(container.querySelector<HTMLImageElement>('.screenshare-preview-img')!.hidden).toBe(true);
    s.r.stop();
  });

  it('設定画面: snapshot の無い本体ではプレビューが無いと書く', async () => {
    const s = await setup({ display: false });
    const container = document.createElement('div');
    document.body.append(container);
    s.r.settingTabs[0].display(container);
    await vi.advanceTimersByTimeAsync(10);
    expect(container.querySelector<HTMLImageElement>('.screenshare-preview-img')!.hidden).toBe(true);
    s.r.stop();
  });

  it('Android: 許可のダイアログでキャンセル（AbortError）したら、何も知らせずに終える', async () => {
    const s = await setup({
      display: false,
      native: {
        supported: true,
        start: async () => Promise.reject(Object.assign(new Error('画面の共有がキャンセルされました (cancelled)'), { name: 'AbortError' })),
        stop: async () => {},
        update: async () => {},
      },
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.toast).not.toHaveBeenCalled();
    expect(s.button()!.active).toBeFalsy();
    s.r.stop();
  });

  it('Android: キャンセル以外の失敗は理由つきで知らせる', async () => {
    const s = await setup({
      display: false,
      native: { supported: true, start: async () => Promise.reject(new Error('サービスを始められません')), stop: async () => {}, update: async () => {} },
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('サービスを始められません'), 'error');
    s.r.stop();
  });

  it('共有ボタンを押したら、フォーカスを外す', async () => {
    const s = await setup({ display: true });
    const b = document.createElement('button');
    document.body.append(b);
    b.focus();
    expect(document.activeElement).toBe(b);
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.activeElement).not.toBe(b);
    s.r.stop();
  });

  it('共有中に問い合わせ（screen.query）が来たら、すぐに state とフレームを送り直す', async () => {
    const s = await setup({ display: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    s.call.emit.mockClear();
    s.fire('screen.query', 'pa', 'a', {});
    expect(emitted(s.call, 'screen.state')).toEqual([{ on: true, source: 'screen' }]);
    await vi.advanceTimersByTimeAsync(1);
    // 画面が変わっていなくても、問い合わせた人のために送る
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    s.r.stop();
  });

  it('共有中に新しい人が来たら、ハートビートを待たずに知らせる', async () => {
    const s = await setup({ display: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1000);
    s.call.emit.mockClear();
    s.call.participants = [...s.call.participants, { peer: 'pb', self: false }];
    s.changed();
    expect(emitted(s.call, 'screen.state')).toEqual([{ on: true, source: 'screen' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    s.r.stop();
  });

  it('通話に入ったときに、共有中の人を問い合わせる', async () => {
    const s = await setup({ display: false });
    s.call.joined = false;
    s.changed();
    s.call.joined = true;
    s.changed();
    expect(s.call.emit).toHaveBeenCalledWith('screen.query', {});
    // 参加中の onChange（しゃべり始めなど）では問い合わせ直さない
    s.call.emit.mockClear();
    s.changed();
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('送信待ち（bufferedAmount）が多いあいだは、新しいフレームを作らずに待つ', async () => {
    const s = await setup({ display: true });
    s.call.bufferedAmount = 10 * 1024 * 1024;
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(0);
    s.call.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);
    s.r.stop();
  });

  it('映像が空（canvas に描けない）なら送らず、続いたら理由を知らせる', async () => {
    const s = await setup({ display: true });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }),
    } as never);
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(0);
    expect(s.toast).toHaveBeenCalledOnce();
    expect(s.toast.mock.calls[0][0]).toContain('相手には映っていません');
    // 取り込み用の <video> は文書に入れている（WebKitGTK で描けるように）
    expect(document.querySelector('video.screenshare-capture-video')).not.toBeNull();
    s.button()!.onClick();
    expect(document.querySelector('video.screenshare-capture-video')).toBeNull();
    s.r.stop();
  });

  it('通話の画面の領域（call.addPanel）に、共有者の画面を出す', async () => {
    const s = await setup({ display: false });
    expect(s.call.addPanel).toHaveBeenCalledOnce();
    expect(s.panel.visible).toBe(false);
    s.fire('screen.state', 'pa', 'a', { on: true });
    expect(s.panel.visible).toBe(true);
    expect(s.panel.el.textContent).toContain('アリス');
    // 通話の画面が開いている（mounted）ときだけ描く
    s.panel.mounted = true;
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: '/9j/QUJDRA==' });
    expect(s.panel.el.querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/QUJDRA==');
    // 「大きく見る」で全画面の閲覧表示を開く
    s.panel.el.querySelector<HTMLButtonElement>('[aria-label="大きく見る"]')!.click();
    expect(document.querySelector('.screenshare-overlay img')).not.toBeNull();
    // 共有が止まれば領域も隠れる
    s.fire('screen.state', 'pa', 'a', { on: false });
    expect(s.panel.visible).toBe(false);
    s.r.stop();
    expect(s.panel.remove).toHaveBeenCalled();
  });

  it('カメラが 2 つ以上ある端末では、カメラの共有中だけ切り替えのボタンを出す', async () => {
    const s = await setup({ display: true, camera: true, cameras: 2 });
    expect(switchEl(s)).toBeNull();
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    const btn = switchEl(s)!;
    expect(btn.getAttribute('aria-label')).toBe('カメラを切り替え');
    // 自分の映像の箱の中（右上）に置く。通話の全画面のバーには出さない
    expect(btn.parentElement!.classList.contains('screenshare-img')).toBe(true);
    expect(s.call.addButton).not.toHaveBeenCalledWith(expect.objectContaining({ icon: 'switch-camera' }));
    s.cameraButton()!.onClick();
    s.r.stop();
  });

  it('カメラが 1 つだけの端末では、切り替えのボタンを出さない', async () => {
    const s = await setup({ display: true, camera: true, cameras: 1 });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(switchEl(s)).toBeNull();
    s.r.stop();
  });

  it('切り替えると、反対の向きのカメラを開き、前のカメラを止める。自分の枠も新しいカメラに替える', async () => {
    const s = await setup({ display: true, camera: true, cameras: 2 });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    const second = fakeStream();
    s.getUserMedia.mockResolvedValueOnce(second.stream as never);
    switchEl(s)!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getUserMedia).toHaveBeenCalledTimes(2);
    expect(s.getUserMedia.mock.calls[1]![0]).toMatchObject({ video: { facingMode: { exact: 'environment' } }, audio: false });
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(second.track.stop).not.toHaveBeenCalled();
    const video = selfVideo(s)!;
    expect(video.srcObject).toBe(second.stream);
    expect(switchEl(s)!.disabled).toBe(false);
    s.r.stop();
  });

  it('切り替えの途中の二度目の押下は無視する', async () => {
    const s = await setup({ display: true, camera: true, cameras: 2 });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    let resolve: (st: never) => void = () => {};
    s.getUserMedia.mockImplementationOnce(() => new Promise<never>((r) => (resolve = r)));
    switchEl(s)!.click();
    switchEl(s)!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getUserMedia).toHaveBeenCalledTimes(2);
    resolve(fakeStream().stream as never);
    await vi.advanceTimersByTimeAsync(1);
    s.r.stop();
  });

  it('開けなかったら、いまのカメラのまま続けて知らせる', async () => {
    const s = await setup({ display: true, camera: true, cameras: 2 });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.getUserMedia.mockRejectedValueOnce(new DOMException('no', 'OverconstrainedError'));
    switchEl(s)!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fs.track.stop).not.toHaveBeenCalled();
    expect(s.cameraButton()).toMatchObject({ active: true });
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('切り替えられません'), 'error');
    s.r.stop();
  });

  it('切り替えの途中で止めたら、遅れて届いたカメラは使わずに止める', async () => {
    const s = await setup({ display: true, camera: true, cameras: 2 });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    const late = fakeStream();
    let resolve: (st: never) => void = () => {};
    s.getUserMedia.mockImplementationOnce(() => new Promise<never>((r) => (resolve = r)));
    switchEl(s)!.click();
    s.cameraButton()!.onClick();
    resolve(late.stream as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.track.stop).toHaveBeenCalled();
    expect(s.fs.track.stop).toHaveBeenCalledTimes(1);
    s.r.stop();
  });

  it('向きの判定: 不明なら背面へ、背面なら前面へ。カメラの数は 2 つ以上・向きに対応のときだけ', async () => {
    const { nextFacing, canSwitchCamera } = await load();
    expect(nextFacing(null)).toBe('environment');
    expect(nextFacing('user')).toBe('environment');
    expect(nextFacing('environment')).toBe('user');
    expect(await canSwitchCamera(undefined)).toBe(false);
    expect(await canSwitchCamera({ mediaDevices: { getUserMedia: () => {} } })).toBe(false);
    const facing = { getSupportedConstraints: () => ({ facingMode: true }) };
    const cams = (n: number) => async () => Array.from({ length: n }, () => ({ kind: 'videoinput' }));
    expect(await canSwitchCamera({ mediaDevices: { getUserMedia: () => {}, ...facing, enumerateDevices: cams(2) } })).toBe(true);
    expect(await canSwitchCamera({ mediaDevices: { getUserMedia: () => {}, ...facing, enumerateDevices: cams(1) } })).toBe(false);
    // 数えられないとき（失敗）は、向きに対応していることだけで決める
    expect(
      await canSwitchCamera({ mediaDevices: { getUserMedia: () => {}, ...facing, enumerateDevices: async () => { throw new Error('x'); } } }),
    ).toBe(true);
  });

  it('カメラを送っているあいだは、自分のカメラを舞台（.screenshare-img）に出し、止めたら外す（新しい取得はしない）', async () => {
    const s = await setup({ display: true, camera: true });
    expect(selfVideo(s)).toBeNull();
    expect(s.panel.visible).toBe(false);
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    const video = selfVideo(s)!;
    expect(video.srcObject).toBe(s.fs.stream);
    expect(video.muted).toBe(true);
    expect(video.getAttribute('aria-label')).toBe('自分のカメラ（送信中）');
    expect(s.panel.visible).toBe(true);
    // 取得は 1 回だけ（舞台は同じ MediaStream を渡すだけ）
    expect(s.getUserMedia).toHaveBeenCalledOnce();
    s.cameraButton()!.onClick();
    expect(selfVideo(s)).toBeNull();
    expect(s.panel.visible).toBe(false);
    s.r.stop();
  });

  it('自分の送信中の映像は、画面でもカメラでも出す（ラベルは送っている種類で変える）。通話を抜けたら外す', async () => {
    const s = await setup({ display: true, camera: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfVideo(s)!.getAttribute('aria-label')).toBe('自分の画面（送信中）');
    expect(selfVideo(s)!.srcObject).toBeTruthy();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfVideo(s)).toBeNull();
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfVideo(s)!.getAttribute('aria-label')).toBe('自分のカメラ（送信中）');
    s.call.joined = false;
    s.changed();
    expect(selfVideo(s)).toBeNull();
    s.r.stop();
  });

  it('自分が送っているあいだも、見ている相手の共有はタブで選べる。自分の映像が既定で、切り替えのボタンは自分の映像のときだけ', async () => {
    const s = await setup({ display: false, camera: true, cameras: 2 });
    s.panel.mounted = true;
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: '/9j/QUJDRA==' });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    // 既定は自分の映像（舞台の箱の中に映像。切り替えのボタンもその右上）
    expect(selfVideo(s)).not.toBeNull();
    expect(switchEl(s)).not.toBeNull();
    const tabs = [...s.panel.el.querySelectorAll<HTMLButtonElement>('.screenshare-tab')];
    expect(tabs).toHaveLength(2);
    // 相手の共有に切り替えると、映像は外れ、相手のフレームを出す（切り替えのボタンも消す）
    tabs[1]!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfVideo(s)).toBeNull();
    expect(switchEl(s)).toBeNull();
    expect(s.panel.el.querySelector('.screenshare-stage img')!.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/QUJDRA==');
    // 自分の映像に戻す
    s.panel.el.querySelectorAll<HTMLButtonElement>('.screenshare-tab')[0]!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfVideo(s)).not.toBeNull();
    s.r.stop();
  });

  it('プラグインを外したら、自分の映像も手放す', async () => {
    const s = await setup({ display: false, camera: true });
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    const video = selfVideo(s)!;
    expect(video.srcObject).toBe(s.fs.stream);
    s.r.stop();
    expect(video.srcObject).toBeNull();
    expect(s.fs.track.stop).toHaveBeenCalled();
  });

  it('古い取り込みが終わらなくても、切り替えた新しい共有は最初のフレームを送る', async () => {
    // 取り込みが返らない（ImageCapture の grabFrame が待ったまま）状態を作る
    const hang = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal(
      'ImageCapture',
      class {
        grabFrame = hang;
        constructor(_track: unknown) {}
      },
    );
    try {
      const s = await setup({ display: false, camera: true });
      const blank = { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }) };
      const opaque = { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(255) }) };
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(blank as never);
      s.cameraButton()!.onClick();
      // 映像が空のまま 5 秒たつと ImageCapture に替え、その取り込みで止まる
      await vi.advanceTimersByTimeAsync(6000);
      expect(hang).toHaveBeenCalled();
      expect(emitted(s.call, 'screen.frame')).toHaveLength(0);
      // 止めて、取り込めるようにしてから、もう一度始める
      s.cameraButton()!.onClick();
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(opaque as never);
      s.cameraButton()!.onClick();
      await vi.advanceTimersByTimeAsync(1);
      expect(emitted(s.call, 'screen.frame').length).toBeGreaterThan(0);
      s.r.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('カメラの映像が取れないときの知らせは「カメラ」と言う', async () => {
    const s = await setup({ display: false, camera: true });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }),
    } as never);
    s.cameraButton()!.onClick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.toast).toHaveBeenCalledOnce();
    expect(s.toast.mock.calls[0][0]).toContain('カメラの映像を取り込めない');
    expect(s.toast.mock.calls[0][0]).not.toContain('画面');
    s.r.stop();
  });
});
