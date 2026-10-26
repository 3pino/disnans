# GUI 全体を宣言的な木へ移す: 棚卸しと移行計画

状態: **設計案(未実装)**。ユーザー決定は「宣言的な木(L3)への移行が最優先。今の GUI をすべて木に移すところからやる」だけ。分類・語彙・順序はすべて案。
前提: [CORE_PLUGINS.md](../CORE_PLUGINS.md)(触らない)、[tree-model.md](tree-model.md)、[vocabulary.md](vocabulary.md)(v1 の語彙)、[UI_TREE.md](../UI_TREE.md)(設定画面・ナビバーの静的な木=実装済み)。
行数は `app/src/` の `wc -l`(2026-10 時点、テスト除く)。分類の A / B / C は次のとおり。

- **A**: [vocabulary.md](vocabulary.md) の語彙(v1)で表せる
- **B**: 語彙の追加で表せる(何を足すかを書く)
- **C**: 本質的に GUI / ブラウザー依存。木の中では **`Slot`(各 UI が描く)** にし、TUI の代替を書く

## 1. 画面・部品の一覧と分類

### 1.1 殻・ナビゲーション・全体のオーバーレイ
| 項目(行数) | 役割 | 分類 | 木にする方法 / 足すもの / TUI |
|---|---|---|---|
| `App.svelte`(214) | 起動(接続前は Setup、後は Shell)・ホットキー・ドロップ・前面/背面・各オーバーレイの置き場 | B | 画面の切替は木のルート `App` 宣言(`screens`・`overlays`)。ホットキーは既存コマンド。TUI は `tui/app.rs`(2909)が担当しており、ルートは各 UI が持つ |
| `Shell.svelte`(210) | 3 つのタブ(チャット/設定/通話)+右のパネル+ナビバー+上の枠。モバイルは全画面パネル | B | `Layout { main, panel?, nav, top }`(**レイアウトの語彙**)。幅による切替(`isMobile` 767px)は UI が決める。TUI は 1 画面 1 つ(`navbar_line`) |
| `NavBar.svelte`(71)+`ui/NavBar`(73) | ナビバー。項目はコマンド+設定(`navBar`)。静的な木 `NAV_ITEMS` 済み | A | `Tabs`。TUI は `tui_nav_items`(実装済み) |
| `TopBarSlot`(29)・`PluginStatusBar`(44) | 上の枠。通話のバー+プラグインの `addStatusBarItem` | A/C | `Stack` + 通話バー。プラグインの DOM 要素は L1 の `Slot`(GUI のみ)、L3 では `StatusItem` ノード(B) |
| `ConnectionBanner`(77) | 切断の表示(時間で出し分け) | A | `Status`(`kind`・`busy`)。出し分けは `view` が時間を受け取って決める(ホストの `time` 購読) |
| `Toasts`(96)・`ui.toasts` | トースト(キュー・自動で消える・アバター付き) | B | **オーバーレイ層**(`Overlay: Toast`)。トーストはホストの効果 `toast(text, kind)`。TUI は `Toast`(実装済み部品) |
| `ConfirmDialog`(25)・`ui.confirmReq` | 確認 | A | `Dialog`。効果 `confirm(...)` が結果をアクションで返す。TUI は `Dialog::confirm` |
| `ui/Modal`(23) | モーダルの枠(幕+Esc) | A | `Dialog` |
| `ui/Menu`+`MenuItem`(53+74) | 位置指定のメニュー | A | `Menu`。TUI は `Menu`。`anchor` は GUI のみ意味(TUI は中央) |
| `ActionSheet`(129) | モバイルの下から出る選択肢 | A | `Menu`(`presentation: 'sheet'` は GUI のヒント) |
| `CommandPalette`(124) | コマンドの絞り込み | A | `Dialog { Input + List }`。TUI は `tui/commands.rs`(348)の既存 |
| `EmojiPicker`(77) | 絵文字の選択 | B | `Grid`(行折り返しの `List`)+検索 `Input`。TUI は `Choice` で代替(`view::emoji` が共通データ) |
| `Lightbox`(314) | 画像の全画面・ピンチ/ドラッグ・ギャラリー | C | `Slot(lightbox)`。GUI: ピンチ・パン・ダブルタップ(`lib/lightbox`)。TUI: 画像の描画層(`tui/picture.rs`・`graphics.rs` 627)が使える端末だけ。無ければ「保存」 |
| `Setup`(142)・`AppIcon`(8) | サーバー URL の入力・確認(接続前) | A | `Input` + `Button` + `Status`。TUI は CLI の引数/設定で足りる(非対応でよい) |

