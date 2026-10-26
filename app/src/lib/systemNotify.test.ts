import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** ブラウザーの Notification の代わり（onclick を呼んで「押した」を再現する） */
class FakeNotification {
  static last: FakeNotification | null = null;
  static fail = false;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly opts: { body: string; tag: string },
  ) {
    if (FakeNotification.fail) throw new Error('denied');
    FakeNotification.last = this;
  }
}

const focus = vi.fn();
const note = { title: '太郎', body: 'こんにちは' };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.invoke.mockResolvedValue(undefined);
  FakeNotification.last = null;
  FakeNotification.fail = false;
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('window', { focus });
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  web: async (onOpen) => {
    sendSystemNote('web', note, onOpen);
    FakeNotification.last!.onclick!();
  },
};

describe.each(['android', 'desktop', 'web'] as const)('押したとき（%s）', (backend) => {
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

  it('Web は受け口を付けない（通知ごとの onclick で押す）', async () => {
    await listenSystemOpen('web', vi.fn());
    expect(h.addPluginListener).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('デスクトップのイベント名は Rust と同じ（desktop_notify.rs の CLICKED_EVENT）', () => {
    expect(DESKTOP_CLICKED_EVENT).toBe('desktop-notification-clicked');
  });
});

describe('Web の押下は、ウィンドウにフォーカスしてから開く', () => {
  it('focus → onOpen の順で、通知を閉じる', async () => {
    const order: string[] = [];
    focus.mockImplementation(() => order.push('focus'));
    sendSystemNote('web', note, () => order.push('open'));
    const n = FakeNotification.last!;
    n.close.mockImplementation(() => order.push('close'));
    n.onclick!();
    expect(order).toEqual(['focus', 'open', 'close']);
  });

  it('通知の見た目は従来どおり（tag は main）', () => {
    sendSystemNote('web', note, vi.fn());
    expect(FakeNotification.last!.title).toBe('太郎');
    expect(FakeNotification.last!.opts).toEqual({ body: 'こんにちは', tag: 'main' });
  });

  it('Notification が使えないとき（許可なし等）は false を返す', () => {
    FakeNotification.fail = true;
    expect(sendSystemNote('web', note, vi.fn())).toBe(false);
  });
});

describe('デスクトップの送信（Rust の desktop_notify を呼ぶ）', () => {
  it('title と body をそのまま渡し、true を返す（通知の出せた扱い）', async () => {
    expect(sendSystemNote('desktop', note, vi.fn())).toBe(true);
    await flush();
    expect(h.invoke).toHaveBeenCalledWith(DESKTOP_NOTIFY_COMMAND, { title: '太郎', body: 'こんにちは' });
    expect(DESKTOP_NOTIFY_COMMAND).toBe('desktop_notify');
  });

  it('Rust の失敗は記録だけして、例外にしない', async () => {
    h.invoke.mockRejectedValue(new Error('toast failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sendSystemNote('desktop', note, vi.fn())).toBe(true);
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Android は JS から送らない（常駐サービスが出す）', () => {
  it('送らず false を返す（Notification も invoke も使わない）', () => {
    expect(sendSystemNote('android', note, vi.fn())).toBe(false);
    expect(FakeNotification.last).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
