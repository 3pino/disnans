# GUI と TUI の共通の画面の木

状態: 確定(実装済み)

GUI（Svelte）と TUI（ratatui）で、同じ画面の構造（どのページに・どの節を・どの部品で・どの順に出すか）を 1 か所に置き、
それぞれが自分の描き方で解釈する仕組みです。いまの対象は**設定画面**と**ナビゲーションバー**です。

- 正: `crates/client-core/src/view/ui.rs`（`SETTINGS_PAGES`・`NAV_ITEMS`）
- GUI へは生成物 `app/src/lib/uiTree.generated.ts`（`cargo test -p disnans-client-core` で書き出す。手で直さない。CI と `scripts/check-rust.sh` が差分を確かめる）。
  開発用ブラウザーは Rust を呼べないので、invoke ではなく生成物で渡す
- 木は**値を持たない**。値は各 UI が prefs から差し込む

## 木の形

```
Page（id・title・show）
└ Section（id・title・show）          … GUI: Section / TUI: 節の見出し
   └ Item
      ├ Field（key・control・label・icon） … 1 つの設定値を部品で変える行
      ├ Link（page）                      … サブページを開く行
      ├ Slot（id）                        … 中身を各 UI が描く
      └ Note（text）                      … 補足の文
```

| Control | GUI | TUI |
|---|---|---|
| `toggle` | Toggle | オン/オフの切り替え |
| `segmented` | SegmentedButton | Choice（選択肢のモーダル） |
| `select` | `<select class="input">` | Choice |
| `slider`（`scale`・`unit`） | Slider | 数の入力（Prompt）。画面の値は「保存する値 × scale」 |

- `show`: `{ gui, tui }`。`gui` は `always` / `never` / `android`（Android の Tauri）/ `notAndroid` / `tauri` / `tauriOrDev`。
  片方の UI でしか意味のない項目も木に入れ、出さない UI は飛ばす（節やページを出さないなら、その中の項目も出さない。テストで確かめる）
- `Field.key`: `DEFINITIONS`（`view/settings.rs`）のキー（`theme`）、オブジェクトの中の 1 項目（`enterKeys.enter`）、
  または派生の項目（`DERIVED_KEYS`。今は `limiterStrength` だけ。TUI には出さない）
- 選択肢の `value` は保存する値、`label` は画面の文言（GUI・TUI で同じ文言を出す）
- `Slot` は、その場の状態で中身が変わるもの（プロフィール・通知・アップデート・機器やデバイスの一覧など）

## GUI

- `components/SettingsTree.svelte` が 1 ページを描き、`components/SettingsField.svelte` が Field を描く
- Field の読み書きは `lib/settingsBindings.svelte.ts`（key → ストア）。プラットフォームで変わる文言（Enter の組み合わせの表記など）もここで直す
- Slot の中身は `components/SettingsView.svelte` の `slot`（id ごと）。サブページの中身だけの部品（`HotkeySettings` など）は Section を持たない（節は木が作る）
- 節のクラスは以前のもの（`settings-profile`・`enter-key-settings` など）を残し、無いものは `settings-section-{id}`
- `lib/uiTree.test.ts` が、GUI に出す Field に読み書きの先があること・Slot を SettingsView が描くことを確かめる

## TUI

- `crates/cli/src/tui/settings.rs` の `rows` が木から行を作る。TUI が描く Slot は `tuiKeys`（キー割り当て）・`deviceList`（このデバイスの名前）・`server`・`version`
- サブページは `Link` から開き、`Esc` / `←` で開いた行へ戻る。Note はカーソルを置かない
- 保存は Field の key の定義（`Scope`）に従い、`enterKeys.shift` のような項目はオブジェクトのほかの項目を残して 1 つだけ変える
- 下の画面切替バーは `tui_nav_items`: ユーザー共通の `navBarItems`・`navBarLabels`（GUI のナビゲーションバーと同じ設定）に従い、
  TUI に画面のある項目（Chat・Settings・Search）だけを出す。表示名の規則は GUI の `navItemLabel` と同じ（`nav_label`）

## 項目の足し方

1. `view/ui.rs` の `SETTINGS_PAGES` に Field / Link / Slot / Note を足し、`show` を決める
2. `cargo test -p disnans-client-core` で生成物を更新する
3. GUI に出すなら: Field は `settingsBindings` に読み書きを足す。Slot は `SettingsView` の `slot` に描き方を足す。サブページは `navHistory.ts` の `SettingsSubpage` に足す
4. TUI に出すなら: Field はそのまま出る（`DEFINITIONS` のキーなら保存もできる）。Slot は `settings.rs` の `slot_rows` に足す

## 範囲

- 木にしているのは設定画面とナビゲーションバーだけ。チャット・検索・エクスプローラー・モーダル・プラグインの UI は、各 UI が自分で描く。
- チャットの一覧のように「core にデータと規則を置き、GUI と TUI がそれぞれ描く」ものは、木ではなく `view`（[architecture.md](architecture.md)）で共有する。木を画面全体へ広げることはしない（語彙が増え、GUI にしか意味のない部分ばかりになるため。[proposals/ideas.md](../proposals/ideas.md)）。
- 木から TUI に出さない項目（プロフィール・通知・プラグイン・通話の機器・デバイス一覧・更新・ナビバーの編集）は、`show` で GUI だけにしてある。