### 1.2 設定(木で実装済み)
| 項目 | 状態 | 分類 |
|---|---|---|
| `SettingsView`(595)・`SettingsTree`(67)・`SettingsField`(81) | 静的な木(`view::ui::SETTINGS_PAGES`)+ Slot | 木 = 実装済み。Slot は下 |
| Slot `profile` / `notifications` / `version` / `customThemes` / `plugins`(`SettingsView`・`ThemeSettings`165・`PluginSettings`307・`PluginManageSection`109・`PublishButton`88) | プロフィール(画像の切り抜き)・通知の許可・更新・テーマ/プラグインの配布 | B(`Avatar` の編集は C = `ImageCropDialog`)。状態はホスト(`updater`・`notifications`・`pluginHost`) |
| Slot `hotkeys`(`HotkeySettings`273) | キー記録 | B(`KeyCapture` ノード。TUI は `tuiKeys` 別 Slot が既存) |
| Slot `navBar`(`NavBarSettings`108)・`composerMenu`(`ComposerMenuSettings`99) | 並べ替え・削除付きリスト(`ui/SortableList`483) | A(`List { reorderable, removable }`。`reorder`・`remove` イベント。ドラッグは GUI のヒント。TUI はキー) |
| Slot `devices`(`DeviceListSettings`122)・`callDevices`(`CallDeviceSettings`64)・`DeviceKindSettings`(105) | デバイス一覧・機器の選択 | A(`List`+`Input`+`Button`) |
| `PluginSettingsPage`(85)・`PluginSettingTab`(46) | プラグインの設定ページ。`addSettingTab` の `render(containerEl)` | C(L1 は DOM)。L3 では `registerSettings` が木を返す。移行期は `Slot(plugin-dom)` |

### 1.3 チャット
| 項目(行数) | 役割 | 分類 | 木にする方法 / 足すもの / TUI |
|---|---|---|---|
| `ChatView`(148) | メインのタイムライン+入力欄+検索の切替+添付パネル+ドロップ | B | `Screen { List(messages) + Composer + Search }` |
| `MessageList`(350) | スクロール(下端に張り付き・古い方を読み込み・未読の区切り・ジャンプ・既読の判定) | **B/C** | `List { stickBottom, loadOlder, anchor, onVisible }`(**スクロール語彙**)。測定(`scrollHeight` など)は UI が持ち、木はイベント `reachTop`・`visible`・`atBottom` を受ける。TUI は `visible()`(`tui/view.rs` 1394)が同じ役 |
| `MessageItem`(697) | 1 メッセージ(頭・本文・返信・カード・添付・リアクション・編集・ホバーの操作・長押し/右クリックのメニュー・編集のその場入力・既読) | B | **既にコアの意味データがある**: `view::Row` / `Line` / `Meta` / `Head`(`client-core/src/view/mod.rs` 507)を、TUI の `transcript`(984)と GUI の一部が使う。木では `MessageRow(row)` ノード(ホストが `timeline_rows` で作る)+操作の `Menu`。GUI のホバー・長押しは `gui` ヒント |
| `Markdown`(89)・`InlineNodes`(59)・`CodeBlock`(80) | 本文 | A/B | Rust の `view::markdown`(`Block` / `Inline`、`parse`)がすでに木。**`Rich { blocks }` ノードとして、そのまま埋め込む**(新しい木を作らない) |
| `FileLink`(133)・`Attachments`(174)・`PdfThumb`(58)・`RecentThumb`(65) | ファイルリンク・添付・サムネイル | B/C | `FileRef`(B: `path`・`kind`・`size`・状態)+サムネイルは `gui` ヒント(C = `IntersectionObserver`、`pdfjs`)。TUI: 種類のグリフ+名前、画像は描画層 |
| `Reactions`(85)・`ReplyQuote`(73)・`ReplyBar`(63) | リアクション・返信の引用・返信先のバー | A | `Row`+`Button`。`view::ReactionView`・`Meta::Reply` |
| `MessageCard`(149) | プラグインのカード(セッションの要約+「開いている人」) | B | `Card` ノード(`registerCardRenderer` の L3 版は木を返す)。L1 は DOM(Slot) |
| `Avatar`(54)・`AuthorAvatar`(43) | アバター(画像・イニシャル・ボット) | B | `Avatar { user | bot }`。TUI は頭文字(既存の `Head.avatar`) |
| `SearchResults`(259)・`stores/search`(109) | 検索のタイムライン(上へ追加読み込み) | B | `MessageList` と同じ `List` を再利用。入力は共通の `Input` |
| `Composer`(794)・`MessageInput`(441)・`SuggestList`(65) | 入力欄(下書き・補完 `@` `:` `/`・IME・貼り付け・添付・Enter の動き・メンション) | **C(中核)** | `Slot(composer)`。入力の **contenteditable/IME/貼り付け/選択範囲** はブラウザー固有。木に出せるのは周辺(送信ボタン・返信バー・添付の一覧・補完の候補 `Suggest`)。TUI は既存の `textbuf`(319)+`suggest.rs`(334)。**共有するのは「状態と補完の意味」**(`view::suggest`・`emoji`・下書き)で、入力欄の描画は各 UI |
| `AttachPanel`(258)・`CameraCapture`(117)・`ImageCropDialog`(197) | 添付のパネル・撮影・切り抜き | B/C | パネルは A(`Grid`+`Button`)。撮影は C(`getUserMedia`・`video`)、切り抜きは C(`canvas`)=Slot。TUI は非対応(パス指定の添付 `/attach`) |
| `TimelinePanel`(121)・`stores/timelinePanel` | スレッド・返信ツリー | B | `Screen { PanelBar, List }` |

