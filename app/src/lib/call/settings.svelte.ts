import { prefs } from '../stores/prefs.svelte';
import { deviceSettings } from '../stores/deviceSettings.svelte';
import { DEFAULT_CALL_SETTINGS, type CallSettingsData } from './pure';
import { CALL_DEVICE_KEYS, CALL_USER_KEYS } from '../settingsModel';

// 通話の設定。機器によらない項目はユーザーごと（prefs）、入力・出力の機器はデバイスごと（deviceSettings）に保存する

/** 通話の設定の保存先（本体では prefs と deviceSettings。テストでは手元の値に差し替える） */
export type CallSettingsSource = {
  /** ユーザーごとの値（機器の項目は含まない） */
  user(): Partial<CallSettingsData>;
  /** このデバイスの機器の値 */
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

  private listeners = new Set<(kind: 'preview' | 'save') => void>();

  constructor(private src: CallSettingsSource = liveSource) {}

  /** 設定が変わったとき（保存 save・動かしている途中の反映 preview）に呼ばれる。戻り値の関数で外す */
  onChange(fn: (kind: 'preview' | 'save') => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private notify(kind: 'preview' | 'save'): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind);
      } catch {
        console.error('[call] 設定の変更の通知で例外');
      }
    }
  }

  /** いまの設定（保存済みの値に、動かしている途中の値を重ねたもの） */
  get value(): CallSettingsData {
    const d = this.src.device();
    // 値は Rust が正規化したもの（prefs・deviceSettings）。ここでは重ねるだけ
    const saved: CallSettingsData = { ...DEFAULT_CALL_SETTINGS, ...this.src.user(), inputId: d.inputId, output: d.output as CallSettingsData['output'] };
    return { ...saved, ...this.draft };
  }

  /** 設定を変えて保存する */
  patch(p: Partial<CallSettingsData>): void {
    this.draft = {};
    const user: Partial<CallSettingsData> = {};
    for (const k of CALL_USER_KEYS) if (k in p) (user as Record<string, unknown>)[k] = p[k];
    if (Object.keys(user).length > 0) this.src.setUser(user);
    for (const k of CALL_DEVICE_KEYS) if (k in p) this.src.setDevice(k, p[k] ?? null);
    this.notify('save');
  }

  /** 音量のスライダーを動かしている間は反映だけして、離したときに保存する */
  preview(p: Partial<CallSettingsData>): void {
    this.draft = { ...this.draft, ...p };
    this.notify('preview');
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
