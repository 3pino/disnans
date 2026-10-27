# ドキュメントの目次

文書の目次はこのファイルだけです。文書を足したら、ここに載せてください（書き方は [CONTRIBUTING.md](../CONTRIBUTING.md#ドキュメント)）。未対応の項目・既知の問題・進行中の作業は [FEEDBACKS.md](../FEEDBACKS.md) にあります。

## 利用者・管理者

- [README.md](../README.md): インストール・サーバーの運用・共有フォルダの接続
- [crates/server/README.md](../crates/server/README.md): サーバーの環境変数・本番・障害の切り分け・バックアップ・自動更新
- [crates/cli/README.md](../crates/cli/README.md): CLI と TUI の使い方

## 開発者

- [CONTRIBUTING.md](../CONTRIBUTING.md): 開発環境・テスト・リリース・文書の書き方

## 確定した設計（`docs/design/`）

- [design/architecture.md](design/architecture.md): クライアントの分担・共通表示データ・見た目の取り込み
- [design/settings-storage.md](design/settings-storage.md): 設定の保存先
- [design/tui.md](design/tui.md): TUI の部品・色の対応
- [design/ui-tree.md](design/ui-tree.md): 設定画面とナビバーの、GUI と TUI の共通の木
- [crates/client-core/README.md](../crates/client-core/README.md): クレートの境界
- [app/src/components/ui/README.md](../app/src/components/ui/README.md): Svelte の部品を足す規則

## API（契約）

- [api/rest.md](api/rest.md): 認証・エラー・REST
- [api/shared-folder.md](api/shared-folder.md): 共有フォルダ（REST と WebDAV）
- [api/websocket.md](api/websocket.md): WebSocket
- [packages/plugin-sdk/README.md](../packages/plugin-sdk/README.md): プラグインの型定義と TypeScript の書き方

## プラグイン・テーマを作る人

- [plugins/README.md](plugins/README.md): プラグインの作り方（5分で動かす）
- [plugins/basics.md](plugins/basics.md): manifest・main.js・ライフサイクル・ホスト API の一覧
- [plugins/commands.md](plugins/commands.md): コマンド・＋メニュー・メッセージの操作
- [plugins/views.md](plugins/views.md): view・カード・セッション・エラー
- [plugins/runtime.md](plugins/runtime.md): 一時的なイベント・ステータス欄・バックグラウンド・通知・設定タブ・共有フォルダ・保存
- [plugins/call.md](plugins/call.md): 通話の拡張・画面共有のネイティブ API
- [plugins/styles.md](plugins/styles.md): 見た目（CSS）・TypeScript
- [plugins/distribution.md](plugins/distribution.md): 配布・更新・削除・互換・API を追加した版・注意点
- [plugins/ui.md](plugins/ui.md): `disnans.ui` とアイコン
- [themes.md](themes.md): テーマの作り方

## 設計案・保留（`docs/proposals/`）

冒頭に「状態」を書く。FEEDBACKS の項目に紐づく。

- [proposals/core-plugins.md](proposals/core-plugins.md): コアプラグイン（エクスプローラーのプラグイン化）
- [proposals/tui-plugins.md](proposals/tui-plugins.md): TUI でプラグインを動かす案（JS エンジンの調査）
- [proposals/ideas.md](proposals/ideas.md): 取り下げた・保留した検討

## テスト用データの説明

- [crates/client-core/tests/fixtures/view/README.md](../crates/client-core/tests/fixtures/view/README.md): 表示データの固定値
- [crates/client-core/tests/fixtures/suggest/README.md](../crates/client-core/tests/fixtures/suggest/README.md): 補完の規則の固定値