### 1.4 通話
| 項目 | 分類 | 方法 / TUI |
|---|---|---|
| `CallView`(331)・`CallBar`(243) | B | 参加者のグリッド(`Grid`+`Avatar`+状態バッジ)・操作ボタン(`Button`)。参加者の操作(ミュート・外す)=`press`/`context`。TUI は通話に参加しない(CLI は非対応)。表示だけ(参加者の一覧)なら共有可 |
| 通話の拡張 `call.addPanel`(DOM `el`)・`addButton` | C | L1 の DOM を `Slot(call-panel)`。`addButton` は L3 でも木のボタン(A)にできる |
| 映像・音声(`lib/call/*`、`capture.ts`、WebRTC) | C | 画面の外(ホストの副作用)。木は状態を見るだけ。映像タイルは `Slot(video)` |

### 1.5 エクスプローラー
`FileExplorer`(1185)・`SharedEntryActions`(73)・`FileProperties`(52)・`PdfThumb`(58)・`ui/PanelBar`(43)・`stores/{fileExplorer,explorerView,explorerBuffer,explorerSelection,sharedIndex}`・`lib/{fileExplorer,sharedOps,sharedTransfer}`。
- 大半が A/B([explorer-tree.md](explorer-tree.md))。C は サムネイル(画像・PDF)・ドロップ・長押し・Linux のクリップボード特例(`gui` ヒント)。語彙の追加: `Grid`(アイコン表示)、`List.columns`(詳細表示)、`InlineEdit`(名前のその場編集)、`Sticky`(右端固定の操作。GUI のヒント)。

### 1.6 プラグインの接点(L1 の DOM を受ける場所)
`PluginPanel`(138: `registerView`)・`PluginSettingTab`・`PluginStatusBar`・`MessageCard`(カード)・通話の `addPanel`・`ui.setting` ほか `disnans.ui` 全部(DOM を返す)。
- L3 では同じものが「木を返す」API になる。**移行期は `Slot(plugin-dom)`**(木の中に L1 の DOM を差し込む。GUI のみ、TUI は「非対応」の表示)。

