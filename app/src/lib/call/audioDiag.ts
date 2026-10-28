// 通話の音声経路の診断。数の集計と、1 行の書き方だけを持つ（ブラウザーの API に触らない）。
// 音声データ・本文・URL・認証情報・相手の ID は書かない。書くのは数と状態だけ。
// 要約は一定間隔（DIAG_MS）ごとだが、JS が止まると出ない。そのため、前回の要約からの経過（gapMs）を毎回書き、
// 止まっていたかは「次に出た行の経過」と「累計の差」で見分ける。

/** 要約の間隔（壁の時計の ms） */
export const DIAG_MS = 5000;

/** 要約・即時の行に出す状態（store が組み立てる） */
export type DiagState = {
  joined: boolean;
  listed: boolean;
  /** 自分以外の参加者の数（サーバーの一覧） */
  others: number;
  muted: boolean;
  deafened: boolean;
  ctxState: string;
  /** AudioContext の時計（秒）。ctx が無ければ null */
  ctxTime: number | null;
  /** getOutputTimestamp の contextTime（対応しない環境は null） */
  outTime: number | null;
  /** マイクの取り込み（worklet / ScriptProcessor）が動いているか */
  capture: boolean;
  /** マイクの track の状態（describeTrack の結果） */
  track: string;
  /** 受けている相手の接続（entries）の数 */
  entries: number;
};

/** 数える項目（書く順も決める）。ここに無い key も記録はできるが、行には出ない */
export const DIAG_LABELS: [string, string][] = [
  ['capCb', '取込'],
  ['capSamples', '取込サンプル'],
  ['capSkip.notListed', '取込後捨て:一覧外'],
  ['capSkip.noPeers', '取込後捨て:相手なし'],
  ['capSkip.noResampler', '取込後捨て:未準備'],
  ['sendMuted', '送らず:ミュート'],
  ['sendSilent', '送らず:無音'],
  ['sendTry', '送信試行'],
  ['alive', 'alive送信'],
  ['recv', '受信音声'],
  ['recvDrop.notJoined', '受信捨て:未参加'],
  ['recvDrop.noCtx', '受信捨て:ctxなし'],
  ['recvDrop.badPayload', '受信捨て:形式'],
  ['recvDrop.noPeer', '受信捨て:相手不明'],
  ['recvDrop.muted', '受信捨て:ミュート/聞かない'],
  ['recvDrop.badPcm', '受信捨て:PCM不正'],
  ['recvDrop.error', '受信捨て:例外'],
  ['play', '再生に載せた'],
  ['playDrop.late', '再生を捨てた:遅れ'],
  ['rebuild', '音の再構築'],
  ['micEvent.mute', 'マイクmute'],
  ['micEvent.unmute', 'マイクunmute'],
  ['micEvent.ended', 'マイクended'],
];

/** 0 の項目は出さない。差分（base）があれば「累計(+差分)」で書く */
export function countsText(cur: Map<string, number>, base: Map<string, number> | null): string {
  const parts: string[] = [];
  for (const [key, label] of DIAG_LABELS) {
    const v = cur.get(key) ?? 0;
    if (v === 0) continue;
    const d = base ? v - (base.get(key) ?? 0) : null;
    parts.push(d === null ? `${label}=${v}` : `${label}=${v}(+${d})`);
  }
  return parts.length > 0 ? parts.join(' ') : '(なし)';
}

/** マイクの track の状態を 1 語で（readyState / muted / enabled のみ。ID は書かない） */
export function describeTrack(t: { readyState?: string; muted?: boolean; enabled?: boolean } | undefined): string {
  if (!t) return 'なし';
  return `${t.readyState ?? '?'} muted=${t.muted ?? '?'} enabled=${t.enabled ?? '?'}`;
}

function stateText(s: DiagState): string {
  const parts = [
    `参加=${s.joined ? 'yes' : 'no'}`,
    `一覧=${s.listed ? 'yes' : 'no'}`,
    `相手=${s.others}`,
    `接続=${s.entries}`,
    `自分=ミュート:${s.muted ? 'yes' : 'no'}/聞かない:${s.deafened ? 'yes' : 'no'}`,
    `取込=${s.capture ? 'on' : 'off'}`,
    `ctx=${s.ctxState} t=${s.ctxTime === null ? '-' : s.ctxTime.toFixed(2)} 出力時刻=${s.outTime === null ? '-' : s.outTime.toFixed(2)}`,
    `マイク=${s.track}`,
  ];
  return parts.join(' ');
}

export class AudioDiag {
  private counts = new Map<string, number>();
  /** 直前の要約時点の累計（差分の基準） */
  private base: Map<string, number> | null = null;
  /** 直前の要約（無ければ開始）の壁の時刻 */
  private lastAt = 0;
  private nextAt = 0;

  /** 参加したとき。累計と基準を捨てて、開始の時刻から数え直す */
  reset(now: number): void {
    this.counts = new Map();
    this.base = null;
    this.lastAt = now;
    this.nextAt = now + DIAG_MS;
  }

  add(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** 要約の時刻になったか（JS が止まっていれば、なっても呼ばれない） */
  due(now: number): boolean {
    return now >= this.nextAt;
  }

  /** 要約の 1 行。差分の基準を今に進める */
  summary(now: number, s: DiagState): string {
    const gap = Math.round((now - this.lastAt) / 100) / 10;
    const frozen = now - this.lastAt > DIAG_MS * 2 ? ' 間隔が長い（JS が止まっていた可能性）' : '';
    const text = `[call] 診断 要約: 前回から=${gap}s${frozen} | ${stateText(s)} | ${countsText(this.counts, this.base)}`;
    this.base = new Map(this.counts);
    this.lastAt = now;
    this.nextAt = now + DIAG_MS;
    return text;
  }

  /** 即時の 1 行（参加・背景・表示・退出・音の再構築）。累計だけ書き、基準は動かさない */
  immediate(now: number, label: string, s: DiagState): string {
    const gap = Math.round((now - this.lastAt) / 100) / 10;
    return `[call] 診断 ${label}: 前回の要約から=${gap}s | ${stateText(s)} | ${countsText(this.counts, null)}`;
  }
}
