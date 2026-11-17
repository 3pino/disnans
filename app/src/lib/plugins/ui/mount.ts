// disnans.ui の部品を、共有の UI 部品（@3pino/ui-kit-web の Svelte の部品）を mount して作るための道具。
// プラグインには、できあがった DOM の要素を渡す。Svelte の外で使われる要素なので、次のことをここで決める:
//  - 中身（文字・プラグインの要素）の入れ方: 文字は文字として（Slot.svelte）。要素は印を描いて、載せ終わったあとに入れ替える
//  - 後始末: mount したものは unmount しないと、Svelte が持つ購読（アイコンの更新・イベントの受け口）が残る。
//    重ねて出すもの（メニュー・モーダル）は ui.ts が明示的に閉じる。ふつうの要素は、画面から外れたものを時間をおいて片付ける（下の「registry」）

import { flushSync, mount, unmount, untrack, type Component } from 'svelte';
import { bridgeDetachedEvents } from './detachedEvents';

// ---- 中身の要素の入れ替え ----

const pendingNodes = new Map<string, Node>();
let nodeSeq = 0;

/** Slot.svelte が、プラグインの要素の置き場所の印に付ける名前 */
export function nodeKey(node: Node): string {
  const key = `n${++nodeSeq}`;
  pendingNodes.set(key, node);
  return key;
}

function resolveSlots(scope: ParentNode): void {
  for (const t of scope.querySelectorAll<HTMLTemplateElement>('template[data-plugin-node]')) {
    const node = pendingNodes.get(t.dataset.pluginNode ?? '');
    pendingNodes.delete(t.dataset.pluginNode ?? '');
    if (node) t.replaceWith(node);
    else t.remove();
  }
}

/**
 * Svelte は class を「btn  primary」のように空白が重なる形で出すことがある。プラグインが class を読む・比べるので、1 つの空白にそろえる（見た目は変わらない）。
 * 中身（プラグインの要素）を入れる前に行う
 */
function tidyClasses(root: Element): void {
  for (const el of [root, ...root.querySelectorAll('[class]')]) {
    const c = el.getAttribute('class');
    if (c === null) continue;
    const t = c.replace(/\s+/g, ' ').trim();
    if (t !== c) el.setAttribute('class', t);
  }
}

// ---- mount ----

type App = ReturnType<typeof mount>;

export type Mounted<E extends Element> = {
  /** 部品ができた要素（置き場所の入れ物から外してある） */
  el: E;
  /** 後始末（unmount）。要素は残る（その時の見た目のまま、状態の切り替えだけが止まる） */
  dispose(): void;
};

function run(Comp: Component<any>, props: Record<string, unknown>, target: HTMLElement): App {
  const before = new Set(target.children);
  // 呼び出しが Svelte の効果の中（view の組み立てなど）でも、その効果の依存にしない
  const app = untrack(() => mount(Comp, { target, props }));
  // 載せたもの（target に増えた要素）だけをきれいにする（target が body のときも、ほかには触らない）
  for (const child of target.children) if (!before.has(child)) tidyClasses(child);
  resolveSlots(target);
  try {
    // 効果（アイコンを描く・メニューの位置を測る・フォーカス）を、いま走らせる。効果の中から呼ばれたときは走らせられないので、次の更新に任せる
    flushSync();
  } catch {
    /* 効果の中: そのまま */
  }
  return app;
}

/** 要素を 1 つ作る部品を mount し、できた要素を返す（登録して、画面から外れたら片付ける） */
export function mountElement<E extends Element = HTMLElement>(Comp: Component<any>, props: Record<string, unknown> = {}): Mounted<E> {
  const host = document.createElement('div');
  const app = run(Comp, props, host);
  const el = host.firstElementChild as E | null;
  if (!el) {
    void unmount(app);
    throw new Error('部品が何も描きませんでした');
  }
  el.remove();
  bridgeDetachedEvents(el);
  const entry: Entry = { el, app, created: Date.now(), seen: false, off: null };
  register(entry);
  return { el, dispose: () => release(entry) };
}

/** 重ねて出すもの（メニュー・モーダル）を target の中に mount する。後始末は、呼んだ側が dispose する */
export function mountOverlay(Comp: Component<any>, props: Record<string, unknown>, target: HTMLElement): { dispose(): void } {
  const app = run(Comp, props, target);
  return { dispose: () => void unmount(app) };
}

// ---- registry: 画面から外れた要素の片付け ----
// プラグインが要素を `el.remove()` で外しても、Svelte の購読は残る。そこで、作った要素を覚えておき、
// 一度は画面（document）につながったあと 30 秒以上つながっていないものは unmount する（プラグインを外したときは、すぐに）。
// 一度もつながらないままのものは、5 分たったら。unmount したあとも要素は残り、押したときのコールバックは呼ばれるが、見た目の切り替え（トグルの表示など）は止まる

const SWEEP_MS = 10_000;
const DETACHED_MS = 30_000;
const NEVER_ATTACHED_MS = 5 * 60_000;

type Entry = { el: Element; app: App; created: number; seen: boolean; off: number | null };

const entries = new Set<Entry>();
let timer: ReturnType<typeof setInterval> | undefined;

function register(entry: Entry): void {
  entries.add(entry);
  // 作ってすぐに付けるのがふつう。付いたのを早めに見つけておく（付けて、すぐ外したものも片付けられる）
  queueMicrotask(() => {
    if (entry.el.isConnected) entry.seen = true;
  });
  timer ??= setInterval(() => sweep(), SWEEP_MS);
}

function release(entry: Entry): void {
  if (!entries.delete(entry)) return;
  if (entries.size === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  const { el } = entry;
  const parent = el.parentNode;
  const next = el.nextSibling;
  try {
    void unmount(entry.app);
  } catch (e) {
    console.error('[plugin ui] unmount で例外', e);
  }
  // 部品によっては、unmount が要素ごと外す。プラグインの木の中に残す
  if (parent && el.parentNode !== parent) parent.insertBefore(el, next && next.parentNode === parent ? next : null);
}

/**
 * 片付ける。now を省くと、いま。画面につながったことがあり、いまは外れているもの（graceMs 以上）と、
 * 一度もつながらないままのもの（NEVER_ATTACHED_MS 以上）を unmount する
 */
export function sweep(now = Date.now(), graceMs = DETACHED_MS): void {
  for (const e of [...entries]) {
    if (e.el.isConnected) {
      e.seen = true;
      e.off = null;
    } else if (e.seen) {
      e.off ??= now;
      if (now - e.off >= graceMs) release(e);
    } else if (now - e.created >= NEVER_ATTACHED_MS) {
      release(e);
    }
  }
}

/** プラグインを外したとき: 画面から外れたもの（つながったことがあるもの）を、待たずに片付ける */
export function releaseDetached(): void {
  for (const e of [...entries]) {
    if (e.el.isConnected) {
      e.seen = true;
      e.off = null;
    } else if (e.seen) release(e);
  }
}

/** 覚えている要素の数（試験用） */
export function mountedCount(): number {
  return entries.size;
}

/** すべて片付ける（試験用） */
export function releaseAll(): void {
  for (const e of [...entries]) release(e);
}