### 1.7 部品(`components/ui/*`)の木の対応(実物から)
| GUI 部品(`app/src/components/ui/`) | TUI の部品(`crates/cli/src/tui/ui/modal.rs` 343、`settings.rs` 591 ほか) | Node |
|---|---|---|
| `Button`・`IconButton` | `Button`(modal.rs) | `Button` |
| `TextInput`(12) | `Prompt`(modal.rs)、`textbuf.rs`(1 行・複数行) | `Input` |
| `Toggle` | 設定の行のオン/オフ(`settings.rs`) | `Toggle` |
| `SegmentedButton`・`select` | `Choice`(modal.rs) | `Choice` |
| `Slider` | 数の入力(`Prompt`) | `Slider` |
| `Menu`・`MenuItem` | `Menu`・`MenuItem` | `Menu` |
| `Modal`・`ConfirmDialog` | `Dialog`・`Modal` | `Dialog` |
| `NavBar` | `navbar_line`(`view.rs`) | `Tabs` |
| `SettingRow`・`Section`・`Divider`・`StatusLine` | 行・節・罫線・状態行(`settings.rs`・`view.rs`) | `Setting`・`Section`・`Divider`・`Status` |
| `SuggestList` | `suggest.rs`(334) | `Suggest` |
| `SortableList`(483) | 並べ替えはキー操作(`settings.rs`) | `List { reorderable }` |
| `PanelBar` | 見出しの行 | `PanelBar` |
| `Icon`・`Avatar` | グリフ(Nerd Font)・頭文字 | `Icon`・`Avatar` |

## 2. 分類の要約

- **A(すぐ表せる)**: ナビ・確認・メニュー・パレット・設定の Slot の多く・リアクション・返信・デバイス一覧。
- **B(語彙の追加)**: レイアウト(`Layout`・`Grid`・`Scroll`)、リストの拡張(`stickBottom`・`loadOlder`・`columns`・`removable`・`reorderable`)、`Rich`(既存の Markdown 木)、`MessageRow`(既存の `view::Row`)、`Avatar`、`FileRef`、`Card`、`StatusItem`、`KeyCapture`、`InlineEdit`、トーストなどの**オーバーレイ層**。
- **C(Slot)**: 入力欄(contenteditable/IME)、Lightbox(ピンチ)、撮影・切り抜き(`video`・`canvas`)、通話の映像、PDF サムネイル、ドロップ、ネイティブのピッカー、L1 のプラグイン DOM。
- **TUI の代替**: 入力欄は既存の `textbuf`(状態は共有)、画像は描画層、撮影・切り抜き・映像・ドロップ・ピッカーは非対応(代わりのコマンド: `/attach <path>` など)、サムネイルは種類のグリフ。

## 3. 語彙の完成案(v1 → v2)

[vocabulary.md](vocabulary.md) の表に、上の B を足したもの。

**レイアウト**: `Stack { dir: 'v'|'h', gap, align, wrap }`、`Row`(= `Stack dir:'h'`)、`Grow { weight }`(残りの幅)、`Scroll { axis, stick?: 'bottom' }`、`Wrap`、`Grid { columns | minItem }`、`Layout { main, panel?, nav, top }`(殻だけ)、`Sticky { edge }`(GUI のヒント)。
**値の部品**: `Text { text, tone, strong, truncate }`、`Rich { blocks }`(`view::markdown::Block` / `Inline` をそのまま。装飾 = 太字・斜体・下線・取り消し・強調・コード・リンク・メンション・絵文字は **木の外に作らない**。TUI は `tui/markdown.rs`(425)の描画、GUI は `Markdown.svelte`)、`Icon`、`Avatar`、`Image { src, alt, size }`、`Badge`。
**操作の部品**: `Button`・`Input { multiline, suggest? }`・`Toggle`・`Choice`・`Slider`・`KeyCapture`・`InlineEdit`・`Menu`・`Dialog`・`PanelBar`・`Tabs`・`Suggest`・`Setting`・`Section`・`Divider`・`Status`・`Toast`。
**リスト**: `List { items(key, 行の木), selectable, selected, reorderable, removable, columns?, empty, stickBottom?, anchor?, window? }`。大きなリスト(メッセージ)は `window`(ホストが見える範囲だけ渡す)。
**ドメイン**: `MessageRow { row }`(`view::Row`)、`FileRef`、`Card`、`StatusItem`、`Slot { id, props, fallback? }`(`fallback` = TUI などで出す代替の木)。
**共通の属性**: `id`・`show { gui, tui }`(既存)・`gui { … }`(GUI のヒント)・`a11y { label }`。
**イベント**: `press`・`change`・`submit`・`select`・`context`・`reorder`・`remove`・`close`・`reachTop`・`reachBottom`・`visible`・`focus`・`key`(`shortcuts` の宣言)。値は `{ id, value?, key?, path? }`。
**Markdown 木との関係**: 新しく作らない。`Rich` が既存の `Block/Inline`(TS の `lib/markdown.ts` と同じ形・同じ fixture)を保持する。メンションの名前解決・絵文字・コピーボタンなど UI の差は各 UI が行う(既存の方針)。

