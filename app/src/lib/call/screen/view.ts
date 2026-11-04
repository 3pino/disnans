/**
 * 画面共有の UI が使う形（エンジンの公開 API の部分集合）。UI の部品はこの形だけに依存し、
 * テストでは同じ形の偽物を渡す。エンジン（store.svelte.ts）の実物もこの形を満たす。
 */
import type { ScreenFrame, ScreenSettingsPort, ScreenSharer, ScreenSource } from './types';

export type ScreenShareView = {
  readonly sharing: boolean;
  readonly starting: boolean;
  readonly source: ScreenSource;
  readonly switching: boolean;
  readonly canSwitchCamera: boolean;
  readonly canScreen: boolean;
  readonly canCamera: boolean;
  readonly localStream: MediaStream | null;
  readonly localFrame: ScreenFrame | null;
  readonly sharers: readonly ScreenSharer[];
  readonly viewerOpen: boolean;
  readonly selectedPeer: string | null;
  readonly settings: ScreenSettingsPort;
  toggleScreen(): Promise<void>;
  toggleCamera(): Promise<void>;
  switchCamera(): Promise<void>;
  stop(): void;
  openViewer(peer?: string): void;
  closeViewer(): void;
  selectPeer(peer: string): void;
};
