// 戻る操作（Android の戻るボタン）で、開いているものを上から1つずつ閉じる。
// Android の WebView は、戻るボタンで履歴を戻る（戻れなければアプリが裏に回る）。
// そこで、閉じられるもの（層）の数だけ履歴を積み、履歴の深さ（state の DEPTH_KEY）と層の数をいつもそろえる。
// 画面のボタンで閉じたときは、その分だけ履歴を戻す

const DEPTH_KEY = 'disnansDepth';

export type BackNav = {
  /** 層の数が変わったら呼ぶ。履歴を積むか戻して、深さを合わせる */
  sync(): void;
  stop(): void;
};

type HistoryLike = Pick<History, 'state' | 'pushState' | 'go'>;
type EventTargetLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;

function depthOf(state: unknown): number {
  const d = (state as Record<string, unknown> | null)?.[DEPTH_KEY];
  return typeof d === 'number' && d > 0 ? d : 0;
}

/** layers は閉じる関数の配列（下から順）。戻る操作のたびに、履歴の深さより上の層を閉じる */
export function startBackNav(layers: () => (() => void)[], h: HistoryLike = history, w: EventTargetLike = window): BackNav {
  let depth = depthOf(h.state);
  /** 自分で履歴を戻している最中。終わったら（popstate）合わせ直す */
  let going = false;

  function sync(): void {
    if (going) return;
    const want = layers().length;
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
    // 戻る操作。上の層から閉じる
    const ls = layers();
    for (let i = ls.length - 1; i >= depth; i--) ls[i]();
    // 進む操作などで、層より深くなったときは戻す
    sync();
  }

  w.addEventListener('popstate', onPop);
  return {
    sync,
    stop: () => w.removeEventListener('popstate', onPop),
  };
}

/** PC の Alt+←（戻る）かどうか。Ctrl・Cmd・Shift を一緒に押していれば違う操作なので除く */
export function isBackKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>): boolean {
  return e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing;
}

/** 戻る操作で、上の層を1つだけ閉じる（Android の戻るボタンと同じ順）。閉じたものがあれば true */
export function closeTopLayer(layers: (() => void)[]): boolean {
  const top = layers.at(-1);
  if (!top) return false;
  top();
  return true;
}
