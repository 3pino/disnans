# 宣言的な木の型（Node・アクション・効果・セレクター）

状態: **設計案(未実装)**。コードは書いていない。ここの型は下書き（コードブロックは Rust の形の案で、まだコンパイルしていない）。
前提: [tree-model.md](tree-model.md)（Elm 型・GUI ヒント・3 層）、[vocabulary.md](vocabulary.md)（部品の語彙）、[explorer-tree.md](explorer-tree.md)（実際の画面からの要求）、[UI_TREE.md](../UI_TREE.md)（今ある静的な木）。
部品の最終的な語彙は designer の移行の棚卸し（`docs/core-plugins/migration-inventory.md`。まだ無い）と揃える。ここでは構造（型・イベント・効果・セレクター）だけを決める。

## 0. 決めること・決めないこと

- 決める: Node の形、イベントとアクションの対応、効果（effects）の種類、共有状態の参照の表し方、JSON と生成の方針、既存の設定の木からの写像、テストの型。
- 決めない: 部品の名前と props の細部（棚卸しに従う）、TUI の描画の詳細、エクスプローラーの画面（[explorer-tree.md](explorer-tree.md)）。

## 1. Node（木のノード）

### 1.1 形

共通の属性（id・key・show・GUI/TUI のヒント・イベント）と、部品ごとの中身（`kind`）に分ける。JSON は 1 段にする（TS から読みやすくするため）。

```rust
/// 木の 1 ノード（JSON では属性と `type` を同じ階層に置く）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Node {
    /// 画面の中で一意な名前。イベントの宛先・フォーカス・テストに使う。イベントを持つノードは必須
    pub id: Option<String>,
    /// 同じ親の中での突き合わせ（List の項目では必須）
    pub key: Option<String>,
    /// どの UI に出すか（省略は両方）。現行の Show と同じ（§1.4）
    pub show: Option<Show>,
    /// GUI だけのヒント（TUI は無視）。§1.5
    pub gui: Option<GuiHint>,
    /// TUI だけのヒント（GUI は無視）。§1.5
    pub tui: Option<TuiHint>,
    /// このノードのイベントに結びつくアクション。§2
    pub on: Events,
    /// 部品の中身（JSON では `type` とその項目が同じ階層に並ぶ）
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Kind {
    Stack { dir: Dir, gap: Gap, wrap: bool, children: Vec<Node> },
    Text { text: String, tone: Tone, strong: bool },
    Icon { name: String },
    Image { src: String, alt: String, size: Size },
    Button { label: String, icon: Option<String>, variant: Variant, disabled: bool },
    Input { value: String, placeholder: String, multiline: bool, error: Option<String> },
    Toggle { checked: bool, label: Option<String> },
    /// 選択肢（segmented は横並び、select は一覧）。value は保存する値
    Choice { style: ChoiceStyle, options: Vec<Opt>, value: String },
    /// 数の入力。value は表示する値（保存する値 × scale。今と同じ）
    Slider { value: f64, min: f64, max: f64, step: f64, scale: f64, unit: String },
    List { items: Vec<Node>, selected: Vec<String>, selectable: bool, reorderable: bool, empty: Option<Box<Node>> },
    Menu { items: Vec<MenuItem> },
    Dialog { title: String, children: Vec<Node>, actions: Vec<Node>, danger: bool },
    PanelBar { title: String, crumbs: Vec<Crumb>, actions: Vec<Node> },
    Tabs { items: Vec<TabItem>, selected: String },
    Divider,
    Status { text: String, kind: StatusKind, busy: bool },
    /// 設定の 1 行（名前・補足・右の操作）。操作が無ければ control は None（行全体がボタンになるなら on.press を持つ）
    Setting { name: String, description: Option<String>, icon: Option<String>, control: Option<Box<Node>>, trailing: Trailing },
    /// 見出し付きの節（Stack の見出し版）
    Section { title: String, children: Vec<Node> },
    /// 中身を各 UI が描く場所（§1.6）
    Slot { slot: String, props: Option<serde_json::Value> },
}
```

