import type { Component } from 'svelte';

// アイコンの登録簿。名前からアイコンを引く:
//   1. 本体の独自のアイコン（disnans-logo など）
//   2. プラグインが登録したもの（addIcon、プラグインの icon.svg）
//   3. Lucide（https://lucide.dev/icons の名前。初めて使うときに別のチャンクで読み込む）
// どれも 24x24 の <svg>（stroke は currentColor、線の太さ 2、角は丸）の中身として描くので、並べても見た目がそろう

const SVG_NS = 'http://www.w3.org/2000/svg';

/** アイコンの指定。名前（文字列）か、Svelte のアイコン部品（@lucide/svelte など） */
export type IconRef = string | Component<{ size?: number; class?: string }>;

/** 登録したアイコン。body は <svg> の中身、attrs は <svg> に付ける属性（既定を上書きする） */
export type IconDef = { body: string; attrs: Record<string, string> };

/** Lucide のアイコンのデータ（lucide パッケージの形） */
type IconNode = [tag: string, attrs: Record<string, string | number>][];

/** <svg> の既定の属性（Lucide と同じ） */
const DEFAULT_ATTRS: Record<string, string> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

/** 登録された SVG から取り込まない属性（大きさ・クラスは使う側が決める） */
const SKIP_ATTRS = new Set(['width', 'height', 'class', 'style', 'xmlns', 'id']);

/** 本体の独自のアイコン（上書きできない） */
const BUILTIN: Record<string, IconDef> = {
  // アプリのロゴ（app/public/icon.svg と同じ形）。Lucide のアイコンと並べて使えるように作ってある
  'disnans-logo': {
    body: '<path d="m3.6 17.4-1.065 3.29a1 1 0 001.236 1.168l3.413-.998A10 10 0 103.6 6.4z"/>',
    attrs: {},
  },
};

/** 登録されたもの。同じ名前は後勝ちで、外すと前のものに戻る */
const registered = new Map<string, IconDef[]>();

/** 登録や Lucide の読み込みで、引ける内容が変わったら増やす（Svelte の Icon が描き直す） */
let rev = $state(0);

let lucide: Record<string, IconNode> | null = null;
let lucideLoading: Promise<void> | null = null;
let lucideError = false;

/** 引ける内容が変わるたびに変わる値。リアクティブ */
export function iconRevision(): number {
  return rev;
}

// ---- SVG の取り込み ----

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 危ないもの（script・イベント属性・javascript: のリンク）を取り除く */
function sanitize(root: Element): void {
  for (const el of [...root.querySelectorAll('script, foreignObject')]) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
}

/**
 * SVG の文字列を取り込む。`<svg>` まるごとでも、中身だけ（`<path .../>` など）でもよい。
 * まるごとのときは viewBox や fill などの属性も使う（width / height / class は使わない）
 */
export function parseIconSvg(svg: string): IconDef {
  const text = svg.trim();
  if (!text) throw new Error('アイコンの SVG が空です');
  const whole = /^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);
  const doc = new DOMParser().parseFromString(
    whole ? text : `<svg xmlns="${SVG_NS}">${text}</svg>`,
    'image/svg+xml',
  );
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('アイコンの SVG を読めません');
  }
  sanitize(root);
  const attrs: Record<string, string> = {};
  if (whole) {
    for (const a of [...root.attributes]) {
      if (SKIP_ATTRS.has(a.name) || a.name.startsWith('xmlns:')) continue;
      attrs[a.name] = a.value;
    }
  }
  const body = [...root.childNodes].map((n) => new XMLSerializer().serializeToString(n)).join('');
  return { body, attrs };
}

// ---- 登録 ----

/** 名前に使える文字（英数字・ハイフン・コロン・アンダースコア） */
export const ICON_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/;

/**
 * アイコンを登録する。svg は `<svg>` まるごとか中身だけ（24x24 の viewBox を想定）。
 * 同じ名前は後勝ち。返り値の関数で外す（外すと前のものに戻る）。本体の独自のアイコンは上書きできない
 */
