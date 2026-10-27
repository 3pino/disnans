# コアプラグイン（エクスプローラーのプラグイン化）

状態: 設計案(未実装)

エクスプローラー(`app/src/components/FileExplorer.svelte`、約 1200 行)のような 1 つの画面を、本体の外(プラグインの仕組み)へ切り出す案。FEEDBACKS の「ファイルエクスプローラーを別のアプリとして切り出したい。プラグインからも新しいアプリや画面を作りたい」に紐づく。

## 決定(ユーザー決定)

1. **コアプラグイン**は次の 4 条件をすべて満たすもの。オン・オフはさせない。
   - 同じ plugin API(`disnans.*`)だけを使う(本体の内部を import しない)
   - アプリに同梱する
   - 本体と同時に更新する
   - 設定のプラグイン一覧に出す
2. 作り方は **Svelte のまま、プラグイン用にビルドして同梱**する(命令型 DOM への書き直しはしない)。
3. TUI と共有することは条件にしない(宣言的な木への全面移行は取り下げた。[ideas.md](ideas.md))。
4. apk 単位の分割は、最終目標ではなく副次的な可能性。エクスプローラーを土台にして、他のコミュニティプラグインでもついでに可能になるようにする、という位置づけ。

## 用語

| 呼び方 | 何か | 更新 | オン・オフ | 権限 |
|---|---|---|---|---|
| 本体 | `app/src/` の Svelte と Rust。内部のストア・部品を自由に使う | アプリ | なし | 制限なし |
| コアプラグイン | plugin API だけで書かれた、アプリ同梱のプラグイン(例: エクスプローラー) | 本体と同時 | させない(一覧には出す) | manifest の `permissions` を書く。ユーザーへの確認はしない(アプリと同じ署名の範囲) |
| サードパーティ | サーバーから配布される JS(+CSS)。ダイスなど | 個別 | できる(デバイスごと) | manifest の `permissions` を宣言(現状は `files` のみ。[plugins/runtime.md](../plugins/runtime.md)) |

- 現行のプラグインの読み込みは `app/src/lib/plugins/host.svelte.ts` の `Wanted`(`manifest` と `load()` が `main`・`styles`・`permissions` を返す)。コアプラグインは、同梱ファイルから `Wanted` を作る新しい供給元として足せる。
- 「同じ API だけを使う」ことは、権限の宣言と、ビルド時に本体の import を禁止する検査で守る(下)。
- 本体に残すもの: 画面のレイアウト(`Shell`)・ナビバー・履歴(`navHistory`)・認証・接続・チャット。**1 つの画面とその状態**がコアプラグインに向く。

## Svelte 同梱ビルド

### ビルド単位と配置

```
plugins/core/explorer/
  manifest.json          id: "explorer"、permissions、icon
  icon.svg
  src/main.ts            export default class extends disnans.Plugin
  src/*.svelte           画面(Svelte のまま)
  src/state/*.ts         UI 非依存の状態・操作
```

- 1 プラグイン = 1 ビルド。出力は他のプラグインと同じ形(`manifest.json`・`main.js`(ES モジュール)・`styles.css`・`icon.svg`)で、`app/public/core-plugins/<id>/` に置く(Tauri の `frontendDist` に入り、Windows・Linux・Android のすべてで同梱される)。
- `main.js` は ES モジュール 1 ファイル(Vite のライブラリモード、`formats: ['es']`、コード分割なし)。現行の読み込み(Blob URL から `import`)にそのまま乗る。
- 読み込み: `Wanted` の供給元を足し、`sig` は本体の版にしてアプリの更新で読み直す。デバイスごとのオン・オフの対象にしない。サーバー配布のものと `id` がぶつかったら、コアが優先する。

### Svelte ランタイムの共有

- 問題: `main.js` に Svelte を含めると、本体とプラグインで Svelte のランタイムが 2 つになる。Svelte 5 の `$state` の購読は、モジュール内の「いま実行中の購読元」を使うので、別インスタンスの間ではリアクティブがつながらない(本体のストアを読んでも更新されない)。`setContext` も別になる。
- 方式(案): ビルドで `svelte` と `svelte/*` を外部にし、仮想モジュールへ解決する。仮想モジュールは `globalThis.disnans.runtime.svelte` から取る。本体は起動時に `svelte` と `svelte/internal/client` などを `disnans.runtime.svelte` に渡す。
  ```ts
  // vite の plugin(概略)
  resolveId: id => id === 'svelte' || id.startsWith('svelte/') ? '\0host:' + id : null,
  load: id => id.startsWith('\0host:') ? `export const { mount, unmount, ... } = disnans.runtime.svelte[${JSON.stringify(id.slice(6))}];` : null,
  ```
- 別案: ブラウザーの import map で `svelte` を本体の URL に向ける。Blob URL のモジュールにも文書の import map が効くが、WebView(Android・WebKitGTK・WKWebView)での挙動を確かめる必要がある。
- 制約: 内部 API(`svelte/internal/client`)は版が変わると壊れる。コアは本体と同じロックファイルの同じ Svelte でビルドするので安全。サードパーティには使わせない(使わせるなら ABI の取り決めが要る)。

