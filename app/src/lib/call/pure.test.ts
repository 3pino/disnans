import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_SETTINGS,
  Framer,
  Resampler,
  SPEAK_HOLD_MS,
  base64ToPcm,
  byteLevel,
  clampVolume,
  diffPeers,
  floatToInt16,
  int16ToFloat,
  normalizeDevice,
  notificationContent,
  parseCallSettings,
  pcmToBase64,
  pickOutput,
  rms,
  scheduleFrame,
  statusBadges,
  updateSpeaking,
} from './pure';
import { describeDevices } from '../plugins/audio';

describe('音量と出力先', () => {
  it('clampVolume は範囲に収め、数でなければ既定値', () => {
    expect(clampVolume(3, 2)).toBe(2);
    expect(clampVolume(-1, 2)).toBe(0);
    expect(clampVolume(0.5, 1)).toBe(0.5);
    expect(clampVolume('x', 2, 1)).toBe(1);
    expect(clampVolume(NaN, 2, 0.7)).toBe(0.7);
  });

  it('pickOutput は ID、なければ同じ種類と名前、なければ同じ種類で探す', () => {
    const outs = [
      { id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: false },
      { id: 'bluetooth:9', label: 'Bluetooth（X）', kind: 'bluetooth', selected: false },
      { id: 'bluetooth:12', label: 'Bluetooth（Y）', kind: 'bluetooth', selected: false },
    ];
    expect(pickOutput(outs, null)).toBeNull();
    expect(pickOutput(outs, { id: 'speaker', kind: 'speaker', label: 'スピーカー' })?.id).toBe('speaker');
    expect(pickOutput(outs, { id: 'bluetooth:3', kind: 'bluetooth', label: 'Bluetooth（Y）' })?.id).toBe('bluetooth:12');
    expect(pickOutput(outs, { id: 'bluetooth:3', kind: 'bluetooth', label: 'Z' })?.id).toBe('bluetooth:9');
    expect(pickOutput(outs, { id: 'wired:1', kind: 'wired', label: 'イヤホン' })).toBeNull();
    expect(pickOutput(outs, { id: 'abc', kind: 'other', label: 'abc' })).toBeNull();
  });

  it('describeDevices は default を実機器と重ねず、名前のない機器に仮の名前を付ける', () => {
    const dev = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label }) as MediaDeviceInfo;
    const list = [dev('audiooutput', 'default', '既定'), dev('audiooutput', 'a', 'Speakers'), dev('audiooutput', 'b', ''), dev('audioinput', 'm', 'Mic')];
    expect(describeDevices(list, 'audiooutput', '出力')).toEqual([
      { id: 'a', label: 'Speakers' },
      { id: 'b', label: '出力 2' },
    ]);
    expect(describeDevices([dev('audiooutput', 'default', '')], 'audiooutput', '出力')).toEqual([{ id: 'default', label: '出力' }]);
    expect(describeDevices([], 'audioinput', '入力')).toEqual([]);
  });
});

describe('設定の読み込み', () => {
  it('壊れた値・足りない値は既定値にし、範囲外は丸める', () => {
    expect(parseCallSettings(null)).toEqual(DEFAULT_CALL_SETTINGS);
    expect(parseCallSettings('x')).toEqual(DEFAULT_CALL_SETTINGS);
    const s = parseCallSettings({
      stun: 'stun:a', // 古い保存値は無視する
      relayOnly: true,
      joinMuted: true,
      micVolume: 9,
      outVolume: -1,
      inputId: 5,
      output: { id: 'speaker', kind: 'speaker', label: 'スピーカー' },
    });
    expect(s).toEqual({ joinMuted: true, micVolume: 2, outVolume: 0, inputId: '', output: { id: 'speaker', kind: 'speaker', label: 'スピーカー' } });
    expect(parseCallSettings({ output: { id: 1 } }).output).toBeNull();
  });
});

describe('参加者の増減', () => {
  it('diffPeers は自分を除いた増減を返す', () => {
    expect(diffPeers(['a', 'b'], ['b', 'c', 'me'], 'me')).toEqual({ added: ['c'], removed: ['a'] });
    expect(diffPeers([], [], 'me')).toEqual({ added: [], removed: [] });
  });
});

