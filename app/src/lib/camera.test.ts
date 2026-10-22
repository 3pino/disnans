import { describe, expect, it } from 'vitest';
import { cameraErrorText, photoFileName } from './camera';
import { cameraRequest } from './stores/cameraRequest.svelte';

describe('photoFileName', () => {
  it('写真-年月日-時分秒.jpg（2 桁そろえ）', () => {
    expect(photoFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('写真-20260102-030405.jpg');
    expect(photoFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe('写真-20261231-235959.jpg');
  });
});

describe('cameraErrorText', () => {
  const err = (name: string) => Object.assign(new Error('x'), { name });
  it('許可・機器の有無・その他で文言を分ける', () => {
    expect(cameraErrorText(err('NotAllowedError'))).toBe('カメラの使用が許可されていません');
    expect(cameraErrorText(err('SecurityError'))).toBe('カメラの使用が許可されていません');
    expect(cameraErrorText(err('NotFoundError'))).toBe('カメラが見つかりません');
    expect(cameraErrorText(err('OverconstrainedError'))).toBe('カメラが見つかりません');
    expect(cameraErrorText(err('AbortError'))).toBe('カメラを起動できませんでした');
    expect(cameraErrorText('x')).toBe('カメラを起動できませんでした');
  });
});

describe('cameraRequest（写真を撮るの依頼）', () => {
  it('依頼は1回ずつ。取り出すと消える', () => {
    expect(cameraRequest.take()).toBe(false);
    cameraRequest.request();
    expect(cameraRequest.pending).toBe(true);
    expect(cameraRequest.take()).toBe(true);
    expect(cameraRequest.pending).toBe(false);
    expect(cameraRequest.take()).toBe(false);
  });
});
