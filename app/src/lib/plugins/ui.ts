// disnans.ui: 本体と同じ見た目の部品を DOM で作る。
// 見た目の正はグローバルのクラス（app.css）。Svelte の部品（components/ui/）と同じ DOM になるようにする

import { createIcon } from '../icons.svelte';

export type UiDeps = {
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; ngLabel: string; danger?: boolean }): Promise<boolean>;
};

/** ボタンの中のアイコンの大きさ（components/ui/Button.svelte と同じ） */
export const BUTTON_ICON_SIZE = 15;
export const BUTTON_ICON_ONLY_SIZE = 18;
/** ナビゲーションのバーのアイコンの大きさ（components/ui/NavBar.svelte と同じ） */
export const NAV_BAR_ICON_SIZE = 22;
/** 設定の1行のアイコンの大きさ（components/ui/SettingRow.svelte と同じ） */
export const SETTING_ROW_ICON_SIZE = 20;
/** 横に並んだ選択肢のアイコンの大きさ（components/ui/SegmentedButton.svelte と同じ） */
export const SEGMENTED_ICON_SIZE = 15;

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function createUi(deps: UiDeps): Disnans.Ui {
  return {
    icon(name, opts = {}) {
      // components/ui/Icon.svelte と同じ
      return createIcon(String(name), { size: opts.size, class: opts.class, label: opts.label });
    },

    button(opts) {
      // components/ui/Button.svelte と同じ
      const text = opts.text ?? '';
      if (!text && !opts.icon) throw new Error('ui.button には text か icon を渡してください');
      if (!text && !opts.label) throw new Error('アイコンだけのボタンには label（読み上げ用の名前）を渡してください');
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn';
      if (opts.variant === 'primary') el.classList.add('primary');
      if (opts.variant === 'danger') el.classList.add('danger');
      if (opts.variant === 'ghost') el.classList.add('ghost');
      if (opts.icon) {
        el.append(createIcon(opts.icon, { size: text ? BUTTON_ICON_SIZE : BUTTON_ICON_ONLY_SIZE }));
      }
      if (text) el.append(text);
      else el.classList.add('btn-icon-only');
      if (opts.label) el.setAttribute('aria-label', opts.label);
      el.disabled = opts.disabled ?? false;
      if (opts.onClick) {
        const cb = opts.onClick;
        el.addEventListener('click', () => cb());
      }
      return el;
    },

    toggle(opts) {
      // components/ui/Toggle.svelte と同じ。label は読み上げ用の名前
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'toggle';
      el.setAttribute('role', 'switch');
      if (opts.label) el.setAttribute('aria-label', opts.label);
      const thumb = document.createElement('span');
      thumb.className = 'toggle-thumb';
      el.append(thumb);
      let value = opts.value;
      const sync = () => {
        el.classList.toggle('toggle-on', value);
        el.setAttribute('aria-checked', String(value));
      };
      sync();
      el.addEventListener('click', () => {
        value = !value;
        sync();
        opts.onChange?.(value);
      });
      return el;
    },

    input(opts = {}) {
      // components/ui/TextInput.svelte と同じ
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'input';
      el.value = opts.value ?? '';
      if (opts.placeholder) el.placeholder = opts.placeholder;
      if (opts.onChange) {
        const cb = opts.onChange;
        el.addEventListener('input', () => cb(el.value));
      }
      return el;
    },

    segmented(opts) {
      // components/ui/SegmentedButton.svelte と同じ
      const el = div('segmented');
      el.setAttribute('role', 'radiogroup');
      if (opts.label) el.setAttribute('aria-label', opts.label);
      let value = opts.value;
      const buttons: [string, HTMLButtonElement][] = [];
      const sync = () => {
        for (const [v, b] of buttons) {
          b.classList.toggle('segmented-option-selected', v === value);
          b.setAttribute('aria-checked', String(v === value));
        }
      };
      for (const o of opts.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'segmented-option';
        b.setAttribute('role', 'radio');
        if (o.icon) b.append(createIcon(o.icon, { size: SEGMENTED_ICON_SIZE }));
        b.append(o.label);
        b.addEventListener('click', () => {
          if (value === o.value) return;
          value = o.value;
          sync();
          opts.onChange?.(value);
        });
        buttons.push([o.value, b]);
        el.append(b);
      }
      sync();
      return el;
    },

    navbar(opts) {
      // components/ui/NavBar.svelte と同じ
      const el = document.createElement('nav');
      el.className = 'nav-bar';
      if (opts.label) el.setAttribute('aria-label', opts.label);
      let selected = opts.selected;
      const buttons: [string, HTMLButtonElement][] = [];
      const sync = () => {
        for (const [id, b] of buttons) {
          b.classList.toggle('nav-bar-item-selected', id === selected);
          if (id === selected) b.setAttribute('aria-current', 'page');
          else b.removeAttribute('aria-current');
        }
      };
      for (const it of opts.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nav-bar-item';
        const icon = document.createElement('span');
        icon.className = 'nav-bar-item-icon';
        icon.append(createIcon(it.icon, { size: NAV_BAR_ICON_SIZE }));
        if (it.badge !== undefined && it.badge !== null && it.badge !== 0 && it.badge !== '') {
          const badge = document.createElement('span');
          badge.className = 'badge nav-bar-item-badge';
          badge.textContent = String(it.badge);
          icon.append(badge);
        }
        const label = document.createElement('span');
        label.className = 'nav-bar-item-label';
        label.textContent = it.label;
        b.append(icon, label);
        b.addEventListener('click', () => {
          selected = it.id;
          sync();
          opts.onSelect?.(it.id);
        });
        buttons.push([it.id, b]);
        el.append(b);
      }
      sync();
      return el;
    },

    divider() {
      // components/ui/Divider.svelte と同じ
      const el = document.createElement('hr');
      el.className = 'divider';
      return el;
    },

    setting(containerEl, opts) {
      // components/ui/SettingRow.svelte と同じ
      const row = div('setting-row');
      if (opts.icon) {
        row.append(createIcon(opts.icon, { size: SETTING_ROW_ICON_SIZE, class: 'setting-row-icon' }));
      }
      const info = div('setting-row-info');
      const name = div('setting-row-name');
      name.textContent = opts.name;
      info.append(name);
      if (opts.description) {
        const desc = div('setting-row-description');
        desc.textContent = opts.description;
        info.append(desc);
      }
      row.append(info);
      if (opts.control) {
        const ctl = div('setting-row-control');
        ctl.append(opts.control);
        row.append(ctl);
      }
      containerEl.append(row);
      return row;
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