### `disnans` の受け渡しとスタイル

- `main.js` のトップレベルで `disnans`(グローバル)を使い、エントリは `export default class extends disnans.Plugin`。画面は `registerView(type, factory)` の `onOpen(containerEl)` で `mount(Component, { target: containerEl, props: { plugin: this } })` し、`onClose` で `unmount` する。コンポーネントは `plugin` を prop か context で受け取り、本体のストアは import しない。型は `packages/plugin-sdk/index.d.ts` だけを使う。
- Svelte の scoped CSS は `styles.css` に出す(`cssHash` にプラグイン ID の接頭辞を付ける)。色・大きさは本体の CSS 変数と共通クラス(`.btn`・`.input`・`.setting-row` など)を使い、`@import` はしない。

### 本体への依存を禁止する検査

- ESLint の境界ルール(または `import` の許可リスト): `plugins/core/**` が import してよいのは `svelte`・`@lucide/svelte`・`@disnans/plugin-sdk`(型)・自分のファイルだけ。`app/src/**` は禁止。
- ビルド後の `main.js` に、許可リスト外の `import` が残っていないことをテストで確かめる。

### ビルドとテストの流れ

1. `npm run build:core`(アプリの `build` の前に実行。`tauri build` からも呼ぶ)で `app/public/core-plugins/` を作る。
2. 単体テスト(vitest + jsdom)はプラグインのディレクトリに置く。`state/` はコンポーネントなしでテストできる。
3. CI(`ci.yml`): `check` → `vitest` → `build:core` → import 検査 → `build`。
4. 開発: 開発用フォルダ(`dev.ts`)に出力を向ければホットリロードできる。

## 足りない API(エクスプローラーに必要なもの)

現行のプラグインは `disnans.ui`(button・toggle・input・segmented・navbar・divider・setting・icon・toast・confirm)と共通の CSS・`files` で画面を作れるが、次が足りない。

| API | 用途 |
|---|---|
| `files.url(path)` | `<img>`・ダウンロード用の URL(`SharedEntry.file_id` / `mime` も) |
| `files.upload(path, blob, { onProgress })` | 進捗付きのアップロード |
| `ui.modal` / `ui.menu` / `ui.panelBar` | 本体の Modal・Menu・PanelBar と同じ DOM |
| 全画面の view と `addNavItem` | チャットを隠す全画面と、ナビバーの項目(今はコマンド経由だけ) |
| 戻る操作と履歴の統合 | view を `navHistory` に載せる(Android の戻る・Alt+← で閉じる) |
| `clipboard`(テキスト・画像)・`pickFiles()`・`save(blob, name)` | 貼り付け・アップロード・保存 |
| `lightbox(src, alt)` | 画像の拡大 |

## 段階

0. エクスプローラーの状態と操作を、UI 非依存のモジュールに分ける。いまは `stores/{fileExplorer,explorerView,explorerBuffer,explorerSelection,sharedIndex}.svelte.ts` と `lib/{fileExplorer,sharedOps,sharedTransfer}.ts` に分かれている。状態は、いまのフォルダ・一覧の状態・表示形式と並び・選択・コピー/切り取りのバッファ・ダイアログ・アップロードの進捗。操作は、開く・上へ・パンくず・再読み込み・選択・コピー・切り取り・貼り付け・削除・名前の変更・フォルダ作成・アップロード・並びと表示の変更・`files.changed`。
1. コアプラグインの供給元(`Wanted`)・ビルド(`plugins/core/`)・本体 import の禁止検査。
2. 足りない API を足す。エクスプローラーをコアプラグインにして、本体の `Shell` の `panel.kind==='files'` 分岐と `app:open-files` を、プラグインのコマンドと view に置き換える。

## apk 単位の分割(副次的な可能性)

- Tauri 公式の Android の複数 WebView は未対応。issue #11528(2024 年から)、#15857(2026-08)は open。PR #16262(`feat(android): use a task per window, activity embedding for multiwebview`、2026-10-12 作成、6 commits・84 files)は 2026-10-12 時点で **open・未マージ**。デスクトップは複数ウィンドウが使える。
- コアプラグインを「manifest + バンドル」で自己完結させ、`disnans` のホスト実装(`app/src/lib/plugins/` と `transport/`)を再利用できる形に分ければ、別アプリの殻が同じバンドルを載せられる。
- 別 apk の課題: サーバー URL・認証・設定の受け渡し(ContentProvider / bound service / 各アプリで入力)、署名と共有 UID、`release.yml` での配布、本体との更新の連動。同一 apk の別 Activity は共有しやすいが、Tauri が複数 Activity を公式に扱うまでは自前の Kotlin が必要で、保守が重い。

## 未決

- 同梱を `public/` の静的ファイルにするか、`main.js` を本体のバンドルに文字列として埋めるか(`fetch` が要らなくなる)。
- 開発用ブラウザー(Rust を呼べない)での読み込み方。
- コアのバージョンは常に本体と同じでよいか。
- サードパーティの権限をユーザーが確認する仕組みは今は無い。先に作るか。
- `disnans` のホスト実装を別パッケージ(`@disnans/runtime`)に分けるのを、いつ始めるか。
