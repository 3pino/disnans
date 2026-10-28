import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri の API を明示的にモックする（Android の受け口・デスクトップの受け口と通知）
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke, addPluginListener: h.addPluginListener }));
vi.mock('@tauri-apps/api/event', () => ({ listen: h.listen }));

import {
  DESKTOP_CLICKED_EVENT,
  DESKTOP_NOTIFY_COMMAND,
  listenSystemOpen,
  sendSystemNote,
  type OnOpen,
  type SystemBackend,
} from './systemNotify';

const note = { title: '太郎', body: 'こんにちは' };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 押したときの経路を、backend ごとに再現する（受け口の登録から、押す操作まで）。
 * どの backend でも「押す → onOpen が 1 回呼ばれる」になることを確かめる
 */
const press: Record<SystemBackend, (onOpen: OnOpen) => Promise<void>> = {
  android: async (onOpen) => {
    await listenSystemOpen('android', onOpen);
    const handler = h.addPluginListener.mock.calls[0][2] as () => void;
    handler();
  },
  desktop: async (onOpen) => {
    await listenSystemOpen('desktop', onOpen);
    const handler = h.listen.mock.calls[0][1] as () => void;
    handler();
  },
};

describe.each(['android', 'desktop'] as const)('押したとき（%s）', (backend) => {
  it('onOpen（チャットを表示する動作）が 1 回だけ呼ばれる', async () => {
    const onOpen = vi.fn();
    await press[backend](onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('押したときの受け口（backend ごと）', () => {
  it('Android は notifier の open に、デスクトップは desktop-notification-clicked に繋ぐ', async () => {
    await listenSystemOpen('android', vi.fn());
    expect(h.addPluginListener).toHaveBeenCalledWith('notifier', 'open', expect.any(Function));
    await listenSystemOpen('desktop', vi.fn());
    expect(h.listen).toHaveBeenCalledWith(DESKTOP_CLICKED_EVENT, expect.any(Function));
  });

  it('デスクトップのイベント名は Rust と同じ（desktop_notify.rs の CLICKED_EVENT）', () => {
    expect(DESKTOP_CLICKED_EVENT).toBe('desktop-notification-clicked');
  });
});

describe('デスクトップの送信（Rust の desktop_notify を呼ぶ）', () => {
  it('title と body をそのまま渡し、true を返す（通知の出せた扱い）', async () => {
    expect(sendSystemNote('desktop', note)).toBe(true);
    await flush();
    expect(h.invoke).toHaveBeenCalledWith(DESKTOP_NOTIFY_COMMAND, { title: '太郎', body: 'こんにちは' });
    expect(DESKTOP_NOTIFY_COMMAND).toBe('desktop_notify');
  });

  it('Rust の失敗は記録だけして、例外にしない', async () => {
    h.invoke.mockRejectedValue(new Error('toast failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sendSystemNote('desktop', note)).toBe(true);
    await flush();
    expect(warn).toHaveBeenCalled();
  });
});

describe('Android は JS から送らない（常駐サービスが出す）', () => {
  it('送らず false を返す（invoke も使わない）', () => {
    expect(sendSystemNote('android', note)).toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
