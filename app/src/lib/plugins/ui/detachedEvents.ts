// まだ document につながっていない要素（プラグインが作って、付ける前・または付けずにテストしているもの）でも、押す・入力するが効くようにする。
//
// Svelte の部品は、click・input・change などを「イベントの委譲」で受ける: 部品を載せた入れ物（mount の target）と document が受け手で、
// 要素に付いたハンドラを、イベントの通り道をたどって呼ぶ。部品の要素をプラグインへ渡すと入れ物から外れ、document にもつながっていない間は、受け手がいなくなる。
// そこで、つながっていない間だけ、要素自身が受け手になり、同じ印（Svelte がハンドラを置く場所）をたどって呼ぶ。
// つながったあとは Svelte の受け手が呼ぶので、ここは何もしない。
//
// Svelte の中の約束（要素のシンボル Symbol('events') の下にハンドラを置く）に頼るので、見つからなければ何もしない（つながった要素は影響を受けない）。
// ui.mount.test.ts が、この約束が今の Svelte で成り立つことを確かめる

const EVENTS = ['click', 'input', 'change'] as const;

type Handlers = Record<string, ((e: Event) => void) | undefined>;

/** Svelte が、委譲するハンドラを置いている場所（要素の Symbol('events')）。なければ undefined */
function handlersOf(node: object): Handlers | undefined {
  for (const s of Object.getOwnPropertySymbols(node)) {
    if (s.description !== 'events') continue;
    const v = (node as Record<symbol, unknown>)[s];
    if (v !== null && typeof v === 'object') return v as Handlers;
  }
  return undefined;
}

/** イベントごとに、もう呼んだ要素（入れ子の部品が、外側の受け手からもう一度呼ばれないように） */
const handled = new WeakMap<Event, Set<object>>();

export function bridgeDetachedEvents(el: Element): void {
  for (const type of EVENTS) {
    // capture: 外へ伝わらないイベント（バブリングしない合成のイベント）も、通り道にある要素のハンドラへ届ける
    el.addEventListener(type, (e) => {
      if (el.isConnected) return;
      let seen = handled.get(e);
      if (!seen) handled.set(e, (seen = new Set()));
      try {
        for (const node of e.composedPath()) {
          if (!seen.has(node)) {
            seen.add(node);
            const h = handlersOf(node)?.[type];
            // 押せない要素には、ブラウザも送らない
            if (h && !(node as { disabled?: boolean }).disabled) {
              Object.defineProperty(e, 'currentTarget', { configurable: true, get: () => node });
              try {
                h.call(node, e);
              } catch (err) {
                // 1 つの失敗で、ほかのハンドラを止めない（Svelte の受け手と同じ）
                setTimeout(() => {
                  throw err;
                });
              }
            }
          }
          if (e.cancelBubble || node === el) break;
        }
      } finally {
        delete (e as { currentTarget?: unknown }).currentTarget;
      }
    }, true);
  }
}
