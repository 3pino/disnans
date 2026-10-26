// 戻る操作（Android の戻るボタン）を、アプリの遷移の履歴（ui.back。lib/navHistory.ts）につなぐ。
// Android の WebView は、戻るボタンで履歴を戻る（戻れなければアプリが裏に回る）。
// そこで、戻れる回数（ui.backDepth）だけ WebView の履歴を積み、履歴の深さ（state の DEPTH_KEY）といつもそろえる。
// 画面のボタンで戻ったり閉じたりしたときは、その分だけ履歴を戻す

const DEPTH_KEY = 'disnansDepth';

export type BackNav = {
  /** 戻れる回数が変わったら呼ぶ。履歴を積むか戻して、深さを合わせる */
  sync(): void;
  stop(): void;
};

type HistoryLike = Pick<History, 'state' | 'pushState' | 'go'>;
type EventTargetLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;

function depthOf(state: unknown): number {
  const d = (state as Record<string, unknown> | null)?.[DEPTH_KEY];
  return typeof d === 'number' && d > 0 ? d : 0;
}

/** 戻る先。depth は戻れる回数、back は1回戻る（戻れなければ false） */
export type BackTarget = { depth(): number; back(): boolean };

/** 戻る操作のたびに、履歴の深さになるまで target.back() で戻る */
export function startBackNav(target: BackTarget, h: HistoryLike = history, w: EventTargetLike = window): BackNav {
  let depth = depthOf(h.state);
  /** 自分で履歴を戻している最中。終わったら（popstate）合わせ直す */
  let going = false;

  function sync(): void {
    if (going) return;
    const want = target.depth();
    if (want > depth) {
      while (depth < want) h.pushState({ [DEPTH_KEY]: ++depth }, '');
    } else if (want < depth) {
      going = true;
      h.go(want - depth);
    }
  }

  function onPop(): void {
    depth = depthOf(h.state);
    if (going) {
      going = false;
      sync();
      return;
    }
    // 戻る操作。履歴の深さになるまで戻る（戻っても深さが減らないときに回り続けないよう、上限を置く）
    for (let guard = 32; guard > 0 && target.depth() > depth; guard--) if (!target.back()) break;
    // 進む操作などで、層より深くなったときは戻す
    sync();
  }

  w.addEventListener('popstate', onPop);
  return {
    sync,
    stop: () => w.removeEventListener('popstate', onPop),
  };
}

/** PC の Alt+←（戻る）かどうか。Ctrl・Meta・Shift を一緒に押していれば違う操作なので除く */
export function isBackKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>): boolean {
  return e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing;
}
