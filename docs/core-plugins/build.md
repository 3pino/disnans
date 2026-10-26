# Svelte 同梱ビルド

状態: **設計案(未実装)**。[CORE_PLUGINS.md](../CORE_PLUGINS.md) の決定 2 の具体案。確定は「Svelte のまま、プラグイン用にビルドして同梱する」だけで、以降は案。

## ビルド単位と配置

```
plugins/core/explorer/
  manifest.json          id: "explorer"、permissions、icon
  icon.svg
  src/main.ts            export default class extends disnans.Plugin
  src/*.svelte           画面(Svelte のまま)
  src/state/*.ts         UI 非依存の状態・操作(段階 0)
```

- 1 プラグイン = 1 ビルド。出力は `app/public/core-plugins/<id>/{manifest.json, main.js, styles.css, icon.svg}`(Tauri の `frontendDist` に入るので、Windows・Linux・Android すべてで同梱される)。
- `main.js` は ES モジュールの 1 ファイル(Vite のライブラリモード、`formats: ['es']`、コード分割なし)。現行の読み込み(Blob URL から `import`)にそのまま乗る。

## 読み込み

- `host.svelte.ts` の `Wanted`(`manifest`、`load()` → `{ main, styles, permissions }`)に、同梱ファイルを `fetch` して返す供給元を足す。`sig` は本体の版にして、アプリの更新で読み直す。
- コアプラグインはデバイスごとのオン・オフの対象にしない(一覧には出す)。サーバー配布のものと `id` がぶつかったら、コアが優先(質問: 衝突時の表示)。

## Svelte ランタイムの共有

- 問題: `main.js` に Svelte を含めると、本体とプラグインで Svelte のランタイムが 2 つになる。Svelte 5 の `$state` の購読は、モジュール内の「いま実行中の購読元」を使うので、別インスタンス間ではリアクティブがつながらない(本体のストアを読んでも更新されない)。コンテキスト(`setContext`)も別になる。
- 方式(案): ビルドで `svelte` と `svelte/*` を外部にし、仮想モジュールへ解決する。仮想モジュールは `globalThis.disnans.runtime.svelte` から取る。本体は起動時に `import * as svelte from 'svelte'` と `svelte/internal/client` などを `disnans.runtime.svelte` に渡す。
  ```ts
  // vite の plugin(概略)
  resolveId: id => id === 'svelte' || id.startsWith('svelte/') ? '\0host:' + id : null,
  load: id => id.startsWith('\0host:') ? `export const { mount, unmount, ... } = disnans.runtime.svelte[${JSON.stringify(id.slice(6))}];` : null,
  ```
- 別案: ブラウザーの import map で `svelte` を本体の URL に向ける。Blob URL のモジュールにも文書の import map が効くが、WebView(Android・WebKitGTK・WKWebView)での挙動を確かめる必要がある。
- 制約: 内部 API(`svelte/internal/client`)は版が変わると壊れる。コアは本体と同じロックファイルの同じ Svelte でビルドするので安全。サードパーティには使わせない。

## `disnans` の受け渡し

- 現行と同じ。`main.js` のトップレベルで `disnans`(グローバル)を使う。エントリは `export default class extends disnans.Plugin`。
- 画面は `registerView(type, factory)` の `onOpen(containerEl)` で `mount(Component, { target: containerEl, props: { plugin: this } })` し、`onClose` で `unmount` する。コンポーネントは `plugin`(= `disnans` の API 一式)を prop か Svelte の context で受け取り、**本体のストアは import しない**。
- 型は `packages/plugin-sdk/index.d.ts`(`Disnans.*`)だけ。

## スタイル

- Svelte の scoped CSS は `styles.css` に出す(`cssHash` にプラグイン ID の接頭辞を付け、本体・他とぶつからないようにする)。
- 色・大きさは本体の CSS 変数(`@3pino/design-system`)と共通クラス(`.btn`・`.input`・`.setting-row` など)を使う。プラグインが自分で `@import` はしない(本体が持っている)。

## 本体への依存を禁止する検査

「同じ API だけを使う」を守る仕組み(コアプラグインの 1 条件)。
- ESLint の境界ルール(または `import` の許可リスト): `plugins/core/**` が import してよいのは `svelte`・`@lucide/svelte`・`@disnans/plugin-sdk`(型)・自分のファイルだけ。`app/src/**` は禁止。
- ビルド後の `main.js` に、解決されない `import`(許可リスト外)が残っていないことをテストで確かめる。

## ビルドとテストの流れ

1. `npm run build:core`(アプリの `build` の前に実行)で `app/public/core-plugins/` を作る。`build` / `tauri build` から呼ぶ。
2. 単体テスト(vitest + jsdom)はプラグインのディレクトリに置く。状態・操作(`state/`)はコンポーネントなしでテストできる(段階 0)。
3. CI(`ci.yml`): `check` → `vitest` → `build:core` → import 検査 → `build`。
4. 開発: 開発用フォルダ(`dev.ts`)に出力を向ければホットリロードできる(現行の開発用プラグインと同じ)。

## 未決
- 同梱を `public/` の静的ファイルにするか、`main.js` を本体のバンドルに文字列として埋めるか(`fetch` 不要になる)。
- 開発用ブラウザー(Rust を呼べない)での読み込み方。
- 本体のアップデートとプラグインの版の対応(コアは常に本体と同じ版でよいか)。
