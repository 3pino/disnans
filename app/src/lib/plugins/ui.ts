// disnans.ui: 本体と同じ見た目の部品を DOM で作る。
// 見た目の正はグローバルのクラス（app.css）。Svelte の部品（components/ui/）と同じ DOM になるようにする

export type UiDeps = {
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; danger?: boolean }): Promise<boolean>;
};

export function createUi(deps: UiDeps): Disnans.Ui {
  return {
    button(opts) {
      // components/ui/Button.svelte と同じ
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn';
      if (opts.variant === 'primary') el.classList.add('primary');
      if (opts.variant === 'danger') el.classList.add('danger');
      el.textContent = opts.text;
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

    setting(containerEl, opts) {
      // components/ui/SettingRow.svelte と同じ
      const row = document.createElement('div');
      row.className = 'setting-row';
      const info = document.createElement('div');
      info.className = 'setting-row-info';
      const name = document.createElement('div');
      name.className = 'setting-row-name';
      name.textContent = opts.name;
      info.append(name);
      if (opts.description) {
        const desc = document.createElement('div');
        desc.className = 'setting-row-description';
        desc.textContent = opts.description;
        info.append(desc);
      }
      row.append(info);
      if (opts.control) {
        const ctl = document.createElement('div');
        ctl.className = 'setting-row-control';
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
      return deps.confirm({ title: opts.title, body: opts.body, okLabel: opts.okLabel ?? 'OK', danger: opts.danger });
    },
  };
}
