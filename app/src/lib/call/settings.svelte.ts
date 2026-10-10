import { getItem, setItem } from '../storage';
import { DEFAULT_CALL_SETTINGS, parseCallSettings, type CallSettingsData } from './pure';

// 通話の設定。端末ごとに保存し、同期しない（storage の localStorage）

const KEY = 'disnans.call.settings';
/** 通話がプラグイン（voice）だったころの保存先。新しい保存先が空なら、ここから引き継ぐ */
const LEGACY_KEY = 'disnans.plugin.voice.data';

function read(key: string): unknown {
  const raw = getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function load(): CallSettingsData {
  return parseCallSettings(read(KEY) ?? read(LEGACY_KEY));
}

export class CallSettings {
  value = $state<CallSettingsData>(load());

  /** 設定を変えて保存する */
  patch(p: Partial<CallSettingsData>): void {
    this.value = { ...this.value, ...p };
    this.save();
  }

  /** 音量のスライダーを動かしている間は反映だけして、離したときに保存する */
  preview(p: Partial<CallSettingsData>): void {
    this.value = { ...this.value, ...p };
  }

  save(): void {
    setItem(KEY, JSON.stringify(this.value));
  }

  reset(): void {
    this.value = { ...DEFAULT_CALL_SETTINGS };
    this.save();
  }
}

export const callSettings = new CallSettings();
