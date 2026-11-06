// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { videoStream } from './videoStream';

const stream = () => ({}) as MediaStream;
function video() {
  const el = document.createElement('video');
  const play = vi.fn(async () => {});
  Object.defineProperty(el, 'play', { value: play });
  return { el, play };
}

describe('videoStream（カメラの映像を video に入れる）', () => {
  it('最初のストリームを入れて再生する', () => {
    const { el, play } = video();
    const a = stream();
    videoStream(el, a);
    expect(el.srcObject).toBe(a);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it('カメラを切り替えて新しいストリームになったら、差し替えて再生し直す（映像が消えない）', () => {
    const { el, play } = video();
    const a = stream();
    const b = stream();
    const action = videoStream(el, a);
    action.update(b);
    expect(el.srcObject).toBe(b);
    expect(play).toHaveBeenCalledTimes(2);
  });
  it('同じストリームなら何もしない。外すときは空にする', () => {
    const { el, play } = video();
    const a = stream();
    const action = videoStream(el, a);
    action.update(a);
    expect(play).toHaveBeenCalledTimes(1);
    action.destroy();
    expect(el.srcObject).toBeNull();
  });
  it('再生が拒まれても例外にしない', () => {
    const el = document.createElement('video');
    Object.defineProperty(el, 'play', { value: () => Promise.reject(new Error('NotAllowedError')) });
    expect(() => videoStream(el, stream())).not.toThrow();
  });
});
