import type { UpdateState } from './stores/updater.svelte';

// アプリのアップデートを裏で確認するかどうかの判定（純粋な関数だけ。監視は updateWatch.ts）

/** 起動後の定期確認の間隔（6時間） */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** フォーカスが戻ったときに確認する、前回からの最短の間隔（1時間） */
export const UPDATE_CHECK_FOCUS_GAP_MS = 60 * 60 * 1000;

/** 確認してよい時刻か。前回の確認から gapMs 以上たっていれば true（記録がないとき、時計が戻ったときも true） */
export function isCheckDue(now: number, lastCheckedAt: number | null, gapMs: number): boolean {
  if (lastCheckedAt === null || now < lastCheckedAt) return true;
  return now - lastCheckedAt >= gapMs;
}

/** 裏で確認してよい状態か（確認中・ダウンロード・インストール中や、新しい版を見つけたままの状態では確認しない） */
export function canBackgroundCheck(state: UpdateState): boolean {
  return state.kind === 'idle' || state.kind === 'latest' || state.kind === 'error';
}

/** 新しい版があり、まだ知らせていない版なら、その版番号。なければ null */
export function versionToNotify(state: UpdateState, notifiedVersion: string | null): string | null {
  if (state.kind !== 'available') return null;
  return state.version === notifiedVersion ? null : state.version;
}
