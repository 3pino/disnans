import { isAndroid, isTauri } from '../config';

/**
 * 音の入出力の選択（API v5 の disnans.audio）。
 * Android では notifier プラグイン（Kotlin の AudioManager）で通話の出力先（受話口・スピーカー・イヤホン・Bluetooth）を切り替える。
 * デスクトップ・ブラウザーでは HTMLMediaElement.setSinkId と enumerateDevices を使う。
 * 使えない環境では一覧が空になる（プラグインは環境を知らなくてよい）。
 */
type Output = Disnans.AudioOutput;
type Input = Disnans.AudioInput;

type SinkElement = (HTMLMediaElement | AudioContext) & { setSinkId?: (id: string | { type: 'none' }) => Promise<void> };

/** setSinkId を付けた要素。出力先を変えたら全部に反映する */
const attached = new Set<SinkElement>();
/** Web で選んでいる出力先（'' は既定） */
let webSink = '';

function useNative(): boolean {
  return isTauri() && isAndroid();
}

/** enumerateDevices の結果から選択肢を作る。'default' と 'communications' は実際の機器と重なるので外す */
export function describeDevices(devices: MediaDeviceInfo[], kind: 'audioinput' | 'audiooutput', fallback: string): { id: string; label: string }[] {
  const real = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const out = real.map((d, i) => ({ id: d.deviceId, label: d.label.trim() || `${fallback} ${i + 1}` }));
  if (out.length > 0) return out;
  // 機器が1つも見えない（既定だけ）ときは、既定を1つ出す
  const def = devices.find((d) => d.kind === kind && d.deviceId === 'default');
  return def ? [{ id: 'default', label: def.label.trim() || fallback }] : [];
}

async function enumerate(): Promise<MediaDeviceInfo[]> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

function webSupportsSink(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

async function applySink(el: SinkElement): Promise<void> {
  if (typeof el.setSinkId !== 'function') return;
  try {
    await el.setSinkId(webSink);
  } catch (e) {
    console.warn('出力先を切り替えられません', e);
  }
}

async function invokeNotifier<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:notifier|${cmd}`, args);
}

export async function listOutputs(): Promise<Output[]> {
  if (useNative()) {
    try {
      const res = await invokeNotifier<{ outputs?: { id: string; label: string; kind: string }[]; current?: string | null }>('list_audio_outputs');
      return (res.outputs ?? []).map((o) => ({ id: o.id, label: o.label, kind: o.kind, selected: o.id === res.current }));
    } catch (e) {
      console.warn('出力先の一覧を取れません', e);
      return [];
    }
  }
  if (!webSupportsSink()) return [];
  const list = describeDevices(await enumerate(), 'audiooutput', '出力');
  const sel = webSink && list.some((o) => o.id === webSink) ? webSink : (list.find((o) => o.id === 'default')?.id ?? list[0]?.id);
  return list.map((o) => ({ ...o, kind: 'other', selected: o.id === sel }));
}

export async function setOutput(id: string): Promise<boolean> {
  if (useNative()) {
    try {
      const res = await invokeNotifier<{ ok?: boolean }>('set_audio_output', { id });
      return res.ok === true;
    } catch (e) {
      console.warn('出力先を切り替えられません', e);
      return false;
    }
  }
  if (!webSupportsSink()) return false;
  webSink = id === 'default' ? '' : id;
  await Promise.all([...attached].map(applySink));
  return true;
}

export async function listInputs(): Promise<Input[]> {
  if (useNative()) return [];
  return describeDevices(await enumerate(), 'audioinput', '入力');
}

/** 音を出す要素（または AudioContext）を登録する。デスクトップでは選んだ出力先に出す。Android では何もしない（端末全体の経路が切り替わる） */
export function attach(el: HTMLMediaElement | AudioContext): Disnans.Cleanup {
  if (useNative() || !webSupportsSink()) return () => {};
  const target = el as SinkElement;
  attached.add(target);
  void applySink(target);
  return () => {
    attached.delete(target);
  };
}

export const audio: Disnans.Audio = { listOutputs, setOutput, listInputs, attach };