- 値（`checked`・`value`・`selected` など）は**木の中に入る**（`view(state)` が状態から作る）。木が値を持たない今の設定の木（[UI_TREE.md](../UI_TREE.md)）とは違う点（§4）。
- `Setting` は vocabulary の `Setting` と同じ。現行の `Field`・`Link`・`Note` は §4 で写す。

### 1.2 補助の型（案）

```rust
pub enum Dir { V, H }                         // Stack
pub enum Tone { Normal, Muted, Danger }       // Text
pub enum Variant { Primary, Ghost, Danger }   // Button
pub enum ChoiceStyle { Segmented, Select }
pub enum StatusKind { Info, Error }
pub enum Trailing { None, Chevron }           // Setting の右の印（Link は Chevron）
pub struct Opt { pub value: String, pub label: String, pub icon: Option<String> }
pub struct MenuItem { pub id: String, pub label: String, pub icon: Option<String>, pub checked: bool, pub danger: bool, pub on: Events }
pub struct Crumb { pub label: String, pub on: Events }
pub struct TabItem { pub id: String, pub label: String, pub icon: Option<String> }
```
`Gap` `Size` は列挙（小・中・大など）。値の範囲は棚卸しで決める。

### 1.3 サイズの上限（案）

- 木の深さ 32 まで、1 画面のノード数 5000 まで、JSON は 1 MB まで。超えたら受け取る側（Rust）で拒む（`tree_too_large`）。
- `Slot` は 1 画面に多くても数個。Slot が増えたら語彙を足す（tree-model の (c)）。

### 1.4 show（表示の条件）

現行の `Show { gui, tui }` と `Gui`（`always` / `never` / `android` / `notAndroid` / `tauri` / `tauriOrDev`）をそのまま使う（UI_TREE.md の表と同じ）。
GUI の条件の判断は GUI が行い、TUI の判断は `tui: bool` だけ。TUI で意味の無い節は `tui: false` にする。

### 1.5 GUI ヒント・TUI ヒント

ヒントは **型のある構造体**にする（自由な JSON にしない。型が無いと GUI と TUI で食い違う）。知らないヒントは無視する。

```rust
pub struct GuiHint {
    /// 行のサムネイル（画像・PDF）。TUI は種類のグリフを出す
    pub thumbnail: Option<Thumb>,
    /// グリッド表示（List）
    pub layout: Option<Layout>,
    /// 長押しで context を出す（タッチの入力手段。アクションは context と同じ）
    pub long_press: bool,
    /// ファイルのドロップを受ける（アクションは upload と同じ形）
    pub drop_files: bool,
    /// アニメーションの種類（GUI だけ。TUI は無視）
    pub animation: Option<Animation>,
}

pub struct TuiHint {
    /// TUI で出す代わりの文字（GUI のサムネイルの代わり等）
    pub fallback_text: Option<String>,
    /// キーの割り当てを表示する（例: "Space"）
    pub key_hint: Option<String>,
}
```
- 原則（tree-model の (c)）: ヒントを外しても意味が通ること。動作は `on` のアクションで決まり、ヒントはその入力手段を強めるだけ。
- TUI のジェスチャー（ドラッグ・アニメーション）は、同じ動作の別のアクション（例: 「上へ」「下へ」は `reorder` の `to`）として `on` に置く。

### 1.6 Slot

`Slot { slot, props }` は、各 UI が中身を描く場所（今の `Slot` と同じ役）。GUI の `SettingsView` の `slot` のように、id ごとに描き方を持つ。TUI が描けない Slot は、その節ごと TUI で出さない（`show.tui: false`）。

### 1.7 id・key の規則

- `id`: 画面の中で一意。イベントを持つノードは必須。フォーカスの戻し先と、テストの宛先（`uiTree.test.ts` のような確認）に使う。
- `key`: List の項目は必須。並びが変わっても同じ項目を同じものとして扱う（GUI は keyed each、TUI は再描画）。
- 木の差分は最初は全体を送る（tree-model の (d)）。

## 2. イベントとアクション

### 2.1 バインド

`Events` はイベント名ごとに 1 つの `Binding` を持つ。`Binding` は「アクション名」と「ノードに埋め込む値（任意）」。