## 4. 状態の持ち方

### 4.1 層
1. **画面の状態**(木の `update` が持つ): 開いているフォルダ・選択・ダイアログ・入力途中の値・タブ・スクロールの「意図」(下端に張り付く等)。
2. **ホストの共有状態**(画面の外。接続・ユーザー・メッセージ・既読・通話・設定・プラグイン・更新): 画面は読むだけ。変更は効果(コマンド)で依頼する。
3. **副作用**: 通信(REST / WebSocket)・ネイティブ(通知・クリップボード・ファイル選択・カメラ)・ナビ(画面の履歴)。

### 4.2 現行のストアの所属(`lib/stores/` 3202 行、`lib/call/store.svelte.ts` ほか)
| ストア | 持っているもの | 層 | 木からの扱い |
|---|---|---|---|
| `client.svelte.ts`(694) | 接続・`me`・`users`・タイムライン・WS イベント・送信 | ホスト | `chat.*` セレクター |
| `timeline.svelte.ts`(207) | メッセージ列・仮の送信・読み込み状態 | ホスト | `chat.timeline(scope)` |
| `unread.svelte.ts`(208) | 未読数・カーソル・既読の送信 | ホスト | `chat.unread` + 効果 `markRead` |
| `prefs.svelte.ts`(245)・`deviceSettings`(229) | ユーザー共通/デバイスの設定 | ホスト | `prefs(key)`(既存の `Field.key`) |
| `ui.svelte.ts`(314)・`navHistory.ts` | タブ・パネル・設定のサブページ・履歴・トースト・確認・Lightbox・ライブ領域 | ホスト(殻) | 効果 `navigate / toast / confirm / lightbox`。**画面の履歴は木が宣言した `onBack` に従う** |
| `search`(109)・`reply`(25)・`attachPanel`(21)・`cameraRequest`(20)・`shareInbox`(22) | 検索・返信先・添付パネル・撮影要求・共有の受け取り | 画面 | 各画面の状態(`update`)に移す |
| `call/store`(`CallStore`、1262 行超)・`call/settings` | 通話の参加者・ミュート・機器・パネル | ホスト | `call.participants`・`call.state` + 効果 `call.join/leave/mute/...` |
| `sharedIndex`(120)・`fileExplorer`(39)・`explorer{View,Buffer,Selection}`(100/45/54) | 共有フォルダの写し・エクスプローラーの状態 | 写し=ホスト(`files.onChange` 購読)/ 他=画面 | `files.list(path)`(購読付き)+ 画面の状態 |
| `presence`(34)・`notifications`(180)・`updater`(171)・`orientation`(50)・`navBar`(39)・`deviceList`(180) | 在席・通知・更新・向き・ナビバー設定・デバイス | ホスト | `presence` / `notifications` / `updater` セレクター + 効果 |
| `ui.editing`・`headerMessage`・`now` | メッセージの編集中・先頭の日付・現在時刻 | 画面 / ホスト(`time`) | 画面の状態 / `time` 購読 |

### 4.3 ホストの状態を木から参照する方法(最重要)
案: **宣言的な購読(`needs`)+ 不変のスナップショット**。

