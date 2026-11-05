/** 本体の通話と画面共有が使う型。プラグインの実行環境には依存しない。 */
export type ScreenSource = 'screen' | 'camera';
export type ScreenSettingsValue = { fps: 5 | 20; quality: 'p480' | 'p720' | 'p1080'; color: 'full' | 'c256' | 'gray' };
export type ScreenSettingsPort = {
  readonly value: ScreenSettingsValue;
  patch(patch: Partial<ScreenSettingsValue>): void;
  subscribe(fn: () => void): () => void;
};
export type ScreenFrame = { data: string; mime: string; width: number; height: number };
export type ScreenSnapshot = { dataUrl: string; width: number; height: number; source: 'screen' | 'app' };
export type ScreenRelay = { frameEvent: string; stateEvent: string; queryEvent?: string; state?: Record<string, string | number | boolean> };
export type ScreenCaptureOptions = {
  maxEdge: number; quality: number; fps: number; format?: 'jpeg' | 'webp';
  color?: 'full' | 'c256' | 'gray'; diffThreshold?: number; keepaliveMs?: number;
  onEnd?: () => void; callRelay?: ScreenRelay;
};
export type ScreenCapturePort = {
  readonly supported: boolean;
  readonly supportsCallRelay?: boolean;
  start(opts: ScreenCaptureOptions, onFrame: (frame: ScreenFrame) => void): Promise<void>;
  update(patch: { quality?: number; scale?: number }): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Promise<ScreenSnapshot>;
};
export type ScreenPipPort = {
  readonly supported: boolean; readonly active: boolean;
  enter(opts?: { aspect?: { width: number; height: number } }): Promise<boolean>;
  onChange(cb: (active: boolean) => void): () => void;
};
export type ScreenCallPort = {
  readonly joined: boolean; readonly listed: boolean; readonly myPeer: string; readonly bufferedAmount: number;
  readonly participants: readonly { peer: string; userId: string; self: boolean }[];
  emit(name: string, payload: unknown): void;
};
/** 自分の共有（このデバイス）を、全画面の表示の対象にするときの印（相手の peer とは重ならない） */
export const LOCAL_VIEW = '@local';
export type ScreenSharer = { peer: string; userId: string; source: ScreenSource; dataUrl: string | null; lastSeen: number };
export type ScreenDataEvent = { peer: string; userId: string; payload: unknown };
export type ScreenShareDeps = {
  call: ScreenCallPort; capture: ScreenCapturePort; settings: ScreenSettingsPort;
  toast(text: string, kind?: 'info' | 'error'): void;
  now?: () => number;
};
