// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyServerUrl, canonicalServerUrl, getServerUrl, normalizeServerUrl, setServerUrl } from './config';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setServerUrl(null);
});

describe('devUser（開発用。リリースでは使わない）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
  });

  it('DEV のとき、?dev_user で別ユーザーになり、X-Dev-User を送る', async () => {
    vi.stubEnv('DEV', true);
    window.history.replaceState({}, '', '/?dev_user=alice');
    vi.resetModules();
    const cfg = await import('./config');
    expect(cfg.devUser).toBe('alice');
    expect(cfg.authHeaders()).toEqual({ 'X-Dev-User': 'alice' });
  });

  it('リリースでは ?dev_user も sessionStorage の値も無視し、ヘッダーを送らない', async () => {
    vi.stubEnv('DEV', false);
    window.history.replaceState({}, '', '/?dev_user=alice');
    sessionStorage.setItem('disnans.devUser', 'bob');
    vi.resetModules();
    const cfg = await import('./config');
    expect(cfg.devUser).toBeNull();
    expect(cfg.authHeaders()).toEqual({});
    // リリースでは保存にも触れない
    expect(sessionStorage.getItem('disnans.devUser')).toBe('bob');
  });
});

describe('normalizeServerUrl', () => {
  it('スキームを補い、末尾のスラッシュを取る', () => {
    expect(normalizeServerUrl(' homeserver:8080/ ')).toBe('http://homeserver:8080');
    expect(normalizeServerUrl('https://a.b')).toBe('https://a.b');
  });

  it('全角で入力されたアドレスを半角にする', () => {
    expect(normalizeServerUrl('ｈｔｔｐ：／／１００．６４．０．１：８０８０')).toBe('http://100.64.0.1:8080');
  });

  it('canonicalizes desktop URLs like the shared core while keeping browser normalization unchanged', () => {
    expect(canonicalServerUrl('HTTP://HOST:80/')).toBe('http://host');
    expect(canonicalServerUrl('https://Bücher.Example:443/Base Path/')).toBe('https://xn--bcher-kva.example/Base%20Path');
    expect(canonicalServerUrl('ｈｔｔｐ：／／１００．６４．０．１：８０８０')).toBe('http://100.64.0.1:8080');
    expect(normalizeServerUrl('HTTP://HOST:80/')).toBe('HTTP://HOST:80');
  });

  it('keeps the legacy getter live after a synchronous browser/Android save', () => {
    setServerUrl('HTTP://HOST:80/');
    expect(getServerUrl()).toBe('HTTP://HOST:80');
    localStorage.setItem('disnans.server', 'http://other.example');
    expect(getServerUrl()).toBe('http://other.example');
  });

  it('does not report an unsaved legacy URL as the active value after a storage failure', () => {
    localStorage.setItem('disnans.server', 'http://old.example');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    setServerUrl('http://new.example');
    expect(getServerUrl()).toBe('http://old.example');
  });

  it('applies a canonical URL to desktop memory without touching legacy normalization', () => {
    applyServerUrl('HTTP://HOST:80/');
    expect(getServerUrl()).toBe('http://host');
    applyServerUrl('');
  });
});
