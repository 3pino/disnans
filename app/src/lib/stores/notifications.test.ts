// デスクトップの押下（Rust の desktop-notification-clicked）→ openTarget（チャットを表示）が 1 回だけ起きることを、store で確かめる。
// init は 1 回だけ購読する（何度呼んでも二重に付かない）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listen: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  showMain: vi.fn(),
  backend: 'desktop' as 'desktop' | 'android' | 'web',
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: h.listen }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: h.isPermissionGranted,
  requestPermission: h.requestPermission,
}));
vi.mock('../platform', () => ({ capabilities: () => ({ notifyBackend: h.backend }) }));
vi.mock('../api', () => ({ api: {} }));
vi.mock('../config', () => ({ getServerUrl: () => 'http://127.0.0.1:8080' }));
vi.mock('./ui.svelte', () => ({ ui: { showMain: h.showMain, toast: vi.fn(), isMobile: false, tab: 'chat' } }));

/** 試験ごとに新しい store を読む（store は 1 つだけのシングルトンで、init の 1 回だけの購読を確かめるため） */
async function freshStore() {
  vi.resetModules();
  const { notifications } = await import('./notifications.svelte');
  return notifications;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listen.mockResolvedValue(() => {});
  h.isPermissionGranted.mockResolvedValue(true);
});

describe('デスクトップの押下（desktop-notification-clicked → openTarget）', () => {
  it('押すと openTarget（ui.showMain("never")）が 1 回呼ばれる', async () => {
    const notifications = await freshStore();
    await notifications.init();
    expect(h.listen).toHaveBeenCalledTimes(1);
    const [event, handler] = h.listen.mock.calls[0] as [string, () => void];
    expect(event).toBe('desktop-notification-clicked');
    handler();
    expect(h.showMain).toHaveBeenCalledTimes(1);
    expect(h.showMain).toHaveBeenCalledWith('never');
  });

  it('init を何度呼んでも購読は 1 回だけ（押しても openTarget は 1 回）', async () => {
    const notifications = await freshStore();
    await notifications.init();
    await notifications.init();
    await notifications.init();
    expect(h.listen).toHaveBeenCalledTimes(1);
    const handler = h.listen.mock.calls[0][1] as () => void;
    handler();
    expect(h.showMain).toHaveBeenCalledTimes(1);
  });
});
