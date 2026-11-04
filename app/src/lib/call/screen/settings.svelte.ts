/**
 * 画面共有の設定（デバイスごと）の入口。UI と通話の機能はここだけを読む（.value・.patch・.subscribe）。
 *
 * - 保存先: デバイスの設定 `screenShare`（Rust が正規化する。null は未設定）。
 * - 未設定のあいだは、旧い画面共有プラグインの保存先（localStorage）の値を読む（起動直後・サーバー未着でも効く）。
 * - 移行: サーバーの値を読めたあと、保存先が未設定で旧い値があれば、一度だけ保存先へ書く。旧い値は消さない。
 * - 既定（未設定かつ旧い値なし）は 5 fps・720p・フルカラー。自動では画面を取らない（設定を変えるだけ）。
 */
import type { ScreenSettingsPort, ScreenSettingsValue } from './types';
import { legacyScreenShare } from '../../settingsModel';
import { DeviceSettings, deviceSettings } from '../../stores/deviceSettings.svelte';
import { getItem } from '../../storage';

export const SCREEN_SETTINGS_DEFAULT: Readonly<ScreenSettingsValue> = Object.freeze({ fps: 5, quality: 'p720', color: 'full' });

/** 保存先の口（デバイスの設定、またはテスト用の簡単な実装） */
export type ScreenShareSource = {
  /** 保存された値。null は未設定（まだ選ばれていない・移行前） */
  readonly stored: ScreenSettingsValue | null;
  /** サーバーの値を読み終えたか（読めていない間は移行しない） */
  readonly synced: boolean;
  write(value: ScreenSettingsValue): void;
  subscribe(fn: () => void): () => void;
};

function isScreenValue(v: unknown): v is ScreenSettingsValue {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o.fps === 5 || o.fps === 20) && (o.quality === 'p480' || o.quality === 'p720' || o.quality === 'p1080') && (o.color === 'full' || o.color === 'c256' || o.color === 'gray');
}

export class ScreenShareSettings implements ScreenSettingsPort {
  private readonly legacyValue: ScreenSettingsValue | null;

  /** legacy: 旧い画面共有プラグインの値（無ければ null）。作るときに一度だけ読む */
  constructor(
    private readonly src: ScreenShareSource,
    legacy: ScreenSettingsValue | null,
  ) {
    this.legacyValue = legacy;
    src.subscribe(() => this.migrate());
    this.migrate();
  }

  /** 今の値（保存 → 旧い値 → 既定の順）。読むだけで、画面も権限も触らない */
  get value(): ScreenSettingsValue {
    return this.src.stored ?? this.legacyValue ?? SCREEN_SETTINGS_DEFAULT;
  }

  /** 一部だけ変える。今の値（旧い値を含む）に足して保存する */
  patch(patch: Partial<ScreenSettingsValue>): void {
    this.src.write({ ...this.value, ...patch });
  }

  subscribe(fn: () => void): () => void {
    return this.src.subscribe(fn);
  }

  /** サーバーの値を読めたあと、保存先が未設定で旧い値があるときだけ、一度書く（既存の保存先の値は上書きしない） */
  private migrate(): void {
    if (!this.src.synced || this.src.stored !== null || this.legacyValue === null) return;
    this.src.write(this.legacyValue);
  }
}

/** デバイスの設定を保存先にする */
export function screenShareSourceOf(ds: DeviceSettings): ScreenShareSource {
  return {
    get stored() {
      const v = ds.raw.screenShare;
      return isScreenValue(v) ? v : null;
    },
    get synced() {
      return ds.synced;
    },
    write: (value) => ds.set('screenShare', value),
    subscribe: (fn) => ds.subscribe(fn),
  };
}

/** テスト用の保存先（書いた値を覚える。synced は外から変える） */
export function simpleSettingsSource(init: { stored?: ScreenSettingsValue | null; synced?: boolean } = {}) {
  let stored: ScreenSettingsValue | null = init.stored ?? null;
  let synced = init.synced ?? false;
  const listeners = new Set<() => void>();
  const writes: ScreenSettingsValue[] = [];
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    get stored() {
      return stored;
    },
    get synced() {
      return synced;
    },
    writes,
    write(value: ScreenSettingsValue) {
      writes.push(value);
      stored = value;
      notify();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setSynced(v: boolean) {
      synced = v;
      notify();
    },
  } satisfies ScreenShareSource & { writes: ScreenSettingsValue[]; setSynced(v: boolean): void };
}

/** アプリの画面共有の設定（デバイスの設定 + 旧い値の移行） */
export const screenShareSettings = new ScreenShareSettings(screenShareSourceOf(deviceSettings), legacyScreenShare(getItem));
