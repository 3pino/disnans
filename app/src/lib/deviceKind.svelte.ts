import { isAndroid } from './platform';
import { deviceSettings } from './stores/deviceSettings.svelte';

// このデバイスの種類（アイコン用）。デバイスごとの設定（サーバーのデバイスの設定。キャッシュは deviceSettings）
// まだ使っている場所はない。使うときは deviceKind.value を読む（リアクティブ）

export const DEVICE_KINDS = ['smartphone', 'tablet', 'laptop', 'monitor'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  smartphone: 'スマートフォン',
  tablet: 'タブレット',
  laptop: 'ノートPC',
  monitor: 'デスクトップ',
};

/** 初めて開いたときの推測。Android はスマートフォン、それ以外はノート PC */
export function guessDeviceKind(userAgent?: string): DeviceKind {
  // 引数が無いときは、このデバイスが Android か（Rust の値があればそれ。無ければ UA。platform.ts）
  const android = userAgent === undefined ? isAndroid() : /android/i.test(userAgent);
  return android ? 'smartphone' : 'laptop';
}

class DeviceKindStore {
  /** このデバイスの種類（リアクティブ）。未設定なら推測 */
  get value(): DeviceKind {
    return (deviceSettings.deviceKind as DeviceKind | null) ?? guessDeviceKind();
  }

  /** 変える。null で推測に戻す */
  set(kind: DeviceKind | null): void {
    deviceSettings.set('deviceKind', kind);
  }
}

export const deviceKind = new DeviceKindStore();
