import { vi } from 'vitest';
import type { ScreenShareView } from '../lib/call/screen/view';

/** Shell の実際の共有ビューを動かす試験の口。コマンド起動や音声・画像取得は行わない。 */
export const state = $state({ paletteOpen: false, screen: null as ScreenShareView | null });
export const commands = {
  get paletteOpen() { return state.paletteOpen; },
  set paletteOpen(value: boolean) { state.paletteOpen = value; },
  start: vi.fn(),
};
export const call = {
  joined: true, pending: false, joining: false, deafened: false, participants: [],
  barButtons: [], topBarButtons: [], panels: [], outputs: [],
  get screen() { return state.screen; },
  refreshOutputs: vi.fn(async () => {}), chooseOutput: vi.fn(),
  toggleDeafen: vi.fn(), leave: vi.fn(),
};
