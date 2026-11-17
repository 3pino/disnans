// disnans.ui: 本体と同じ見た目の部品を DOM で作る。
// 部品の作り方は共有の UI 部品（@3pino/ui-kit-web/dom）にある（見た目の正は @3pino/design-system のクラス。Svelte の部品と同じ DOM になることは、
// @3pino/ui-kit-web の parity.test.ts が確かめている）。ここは、プラグインから呼ばれる形（引数の確かめ・エラーの種類）と、本体の機能（トースト・確認・戻る・没入）をつなぐ

import * as dom from '@3pino/ui-kit-web/dom';
import { PluginError } from './errors';
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
function children(v: unknown, what: string): dom.Children {
  if (v === undefined || v === null) return undefined;
  const one = (x: unknown): string | Node => {
    if (typeof x === 'string' || x instanceof Node) return x;
    throw invalid(`${what} は文字列か要素（またはその配列）で渡してください`);
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/** 呼び方の誤り（ui-kit-web の DomArgumentError）は、プラグインの引数のエラーにする */
function mapDomErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof dom.DomArgumentError) throw invalid(e.message);
    throw e;
  }
}

// ---- 重ねて出すもの（メニュー・モーダル） ----
// ui は本体に 1 つで、どのプラグインが呼んだかは分からない。そのため、開いているものをここで覚え、
// プラグインが外されたとき（本体が closePluginOverlays を呼ぶ）に、開いたままのものを全部閉じる（一時的な表示なので、開き直せる）。
// 持ち主だけを閉じたいときは、プラグインが `this.register(overlay.close)` で渡す

const openOverlays = new Set<() => void>();

/** 開いているメニュー・モーダルを、すべて閉じる（プラグインを外すときに本体が呼ぶ。onClose は呼ばない） */
export function closePluginOverlays(): void {
  for (const close of [...openOverlays]) close();
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
      return dom.icon(String(name), { size: opts.size, class: opts.class, label: opts.label });
    },

    button(opts) {
      try {
        return dom.button(opts);
      } catch (e) {
        // 呼び方の誤り（text も icon も無い・アイコンだけで label が無い）は、プラグインの引数のエラーにする
        if (e instanceof dom.DomArgumentError) throw new PluginError('invalid_argument', e.message);
        throw e;
      }
    },

    iconButton(opts) {
      const o = requireOpts<Disnans.IconButtonOptions>(opts, 'ui.iconButton');
      const onClick = optFn<[]>(o.onClick, 'onClick');
      return dom.iconButton({
        label: requireText(o.label, 'label（読み上げ用の名前）'),
        icon: optText(o.icon, 'icon'),
        iconSize: optNum(o.iconSize, 'iconSize'),
        active: optBool(o.active),
        disabled: optBool(o.disabled),
        class: optText(o.class, 'class'),
        children: children(o.children, 'children'),
        onClick: onClick && (() => onClick()),
      });
    },

    section(opts) {
      const o = requireOpts<Disnans.SectionOptions>(opts, 'ui.section');
      return dom.section({
        title: requireText(o.title, 'title'),
        class: optText(o.class, 'class'),
        children: children(o.children, 'children'),
      });
    },

    statusLine(opts = {}) {
      const o = requireOpts<Disnans.StatusLineOptions>(opts, 'ui.statusLine');
      if (o.kind !== undefined && !(STATUS_KINDS as readonly unknown[]).includes(o.kind)) {
        throw invalid(`kind は ${STATUS_KINDS.join(' / ')} のどれかで渡してください`);
      }
      return dom.statusLine({
        kind: o.kind,
        icon: optText(o.icon, 'icon'),
        busy: optBool(o.busy),
        class: optText(o.class, 'class'),
        children: children(o.children, 'children'),
      });
    },

    slider(opts) {
      const o = requireOpts<Disnans.SliderOptions>(opts, 'ui.slider');
      const format = optFn<[number]>(o.format, 'format') as ((v: number) => unknown) | undefined;
      const onInput = optFn<[number]>(o.onInput, 'onInput');
      const onChange = optFn<[number]>(o.onChange, 'onChange');
      return dom.slider({
        label: requireText(o.label, 'label（読み上げ用の名前）'),
        value: optNum(o.value, 'value'),
        min: optNum(o.min, 'min'),
        max: optNum(o.max, 'max'),
        step: optNum(o.step, 'step'),
        format: format && ((v) => {
          // プラグインの関数が失敗しても、部品は壊さず数のまま出す
          try {
            return String(format(v));
          } catch {
            return String(v);
          }
        }),
        disabled: optBool(o.disabled),
        class: optText(o.class, 'class'),
        onInput: onInput && ((v) => onInput(v)),
        onChange: onChange && ((v) => onChange(v)),
      });
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

      // 基準の要素の位置に置いた、見えない入れ物の中に、メニューを置く（メニューは入れ物の下に開く。画面の端では本体が収める）
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
      const handle = dom.menu({
        label,
        onClose: dismiss,
        children: specs.map((s) =>
          dom.menuItem({
            children: s.text,
            icon: s.icon,
            danger: s.danger,
            disabled: s.disabled,
            reason: s.reason,
            // 項目を選んだら閉じてから、プラグインの処理を呼ぶ（onClose は呼ばない）
            onClick: () => {
              layer?.close();
              s.onClick?.();
            },
          }),
        ),
      });
      document.body.append(box);
      handle.mount(box);
      layer = track(() => {
        handle.close();
        box.remove();
      }, dismiss);
      return { close: layer.close, get closed() { return layer!.closed; } };
    },

    modal(opts) {
      const o = requireOpts<Disnans.ModalOptions>(opts, 'ui.modal');
      const title = requireText(o.title, 'title');
      const width = optNum(o.width, 'width');
      const onClose = optFn<[]>(o.onClose, 'onClose');
      const body = children(o.children, 'children');
      if (o.actions !== undefined && !Array.isArray(o.actions)) throw invalid('actions はボタンのオプションの配列で渡してください');
      const buttons = (o.actions ?? []).map((a, i) => mapDomErrors(() => dom.button(requireOpts<Disnans.ButtonOptions>(a, `actions[${i}]`))));

      const content: (string | Node)[] = [];
      if (body !== undefined) content.push(...(Array.isArray(body) ? (body as (string | Node)[]) : [body as string | Node]));
      if (buttons.length > 0) {
        const row = document.createElement('div');
        row.className = 'modal-actions';
        row.append(...buttons);
        content.push(row);
      }

      let layer: ReturnType<typeof track> | undefined;
      // Esc・幕の押下・戻る操作は、どれも閉じて onClose を呼ぶ
      const dismiss = (): void => {
        if (!layer || layer.closed) return;
        layer.close();
        onClose?.();
      };
      const handle = dom.modal({ title, width, onClose: dismiss, children: content });
      handle.mount(document.body);
      layer = track(() => handle.close(), dismiss);
      return { close: layer.close, get closed() { return layer!.closed; } };
    },

    toggle: (opts) => dom.toggle(opts),
    input: (opts = {}) => dom.input(opts),
    segmented: (opts) => dom.segmented(opts),
    navbar: (opts) => dom.navbar(opts),
    divider: () => dom.divider(),
    setting: (containerEl, opts) => dom.setting(containerEl, opts),

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
