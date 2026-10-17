import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_SETTINGS,
  micConstraints,
  micRawFlag,
  ctxRateFlag,
  noKeepAliveFlag,
  LIMIT_LOOKAHEAD_MS,
  PeakLimiter,
  RELAY_RATE,
  Framer,
  Resampler,
  SPEAK_HOLD_MS,
  base64ToPcm,
  byteLevel,
  clampLimitDb,
  clampVolume,
  clipCurve,
  dbToLinear,
  diffPeers,
  floatToInt16,
  int16ToFloat,
  limiterStrength,
  limiterStrengthPatch,
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
    expect(s).toEqual({
      joinMuted: true,
      micVolume: 2,
      outVolume: 0,
      inputId: '',
      output: { id: 'speaker', kind: 'speaker', label: 'スピーカー' },
      limiter: true,
      limitDb: -6,
    });
    expect(parseCallSettings({ output: { id: 1 } }).output).toBeNull();
  });

  it('大きい音を抑える設定は、既定で入、上限は範囲に収める（保存値が壊れていれば既定）', () => {
    expect(DEFAULT_CALL_SETTINGS.limiter).toBe(true);
    expect(DEFAULT_CALL_SETTINGS.limitDb).toBe(-6);
    expect(parseCallSettings({ limiter: false, limitDb: -12 })).toMatchObject({ limiter: false, limitDb: -12 });
    expect(parseCallSettings({ limiter: 'no', limitDb: 'x' })).toMatchObject({ limiter: true, limitDb: -6 });
    expect(parseCallSettings({ limitDb: -40 }).limitDb).toBe(-18);
    expect(parseCallSettings({ limitDb: 5 }).limitDb).toBe(-3);
  });
});

