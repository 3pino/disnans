import { isTauri, osName } from '../platform';
import { getItem, setItem } from '../storage';
import { devUser, getServerUrl } from '../config';
import { createDeviceApi, type DeviceApi } from '../transport/device';
import { tauriInvoke } from '../transport/tauri';
import type { OrientationMode } from '../orientation';
import { DEVICE_DEFAULTS, fillDeviceDefaults, legacyDeviceValues, reportSettingsError, type Raw } from '../settingsModel';
import { createRefreshGate } from '../refreshGate';

/** デバイスごとの設定の起動時キャッシュ（サーバーの値を受けるたびに書き直す。起動直後に使える） */
export const DEVICE_CACHE_KEY = 'disnans.devicePrefs';
/** このデバイスの名前（このデバイスだけ。登録のときに送る） */
export const DEVICE_NAME_KEY = 'disnans.deviceName';

/** デバイスの名前の既定（OS の名前。ホスト名は取れないので付けない。後で変えられる） */
export function defaultDeviceName(os: string): string {
  switch (os) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'android':
      return 'Android';
    case 'macos':
      return 'macOS';
    case 'ios':
      return 'iOS';
    default:
      return 'このデバイス';
  }
}

export type DeviceDeps = {
  /** Tauri のときだけ（ブラウザ版は localStorage だけで動く） */
  api: DeviceApi | null;
  get: (key: string) => string | null;
  set: (key: string, value: string | null) => void;
  defaultName: () => string;
  /** 時刻（ミリ秒）。読み直しの間引きに使う。省くと Date.now */
  now?: () => number;
};

/**
 * デバイスごとの設定（`/api/me/devices/{id}/prefs`）。このデバイスの ID で読み書きする。
 * 起動時にデバイスを登録し、設定を読む。値が無いときは、以前の localStorage の値を一度だけ取り込む（サーバーに無いときだけ）。
 * ほかのデバイスの変更はイベントで届かないので、起動時と設定画面を開いたとき（refresh）に読み直す。
 * 書き込みは順番に送り、キャッシュ（localStorage）にも残す。
 */
export class DeviceSettings {
  /** 表示と保存に使う設定（Rust が正規化したもの。キャッシュ → サーバーの順に置き換わる。書き込みは全体を送り、Rust が正規化する） */
  raw = $state.raw<Raw>({ ...DEVICE_DEFAULTS });
  /** 起動時の読み込みが済んだか（サーバーを使わない環境では、すぐ true） */
  ready = $state(false);

  private id: string | null = null;
  private started = false;
  private queue: Promise<void> = Promise.resolve();
  /** 送っていない（送信中の）書き込みの数 */
  private pending = 0;
  private listeners = new Set<() => void>();
  private gate: { allow(): boolean };

  constructor(private deps: DeviceDeps) {
    this.gate = createRefreshGate(deps.now);
    let cached: unknown = null;
    try {
      cached = JSON.parse(deps.get(DEVICE_CACHE_KEY) ?? 'null') as unknown;
    } catch {
      cached = null;
    }
    // キャッシュが無ければ、以前の localStorage の値から始める（取り込みは start で、サーバーに無いときに行う）
    const base = cached !== null && typeof cached === 'object' ? cached : legacyDeviceValues(deps.get);
    this.raw = fillDeviceDefaults(base as Raw);
  }

  // ---- 値（リアクティブ） ----

  get inputId(): string {
    return typeof this.raw.inputId === 'string' ? this.raw.inputId : '';
  }
  get output(): Raw | null {
    const o = this.raw.output;
    return o && typeof o === 'object' ? (o as Raw) : null;
  }
  get deviceKind(): string | null {
    return typeof this.raw.deviceKind === 'string' ? this.raw.deviceKind : null;
  }
  get hideNavigationBar(): boolean {
    return this.raw.hideNavigationBar === true;
  }
  get orientation(): OrientationMode {
    return this.raw.orientation as OrientationMode;
  }
  get pluginsDisabled(): string[] {
    return this.raw.pluginsDisabled as string[];
  }
  get pluginsDevDir(): string | null {
    return typeof this.raw.pluginsDevDir === 'string' ? this.raw.pluginsDevDir : null;
  }

