import { vi } from 'vitest';
import type { ScreenShareView } from '../../lib/call/screen/view';
import type { ScreenSharer } from '../../lib/call/screen/types';

/** 画面共有の偽物（テスト用）。値は作るたびに新しく。変えたら、部品を作り直して確かめる */
export function fakeScreen(over: Partial<ScreenShareView> = {}): ScreenShareView & Record<string, ReturnType<typeof vi.fn>> {
  const settingsValue = { fps: 5 as const, quality: 'p720' as const, color: 'full' as const };
  return {
    sharing: false,
    starting: false,
    source: 'screen',
    switching: false,
    canSwitchCamera: false,
    canScreen: true,
    canCamera: true,
    localStream: null,
    localFrame: null,
    sharers: [] as ScreenSharer[],
    viewerOpen: false,
    selectedPeer: null,
    settings: { value: settingsValue, patch: vi.fn(), subscribe: vi.fn(() => () => {}) },
    toggleScreen: vi.fn(async () => {}),
    toggleCamera: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    stop: vi.fn(),
    openViewer: vi.fn(),
    closeViewer: vi.fn(),
    selectPeer: vi.fn(),
    ...over,
  } as ScreenShareView & Record<string, ReturnType<typeof vi.fn>>;
}

export const sharer = (peer: string, over: Partial<ScreenSharer> = {}): ScreenSharer => ({
  peer,
  userId: `user-${peer}`,
  source: 'screen',
  dataUrl: 'data:image/jpeg;base64,/9j/QUJDRA==',
  lastSeen: 0,
  ...over,
});
