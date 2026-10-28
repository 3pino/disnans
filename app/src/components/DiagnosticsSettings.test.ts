// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiagnosticsSettings from './DiagnosticsSettings.svelte';

const h = vi.hoisted(() => ({
  android: false,
  build: vi.fn(async () => 'diagnostic report'),
  export: vi.fn(async (_text: string) => false),
  clear: vi.fn(async () => {}),
  copy: vi.fn(async (_text: string) => true),
  confirm: vi.fn(async (_opts: unknown) => true),
  toast: vi.fn(),
}));
vi.mock('../lib/diagLog', () => ({ buildDiagReport: h.build, exportDiagReport: h.export, clearDiagLog: h.clear }));
vi.mock('../lib/clipboard', () => ({ copyText: h.copy }));
vi.mock('../lib/config', () => ({ getServerUrl: () => 'http://test.invalid' }));
vi.mock('../lib/platform', () => ({ isAndroid: () => h.android, capabilities: () => ({}) }));
vi.mock('../lib/stores/client.svelte', () => ({ client: { me: null, status: 'open', linkReason: '' } }));
vi.mock('../lib/stores/notifications.svelte', () => ({ notifications: { backend: 'desktop', permission: 'granted' } }));
vi.mock('../lib/stores/ui.svelte', () => ({ ui: { confirm: h.confirm, toast: h.toast } }));
vi.mock('../lib/stores/updater.svelte', () => ({ updater: { version: '0.2.48', supported: true, loadVersion: async () => {} } }));

let instance: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.android = false;
  h.export.mockResolvedValue(false);
  h.confirm.mockResolvedValue(true);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  document.body.innerHTML = '';
});
function render() { instance = mount(DiagnosticsSettings, { target: document.body }); flushSync(); }
function button(selector: string) { return document.querySelector<HTMLButtonElement>(selector)!; }

describe('診断ログの設定行', () => {
  it.each([false, true])('標準の「ログ」行で操作を表示する（Android=%s）', (android) => {
    h.android = android;
    render();
    expect(document.querySelector('.setting-row-name')?.textContent).toBe('ログ');
    expect(document.querySelector('.diagnostics-text')).toBeNull();
    expect(button('.diagnostics-send').textContent?.trim()).toBe(android ? '送る' : '保存');
    expect(button('.diagnostics-copy').textContent?.trim()).toBe('コピー');
    const clear = button('.diagnostics-clear');
    expect(clear.getAttribute('aria-label')).toBe('ログを消去');
    expect(clear.textContent?.trim()).toBe('');
    expect(clear.querySelector('svg')).not.toBeNull();
  });

  it('書き出しの間は操作を無効にし、終わったら戻す', async () => {
    let finish!: (shared: boolean) => void;
    h.export.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render();
    button('.diagnostics-send').click();
    await vi.waitFor(() => expect(h.export).toHaveBeenCalledWith('diagnostic report'));
    flushSync();
    expect([...document.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    finish(false);
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledWith('ログを保存しました'));
    flushSync();
    expect([...document.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
  });

  it('レポートをコピーできる', async () => {
    render();
    button('.diagnostics-copy').click();
    await vi.waitFor(() => expect(h.copy).toHaveBeenCalledWith('diagnostic report'));
  });

  it('ゴミ箱は確認が承認されたときだけ消去する', async () => {
    h.confirm.mockResolvedValueOnce(false);
    render();
    button('.diagnostics-clear').click();
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.clear).not.toHaveBeenCalled();
    button('.diagnostics-clear').click();
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
  });
});
