// 設定の木（lib/uiTree.ts）の Field と、GUI のストアをつなぐ。木は値を持たないので、ここで読み書きの先を決める。
// key は view::ui の Field.key（DEFINITIONS のキー・`enterKeys.enter` のようなオブジェクトの中の項目・派生の項目）と同じ。
// TUI は同じ key を prefs の JSON から直接読み書きする（crates/cli/src/tui/settings.rs）

import { devUser } from './config';
import { isAndroid, isTauri } from './platform';
import { ENTER_COMBOS, enterComboLabel, type EnterAction, type EnterCombo } from './enterKeys';
import { limiterStrength, limiterStrengthPatch, type LimiterStrength } from './call/pure';
import type { OrientationMode } from './orientation';
import type { ThemeChoice } from './settingsModel';
import type { GuiEnv, UiField } from './uiTree';
import { prefs } from './stores/prefs.svelte';
import { ui } from './stores/ui.svelte';
import { orientation } from './stores/orientation.svelte';
import { callSettings } from './call/settings.svelte';
import { call } from './call/instance.svelte';

/** Field の読み書き。`preview` があれば、動かしている間（Slider）はそれを呼び、離したときに `set` を呼ぶ */
export type FieldBinding = {
  get(): unknown;
  set(value: unknown): void;
  preview?(value: unknown): void;
};

/** いまの GUI の環境（木の Show の判断に使う） */
export function guiEnv(): GuiEnv {
  return { tauri: isTauri(), android: isAndroid(), devUser: !!devUser };
}

function volume(key: 'micVolume' | 'outVolume'): FieldBinding {
  const preview = (v: unknown) => {
    callSettings.preview({ [key]: Number(v) });
    if (key === 'micVolume') call.applyMicVolume();
    else call.applyOutVolume();
  };
  return {
    get: () => callSettings.value[key],
    preview,
    set: (v) => {
      preview(v);
      callSettings.save();
    },
  };
}

const BINDINGS: Record<string, FieldBinding> = {
  theme: { get: () => prefs.theme, set: (v) => prefs.setTheme(v as ThemeChoice) },
  orientation: { get: () => orientation.mode, set: (v) => orientation.set(v as OrientationMode) },
  hideNavigationBar: { get: () => ui.hideNavigationBar, set: (v) => ui.setHideNavigationBar(!!v) },
  joinMuted: { get: () => callSettings.value.joinMuted, set: (v) => callSettings.patch({ joinMuted: !!v }) },
  micVolume: volume('micVolume'),
  outVolume: volume('outVolume'),
  limiterStrength: {
    get: () => limiterStrength(callSettings.value),
    set: (v) => callSettings.patch(limiterStrengthPatch(v as LimiterStrength)),
  },
  ...Object.fromEntries(
    ENTER_COMBOS.map((combo): [string, FieldBinding] => [
      `enterKeys.${combo}`,
      { get: () => prefs.enterKeys[combo], set: (v) => prefs.setEnterAction(combo, v as EnterAction) },
    ]),
  ),
};

/** Field の読み書きの先。無ければ null（木に足した項目の配線忘れ。テストで確かめる） */
export function fieldBinding(key: string): FieldBinding | null {
  return BINDINGS[key] ?? null;
}

/** 配線済みの key（テスト用） */
export const BOUND_KEYS: readonly string[] = Object.keys(BINDINGS);

/** 画面の名前。木の文言を使い、環境で変わるものだけ直す（Enter の組み合わせの表記など） */
export function fieldLabel(field: UiField): string {
  if (field.key.startsWith('enterKeys.')) return enterComboLabel(field.key.slice('enterKeys.'.length) as EnterCombo);
  return field.label;
}
