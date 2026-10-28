// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tauri: false,
  mount: vi.fn(() => ({ mounted: true })),
  installDiagLog: vi.fn(),
}));
vi.mock('svelte', () => ({ mount: h.mount }));
vi.mock('./App.svelte', () => ({ default: {} }));
vi.mock('./lib/platform', () => ({ isTauri: () => h.tauri }));
vi.mock('./lib/diagLog', () => ({ installDiagLog: h.installDiagLog }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.tauri = false;
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { document.body.innerHTML = ''; });

describe('アプリの起動環境', () => {
  it('ブラウザー単体では案内だけを出し、アプリを起動しない', async () => {
    const { default: app } = await import('./main');
    expect(app).toBeNull();
    expect(h.mount).not.toHaveBeenCalled();
    expect(document.getElementById('app')?.textContent).toContain('Windows・Linux・Android');
  });

  it('Tauri では診断を準備してからアプリを起動する', async () => {
    h.tauri = true;
    const { default: app } = await import('./main');
    expect(app).toEqual({ mounted: true });
    expect(h.mount).toHaveBeenCalledWith(expect.anything(), { target: document.getElementById('app') });
    expect(h.installDiagLog.mock.invocationCallOrder[0]).toBeLessThan(h.mount.mock.invocationCallOrder[0]);
  });
});
