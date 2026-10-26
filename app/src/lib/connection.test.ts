import { describe, expect, it } from 'vitest';
import { BANNER_SHOW_MS, BANNER_STALL_MS, bannerPhase, failureReason, isConnectionFailure } from './connection';
import { ConnectionError, HttpError } from './transport/http';

describe('接続の失敗か', () => {
  it('届かなかった通信（fetch の timeout・network）は接続の失敗', () => {
    expect(isConnectionFailure(new ConnectionError('timeout', 'x'))).toBe(true);
    expect(isConnectionFailure(new ConnectionError('network', 'x'))).toBe(true);
  });

  it('Tauri の Rust 経路の timeout・network（HttpError の code）も接続の失敗', () => {
    expect(isConnectionFailure(new HttpError(0, 'timeout', '応答がありませんでした'))).toBe(true);
    expect(isConnectionFailure(new HttpError(0, 'network', 'ネットワークエラー'))).toBe(true);
  });

  it('サーバーの HTTP エラー・ほかの例外は、接続の失敗ではない', () => {
    expect(isConnectionFailure(new HttpError(401, 'unauthorized', 'x'))).toBe(false);
    expect(isConnectionFailure(new HttpError(500, 'internal', 'x'))).toBe(false);
    expect(isConnectionFailure(new Error('x'))).toBe(false);
    expect(isConnectionFailure('文字列')).toBe(false);
  });
});

describe('接続バナーの段階（切れてからの時間）', () => {
  it('切れていない・一瞬の切れは出さない', () => {
    expect(bannerPhase(null)).toBe('hidden');
    expect(bannerPhase(0)).toBe('hidden');
    expect(bannerPhase(BANNER_SHOW_MS - 1)).toBe('hidden');
  });

  it('少し続くと出し、長く続くと原因と案内（stalled）', () => {
    expect(bannerPhase(BANNER_SHOW_MS)).toBe('short');
    expect(bannerPhase(BANNER_STALL_MS - 1)).toBe('short');
    expect(bannerPhase(BANNER_STALL_MS)).toBe('stalled');
  });
});

describe('失敗の原因（1 行）', () => {
  it('例外の文を使い、無ければ文字列にする', () => {
    expect(failureReason(new ConnectionError('timeout', '応答がありません（15 秒）'))).toBe('応答がありません（15 秒）');
    expect(failureReason('そのまま')).toBe('そのまま');
  });
});
