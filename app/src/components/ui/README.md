# UI 部品

小さな UI 部品（Button・IconButton・Icon・Menu・Modal・NavBar・SettingRow・Toggle・SortableList など）は、共有パッケージ **[@3pino/ui-kit-web](https://github.com/3pino/ui-kit-web)** に移しました。
このフォルダには、部品はありません（Svelte の部品は `@3pino/ui-kit-web/Button.svelte` のように取り込みます）。

- 部品ごとの使い方・クラス・状態: ui-kit-web の `docs/ui.md`（`app/node_modules/@3pino/ui-kit-web/docs/ui.md`）
- プラグイン向けの DOM 部品（`disnans.ui`）は、ui-kit-web の `@3pino/ui-kit-web/dom` を呼びます（`src/lib/plugins/ui.ts`。説明は `docs/plugins/ui.md`）。
  Svelte の部品と DOM の部品が同じ DOM になることは、ui-kit-web の `parity.test.ts` が確かめます
- 見た目の正はグローバルの CSS クラス（`@3pino/design-system` の `components.css`）
- 本体だけの設定（アイコンの `disnans-logo`・Android の振動）は、`src/lib/icons.svelte.ts` と `src/lib/haptics.ts` が ui-kit-web の差し込み口（`defineBuiltinIcon`・`setHaptics`）へ渡します
- 部品を足したり DOM を変えたりするときは、ui-kit-web の側で直し（Svelte の部品・`src/dom`・`docs/ui.md`・`parity.test.ts`）、`@3pino/design-system` と `packages/plugin-sdk/index.d.ts`・`docs/plugins/ui.md` をそろえてから、ui-kit-web のタグを打って `app/package.json` のタグを更新する
- 本体の画面だけで使う部品は、`src/components/` に置く（ui-kit-web には、ほかのアプリや、プラグインでも使えるものだけを入れる）
