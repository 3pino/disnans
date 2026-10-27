# 見た目（CSS）と TypeScript

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

## 見た目（CSS）

`styles.css` を置くと、読み込んだときに自動で適用し、オフにすると取り除きます。

### 本体の CSS 変数

本体の色や大きさは CSS 変数（`--bg`・`--surface`・`--text`・`--accent`・`--radius`・`--font` など）です。これを使えば、**ライト・ダークのどちらでも**本体に合う見た目になります（テーマが変わると変数の値が変わる）。変数の一覧と値は [themes.md の「CSS 変数の一覧」](../themes.md#css-変数の一覧) にあります。

### 共通クラス

`.btn`・`.input`・`.segmented`・`.nav-bar`・`.divider`・`.setting-row` などの本体のクラスは、プラグインからも使えます。
一覧は [PLUGIN_UI.md の「CSS クラス」](ui.md#css-クラス) を参照してください。

### 書き方の決まり

- 自分のクラスには**プラグイン ID の接頭辞**を付けます（ダイスなら `.dice-view`, `.dice-face`）。本体や他のプラグインとぶつからないようにするためです
- `body` や `.btn` など、本体のセレクターを直接書き換えないでください。全員の本体の見た目が変わります
- 色は直接書かず、CSS 変数を使います

ダイスの `styles.css`（抜粋）。揺れる演出は `@keyframes` で書き、動きを減らす設定（`prefers-reduced-motion`）の人には止めています。

```css
.dice-face {
  min-width: 72px;
  height: 72px;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 36px;
  font-weight: 700;
}
.dice-face-max {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.dice-face-shaking {
  border-color: var(--accent);
  animation: dice-shake 0.24s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dice-face-shaking {
    animation: none;
  }
}
/* view の中のタブのバー（本体の .nav-bar）を、自分のクラスの下でだけ調整する */
.dice-view .nav-bar {
  padding-bottom: env(safe-area-inset-bottom);
}
```

---

## TypeScript で書く

TypeScript で書き、ビルドで `main.js`（**ES モジュール 1 ファイル**）を出します。`disnans` はグローバルなので `import` は要りません。型定義の読み込み・`tsconfig.json`・esbuild と Vite の設定は [`packages/plugin-sdk/README.md`](../../packages/plugin-sdk/README.md) にあります。
配布されるのは `manifest.json`・`main.js`・`styles.css`・`icon.svg` だけなので、`src/` や `node_modules/` が同じフォルダにあってもかまいません。