  /** 値が変わったとき（読み込み・変更のあと）に呼ぶ関数を登録する。返り値で外す */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** このデバイスの名前（保存したもの。なければ OS の名前） */
  deviceName(): string {
    const saved = this.deps.get(DEVICE_NAME_KEY)?.trim();
    return saved ? saved : this.deps.defaultName();
  }

  // ---- 変更 ----

  /** 1項目を変えて保存する（キャッシュにはすぐ残す。サーバーへは順番に送る） */
  set(key: string, value: unknown): void {
    this.commit({ ...this.raw, [key]: value });
  }

  /** このデバイスの名前を変える（登録し直す）。空なら OS の名前に戻す */
  async renameDevice(name: string): Promise<void> {
    const trimmed = name.trim();
    // 失敗を呼び出し側へ返す。先にローカル名を変えると、失敗しても
    // 次の起動の登録でその名前を再送してしまうため、成功してから保存する。
    if (this.deps.api && this.id) {
      await this.deps.api.register(this.id, trimmed || this.deps.defaultName());
    }
    this.deps.set(DEVICE_NAME_KEY, trimmed === '' ? null : trimmed);
  }

  // ---- 読み込み ----

  /** 起動のあとに1回呼ぶ。デバイスを登録し、設定を読む（無ければ、いまの値を送って作る） */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const api = this.deps.api;
    if (!api) {
      this.ready = true;
      return;
    }
    try {
      const id = await api.id();
      this.id = id;
      await api.register(id, this.deviceName());
      const view = await api.read(id);
      if (view.saved) this.apply(view.prefs);
      else this.commit(this.raw);
    } catch (e) {
      reportSettingsError(`デバイスの設定を読めませんでした: ${errorText(e)}`);
    } finally {
      this.ready = true;
    }
  }

  /**
   * サーバーから読み直す（設定画面を開いたとき、ウィンドウに戻ったとき）。
   * 書き込みの途中は読まない。最短 REFRESH_MIN_MS の間隔（それより頻繁な呼び出しは何もしない）。
   * quiet なら、失敗を利用者に知らせず記録だけにする（オフラインで戻ったときの連続の通知を避ける）。
   */
  async refresh(opts: { quiet?: boolean } = {}): Promise<void> {
    const api = this.deps.api;
    if (!api || !this.id || this.pending > 0) return;
    if (!this.gate.allow()) return;
    try {
      const view = await api.read(this.id);
      if (this.pending === 0 && view.saved) this.apply(view.prefs);
    } catch (e) {
      if (opts.quiet) console.warn('デバイスの設定を読めませんでした', e);
      else reportSettingsError(`デバイスの設定を読めませんでした: ${errorText(e)}`);
    }
  }

  // ---- 内部 ----

  private apply(prefs: unknown): void {
    this.raw = fillDeviceDefaults(prefs as Raw);
    this.deps.set(DEVICE_CACHE_KEY, JSON.stringify(this.raw));
    this.notify();
  }

  private commit(next: Raw): void {
    this.raw = next;
    this.deps.set(DEVICE_CACHE_KEY, JSON.stringify(next));
    this.notify();
    if (this.deps.api && this.id) this.push(next);
  }

  /** 書き込みを順番に送る。送っている間に、さらに変えていなければ、サーバーの返事に合わせる */
  private push(body: Raw): void {
    const api = this.deps.api;
    const id = this.id;
    if (!api || !id) return;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        const view = await api.write(id, body);
        if (this.pending === 1 && this.raw === body) this.apply(view.prefs);
      } catch (e) {
        reportSettingsError(`デバイスの設定を保存できませんでした: ${errorText(e)}`);
      } finally {
        this.pending--;
      }
    });
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('デバイスの設定の購読で例外', e);
      }
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function realDeps(): DeviceDeps {
  return {
    api: isTauri() ? createDeviceApi(tauriInvoke, { server: () => getServerUrl(), devUser }) : null,
    get: (key) => getItem(key),
    set: (key, value) => setItem(key, value),
    defaultName: () => defaultDeviceName(osName()),
  };
}

export const deviceSettings = new DeviceSettings(realDeps());
