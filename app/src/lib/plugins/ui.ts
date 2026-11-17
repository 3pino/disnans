// disnans.ui: 本体と同じ見た目の部品を DOM の要素で渡す。
// 部品は共有の UI 部品（@3pino/ui-kit-web の Svelte の部品）を、ここで mount して作る（ui/*.svelte が、プラグインの引数を部品に渡す薄い包み）。
// 見た目の正は @3pino/design-system のクラス。ここは、プラグインから呼ばれる形（引数の確かめ・エラーの種類）と、
// 本体の機能（トースト・確認・戻る・没入）、mount したものの後始末（ui/mount.ts）をつなぐ

import Divider from '@3pino/ui-kit-web/Divider.svelte';
import Icon from '@3pino/ui-kit-web/Icon.svelte';
import { PluginError } from './errors';
import { mountElement, mountOverlay, releaseDetached } from './ui/mount';
import PButton from './ui/PButton.svelte';
import PIconButton from './ui/PIconButton.svelte';
import PInput from './ui/PInput.svelte';
import PMenu from './ui/PMenu.svelte';
import PModal from './ui/PModal.svelte';
import PNavBar from './ui/PNavBar.svelte';
import PSection from './ui/PSection.svelte';
import PSegmented from './ui/PSegmented.svelte';
import PSettingRow from './ui/PSettingRow.svelte';
import PSlider from './ui/PSlider.svelte';
import PStatusLine from './ui/PStatusLine.svelte';
import PToggle from './ui/PToggle.svelte';
import './ui.css';

export type UiDeps = {
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; ngLabel: string; danger?: boolean }): Promise<boolean>;
  /** 戻る操作（Android の戻るジェスチャーなど）で閉じる層を足す（API v9）。省くと何もしない */
  onBack?(run: () => void): () => void;
  /** 没入モード（システムバーを隠す。Android）。ネイティブで切り替えたら true（API v9） */
  setImmersive?(on: boolean): Promise<boolean>;
};

// ---- プラグインが渡す値の確かめ（文字は文字として入れる。HTML としては読まない） ----

/** disnans.ui のメソッドの、オプションの型 */
type Opts<K extends keyof Disnans.Ui> = NonNullable<Parameters<Disnans.Ui[K]>[0]>;

const invalid = (message: string): PluginError => new PluginError('invalid_argument', message);

function requireOpts<T extends object>(opts: unknown, fn: string): T {
  if (typeof opts !== 'object' || opts === null) throw invalid(`${fn} にはオプションのオブジェクトを渡してください`);
  return opts as T;
}

function requireText(v: unknown, what: string, { allowEmpty = false } = {}): string {
  if (typeof v !== 'string' || (!allowEmpty && v === '')) throw invalid(`${what} は${allowEmpty ? '' : '空でない'}文字列で渡してください`);
  return v;
}

function optText(v: unknown, what: string): string | undefined {
  return v === undefined || v === null ? undefined : requireText(v, what, { allowEmpty: true });
}

function optFn<A extends unknown[]>(v: unknown, what: string): ((...a: A) => void) | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'function') throw invalid(`${what} は関数で渡してください`);
  return v as (...a: A) => void;
}

function optBool(v: unknown): boolean | undefined {
  return v === undefined || v === null ? undefined : !!v;
}

