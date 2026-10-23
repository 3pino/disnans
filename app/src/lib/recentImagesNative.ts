// 最近の画像の Tauri の出どころ。コマンドの形は helper-1 の決め（notifier プラグインと Rust の recent_images）。
// Android: plugin:notifier|recent_images / request_recent_images_permission / read_image（base64）。
// デスクトップ: recent_images（許可の概念は無い）。本体は既存のパス経路（plugin-fs の readFile）で読む。

import type { RecentImage, RecentImageSource, RecentImages, RecentPermission } from './recentImages';
import { getItem, setItem } from './storage';

/** 1 件の形（Rust・Kotlin が返すもの） */
export type RecentImageInfo = {
  id: string;
  name: string;
  mime: string;
  modified: number;
  width: number | null;
  height: number | null;
  /** 長辺 256 の data URL。作れなかった形式は null */
  thumb: string | null;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * 1 件を、パネルの表示の形にする（load は押したときに読む）。
 * サムネイルが無いときは、原本を読んで blob URL にする（WebView が描けるかは <img> に任せる）
 */
export function toRecentImage(info: RecentImageInfo, load: () => Promise<File>): RecentImage {
  return {
    id: info.id,
    name: info.name,
    thumbUrl: info.thumb || null,
    load,
    preview: async () => URL.createObjectURL(await load()),
  };
}

/** base64 を、バイト列にする */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 出どころを作る。invoke と読み込みは差し替えられる（テスト用） */
export function nativeRecentImageSource(
  platform: 'android' | 'desktop',
  deps: { invoke?: Invoke; readDesktopFile?: (path: string) => Promise<Uint8Array<ArrayBuffer>> } = {},
): RecentImageSource {
  const invoke: Invoke = deps.invoke ?? defaultInvoke;
  const readDesktop = deps.readDesktopFile ?? defaultReadDesktopFile;
  const android = platform === 'android';

  const list = async (limit: number): Promise<RecentImages> => {
    if (android) {
      const res = await invoke<{ permission: RecentPermission; images: RecentImageInfo[] }>('plugin:notifier|recent_images', { limit });
      return { permission: res.permission, images: res.images.map((info) => toRecentImage(info, () => loadAndroid(info))) };
    }
    const res = await invoke<{ permission: RecentPermission; images: RecentImageInfo[] }>('recent_images', { limit });
    return { permission: res.permission, images: res.images.map((info) => toRecentImage(info, () => loadDesktop(info))) };
  };

  const loadAndroid = async (info: RecentImageInfo): Promise<File> => {
    const res = await invoke<{ name: string; mime: string; data: string }>('plugin:notifier|read_image', { id: info.id });
    return new File([base64ToBytes(res.data)], res.name || info.name, { type: res.mime || info.mime, lastModified: info.modified });
  };

  const loadDesktop = async (info: RecentImageInfo): Promise<File> => {
    const bytes = await readDesktop(info.id);
    return new File([bytes], info.name, { type: info.mime, lastModified: info.modified });
  };

  const requestPermission = async (): Promise<RecentPermission> => {
    if (!android) return 'granted';
    const res = await invoke<{ permission: RecentPermission }>('plugin:notifier|request_recent_images_permission');
    return res.permission;
  };

  return { list, requestPermission };
}

async function defaultReadDesktopFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  return new Uint8Array(await readFile(path)) as Uint8Array<ArrayBuffer>;
}

/** 初回のパネルを開いたかどうか（端末ごと。許可のダイアログを初回だけ出すため） */
const ASKED_KEY = 'disnans.recentImages.asked';

export function hasAskedRecentImages(): boolean {
  return getItem(ASKED_KEY) === '1';
}

export function markAskedRecentImages(): void {
  setItem(ASKED_KEY, '1');
}
