// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: 'desktop' as 'desktop' | 'android' | null,
  check: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock('../platform', () => ({ capabilities: () => ({ updater: mocks.platform }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage = null; } }));
const { Updater } = await import('./updater.svelte');

function desktop(version: string) {
  return { version, body: null, close: vi.fn(async () => {}), downloadAndInstall: vi.fn(async () => {}) };
}
function release(version: string) {
  return new Response(JSON.stringify({
    tag_name: `v${version}`,
    body: version,
    assets: [{ name: 'universal.apk', browser_download_url: `https://example.test/${version}.apk` }],
  }), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.check.mockReset();
  mocks.invoke.mockReset();
  mocks.platform = 'desktop';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('最新版を確認し直してから更新する', () => {
  it('desktop: 通知が 0.2.1 でも、インストール時の 0.2.2 を入れる。古いリソースは解放する', async () => {
    const old = desktop('0.2.1');
    const latest = desktop('0.2.2');
    mocks.check.mockResolvedValueOnce(old).mockResolvedValueOnce(latest);
    const u = new Updater();
    await u.check();
    expect(u.state).toMatchObject({ kind: 'available', version: '0.2.1' });
    expect(old.close).toHaveBeenCalledOnce();
    await u.install();
    expect(old.downloadAndInstall).not.toHaveBeenCalled();
    expect(latest.downloadAndInstall).toHaveBeenCalledOnce();
    expect(latest.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it('配信が消えた場合は古い版を取得しない', async () => {
    const old = desktop('0.2.1');
    mocks.check.mockResolvedValueOnce(old).mockResolvedValueOnce(null);
    const u = new Updater();
    await u.check();
    await u.install();
    expect(u.state).toEqual({ kind: 'latest' });
    expect(old.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('再確認が失敗したらエラーを出し、古い URL にフォールバックしない', async () => {
    const old = desktop('0.2.1');
    mocks.check.mockResolvedValueOnce(old).mockRejectedValueOnce(new Error('offline'));
    const u = new Updater();
    await u.check();
    await u.install();
    expect(u.state).toEqual({ kind: 'error', message: 'offline' });
    expect(old.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('ダウンロード失敗も解放し、勝手に再送しない', async () => {
    const update = desktop('0.2.2');
    update.downloadAndInstall.mockRejectedValueOnce(new Error('404'));
    mocks.check.mockResolvedValue(update);
    const u = new Updater();
    u.state = { kind: 'available', version: '0.2.1', notes: null };
    await u.install();
    expect(u.state).toEqual({ kind: 'error', message: '404' });
    expect(update.close).toHaveBeenCalledOnce();
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it('Android: 通知後の新しい APK を選ぶ。許可画面から戻ったときも再確認する', async () => {
    mocks.platform = 'android';
    const fetcher = vi.fn().mockResolvedValueOnce(release('0.2.1'))
      .mockResolvedValueOnce(release('0.2.2')).mockResolvedValueOnce(release('0.2.3'));
    vi.stubGlobal('fetch', fetcher);
    let allowed = false;
    mocks.invoke.mockImplementation(async (cmd: string) => cmd.endsWith('can_install') ? { granted: allowed } : undefined);
    const u = new Updater();
    await u.check();
    expect(u.state).toMatchObject({ kind: 'available', version: '0.2.1' });
    await u.install();
    expect(u.state).toEqual({ kind: 'permission' });
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:apk-updater|open_install_settings');
    allowed = true;
    await u.install();
    const downloads = mocks.invoke.mock.calls.filter(([cmd]) => cmd.endsWith('download_and_install'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0][1]).toMatchObject({ url: 'https://example.test/0.2.3.apk' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, opts]) => opts.cache === 'no-store')).toBe(true);
  });

  it('二重押し・確認の重なりで二重取得や状態の巻き戻りが起きない', async () => {
    const old = desktop('0.2.1');
    const latest = desktop('0.2.2');
    let resolve!: (value: typeof latest) => void;
    mocks.check.mockResolvedValueOnce(old).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const u = new Updater();
    await u.check();
    const installing = u.install();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    await Promise.all([u.install(), u.check()]);
    resolve(latest);
    await installing;
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(latest.downloadAndInstall).toHaveBeenCalledOnce();
    expect(u.state).toEqual({ kind: 'installing' });
  });
});