function optNum(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${what} は数で渡してください`);
  return v;
}

/** 中身（文字・要素・その配列）。文字列は文字として入る */
function parts(v: unknown, what: string): (string | Node)[] {
  if (v === undefined || v === null) return [];
  const one = (x: unknown): string | Node => {
    if (typeof x === 'string' || x instanceof Node) return x;
    throw invalid(`${what} は文字列か要素（またはその配列）で渡してください`);
  };
  return Array.isArray(v) ? v.map(one) : [one(v)];
}

type ButtonProps = {
  text?: string;
  icon?: string;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  label?: string;
  disabled?: boolean;
  onclick?: () => void;
};

/** ui.button（と modal の actions）のオプションを、部品の引数にする。呼び方の誤りは invalid_argument */
function buttonProps(raw: unknown, fn: string): ButtonProps {
  const o = requireOpts<Opts<'button'>>(raw, fn);
  const text = o.text === undefined || o.text === null ? '' : String(o.text);
  if (!text && !o.icon) throw invalid('ui.button には text か icon を渡してください');
  if (!text && !o.label) throw invalid('アイコンだけのボタンには label（読み上げ用の名前）を渡してください');
  const onClick = o.onClick;
  return {
    text,
    icon: o.icon ? String(o.icon) : undefined,
    variant: o.variant,
    label: o.label ? String(o.label) : undefined,
    disabled: o.disabled ?? false,
    onclick: typeof onClick === 'function' ? () => onClick() : undefined,
  };
}

// ---- 重ねて出すもの（メニュー・モーダル） ----
// ui は本体に 1 つで、どのプラグインが呼んだかは分からない。そのため、開いているものをここで覚え、
// プラグインが外されたとき（本体が closePluginOverlays を呼ぶ）に、開いたままのものを全部閉じる（一時的な表示なので、開き直せる）。
// 持ち主だけを閉じたいときは、プラグインが `this.register(overlay.close)` で渡す

const openOverlays = new Set<() => void>();

/** 開いているメニュー・モーダルを、すべて閉じる（onClose は呼ばない） */
export function closePluginOverlays(): void {
  for (const close of [...openOverlays]) close();
}

/**
 * プラグインを外したとき、本体が呼ぶ: 開いているメニュー・モーダルを閉じ、画面から外れた部品を片付ける（ui/mount.ts）。
 * disnans.ui は本体に 1 つで、呼んだプラグインを区別できないので、他のプラグインの開いているメニューも閉じる（開き直せる一時的な表示）
 */
export function cleanupPluginUi(): void {
  closePluginOverlays();
  releaseDetached();
}

const STATUS_KINDS = ['default', 'muted', 'ok', 'accent', 'warn', 'error'] as const;

export function createUi(deps: UiDeps): Disnans.Ui {
  /** 層を 1 つ登録して、閉じる関数（何度呼んでもよい）を返す。戻る操作で閉じる層にもなる */
  function track(remove: () => void, dismiss: () => void): { close: () => void; readonly closed: boolean } {
    let closed = false;
    let offBack: (() => void) | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      openOverlays.delete(close);
      offBack?.();
      remove();
    };
    openOverlays.add(close);
    // 戻る操作では、層を先に外されてから呼ばれる（外し忘れても空回りしない）。閉じて、onClose を呼ぶ
    offBack = deps.onBack?.(() => {
      offBack = undefined;
      dismiss();
    });
    return {
      close,
      get closed() {
        return closed;
      },
    };
  }

  return {
    icon(name, opts = {}) {
      return mountElement<SVGSVGElement>(Icon, {
        icon: String(name),
        size: opts.size,
        class: opts.class,
        label: opts.label,
      }).el;
    },

    button(opts) {
      return mountElement<HTMLButtonElement>(PButton, buttonProps(opts, 'ui.button')).el;
    },

    toggle(opts) {
      const o = requireOpts<Opts<'toggle'>>(opts, 'ui.toggle');
      const onChange = o.onChange;
      return mountElement<HTMLButtonElement>(PToggle, {
        value: !!o.value,
        label: o.label ? String(o.label) : undefined,
        onchange: typeof onChange === 'function' ? (v: boolean) => onChange(v) : undefined,
      }).el;
    },

    input(opts = {}) {
      const o = requireOpts<Opts<'input'>>(opts, 'ui.input');
      const onChange = o.onChange;
      return mountElement<HTMLInputElement>(PInput, {
        value: o.value === undefined || o.value === null ? '' : String(o.value),
        placeholder: o.placeholder ? String(o.placeholder) : undefined,
        onchange: typeof onChange === 'function' ? (v: string) => onChange(v) : undefined,
      }).el;
    },

    segmented(opts) {
      const o = requireOpts<Opts<'segmented'>>(opts, 'ui.segmented');
      const onChange = o.onChange;
      return mountElement(PSegmented, {
        options: (o.options ?? []).map((x) => ({ value: String(x.value), label: String(x.label), icon: x.icon ? String(x.icon) : undefined })),
        value: o.value,
        label: o.label ? String(o.label) : undefined,
        onchange: typeof onChange === 'function' ? (v: string) => onChange(v) : undefined,
      }).el;
    },

    navbar(opts) {
      const o = requireOpts<Opts<'navbar'>>(opts, 'ui.navbar');
      const onSelect = o.onSelect;
      return mountElement(PNavBar, {
        items: (o.items ?? []).map((x) => ({ id: String(x.id), label: String(x.label), icon: String(x.icon), badge: x.badge })),
        selected: o.selected,
        label: o.label ? String(o.label) : undefined,
        onselect: typeof onSelect === 'function' ? (id: string) => onSelect(id) : undefined,
      }).el;
    },

    divider: () => mountElement<HTMLHRElement>(Divider).el,

    setting(containerEl, opts) {
      const o = requireOpts<Parameters<Disnans.Ui['setting']>[1]>(opts, 'ui.setting');
      const control = o.control;
      const row = mountElement<HTMLElement>(PSettingRow, {
        name: String(o.name),
        description: o.description ? String(o.description) : undefined,
        icon: o.icon ? String(o.icon) : undefined,
        node: control ? (control instanceof Node ? control : String(control)) : undefined,
      }).el;
      containerEl.append(row);
      return row;
    },

    iconButton(opts) {
      const o = requireOpts<Disnans.IconButtonOptions>(opts, 'ui.iconButton');
      const onClick = optFn<[]>(o.onClick, 'onClick');
      return mountElement<HTMLButtonElement>(PIconButton, {
        label: requireText(o.label, 'label（読み上げ用の名前）'),
        icon: optText(o.icon, 'icon'),
        iconSize: optNum(o.iconSize, 'iconSize'),
        active: optBool(o.active),
        disabled: optBool(o.disabled),
        class: optText(o.class, 'class'),
        parts: parts(o.children, 'children'),
        onclick: onClick && (() => onClick()),
      }).el;
    },

    section(opts) {
      const o = requireOpts<Disnans.SectionOptions>(opts, 'ui.section');
      return mountElement(PSection, {
        title: requireText(o.title, 'title'),
        class: optText(o.class, 'class'),
        parts: parts(o.children, 'children'),
      }).el;
    },

    statusLine(opts = {}) {
      const o = requireOpts<Disnans.StatusLineOptions>(opts, 'ui.statusLine');
      if (o.kind !== undefined && !(STATUS_KINDS as readonly unknown[]).includes(o.kind)) {
        throw invalid(`kind は ${STATUS_KINDS.join(' / ')} のどれかで渡してください`);
      }
      return mountElement(PStatusLine, {
        kind: o.kind,
        icon: optText(o.icon, 'icon'),
        busy: optBool(o.busy),
        class: optText(o.class, 'class'),
        parts: parts(o.children, 'children'),
      }).el;
    },

    slider(opts) {
      const o = requireOpts<Disnans.SliderOptions>(opts, 'ui.slider');
      const format = optFn<[number]>(o.format, 'format') as ((v: number) => unknown) | undefined;
      const onInput = optFn<[number]>(o.onInput, 'onInput');
      const onChange = optFn<[number]>(o.onChange, 'onChange');
      return mountElement(PSlider, {
        label: requireText(o.label, 'label（読み上げ用の名前）'),
        value: optNum(o.value, 'value'),
        min: optNum(o.min, 'min'),
        max: optNum(o.max, 'max'),
        step: optNum(o.step, 'step'),
        format: format && ((v: number) => {
          // プラグインの関数が失敗しても、部品は壊さず数のまま出す
          try {
            return String(format(v));
          } catch {
            return String(v);
          }
        }),
        disabled: optBool(o.disabled),
        class: optText(o.class, 'class'),
        oninput: onInput && ((v: number) => onInput(v)),
        onchange: onChange && ((v: number) => onChange(v)),
      }).el;
    },

    menu(opts) {
      const o = requireOpts<Disnans.MenuOptions>(opts, 'ui.menu');
      if (!(o.anchor instanceof HTMLElement)) throw invalid('anchor（メニューを出す位置の基準の要素）を渡してください');
      if (!Array.isArray(o.items) || o.items.length === 0) throw invalid('items には、項目を 1 つ以上並べてください');
      if (o.align !== undefined && o.align !== 'start' && o.align !== 'end') throw invalid("align は 'start' か 'end' で渡してください");
      const onClose = optFn<[]>(o.onClose, 'onClose');
      const label = optText(o.label, 'label');
      const specs = o.items.map((it, i) => {
        const s = requireOpts<Disnans.MenuItemOptions>(it, `items[${i}]`);
        return {
          text: requireText(s.text, `items[${i}].text`),
          icon: optText(s.icon, `items[${i}].icon`),
          danger: optBool(s.danger),
          disabled: optBool(s.disabled),
          reason: optText(s.reason, `items[${i}].reason`),
          onClick: optFn<[]>(s.onClick, `items[${i}].onClick`),
        };
      });
      const anchor = o.anchor;

      // 基準の要素の位置に置いた、見えない入れ物の中に、メニューを置く（メニューは入れ物の下に開く。画面の端では部品が収める）
      const box = document.createElement('div');
      box.className = o.align === 'end' ? 'plugin-menu-anchor plugin-menu-end' : 'plugin-menu-anchor';
      const r = anchor.getBoundingClientRect();
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;

      let layer: ReturnType<typeof track> | undefined;
      const dismiss = (): void => {
        if (!layer || layer.closed) return;
        layer.close();
        onClose?.();
      };
      document.body.append(box);
      let mounted: { dispose(): void };
      try {
        mounted = mountOverlay(
          PMenu,
          {
            label,
            onclose: dismiss,
            // 項目を選んだら閉じてから、プラグインの処理を呼ぶ（onClose は呼ばない）
            items: specs.map((s) => ({
              text: s.text,
              icon: s.icon,
              danger: s.danger,
              disabled: s.disabled,
              reason: s.reason,
              onpick: () => {
                layer?.close();
                s.onClick?.();
              },
            })),
          },
          box,
        );
      } catch (e) {
        box.remove();
        throw e;
      }
      layer = track(() => {
        mounted.dispose();
        box.remove();
      }, dismiss);
      const handle = layer;
      return { close: handle.close, get closed() { return handle.closed; } };
    },

    modal(opts) {
      const o = requireOpts<Disnans.ModalOptions>(opts, 'ui.modal');
      const title = requireText(o.title, 'title');
      const width = optNum(o.width, 'width');
      const onClose = optFn<[]>(o.onClose, 'onClose');
      const body = parts(o.children, 'children');
      if (o.actions !== undefined && !Array.isArray(o.actions)) throw invalid('actions はボタンのオプションの配列で渡してください');
      const actions = (o.actions ?? []).map((a, i) => buttonProps(a, `actions[${i}]`));

      let layer: ReturnType<typeof track> | undefined;
      // Esc・幕の押下・戻る操作は、どれも閉じて onClose を呼ぶ
      const dismiss = (): void => {
        if (!layer || layer.closed) return;
        layer.close();
        onClose?.();
      };
      const mounted = mountOverlay(PModal, { title, width, parts: body, actions, onclose: dismiss }, document.body);
      layer = track(() => mounted.dispose(), dismiss);
      const handle = layer;
      return { close: handle.close, get closed() { return handle.closed; } };
    },

    onBack(handler) {
      return deps.onBack?.(() => handler()) ?? (() => {});
    },

    async setImmersive(on) {
      try {
        return (await deps.setImmersive?.(!!on)) ?? false;
      } catch {
        return false;
      }
    },

    toast(text, kind = 'info') {
      deps.toast(String(text), kind === 'error' ? 'error' : 'info');
    },

    confirm(opts) {
      return deps.confirm({
        title: opts.title,
        body: opts.body,
        okLabel: opts.okLabel ?? 'OK',
        ngLabel: opts.ngLabel ?? 'キャンセル',
        danger: opts.danger,
      });
    },
  };
}
