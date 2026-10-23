// 画面の遷移の履歴（ブラウザの履歴のようなもの）。純粋な関数だけを置き、状態は ui ストア（stores/ui.svelte.ts）が持つ。
// 画面を開く操作は「開く前の状態」を履歴に積み、戻る操作は1つ取り出してその状態に戻す。
// 履歴が尽きたら、いまの状態から1段ずつ閉じる（検索 → パネル → 設定のサブページ → チャット以外のタブ）。
// チャットのトップで何も開いていなければ、戻る先はない（Android ではアプリが裏に回る）

/** 右側のパネル（モバイルでは全画面）。返信のツリー、メッセージの集合（timeline。lib/stores/timelinePanel.svelte.ts）、プラグインの view */
export type Panel =
  | { kind: 'replyTree'; messageId: string }
  | { kind: 'timeline'; id: number }
  | { kind: 'plugin'; plugin: string; view: string; sessionId: string }
  | null;

/** 設定の中のサブページ（一覧の代わりに出す）。入力欄のキー・ホットキー・ナビゲーションバー・＋メニュー・通話 */
export type SettingsSubpage = 'enterKeys' | 'hotkeys' | 'navBar' | 'composerMenu' | 'call' | 'devices';

/** ナビゲーションバーのタブ（チャット・設定・通話） */
export type NavTab = 'chat' | 'settings' | 'call';

/** 履歴に積む画面の状態。画像の全画面とプラグインの層（ui.onBack）は、履歴とは別に一番上で扱う */
export type NavState = {
  tab: NavTab;
  settingsSub: SettingsSubpage | null;
  pluginSettings: string | null;
  panel: Panel;
  searchOpen: boolean;
};

/**
 * 開く操作の積み方。
 * - push: いまの状態を積む（普通の画面の移動）
 * - replace: 積まずに置き換える（画面のボタンで閉じるなど）
 * - reset: 履歴を捨てる（ナビゲーションバーのタブの切り替え。チャット以外のタブなら、戻るとチャットのトップへ）
 * どれも、行き先が履歴の中にあれば、そこまで戻ったことにする（A → B → A を繰り返しても積み上がらない）
 */
export type NavMode = 'push' | 'replace' | 'reset';

/** チャットのトップ（何も開いていない） */
export const HOME: NavState = { tab: 'chat', settingsSub: null, pluginSettings: null, panel: null, searchOpen: false };

/** 履歴の上限（古いものから捨てる） */
export const NAV_LIMIT = 50;

/** 設定のタブの外では、設定のサブページとプラグインの設定画面は持たない。プラグインの設定画面とサブページは同時に開かない */
export function normalizeNav(s: NavState): NavState {
  const inSettings = s.tab === 'settings';
  const pluginSettings = inSettings ? s.pluginSettings : null;
  return { ...s, pluginSettings, settingsSub: inSettings && !pluginSettings ? s.settingsSub : null };
}

export function samePanel(a: Panel, b: Panel): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'replyTree':
      return a.messageId === (b as typeof a).messageId;
    case 'timeline':
      return a.id === (b as typeof a).id;
    case 'plugin': {
      const o = b as typeof a;
      return a.plugin === o.plugin && a.view === o.view && a.sessionId === o.sessionId;
    }
  }
}

export function sameNav(a: NavState, b: NavState): boolean {
  const x = normalizeNav(a);
  const y = normalizeNav(b);
  return x.tab === y.tab && x.settingsSub === y.settingsSub && x.pluginSettings === y.pluginSettings && x.searchOpen === y.searchOpen && samePanel(x.panel, y.panel);
}

/** from から to へ移るときの、新しい履歴 */
export function navigate(stack: readonly NavState[], from: NavState, to: NavState, mode: NavMode = 'push'): NavState[] {
  if (mode === 'reset') return normalizeNav(to).tab === 'chat' ? [] : [HOME];
  if (sameNav(from, to)) return [...stack];
  // 行き先がすでに履歴にあれば、そこまで戻ったことにする
  for (let i = stack.length - 1; i >= 0; i--) if (sameNav(stack[i], to)) return stack.slice(0, i);
  if (mode === 'replace') return [...stack];
  return [...stack, normalizeNav(from)].slice(-NAV_LIMIT);
}

/** 履歴が尽きたときの戻り先（いまの状態の、1段上）。チャットのトップなら null */
export function parentNav(cur: NavState): NavState | null {
  const s = normalizeNav(cur);
  if (s.searchOpen) return { ...s, searchOpen: false };
  if (s.panel) return { ...s, panel: null };
  if (s.pluginSettings || s.settingsSub) return { ...s, pluginSettings: null, settingsSub: null };
  if (s.tab !== 'chat') return { ...s, tab: 'chat' };
  return null;
}

/** 戻る操作の行き先と、そのあとの履歴。戻る先がなければ null（いまと同じ状態の履歴は飛ばす） */
export function navBack(stack: readonly NavState[], cur: NavState): { stack: NavState[]; to: NavState } | null {
  const st = [...stack];
  while (st.length > 0) {
    const e = st.pop()!;
    if (!sameNav(e, cur)) return { stack: st, to: normalizeNav(e) };
  }
  const p = parentNav(cur);
  return p ? { stack: [], to: p } : null;
}

/** 戻る操作を何回できるか（Android の履歴の深さをこれに合わせる） */
export function navBackDepth(stack: readonly NavState[], cur: NavState): number {
  let n = 0;
  let st: readonly NavState[] = stack;
  let c = cur;
  // 1回ごとに履歴か状態の段が減るので必ず止まるが、念のため上限を置く
  for (let guard = stack.length + 8; guard > 0; guard--) {
    const r = navBack(st, c);
    if (!r) break;
    n++;
    st = r.stack;
    c = r.to;
  }
  return n;
}

/** 消えたパネル（削除されたスレッド・閉じたタイムラインなど）を履歴から外す。外したあとに続けて同じになった状態は1つにまとめる */
export function forgetPanelIn(stack: readonly NavState[], match: (p: NonNullable<Panel>) => boolean): NavState[] {
  const out: NavState[] = [];
  for (const e of stack) {
    const s = e.panel && match(e.panel) ? { ...e, panel: null } : e;
    if (out.length > 0 && sameNav(out[out.length - 1], s)) continue;
    out.push(s);
  }
  return out;
}