describe('音量キャップの4段階', () => {
  it('既定・以前のオン／オフと3つの上限を引き継ぐ', () => {
    expect(limiterStrength(DEFAULT_CALL_SETTINGS)).toBe('medium');
    expect(limiterStrength(parseCallSettings({ limiter: false, limitDb: -12 }))).toBe('none');
    expect(limiterStrength(parseCallSettings({ limiter: true, limitDb: -3 }))).toBe('weak');
    expect(limiterStrength(parseCallSettings({ limiter: true, limitDb: -6 }))).toBe('medium');
    expect(limiterStrength(parseCallSettings({ limiter: true, limitDb: -12 }))).toBe('strong');
  });

  it('選択した強さの上限とオンを一緒に設定する', () => {
    for (const [level, db] of [['weak', -3], ['medium', -6], ['strong', -12]] as const) {
      const previous = parseCallSettings({ limiter: false, limitDb: -6 });
      const saved = parseCallSettings({ ...previous, ...limiterStrengthPatch(level) });
      expect(saved).toMatchObject({ limiter: true, limitDb: db });
      expect(limiterStrength(saved)).toBe(level);
    }
  });

  it('なしはオフにするが、以前の上限を消さない', () => {
    const previous = parseCallSettings({ limiter: true, limitDb: -12 });
    const saved = parseCallSettings({ ...previous, ...limiterStrengthPatch('none') });
    expect(saved).toMatchObject({ limiter: false, limitDb: -12 });
    expect(limiterStrength(saved)).toBe('none');
  });

  it('中間の保存値は近い段階で表示し、表示だけでは設定を変えない', () => {
    const saved = parseCallSettings({ limitDb: -8 });
    expect(limiterStrength(saved)).toBe('medium');
    expect(saved.limitDb).toBe(-8);
    expect(limiterStrength(parseCallSettings({ limitDb: -4 }))).toBe('weak');
    expect(limiterStrength(parseCallSettings({ limitDb: -9 }))).toBe('strong');
    expect(limiterStrength(parseCallSettings({ limitDb: NaN }))).toBe('medium');
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

describe('受け取った音の上限（リミッター）', () => {
  // 16kHz・先読み 5ms = 80 サンプル
  const L = Math.round((LIMIT_LOOKAHEAD_MS * RELAY_RATE) / 1000);
  /** 決まった並びの乱数（テストを毎回同じにする） */
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const peak = (f: Float32Array) => f.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it('dB と倍率の換算、上限の範囲', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 3);
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 6);
    expect(clampLimitDb(-6)).toBe(-6);
    expect(clampLimitDb(NaN)).toBe(-6);
    expect(clampLimitDb(-30)).toBe(-18);
    expect(clampLimitDb(0)).toBe(-3);
  });

  it('上限より小さい音は変えず、先読みの分だけ遅らせる（通常の声は素通し）', () => {
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const input = Float32Array.from({ length: 4000 }, (_, i) => 0.3 * Math.sin(i / 7));
    const out = lim.process(input);
    expect(out.length).toBe(input.length);
    for (let i = 0; i < L; i++) expect(out[i]).toBe(0); // 最初は前の音（無音）
    for (let i = L; i < input.length; i++) expect(out[i]).toBeCloseTo(input[i - L]!, 6);
  });

  it('チャンクに分けて渡しても、まとめて渡したときと同じ結果になる', () => {
    const r = rng(7);
    const input = Float32Array.from({ length: 6000 }, () => (r() * 2 - 1) * 1.4);
    const whole = new PeakLimiter(RELAY_RATE, -6).process(input);
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const parts = [lim.process(input.subarray(0, 800)), lim.process(input.subarray(800, 2345)), lim.process(input.subarray(2345))];
    const joined = Float32Array.from(parts.flatMap((p) => [...p]));
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(joined[i]).toBeCloseTo(whole[i]!, 6);
  });

  it('フルスケールの落下音（1サンプルのクリック）も上限を超えない', () => {
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const input = new Float32Array(2000);
    input[1000] = 1;
    input[1001] = -1;
    const out = lim.process(input);
    expect(peak(out)).toBeLessThanOrEqual(dbToLinear(-6) + 1e-6);
  });

  it('大きい音が続いても、どの時点でも上限以下（乱数・ふつうの声を超える音で確かめる）', () => {
    for (const db of [-3, -6, -12]) {
      const r = rng(db + 100);
      const lim = new PeakLimiter(RELAY_RATE, db);
      const ceil = dbToLinear(db);
      for (let k = 0; k < 40; k++) {
        const chunk = Float32Array.from({ length: 800 }, () => (r() * 2 - 1) * (k % 3 === 0 ? 3 : 1));
        expect(peak(lim.process(chunk))).toBeLessThanOrEqual(ceil + 1e-6);
      }
    }
  });

  it('大きい音はほぼ上限まで抑え、来る前（先読みの分）から下げ始める', () => {
    const ceil = dbToLinear(-6);
    const lim = new PeakLimiter(RELAY_RATE, -6);
    // 0.4 の音のなかに、フルスケールの1サンプルが来る（p）。先読みがあれば、その直前の 0.4 もすでに下がっている
    const p = 1500;
    const input = new Float32Array(3000).fill(0.4);
    input[p] = 1;
    const out = lim.process(input);
    expect(out[p + L - 1]!).toBeCloseTo(0.4 * ceil, 2); // 直前の音（入力 p-1）は、上限の比率まで下がっている
    expect(out[p + L]!).toBeLessThanOrEqual(ceil + 1e-6); // 大きい音そのもの
    expect(peak(out.subarray(p + L))).toBeGreaterThan(0.38);
  });

  it('上限ぎりぎりの正弦波は、上限の近くで滑らかに抑えられる（わざと頭を切らない）', () => {
    const ceil = dbToLinear(-6);
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const input = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 5));
    const out = lim.process(input);
    // 鳴っている部分の山は上限と同じ大きさ（小さく抑えすぎない）
    expect(peak(out.subarray(1000))).toBeGreaterThan(ceil * 0.97);
    expect(peak(out.subarray(1000))).toBeLessThanOrEqual(ceil + 1e-6);
  });

  it('大きい音が終わったあとは、ゆっくり元の大きさに戻る（リリース）', () => {
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const n = RELAY_RATE * 2;
    const input = new Float32Array(n).fill(0.4);
    input[100] = 1; // 1 回の大きい音で下がる
    const out = lim.process(input);
    // 大きい音の直後は下がっている
    expect(Math.abs(out[100 + L + 2]!)).toBeLessThan(0.4 * 0.95);
    // 約 2 秒後（時定数 150ms の 10 倍以上）にはほぼ元の 0.4 へ戻る
    expect(out[n - 1]!).toBeCloseTo(0.4, 3);
  });

  it('上限を変えると、次の音から反映される', () => {
    const lim = new PeakLimiter(RELAY_RATE, -6);
    const hot = Float32Array.from({ length: 4000 }, () => 1);
    lim.process(hot);
    lim.setCeilingDb(-12);
    const out = lim.process(hot);
    expect(peak(out.subarray(1000))).toBeLessThanOrEqual(dbToLinear(-12) + 1e-6);
    expect(peak(out.subarray(1000))).toBeGreaterThan(dbToLinear(-12) * 0.9);
  });

  it('合計を抑える最後の段の曲線は、上限を超えず、上限以下はそのまま', () => {
    const c = clipCurve(0.5, 5); // 入力 -1, -0.5, 0, 0.5, 1
    expect([...c]).toEqual([-0.5, -0.5, 0, 0.5, 0.5]);
    const id = clipCurve(1, 5);
    expect([...id]).toEqual([-1, -0.5, 0, 0.5, 1]);
    const big = clipCurve(dbToLinear(-6));
    expect(peak(big)).toBeLessThanOrEqual(dbToLinear(-6) + 1e-7);
    expect(big[big.length - 1]).toBeCloseTo(dbToLinear(-6), 6);
    expect(big[big.length >> 1]).toBeCloseTo(0, 3);
  });
});

describe('マイクの実験用の切り替え', () => {
  it("localStorage 'disnans.micRaw' が '1' のときだけ raw（処理を切る）", () => {
    expect(micRawFlag('1')).toBe(true);
    expect(micRawFlag(null)).toBe(false);
    expect(micRawFlag('0')).toBe(false);
    expect(micRawFlag('yes')).toBe(false);
  });

  it('既定はエコー消去・雑音抑制・自動音量を通す。raw は三つとも切る', () => {
    expect(micConstraints(false)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(micConstraints(true)).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe('通話の実験用の切り替え（時計・keep-alive・周波数）', () => {
  it('周波数は数値だけ受ける。範囲外・不正は既定（null）', () => {
    expect(ctxRateFlag('44100')).toBe(44100);
    expect(ctxRateFlag(' 48000 ')).toBe(48000);
    expect(ctxRateFlag(null)).toBeNull();
    expect(ctxRateFlag('abc')).toBeNull();
    expect(ctxRateFlag('100')).toBeNull();
    expect(ctxRateFlag('1000000')).toBeNull();
    expect(ctxRateFlag('48000.5')).toBeNull();
  });

  it("keep-alive は 'disnans.noKeepAlive'==='1' のときだけ止める", () => {
    expect(noKeepAliveFlag('1')).toBe(true);
    expect(noKeepAliveFlag(null)).toBe(false);
    expect(noKeepAliveFlag('0')).toBe(false);
  });
});
