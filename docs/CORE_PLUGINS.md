# コアプラグインと、アプリ・画面の切り出し

状態: **設計案(未実装)**。「決定」と書いたものだけがユーザー決定で、ほかは案。2026-10 時点の調査(FEEDBACKS「ファイルエクスプローラーを別のアプリとして切り出したい。プラグインからも新しいアプリや画面を作りたい」)。

細かい内容は次のファイルに分けた。

| ファイル | 内容 |
|---|---|
| [core-plugins/build.md](core-plugins/build.md) | Svelte のままプラグインとして同梱ビルドする方式(決定 2 の具体案) |
| [core-plugins/tree-model.md](core-plugins/tree-model.md) | TUI と共有する「画面の木」の設計(粒度・状態・GUI 専用の見た目・3 層の整理) |
| [core-plugins/vocabulary.md](core-plugins/vocabulary.md) | 木の部品の語彙・イベント・追加する API の表 |
| [core-plugins/explorer-tree.md](core-plugins/explorer-tree.md) | エクスプローラーを木で書いたスケッチ(GUI / TUI の描き分け) |

## 決定事項(ユーザー決定)

1. **コアプラグイン**は次の 4 条件をすべて満たすもの。オン・オフはさせない。
   - 同じ plugin API(`disnans.*`)だけを使う(本体の内部を import しない)
   - アプリに同梱する
   - 本体と同時に更新する
   - 設定のプラグイン一覧に出す
2. 作り方は **Svelte のまま、プラグイン用にビルドして同梱**する。命令型 DOM への書き直しはしない(→ [build.md](core-plugins/build.md))。
3. Android は Tauri 公式の複数 WebView / Activity の対応待ち。
4. TUI と画面の定義(DOM に相当するもの)を共有する目標は必ず成し遂げる。

## ① 用語

| 呼び方 | 何か | 配り方・更新 | オン・オフ | 権限 |
|---|---|---|---|---|
| **本体** | `app/src/` の Svelte と Rust。内部のストア・部品を自由に使う | アプリ | なし | 制限なし |
| **コアプラグイン** | plugin API だけで書かれた、同梱のプラグイン。例: エクスプローラー | アプリに同梱。本体と同時に更新 | なし | manifest の `permissions` を書く。 |
| **コミュニティプラグイン** | サーバーから配布される JS(+CSS)。ダイスなど | サーバーに[配布]。個別に更新 | できる(デバイスごと) | manifest の `permissions` を宣言(現状は `files` のみ。`docs/PLUGINS.md`) |

- 現行のプラグインの読み込みは `app/src/lib/plugins/host.svelte.ts` の `Wanted`(`manifest` と `load()` で `main`・`styles`・`permissions` を返す)で抽象化されている。コアプラグインは、この `Wanted` を同梱ファイルから作る新しい供給元として足せる(`sig` は本体の版)。
- 信頼: コアプラグインは同梱でアプリの署名の範囲にあり、サードパーティの権限の確認(未決・下の質問 3)とは別。**同じ API しか使えない**ことは、権限の宣言と、ビルド時に本体の import を禁止する検査で守る([build.md](core-plugins/build.md))。

## ② Svelte 同梱ビルド(要約)

詳細は [build.md](core-plugins/build.md)。

- 1 プラグイン = 1 ビルド単位(`plugins/core/<id>/`)。出力は他のプラグインと同じ形(`manifest.json`・`main.js`(ES モジュール)・`styles.css`・`icon.svg`)。
- Svelte のランタイムは本体と共有する。
- Svelte の内部 API は公開の安定した契約ではないので、コミュニティプラグインには開放しない。

## ③ TUI との共有(前提・制約)

詳細は [tree-model.md](core-plugins/tree-model.md)。結論だけ。

- いま共有できているのは、設定画面とナビバーの**静的な木**(`crates/client-core/src/view/ui.rs`、[UI_TREE.md](UI_TREE.md))。値は持たず、イベントもない。
- Svelte でビルドしたコアプラグインは、**GUI(DOM)でしか動かない**。TUI で同じ画面を出すには、画面を DOM ではなく**宣言的な木(状態から作る値)**として表せる必要がある。よって Svelte 同梱は「抜き出しを早く終えるための中継」であり、**最終形は宣言的な木**(3 層の整理の最後)。
- 無駄にしないための制約を今から置く:
  1. 画面の状態と操作(選択・コピー・並び・パンくず・転送)は、UI から独立した純粋なモジュール(状態 + アクション → 状態 + 副作用)として書く。Svelte はそれを描くだけにする。
  2. 部品は [vocabulary.md](core-plugins/vocabulary.md) の語彙に載るものだけを使い、GUI 専用の見た目(サムネイル・ジェスチャー・アニメーション)は「GUI のヒント」に分ける。
  3. プラグインから見える API は、TUI でも実装できるものだけにする(Rust の `client-core` に対応があるか)。

### 3 層の整理と移行

| 層 | 中身 | 動く場所 | 位置づけ |
|---|---|---|---|
| L1 命令型 DOM(現行) | `registerView` で `containerEl` に描く。`disnans.ui` | GUI のみ | サードパーティの既存プラグイン用に残す(互換)。新規は推奨しない |
| L2 Svelte ビルド(コア) | 同じ plugin API + Svelte | GUI のみ | **中継**。エクスプローラーの抜き出しに使う |
| L3 宣言的な木 | `registerScreen`(状態 → 木、操作 → アクション)。Rust で型を定義 | **GUI も TUI も** | **最終形**。コアもサードパーティも |