```rust
pub struct Events {
    pub press: Option<Binding>,
    pub change: Option<Binding>,
    pub submit: Option<Binding>,
    pub select: Option<Binding>,
    pub context: Option<Binding>,
    pub reorder: Option<Binding>,
    pub close: Option<Binding>,
}

pub struct Binding {
    /// update に渡すアクション名（例: "open"・"set-pref"）
    pub action: String,
    /// ノードに埋め込む値。UI は変えずにそのまま渡す（例: 行の `{ "path": "docs" }`）
    pub arg: Option<serde_json::Value>,
}
```

例（chief の例の形）: 行の押下は `on: { press: { action: "open", arg: { path: "docs" } } }`。
入力欄は `on: { change: { action: "rename-draft" } }` で、値は UI が入力時に送る。

### 2.2 UI が update に送るメッセージ

UI は入力を次のメッセージにして、`update` に渡す。どのイベントでも形は同じ。

```rust
pub struct Msg {
    /// バインドしたアクション名
    pub action: String,
    /// 発生元のノード（id）。同じアクション名の別のボタンを区別する
    pub node: Option<String>,
    /// バインドの埋め込み値（そのまま）
    pub arg: Option<serde_json::Value>,
    /// イベントごとの中身（下の表）
    pub payload: Payload,
}

#[serde(tag = "event", rename_all = "camelCase")]
pub enum Payload {
    /// 押した。List の行なら key が入る
    Press { key: Option<String> },
    /// 値が変わった（Toggle・Input・Choice・Slider）
    Change { value: serde_json::Value },
    /// 入力で確定（Enter など）
    Submit { value: String },
    /// 行を選んだ
    Select { key: String },
    /// 文脈メニュー（長押し・右クリック・メニューキー）。行なら key
    Context { key: Option<String> },
    /// 並べ替え。to は動かしたあとの位置（上へ・下へも同じ）
    Reorder { key: String, to: u32 },
    /// 閉じた。reason は "cancel"・"confirm"・"escape"
    Close { reason: String },
    /// ホストからの通知（画面を開いた・戻る・前面に戻った）
    Lifecycle { kind: String },
    /// 効果の結果（§3 の then）
    Result { id: String, ok: bool, value: Option<serde_json::Value>, error: Option<String> },
    /// 進捗（アップロードなど。id は効果と同じ）
    Progress { id: String, ratio: f64 },
}
```

| イベント | 誰が発生させるか | payload |
|---|---|---|
| press | Button・Image・Setting（行）・Menu の項目・PanelBar の操作・パンくず | `key`（List の行のときだけ） |
| change | Toggle・Input・Choice・Slider | `value`（そのコントロールの値の型） |
| submit | Input（確定） | `value` |
| select | List（行の選択） | `key` |
| context | List の行・Menu のアンカー | `key`（行のとき） |
| reorder | List（`reorderable`）。TUI は「上へ・下へ」のキーで同じ形を送る | `key`・`to` |
| close | Dialog | `reason` |
| （画面全体） | `onBack`（戻る・Esc・Alt+←） | `lifecycle` の `kind: "back"` |

- 静的な値（`arg`）と、UI が入れる値（payload）は分けて渡す。update は両方を見る。
- 「UI が入力時に update へ送る」の具体: Input の変更は `change`、確定は `submit`。値はそのノードの型（string）で入る。

## 3. 効果（Effect）と結果

### 3.1 update の形

```text
update(state, msg) -> (state', effects[])
```

- `state` は画面の状態（JSON。画面ごとの型）。`effects` は**ホストが実行する**命令の列。update の中で I/O はしない（純粋）。
- 効果の結果は、`then` で指定したアクション名の `Msg`（`payload.event = "result"`）として返る。進捗は `progress`。

