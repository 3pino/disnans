# UI 部品

小さな UI 部品（Button・IconButton・Icon・Menu・Modal・NavBar・SettingRow・Toggle・SortableList など）は、共有パッケージ **[@3pino/ui-kit-web](https://github.com/3pino/ui-kit-web)** に移しました。
このフォルダには、部品はありません（Svelte の部品は `@3pino/ui-kit-web/Button.svelte` のように取り込みます）。

- 部品ごとの使い方・クラス・状態: ui-kit-web の `docs/ui.md`（`app/node_modules/@3pino/ui-kit-web/docs/ui.md`）
- プラグイン向けの DOM の部品（`disnans.ui`。説明は `docs/plugins/ui.md`）は、ここの部品（Svelte）を **mount して**、できた要素を渡します（`src/lib/plugins/ui.ts`・`ui/*.svelte`・`ui/mount.ts`）。
  ui-kit-web は DOM の作り手を持ちません（v0.3.0 から）。同じ部品なので、本体の画面とプラグインの部品は同じ DOM・同じ見た目になります
- 見た目の正はグローバルの CSS クラス（`@3pino/design-system` の `components.css`）
- 本体だけの設定（アイコンの `disnans-logo`・Android の振動）は、`src/lib/icons.svelte.ts` と `src/lib/haptics.ts` が ui-kit-web の差し込み口（`defineBuiltinIcon`・`setHaptics`）へ渡します
- 部品を足したり DOM を変えたりするときは、ui-kit-web の側で直し（Svelte の部品・`docs/ui.md`・`components.test.ts`）、`@3pino/design-system` と `packages/plugin-sdk/index.d.ts`・`docs/plugins/ui.md` をそろえてから、ui-kit-web のタグを打って `app/package.json` のタグを更新する
- 本体の画面だけで使う部品は、`src/components/` に置く（ui-kit-web には、ほかのアプリや、プラグインでも使えるものだけを入れる）