describe('参加者の表示', () => {
  it('statusBadges はミュート・スピーカーミュート・自分の側の消音を並べる', () => {
    expect(statusBadges({ muted: false, deafened: false }, false)).toEqual([]);
    expect(statusBadges({ muted: true, deafened: true }, true)).toEqual(['muted', 'deafened', 'local-muted']);
    expect(statusBadges({ muted: false, deafened: true }, false)).toEqual(['deafened']);
  });

  it('normalizeDevice は知っている種類だけ通す', () => {
    expect(normalizeDevice('laptop')).toBe('laptop');
    expect(normalizeDevice('monitor')).toBe('monitor');
    expect(normalizeDevice('toaster')).toBeNull();
    expect(normalizeDevice(null)).toBeNull();
  });

  it('通知の文言とボタンは状態で変わる', () => {
    const a = notificationContent({ muted: false, deafened: false, count: 3 });
    expect(a.text).toBe('通話中 ・ 3人');
    expect(a.actions.map((x) => [x.id, x.title])).toEqual([
      ['mute', 'ミュート'],
      ['deafen', 'スピーカーミュート'],
      ['hangup', '切断'],
    ]);
    const b = notificationContent({ muted: true, deafened: true, count: 1 });
    expect(b.text).toBe('ミュート中・スピーカーミュート中 ・ 1人');
    expect(b.actions[0].title).toBe('ミュート解除');
    expect(b.actions[1].title).toBe('スピーカー解除');
  });

  it('updateSpeaking は大きい音で光り、しばらく保ち、変わったときだけ true', () => {
    const st = { lastLoud: 0, speaking: false };
    expect(updateSpeaking(st, 0.5, 1000, false)).toBe(true);
    expect(updateSpeaking(st, 0, 1000 + SPEAK_HOLD_MS - 1, false)).toBe(false);
    expect(st.speaking).toBe(true);
    expect(updateSpeaking(st, 0, 1000 + SPEAK_HOLD_MS + 1, false)).toBe(true);
    expect(st.speaking).toBe(false);
    // ミュート中は大きい音でも光らない
    expect(updateSpeaking(st, 0.5, 5000, true)).toBe(false);
  });

  it('byteLevel は無音で 0', () => {
    expect(byteLevel(new Uint8Array(8).fill(128))).toBe(0);
    expect(byteLevel(new Uint8Array(0))).toBe(0);
    expect(byteLevel(Uint8Array.from([255, 1]))).toBeGreaterThan(0.9);
  });
});

describe('リレー音声', () => {
  it('Resampler は 48kHz→16kHz で長さが約 1/3 になり、チャンクを分けても同じ結果', () => {
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 50));
    const whole = new Resampler(48000).push(input);
    expect(Math.abs(whole.length - 1600)).toBeLessThanOrEqual(1);
    const r = new Resampler(48000);
    const parts = [r.push(input.subarray(0, 1000)), r.push(input.subarray(1000, 3333)), r.push(input.subarray(3333))];
    const joined = Float32Array.from(parts.flatMap((p) => [...p]));
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(joined[i]).toBeCloseTo(whole[i]!, 5);
  });

  it('Framer は指定の長さずつに分け、余りは次に持ち越す', () => {
    const f = new Framer(4);
    expect(f.push(new Float32Array(3))).toHaveLength(0);
    const out = f.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(out).toHaveLength(3);
    expect([...out[0]!]).toEqual([0, 0, 0, 1]);
  });

  it('PCM の変換と base64 は往復できて、壊れた入力は null', () => {
    const f = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const pcm = floatToInt16(f);
    expect(pcm[3]).toBe(32767);
    expect(pcm[4]).toBe(-32768);
    expect(pcm[5]).toBe(32767); // 範囲を超えたら丸める
    const back = int16ToFloat(base64ToPcm(pcmToBase64(pcm))!);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(base64ToPcm('!!')).toBeNull();
    expect(base64ToPcm('QQ==')).toBeNull(); // 1バイト
    expect(base64ToPcm(5)).toBeNull();
    expect(base64ToPcm('A'.repeat(9000))).toBeNull();
    expect(rms(new Float32Array(4))).toBe(0);
    expect(rms(Float32Array.from([1, -1]))).toBe(1);
  });

  it('scheduleFrame は最初と空になったときにためてから鳴らし、続きは隙間なく、ためすぎは捨てる', () => {
    const st = { next: 0 };
    expect(scheduleFrame(st, 10, 0.05)).toBeCloseTo(10.12);
    expect(scheduleFrame(st, 10.01, 0.05)).toBeCloseTo(10.17);
    expect(scheduleFrame(st, 11, 0.05)).toBeCloseTo(11.12);
    st.next = 12;
    expect(scheduleFrame(st, 11, 0.05)).toBeNull();
  });
});