```rust
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    /// 共有フォルダの操作（client-core の `shared_*`）。結果は then のアクションで返る
    Shared { id: String, op: SharedOp, then: String },
    /// 画面の移動。サブページ（設定の中のページ）は状態で持つので、効果にしない
    Navigate { to: Nav },
    /// アプリ内のトースト
    Toast { text: String, kind: ToastKind },
    /// クリップボード（テキスト・画像の読み取りは結果を then で返す）
    Clipboard { op: ClipboardOp, then: Option<String> },
    /// システム通知（通知の設定に従う）。Android は常駐サービスに任せる（今の方針と同じ）
    Notify { title: String, body: String },
    /// 設定の保存（prefs）。scope は user・device・local（V5 の分類と同じ）
    SavePrefs { scope: PrefScope, key: String, value: serde_json::Value },
    /// 画像の拡大（overlay。Slot を使わずに済む場合の語彙）
    Lightbox { src: String, alt: String },
}

pub enum SharedOp {
    List { dir: String },
    Mkdir { dir: String, name: String },
    Rename { path: String, to: String },
    Delete { paths: Vec<String> },
    Copy { paths: Vec<String>, dest: String },
    Move { paths: Vec<String>, dest: String },
    /// 送る中身はホストが持つ（ファイルの選択で得た参照。JSON には入らない）
    Upload { dir: String, files: Vec<FileRef> },
    Url { path: String },
}
pub enum Nav { Open { screen: String, props: Option<serde_json::Value> }, Back, Close, Tab { id: String } }
pub enum ToastKind { Info, Error }
pub enum ClipboardOp { WriteText { text: String }, ReadText, ReadImage }
pub enum PrefScope { User, Device, Local }
pub struct FileRef { pub handle: String, pub name: String, pub size: u64 }
```

### 3.2 結果と進捗

- `Shared` の結果は `then` のアクションで `payload: result { id, ok, value | error }`。失敗は `ok: false` と `error`（既存の API の `{ status?, code, message }` と揃える）。
- 進捗（アップロードの割合）は `progress { id, ratio }` を同じ `then` 系のアクションに送る（`files.upload.progress`）。
- **再送はしない**（送信と同じ方針）。結果が無いまま止まったら、`unknown` として扱う（今の chat の方針）。

### 3.3 確認ダイアログは効果にしない

削除の確認・上書きの確認は、状態の `dialog`（木の `Dialog`）で持つ。効果の `Confirm` は作らない（画面の状態で決まることで、テストもしやすい）。

## 4. 共有状態の参照（セレクター）

### 4.1 表し方

画面は、読む共有状態を**宣言**する（`uses`）。ホストは宣言した分だけを view に渡し、変わったときだけ view を呼び直す。

```rust
pub struct Screen {
    /// 画面の版。対象の host API（disnans.apiVersion）と揃えて扱う（§5）
    pub api_version: u32,
    pub id: String,
    pub title: String,
    /// 読む共有状態（例: "me", "users", "prefs.navBarItems", "chat.messages"）
    pub uses: Vec<String>,
    /// 戻る（Android の戻る・Esc・Alt+←）
    pub on_back: Option<Binding>,
    pub shortcuts: Vec<Shortcut>,
    /// 木（view(state) の結果）
    pub root: Node,
}
pub struct Shortcut { pub action: String, pub default_key: String, pub label: String }
```

### 4.2 参照できる共有状態（案。最終形は棚卸しと揃える）

| 参照 | 値の形 | 出所 | 備考 |
|---|---|---|---|
| `me` | `{ id, name, avatar }` | サーバー（`api_me`） | |
| `users` | `Map<id, User>` | サーバー | 名前の解決は TS のまま（V4 の決定） |
| `prefs.<key>` | 設定の値（DEFINITIONS の型） | `prefs`（ユーザー共通） | 例 `prefs.navBarItems` |
| `device.<key>` | 同上 | デバイスごと（V5） | |
| `chat.messages` | 表示中の一覧（木の `Row` 相当は別に作る） | Rust チャット経路 | 大きいので、木には載せない（Slot か、別の参照） |
| `call.participants` | 参加者の一覧 | 通話 | |
| `call.status` | 通話の状態 | 通話 | |
| `shared.listing` | 直近の一覧（`Shared(List)` の結果） | 効果の結果を画面が保存 | `uses` に入れず、state に入れる方が自然 |

