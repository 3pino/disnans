import { prefs } from '../stores/prefs.svelte';
import { deviceSettings } from '../stores/deviceSettings.svelte';
import { DEFAULT_CALL_SETTINGS, parseCallSettings, type CallSettingsData } from './pure';
import { CALL_DEVICE_KEYS, CALL_USER_KEYS } from '../settingsModel';

// 通話の設定。機器によらない項目はユーザーごと（prefs）、入力・出力の機器は端末ごと（deviceSettings）に保存する

/** 通話の設定の保存先（本体では prefs と deviceSettings。テストでは手元の値に差し替える） */
export type CallSettingsSource = {
  /** ユーザーごとの値（機器の項目は含まない） */
  user(): Partial<CallSettingsData>;
  /** この端末の機器の値 */
  device(): { inputId: string; output: unknown };
  setUser(patch: Partial<CallSettingsData>): void;
  setDevice(key: (typeof CALL_DEVICE_KEYS)[number], value: unknown): void;
};

const liveSource: CallSettingsSource = {
  user: () => prefs.callUser,
  device: () => ({ inputId: deviceSettings.inputId, output: deviceSettings.output }),
  setUser: (p) => prefs.setCallUser(p),
  setDevice: (k, v) => deviceSettings.set(k, v),
};

/** 手元の値だけで動く保存先（テスト用） */
export function createCallSource(init: Partial<CallSettingsData> = {}): CallSettingsSource {
  const state: CallSettingsData = { ...DEFAULT_CALL_SETTINGS, ...init };
  return {
    user: () => state,
    device: () => ({ inputId: state.inputId, output: state.output }),
    setUser: (p) => Object.assign(state, p),
    setDevice: (k, v) => Object.assign(state, { [k]: v }),
  };
}

export class CallSettings {
  /** 音量のスライダーを動かしている間の仮の値（離したときに保存する） */
  private draft = $state<Partial<CallSettingsData>>({});

  constructor(private src: CallSettingsSource = liveSource) {}

  /** いまの設定（保存済みの値に、動かしている途中の値を重ねたもの） */
  get value(): CallSettingsData {
    const d = this.src.device();
    const saved = parseCallSettings({ ...this.src.user(), inputId: d.inputId, output: d.output });
    return { ...saved, ...this.draft };
  }

  /** 設定を変えて保存する */
  patch(p: Partial<CallSettingsData>): void {
    this.draft = {};
    const user: Partial<CallSettingsData> = {};
    for (const k of CALL_USER_KEYS) if (k in p) (user as Record<string, unknown>)[k] = p[k];
    if (Object.keys(user).length > 0) this.src.setUser(user);
    for (const k of CALL_DEVICE_KEYS) if (k in p) this.src.setDevice(k, p[k] ?? null);
  }

  /** 音量のスライダーを動かしている間は反映だけして、離したときに保存する */
  preview(p: Partial<CallSettingsData>): void {
    this.draft = { ...this.draft, ...p };
  }

  /** 仮の値を保存する */
  save(): void {
    const d = this.draft;
    this.patch(d);
  }

  reset(): void {
    this.patch({ ...DEFAULT_CALL_SETTINGS });
  }
}

export const callSettings = new CallSettings();
