# TUI と共有する「画面の木」の設計

状態: **設計案(未実装)**。[CORE_PLUGINS.md](../CORE_PLUGINS.md) の決定 4(TUI と共有する目標は必ず成し遂げる)を前提にした道筋。ここに書いたことはすべて案で、確定していない。現状の事実は「現状」の節だけ。

## 現状(事実)
- `crates/client-core/src/view/ui.rs` に、設定画面とナビゲーションバーの**静的な木**がある(`Page → Section → Item(Field / Link / Slot / Note)`、`Show { gui, tui }`、`Control`(Toggle / Segmented / Select / Slider))。`const` で値は持たない。値は各 UI が prefs から差し込む。
- GUI へは `uiTree.generated.ts`(`cargo test -p disnans-client-core` で生成)で渡し、`SettingsTree.svelte` が描く。TUI は `tui/settings.rs` が描く。([UI_TREE.md](../UI_TREE.md))
- 木に**イベントはなく**、状態も持たない(`Field.key` で prefs に結びつくだけ)。動的な中身は `Slot` にして各 UI が描く。
- プラグインの UI(`disnans.ui`)は DOM を返す命令型で、木には載っていない。TUI のプラグイン実行は未実装。

## 目標の形: Elm 型(状態 → 木、操作 → アクション)

```
state ──view(state)──▶ Node(木)  ──各 UI が描く──▶ 画面
  ▲                                                │
  └──update(state, action)◀── アクション(名前 + 値)┘
```

- 画面は `{ init, view, update }`。`view` は**純粋**(状態から木を作る)、`update` は状態とアクションから新しい状態と**副作用**(共有フォルダの呼び出し・ナビ・トースト)を返す。
- 木の部品は、見た目ではなく「何を出すか」の宣言。イベントは**アクション名と値**で宣言し、各 UI が入力(クリック・キー)をバインドして `update` に送る。
- 木は JSON にできる値。Rust で型を定義し、ts-rs で TS を生成する(`protocol/` と同じやり方)。

## (a) 木に載せる粒度
- 語彙は小さく、画面の意味を持つ単位にする([vocabulary.md](vocabulary.md))。例: `Stack` `Text` `Icon` `Button` `Input` `Toggle` `Choice` `List` `Menu` `Dialog` `PanelBar` `Tabs` `Divider` `StatusLine` `Image`。DOM の `div` やスタイルは載せない。
- 既存の GUI 部品(`components/ui/`)と TUI の部品(`tui/ui/`)の対応表([DESIGN.md](../DESIGN.md) の「部品の対応」)をそのまま語彙の出発点にする。
- 既存の設定の木(`Page/Section/Field/Link/Slot/Note`)は、同じ語彙の特別な場合として後から寄せる(`Section` = 見出し付き `Stack`、`Field` = `SettingRow` + 部品)。
- イベント: `press`(押す)・`change`(値が変わる)・`submit`・`select`(行の選択)・`context`(メニュー)・`reorder`。値の型は語彙の表で決める。長押し・ドラッグは GUI の入力手段で、木にはアクションとして現れる(`context` や `reorder`)。

## (b) 状態の持ち方
- 状態は**プラグイン(画面の定義)が持つ**。UI は描画と入力だけ。GUI も TUI も同じ `update` を呼ぶ。
- 実行場所: GUI は WebView の JS。TUI は CLI に組み込む JS エンジンで同じ JS を動かす案(`disnans.*` のホスト関数は Rust で実装し、共有フォルダは `client-core` の `shared_*`)。別案は状態の論理を Rust に移す案(エクスプローラーの選択・バッファ・表示・並び・パンくず・転送の計画を Rust で書き直す)。後者は TUI だけでなく GUI でも WASM か invoke が要り、現実性は低い(コストが大きく、サードパーティが Rust を書けない)。**JS を TUI で動かす案を推す**(未決・質問 2)。
- 状態の永続は `loadData / saveData`(現行のまま)。ユーザー設定は prefs。
- エクスプローラーの状態(選択・バッファ・表示形式・並び・パンくず)は、今も `stores/explorer*.svelte.ts` に分かれている。段階 0 でこれを UI 非依存の純粋なモジュール(状態 + アクション → 状態 + 副作用)にしておけば、`update` へそのまま移せる。

## (c) GUI 専用の見た目の扱い
- 木の各ノードに任意の **`gui` ヒント**(TUI は無視する)を付ける。例: 行の `thumbnail: { src, kind: 'image'|'pdf' }`、`animation`、`dragDrop: true`、`longPress`、グリッド表示 `layout: 'grid'`。ヒントが無くても意味が通ること(ヒントは強化)。
- 構造が GUI にしか意味を持たないものは、`Slot { id }`(各 UI が描く)として残す。Slot が多い画面は TUI で共有できていないので、Slot の増加は設計の失敗として扱い、語彙を足す側で解決する。
- `show: { gui, tui }`(現行の `Show`)で、片方だけに出す節・項目を宣言する。TUI の代替(サムネイル → ファイルの種類のグリフ)は TUI 側が持つ。
- TUI でできないこと(アニメーション・ドラッグ)は、同じ動作をキーで行う別のアクション(並べ替え = 「上へ」「下へ」)として木に宣言し、各 UI が自分の入力に割り当てる。

## (d) プラグイン API の 3 層と一本化

| 層 | API | 動く場所 | 移行 |
|---|---|---|---|
| L1 命令型 DOM | `registerView` + `containerEl` + `disnans.ui.*` | GUI | 互換のため残す。新規は L3 を勧める。最後に非推奨 |
| L2 Svelte ビルド | 同上の API + Svelte(コアのみ) | GUI | 抜き出しの中継。L3 が使えるようになったら移す |
| L3 宣言的な木 | `registerScreen({ init, view, update })` | GUI・TUI | 最終形 |

- L1 と L3 の橋: `registerView` の中で GUI 専用の `Slot`(= L1 の DOM を差し込む)を使える。これにより、既存のサードパーティが L3 へ段階的に移れる(画面を丸ごと書き直さなくてよい)。
- 一本化の順序: ①L3 の型と GUI の汎用 `TreeView.svelte`(まず GUI だけで動かす)→ ②TUI の描画と JS 実行 → ③エクスプローラーを L3 に移す → ④L1/L2 を非推奨。①②の間は GUI と TUI で同じ木が動くかを、設定画面(木に寄せた静的な画面)で先に確かめる。
- 木の差分: 最初は毎回全体を送る(画面が小さいので十分)。リストは `key` を持たせ、UI 側が突き合わせる(GUI は Svelte の keyed each、TUI は再描画)。

## (e) エクスプローラーを木で書く
→ [explorer-tree.md](explorer-tree.md)

## リスク
- 語彙が足りず `Slot` と GUI ヒントだらけになると、TUI との共有が名ばかりになる。エクスプローラーのような実際の画面から語彙を決める。
- 木の設計を一度に固めすぎると変えにくい。最初は設定画面とエクスプローラー(2 つ)に必要な語彙だけにし、`apiVersion` で版を持つ。
- TUI の組み込み JS のコストと安全性(ネットワーク・ファイルの権限をホスト関数だけに限る)。