- 参照は**読むだけ**。書くのは効果（`SavePrefs` など）だけ。
- 参照の名前と値の形は、Rust と TS の両方に同じ表を置き、フィクスチャで照合する（§6）。

### 4.3 プラグインの状態

画面の状態（state）はプラグインが持つ（tree-model の (b)）。プラグインは `uses` で読む共有状態を宣言する。ホストが `uses` 以外を渡さないので、プラグインが本体の内部を見ることはない（同じ plugin API の範囲）。

## 5. JSON・バージョン・生成

### 5.1 JSON

- 木・メッセージ・効果は JSON。キーは camelCase、`type`（タグ）は小文字の camelCase（既存の `view::ui` と同じ）。
- 知らない `type`（新しい版の部品）は、TS・TUI ともに**その部品を出さず、警告を残す**（落とさない）。Rust の受け側は `Kind::Unknown` で受けて、描かない。

### 5.2 版

- 木の版は `Screen.api_version` で持つ。プラグインの manifest の `apiVersion`（既存。対象の host API の版）と同じ仕組みで、本体がこれより古いと読み込まない（既存の `compat.ts` の扱い）。
- 新しい型（この木）を使う版は、`disnans.apiVersion` を上げる（いまは 15。上げるかは chief の判断）。既存の `registerView`（L1）は動かし続ける。

### 5.3 生成（ts-rs）

- 木の型は Rust を正にし、ts-rs で TS を生成する（`protocol/` と同じ。CORE_PLUGINS の質問 1 への案）。
- 生成先: `app/src/lib/tree/`（生成物。手で直さない）。`scripts/check-rust.sh` と CI で差分を見る（`uiTree.generated.ts` と同じ仕組み）。
- 注意（要確認）: `#[serde(flatten)]` と内部タグ（`#[serde(tag = "type")]`）の組み合わせを、ts-rs が正しく出すか未確認。出ない場合の案は `kind: Kind` を入れ子にする形（JSON は 1 段深くなる）。**最初に小さな試作で確かめる**。
- 型の置き場所: `crates/client-core/src/view/tree.rs`（案）。client-core に ts-rs を足す（Cargo は chief）。代案は `crates/shared`（protocol と同じ crate）。

### 5.4 既存の生成物との関係

- `uiTree.generated.ts`（静的な設定の木）は、移行の間は残す。新しい木が設定の画面を描けたら、古い木を生成から外す（§7）。

## 6. テストの方針

1. **JSON ラウンドトリップ**: Rust で全部の `Kind`・`Payload`・`Effect` を JSON にして読み戻し、一致を確かめる。TS 側も同じ JSON を型で読めることを確かめる（ts-rs の生成物）。
2. **共通フィクスチャ（木）**: `crates/client-core/tests/fixtures/tree/*.json`。GUI（TreeView）と TUI（描画）は、同じ木から**意味の要約**（種類・表示の文字・アクション名・key）を作り、フィクスチャの `expected` と一致させる。描画の細部（色・幅）は比べない（batch 7 の suggest と同じ考え方）。
3. **共通フィクスチャ（アクション）**: `(state, msg) -> (state', effects)` の JSON。Rust の built-in 画面と、TS（プラグインの実行環境）の両方で同じフィクスチャを通す。
4. **検証の単体テスト**: 重複した id・List の key の無い項目・深さの上限・Slot の数・未知の `type` の扱い。
5. **写像のテスト（§7）**: 静的な設定の木の全 Field・Link・Note・Slot が、新しい木の同じ位置に出ること（節の順・show・ラベル・選択肢の値）。
6. **生成物の差分**: `app/src/lib/tree/` の生成物が Rust と一致すること（CI）。

## 7. 既存の設定の木を新しい型へ寄せる（写像）

設定画面が最初に新しい型で動く（tree-model の (d) の ①）。写像は次の表のとおり。

