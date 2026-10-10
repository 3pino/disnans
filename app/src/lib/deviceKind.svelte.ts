import { getItem, setItem } from './storage';

// この端末の種類（アイコン用）。端末ごとの設定で、サーバーには送らない（storage の localStorage に置く）
// まだ使っている場所はない。使うときは deviceKind.value を読む（リアクティブ）

export const DEVICE_KINDS = ['smartphone', 'tablet', 'laptop', 'monitor'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  smartphone: 'スマートフォン',
  tablet: 'タブレット',
  laptop: 'ノートPC',
  monitor: 'デスクトップ',
};

const KEY = 'disnans.deviceKind';

/** 保存した値を読む。知らない値・空は null */
export function normalizeDeviceKind(raw: unknown): DeviceKind | null {
  return typeof raw === 'string' && (DEVICE_KINDS as readonly string[]).includes(raw) ? (raw as DeviceKind) : null;
}

/** 初めて開いたときの推測。Android はスマートフォン、それ以外はノート PC */
export function guessDeviceKind(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): DeviceKind {
  return /android/i.test(userAgent) ? 'smartphone' : 'laptop';
}

class DeviceKindStore {
  private current = $state<DeviceKind>(normalizeDeviceKind(getItem(KEY)) ?? guessDeviceKind());

  /** この端末の種類（リアクティブ） */
  get value(): DeviceKind {
    return this.current;
  }

  /** 変える。null で推測に戻す */
  set(kind: DeviceKind | null): void {
    this.current = kind ?? guessDeviceKind();
    setItem(KEY, kind);
  }
}

export const deviceKind = new DeviceKindStore();
