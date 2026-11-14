// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setKeepWebViewResumed } from './nativeCall';

describe('nativeCall（Android 以外では何もしない）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Android でないとき、WebView の設定は何もしない', () => {
    expect(() => setKeepWebViewResumed()).not.toThrow();
  });
});