順序は「L2 で抜き出し(API の穴を埋める)→ L3 の型と GUI の木の描画 → TUI の描画と JS 実行 → エクスプローラーを L3 に移す → L1 を非推奨」([④](#-段階的な計画))。

## ④ 段階的な計画

| 段階 | 作るもの | TUI と共有できるようになるもの |
|---|---|---|
| 0 | エクスプローラーの状態・操作を UI 非依存のモジュールに分ける(`explorerSelection`・`explorerBuffer`・`explorerView`・`fileExplorer`・`sharedOps`・`sharedTransfer` の整理) | 状態の論理(後で木の `update` になる) |
| 1 | コアプラグインの供給元(`Wanted` に同梱ファイルを足す)、ビルド(`plugins/core/`)、本体 import 禁止の検査 | なし(GUI のみ) |
| 2 | 足りない API(→ [vocabulary.md](core-plugins/vocabulary.md) の API 表。まず `files.url`・`files.upload`・`ui.modal/menu/panelBar`・全画面 view と `addNavItem`・`clipboard/pickFiles/save`・`lightbox`)。エクスプローラーを L2 のコアプラグインにして、本体の `panel.kind==='files'` を外す | `files` の API は TUI でも実装できる形に(`client-core` の `shared_*` と対応) |
| 3 | 木の型(Rust `view::tree`、ts-rs で TS を生成)と、GUI の汎用 `TreeView.svelte`。設定画面の静的な木も同じ型へ寄せる | 型・語彙・イベント |
| 4 | TUI の描画(`tui/ui/` の部品を木に対応)と、TUI の JS 実行(プラグインを動かす) | 画面の木、プラグインの中身 |
| 5 | エクスプローラーを L3 に移す。GUI 専用の見た目は「GUI のヒント」へ | エクスプローラーが TUI で動く |
| 6 | L1 を非推奨にする。apk の分割は Tauri の公式対応後(段階 1〜5 とは独立) | — |

リスク:
- L2 → L3 でエクスプローラーの画面を書き直すことになる。段階 0 で状態・操作を分けておくと、書き直すのは描画だけで済む。それでも回帰の可能性がある。
- 木の語彙が不足すると、GUI のヒントや Slot が増えて、TUI との共有が名ばかりになる。語彙は(エクスプローラーのような)実際の画面から決める。
- TUI の JS 実行(組み込みの JS エンジン)はバイナリの大きさ・サンドボックス・`disnans.*` のホスト関数の Rust 実装が必要で、段階 4 の最大の仕事。
- プラグイン API を増やすほど互換(`apiVersion`)の負担が増える。コアプラグインは本体と同時に更新するので、先に API を試す場にできる。

## apk 単位の分割(決定 3)

- Tauri 公式の状況(2026-10 に再確認): Android のマルチ WebView は issue #11528(2024〜)が open。task を窓ごとに分け、activity embedding で複数 WebView を載せる PR #16262(`feat(android): use a task per window, activity embedding for multiwebview`、2026-10-12 作成、6 commits・84 files)は **open・未マージ**。issue #15857(2026-08)も open。デスクトップは複数ウィンドウが使える。
- 別 apk にする前提の設計: コアプラグインは「manifest + バンドル」で自己完結させ、`disnans` のホスト実装(`app/src/lib/plugins/` と `transport/`)を本体から分けて再利用できる形に(`@disnans/runtime` のようなパッケージ)すると、別アプリの殻がその上に同じバンドルを載せるだけになる。
- 別 apk の課題(未解決): サーバー URL・認証・設定の受け渡し(ContentProvider / bound service / 各アプリで入力)、署名、`release.yml` での配布、本体との更新の連動。Activity 分割は同一 apk・同一 UID で共有しやすいが、Tauri が複数 Activity を公式に扱うまでは自前の Kotlin が必要で保守が重い。

## 現在確認済み / 未決

確認済み(コードと文書で確かめた事実):
- プラグインは ES モジュールを Blob URL から import し、`disnans` を受け取る(`host.svelte.ts` の `importModule`)。Svelte・本体のストアは import できない。
- 供給元は `Wanted`(サーバー配布・開発用フォルダ)。権限は `files` のみ(`manifest.ts`・`runtime.ts`)。
- 設定画面・ナビバーは Rust の静的な木から GUI(`SettingsTree.svelte`)と TUI(`tui/settings.rs`)が描く。プラグインの UI は木に載っていない([UI_TREE.md](UI_TREE.md))。
- TUI のプラグイン実行(JS)は未実装(FEEDBACKS「TUI向けのプラグイン」)。共有フォルダの REST は `client-core/src/rest_api.rs`(`shared_list` など)にある。
- Tauri の Android マルチ WebView は公式未対応(上記)。

未決は下の「chief への質問」にまとめた。

## chief への質問

1. L3(宣言的な木)の置き場: 木の型は Rust(`client-core`)を正にして ts-rs で TS を生成する案でよいか(既存の `protocol/` と同じやり方)。
2. TUI の JS 実行は、組み込みエンジン(QuickJS 系)を CLI に入れる案でよいか。別案は、プラグインの論理を Rust 側(WASM など)に移す案(重い)。
3. コアプラグインの権限: 同梱だが `permissions` を宣言する方針でよいか。サードパーティの権限をユーザーが確認する仕組みは今は無いが、先に作るか。
4. L2(Svelte)の期間: エクスプローラーを L2 にしてから L3 へ移す(書き直しが 1 回増える)のと、段階 0 のあと直接 L3 にするのとで、どちらを優先するか。前者は抜き出しが早い。後者は無駄が少ないが、木の描画と TUI の実行が先に要る。
5. L1(命令型 DOM)の非推奨にする時期と、既存のサードパーティ(ダイスなど)の扱い。
6. `@disnans/runtime` の分離(apk 分割の前提)を、段階 2 のうちから始めるか。
