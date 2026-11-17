// disnans.ui: 本体と同じ見た目の部品を DOM で作る。
// 部品の作り方は共有の UI 部品（@3pino/ui-kit-web/dom）にある（見た目の正は @3pino/design-system のクラス。Svelte の部品と同じ DOM になることは、
// @3pino/ui-kit-web の parity.test.ts が確かめている）。ここは、プラグインから呼ばれる形（引数の確かめ・エラーの種類）と、本体の機能（トースト・確認・戻る・没入）をつなぐ

import * as dom from '@3pino/ui-kit-web/dom';
import { PluginError } from './errors';

export type UiDeps = {
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; ngLabel: string; danger?: boolean }): Promise<boolean>;
  /** 戻る操作（Android の戻るジェスチャーなど）で閉じる層を足す（API v9）。省くと何もしない */
  onBack?(run: () => void): () => void;
  /** 没入モード（システムバーを隠す。Android）。ネイティブで切り替えたら true（API v9） */
  setImmersive?(on: boolean): Promise<boolean>;
};

export function createUi(deps: UiDeps): Disnans.Ui {
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
