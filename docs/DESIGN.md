# デザイン

見た目（トークン・リセット・共通部品のクラス）は、共有パッケージ **[@3pino/design-system](https://github.com/3pino/design-system)** にあります。説明は同リポジトリの `DESIGN.md`。

- 取り込み: `app/package.json` の依存（`github:3pino/design-system#vX.Y.Z`）と、`app/src/app.css` の `@import '@3pino/design-system'`
- 本体だけのスタイル（検索ヒットの強調、チャット画面）は、`app.css` と各コンポーネントの `<style>` に置く
- 更新: 共有側でタグを打ち、`npm install github:3pino/design-system#<新しいタグ>` で上げる
- 部品や DOM を変えるときは、共有側の CSS と、`components/ui/`・`lib/plugins/ui.ts`・`docs/PLUGIN_UI.md` をそろえる