| 現行（`view/ui.rs`） | 新しい Node | 値・イベント |
|---|---|---|
| `Page { id, title, sections, show }` | 画面の `root` の `Stack`（id = page id）。サブページは `Setting` の押下で状態を切り替える | 値なし |
| `Section { id, title, items, show }` | `Section { title, children }`（id・show は Node の属性） | — |
| `Field { id, label, icon, key, control, show }` | `Setting { name: label, icon, control, … }`。control は下の表 | 値は `view(state)` が prefs から入れる。`change` は `SavePrefs`（key・scope は `DEFINITIONS`） |
| `Control::Toggle` | `Toggle { checked }` | `change` → `value: bool` |
| `Control::Segmented { options }` | `Choice { style: segmented, options, value }` | `change` → `value: string` |
| `Control::Select { options }` | `Choice { style: select, options, value }` | 同上 |
| `Control::Slider { min, max, step, scale, unit }` | `Slider { value (= 保存値 × scale), min, max, step, scale, unit }` | `change` → `value: number`（表示の値。保存は `value ÷ scale`。今と同じ） |
| `Link { id, label, page, show }` | `Setting { name: label, trailing: chevron, on.press: { action: "open-page", arg: { page } } }` | 押下でサブページの状態に入る（効果ではない） |
| `Slot { id, show }` | `Slot { slot: id }` | 各 UI が描く（今と同じ） |
| `Note { id, text, show }` | `Text { text, tone: muted }` | — |
| `DERIVED_KEYS`（`limiterStrength`） | `Setting` の control を `view` が計算した値で作る。`on` は持たない（読むだけ） | — |
| `show` | Node の `show`（同じ `Show`） | — |

- 値の差し込み: 今は UI が prefs から差し込む（木は値を持たない）。新しい木では `view(state)` が差し込んだ木を返す。**定義（`DEFINITIONS`）と項目の並びは変えない**。
- 移行の手順: ①新しい型で設定の木を作る関数を足す（静的な `SETTINGS_PAGES` は残す）②写像のテスト（§6-5）で、同じ項目が同じ順に出ることを確かめる③GUI の `SettingsTree` を `TreeView` に置き換える④TUI の `settings.rs` の `rows` を新しい木から作る⑤静的な木と生成物を消す。
- 変えない: 設定の既定値・保存先・文言・show の条件（UI_TREE.md の「現状と残り」の項目は別途）。

## 8. 決めてほしいこと（chief・designer へ）

1. **update の実行場所（built-in 画面）**: 設定のような Rust の画面は、`update` も Rust で書く（純粋関数）か、JS で書くか。案は Rust（設定は prefs だけなので、Rust の方が単純。テストも Rust）。プラグインは JS。
2. **型の置き場所**: `client-core/src/view/tree.rs`（ts-rs を client-core に足す）か、`crates/shared`（protocol と同じ crate）か。
3. **flatten の試作**: §5.3 の ts-rs の確認を、設計の確定の前にやるか（小さな試作で確かめる。crates には入れない案もある）。
4. **結果の返し方**: `then`（画面ごとのアクション名）で返すか、`result` の一般的なアクションにするか。案は `then`（画面が読みやすい）。
5. **Slot の上限**: 1 画面の Slot の数の上限（案: 数個まで。超えたら語彙を足す）。
6. **API の版**: 木を使う版（`apiVersion` 16 など）の番号と、L1 の非推奨の時期（CORE_PLUGINS の質問 5）。
7. **Settings の値の差し込み**: `view(state)` で差し込む案で良いか（木が値を持たない今の方針からの変更。UI_TREE.md の「木は値を持たない」を、「木は状態から作られる値を持つ」に変える）。

## 9. リスク

- 型を固めすぎると変えにくい。最初は設定画面（§7）と、エクスプローラーの木（[explorer-tree.md](explorer-tree.md)）に必要な語彙だけにし、版で守る。
- `flatten` と ts-rs の組み合わせが出ない場合、JSON の形（1 段か入れ子か）が変わる。試作で先に確かめる。
- 効果の結果を `then` で返す形は、同じ画面で同じ処理を並行して走らせると結果の取り違えが起きうる。`id` で照合する（`Shared.id` と `Result.id`）。
- 参照（`uses`）の表を増やしすぎると、ホストの実装が肥大する。セレクターは読み取りだけにし、書き込みは効果に限る。