export function registerIcon(name: string, svg: string | IconDef): () => void {
  if (!ICON_NAME_RE.test(name)) throw new Error(`アイコンの名前が正しくありません: ${name}`);
  if (name in BUILTIN) throw new Error(`「${name}」は本体のアイコンなので上書きできません`);
  const def = typeof svg === 'string' ? parseIconSvg(svg) : svg;
  const list = registered.get(name) ?? [];
  list.push(def);
  registered.set(name, list);
  rev++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const l = registered.get(name);
    const i = l?.indexOf(def) ?? -1;
    if (!l || i < 0) return;
    l.splice(i, 1);
    if (l.length === 0) registered.delete(name);
    rev++;
  };
}

// ---- Lucide ----

/** `message-circle` → `MessageCircle`（lucide パッケージの名前）。PascalCase はそのまま */
export function lucideKey(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
}

function nodeToBody(node: IconNode): string {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
        .join('');
      return `<${tag}${a}/>`;
    })
    .join('');
}

/** Lucide のアイコンの一覧を読み込む（別のチャンク）。何度呼んでもよい */
export function loadLucide(): Promise<void> {
  if (lucide || lucideError) return Promise.resolve();
  lucideLoading ??= import('lucide').then(
    (m) => {
      lucide = m.icons as unknown as Record<string, IconNode>;
      rev++;
      flushPending();
    },
    (e: unknown) => {
      // 読み込めなくても本体は動かす（アイコンが空になるだけ）
      console.error('[icons] Lucide のアイコンを読み込めませんでした', e);
      lucideError = true;
      lucideLoading = null;
      flushPending();
    },
  );
  return lucideLoading;
}

/** テスト用: Lucide の一覧を差し込む */
export function setLucideForTest(icons: Record<string, IconNode> | null): void {
  lucide = icons;
  lucideError = false;
  lucideLoading = null;
  rev++;
}

// ---- 引く ----

/**
 * 名前からアイコンを引く。
 * まだ Lucide を読み込んでいないときは 'pending'（読み込みを始める）、見つからなければ null
 */
export function lookupIcon(name: string): IconDef | 'pending' | null {
  const b = BUILTIN[name];
  if (b) return b;
  const r = registered.get(name);
  if (r && r.length > 0) return r[r.length - 1];
  if (!lucide) {
    if (lucideError) return null;
    void loadLucide();
    return 'pending';
  }
  const node = lucide[lucideKey(name)];
  return node ? { body: nodeToBody(node), attrs: {} } : null;
}

/** 名前でアイコンを引けるか（Lucide を読み込む前は、本体・登録したものだけを見る） */
export function hasIcon(name: string): boolean {
  const d = lookupIcon(name);
  return d !== null && d !== 'pending';
}

// ---- 描く ----

/** Lucide の読み込みを待っている <svg> */
const pending = new Map<SVGElement, string>();

function flushPending(): void {
  const list = [...pending];
  pending.clear();
  for (const [el, name] of list) if (el.dataset.icon === name) fillIcon(el, name);
}

const warned = new Set<string>();

/**
 * <svg> の中身を、名前のアイコンに入れ替える（width / height / class はそのまま）。
 * Lucide を読み込む前なら、読み込めたときに描く
 */
export function fillIcon(el: SVGElement, name: string): void {
  el.dataset.icon = name;
  const def = lookupIcon(name);
  if (def === 'pending') {
    el.replaceChildren();
    pending.set(el, name);
    return;
  }
  pending.delete(el);
  // 前のアイコンの属性を消してから付け直す
  for (const k of (el.dataset.iconAttrs ?? '').split(' ').filter(Boolean)) el.removeAttribute(k);
  const attrs = { ...DEFAULT_ATTRS, ...(def?.attrs ?? {}) };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.dataset.iconAttrs = Object.keys(attrs).join(' ');
  if (!def) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] アイコン「${name}」がありません`);
    }
    el.replaceChildren();
    return;
  }
  el.innerHTML = def.body;
}

export type IconOptions = {
  /** 大きさ（px）。既定は 24 */
  size?: number;
  class?: string;
  /** 読み上げ用の名前。省略すると飾り（aria-hidden） */
  label?: string;
};

/** 名前のアイコンの <svg> を作る（Svelte の Icon と同じ DOM） */
export function createIcon(name: string, opts: IconOptions = {}): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  const size = String(opts.size ?? 24);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('class', opts.class ? `icon ${opts.class}` : 'icon');
  if (opts.label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  fillIcon(el, name);
  return el;
}