```ts
registerScreen({
  id: 'chat',
  needs: {                                  // 画面が読むものを宣言(ホストはこれだけ渡す)
    me: 'me',
    messages: { sel: 'chat.timeline', args: { scope: 'main' }, window: { around: 'bottom', size: 80 } },
    unread: 'chat.unread',
    theme: { sel: 'prefs', key: 'theme' },
  },
  init: () => ({ composer: '' }),
  view: (s, h) => /* h.me, h.messages, h.unread … から木を返す */,
  update: (s, action, h) => ({ state, effects: [ { effect: 'chat.send', draft } ] }),
});
```
- ホストは `needs` の変化ごとに `view` を呼び直す。値は**不変の JSON**(世代番号付き)。GUI は Svelte の `$state` 購読から、TUI は ChatSession の更新から作る。同じセレクター名・同じ形を両 UI が実装する(**セレクターの一覧が、コアとして固定する面**)。
- セレクターは**意味データ**を返す(例: `chat.timeline` は `view::timeline_rows` の `Row` 列。いまの `view` モジュールがそのまま使える)。生の `Message` を画面に渡さない(整形が UI ごとにずれるため)。
- 大きい値(メッセージ列)は `window`(見える範囲+前後)で渡す。全部を JS に渡さない。`List.loadOlder`/`reachTop` が窓を動かす効果になる。
- 効果は名前付きのコマンド(`chat.send`・`chat.react`・`files.upload`・`navigate`・`toast`・`call.join`)。結果はアクション(`'chat.sent'` / `'chat.failed'`)として返る。コアの API(`disnans.*`)と同じ表に統一する。
- **実装の置き場**: セレクターと効果の面は Rust(`client-core`)で定義し、GUI は既存のストアを薄く包み、TUI は ChatSession をそのまま包む。`view`・`update` は JS(プラグイン)か Rust(本体の画面)のどちらでもよく、**どちらも同じ `Node` を返す**。本体の画面(チャット)は Rust 側で `view` を書ける(`timeline_rows` が既にそう)ので、TUI にとって JS の組み込みは「プラグイン」のためだけに足りる。

論点(未決・質問 2、3):
- 粒度: セレクターを細かく切ると呼び出しが増え、粗いと再描画が増える。最初は 10 前後(`me`・`users`・`chat.timeline`・`chat.unread`・`prefs`・`call`・`files(path)`・`presence`・`time`・`platform`)に限る。
- ストアの購読解除・ライフサイクル(画面を閉じたら購読も止める)。
- 競合: 木の `update` が持つ状態とホストの状態の二重管理(例: 編集中のメッセージ本文)。入力中の値は画面が持ち、確定で効果に渡す。

## 5. 移行の順序(葉 → 大物)

検証(スクリーンショット比較はしない):
1. **既存の vitest**(1349 件、`components/**/*.test.ts`)を、移行先でも通す。DOM 構造とクラスのテストが多い(例: `SettingRow.test.ts`)。
2. **DOM 構造の等価テスト**: 旧 Svelte 部品と `TreeView` の出力を、同じ状態で `mount` し、正規化した DOM(クラス・`aria-*`・子の順)を比較する。差が出たら意図した変更だけを許す。
3. **`app/scripts/touch-check.mjs`**(Chromium・390×844 と 1280×720、タッチ入力で項目が押せるか。手動)を画面ごとに足す。
4. **レイアウトの測定**: ボタンの矩形・文字の位置を Chromium で取り、前後で比較する(PanelBar のときの方法)。
5. 見た目の最終確認はユーザー。

