// feedback-ui-check.mjs 用。本物の CallView に、通話の状態だけの偽物を渡す（lib/call/instance.svelte の代わりに vite で差し替える）。
// マイク・音声・ネットワーク・撮影には到達しない。
import type { ScreenShareView } from '../src/lib/call/screen/view';

export const fixtureState = $state({ screen: null as ScreenShareView | null, joined: true, people: [] as unknown[] });
const noop = () => {};
export const call = {
  get joined() { return fixtureState.joined; },
  pending: false,
  joining: false,
  deafened: false,
  get participants() { return fixtureState.people as never[]; },
  barButtons: [],
  topBarButtons: [],
  panels: [],
  outputs: [],
  get screen() { return fixtureState.screen; },
  refreshOutputs: async () => {},
  chooseOutput: noop,
  toggleDeafen: noop,
  toggleMute: noop,
  toggleLocalMute: noop,
  kick: async () => {},
  join: async () => {},
  leave: noop,
  addPanel: noop,
  panelMounted: noop,
};
// 他の部品（プラグインのホスト・コマンド）が読み込む名前。この確認では使われない
export const callApi = {};
export function startCall(): void {}