| 段階 | 対象 | 規模 | 内容と理由 |
|---|---|---|---|
| 0 | `Node` の型(Rust + ts-rs)、`TreeView.svelte`(汎用)、オーバーレイ層、ホストのセレクター/効果の最小(`prefs`・`navigate`・`toast`・`confirm`) | 大(2〜3 週) | 以降の全部の土台。設定の静的な木を同じ型へ寄せる |
| 1 | **設定のサブページ**(`navBar`・`composerMenu`・`devices`・`callDevices`・`hotkeys`・`customThemes` の Slot を木へ) | 中(1〜2 週) | すでに木があり、`SortableList`・`Menu`・`Dialog` で語彙を試せる。TUI へも出せる(デバイス一覧は FEEDBACKS にもある) |
| 2 | **エクスプローラー**(1185 行) | 大(2〜3 週) | `List`(columns・grid)・`Menu`・`Dialog`・`InlineEdit`・`files` 購読を総合的に試す。状態は段階 0 の分離(CORE_PLUGINS の段階 0)が前提。`touch-check.mjs` が既にある |
| 3 | 小さなオーバーレイ(`CommandPalette`・`ActionSheet`・`ConfirmDialog`・`Toasts`・`ConnectionBanner`・`EmojiPicker`・`TopBarSlot`) | 中(1 週) | 独立していて失敗しても戻しやすい |
| 4 | 周辺(`SearchResults`・`ReplyBar`・`AttachPanel`・`TimelinePanel`・`PluginPanel`・`PluginSettingsPage`) | 中(1〜2 週) | `List` の拡張(`loadOlder`)の準備 |
| 5 | 通話(`CallView`・`CallBar`・`CallDeviceSettings`) | 中(1〜2 週) | `call.*` セレクター。映像は Slot |
| 6 | **チャットのタイムライン**(`MessageList`・`MessageItem`・`Markdown`・`Reactions`・`MessageCard`・`FileLink`・`Attachments`) | 大(3〜4 週) | `view::Row` と `Rich` を使う。スクロール(張り付き・未読・ジャンプ・読み込み)の語彙が山場。回帰が最も怖い |
| 7 | **入力欄**(`Composer`・`MessageInput`・`SuggestList`・`CameraCapture`・`ImageCropDialog`) | 大(2〜3 週) | `Slot(composer)` の周りを木に。入力欄自体は C のまま |
| 8 | 殻(`Shell`・`NavBar`・`App`・`Setup`)と L1 の `Slot(plugin-dom)` | 中(1〜2 週) | 最後にルートの宣言を木にする |

最初の 3 画面の推奨: **設定のサブページ → エクスプローラー → 小さなオーバーレイ**。理由: ①語彙(リスト・メニュー・ダイアログ・入力)を、リスクの低い画面で先に固められる。②エクスプローラーはユーザーの関心が強く、語彙の総合試験になる。③チャットは語彙が固まってから。

各段階で守ること: 旧 Svelte を残したまま、新しい木の画面を**切り替え可能**にして並べ(開発用フラグ)、DOM 等価テストが通ってから旧を消す。1 段階 = 1 リリース以内。

## 6. リスクと未決

リスク:
- **チャット(段階 6)の規模と回帰**: スクロールの張り付き・未読・ジャンプ・読み込みの組み合わせがもっとも複雑(`MessageList` の測定コード)。測定を UI が持ち、木はイベントだけを受ける、という分担が崩れると語彙が肥大する。
- **入力欄(C)は木の外**: `Slot(composer)` のままだと、TUI との共有は「状態と補完」までで、描画は別実装のまま。それが目標(「TUI と共有」)に含まれるかを明確にする必要がある。
- **木の語彙が育つ前に固めすぎる**: `apiVersion` で版を持ち、v1(設定・エクスプローラー)で止める。
- **性能**: メッセージ列の木の全送信は重い。`window` と `key` の突き合わせが前提。
- **二重のホスト状態**: 本体のストアと `needs` の写しが食い違う(世代番号と不変スナップショットで防ぐ)。
- **テストの移植**: 旧コンポーネントに強く結びついたテスト(`MessageItem` など)は書き直し。

chief への質問:
1. **入力欄(contenteditable/IME)**を `Slot` のままにしてよいか。TUI との共有の範囲を「状態・補完・送信」までとしてよいか。
2. **ホスト状態の面**(セレクターと効果)を、Rust(`client-core`)で正として定義し、GUI のストアをその薄い包みにする案でよいか(本体の画面は Rust で `view` を書ける、という前提を含む)。
3. 本体の画面(チャット・通話)は `view` / `update` を **JS(GUI のみ)で書く**のと **Rust で書く**のと、どちらを基本にするか。Rust なら TUI が自動で得をするが、GUI の部品で Svelte を捨てる量が増える。
4. 段階 0 を先に始めてよいか(`Node` の型と `TreeView`)。CORE_PLUGINS の段階 0(エクスプローラーの状態の分離)も同時にやるか。
5. 旧 Svelte を残した並走(開発用フラグ)を、どの段階まで許すか(コードの二重管理の期間)。
6. ユーザーが「今の GUI を全て」と言う範囲に、Setup(接続前)・`ImageCropDialog`・`CameraCapture`・Lightbox の C 部分を含めるか(含めるなら C の定義を変える必要がある)。
