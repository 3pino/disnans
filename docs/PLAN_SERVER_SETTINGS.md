# 設定のサーバー保管（端末ごとの設定）

状態: 進行中。サーバー側の端末 API は入っている（commit `2e805fc`）。クライアント側（GUI の設定をどこに置くか、移行）は判断待ち。未対応の一覧は [FEEDBACKS.md](../FEEDBACKS.md)。

## 目的

- ユーザー共通の設定は、既存の `/api/me/prefs` にまとめる（ホットキー・Enter キー・スラッシュコマンドの別名など）。
- 端末ごとの設定もサーバーに置き、端末の一覧（名前つき）を出せるようにする。
- ローカルに残すのは、起動に必要なもの（接続先 URL、端末 ID）だけ。

## 分類（GUI の保存先の洗い出し）

| 分類 | 例 | 置き場所 |
|---|---|---|
| ユーザー共通 | ホットキー・Enter キー・スラッシュコマンドの別名・「＋」メニュー・メッセージの表示 | `/api/me/prefs`（サーバー。既に移行済み） |
| 端末ごと | 通話の入力・出力の機器、端末の種類、ナビゲーションバーを隠す（Android）、プラグインの無効化、プラグインの開発フォルダ、更新の確認の時刻 | 端末ごとの設定（サーバーへ移す候補。判断が要るものは別に決める） |
| 端末ごと（同期しない） | 下書き、開発用フラグ、実験用フラグ、戻る操作の深さ | ローカルのまま |
| ローカル必須 | サーバーの URL、開発ユーザー | ローカルのまま（サーバーに接続する前に必要） |

## サーバーの設計（実装済み）

- 端末 ID はクライアントが作る（ULID の形）。認証ではない。アクセスできるのは、そのユーザー自身の端末だけ（`/api/me/...` の下）。
- 保存は端末の一覧（`devices`）と、端末ごとの設定（`device_prefs`）を分ける。名前だけの変更で設定の中身を読み書きしない。
- API:
  - `GET /api/me/devices`（一覧。新しい順）
  - `PUT /api/me/devices/{device_id}`（登録と名前の変更。初回は作る）
  - `DELETE /api/me/devices/{device_id}`（端末と設定を消す）
  - `GET /api/me/devices/{device_id}/prefs`、`PUT /api/me/devices/{device_id}/prefs`（設定はまるごと置き換える。部分更新はしない）
- 上限: 設定は既存の `MAX_PREFS_BYTES` と同じ。端末は 1 ユーザーあたり 50。設定は JSON オブジェクトだけ。
- 端末の変更は他の端末へイベントで知らせない。一覧と設定は起動時と設定画面を開いたときに取る。
- 削除された端末が次に読み書きすると 404。その端末はローカルの設定だけで動き続けてよい。

## 移行の方針

- 「サーバーに値がない項目だけ、ローカルの値を取り込む」。既存の値は上書きしない（共有ファイルの取り込みと同じ考え方）。
- 旧クライアントは新 API を使わないので、影響はない。
- 移行の範囲（どの設定を端末単位にするか）は判断が要る。通知の購読の状態は端末ごとが候補。

## 未決定

1. 端末数の上限（50）が妥当か。
2. ユーザー単位と端末単位の設定を、サーバーで合成しない（クライアントが両方を読み、端末の値を優先する）でよいか。
3. 端末 ID の発行元（クライアント発行の案）。
4. 移行する設定の範囲。

## V5（Rust 側の実装。CI 待ち）

- **端末 ID**: `LocalStore::device_id(Surface)`。設定ディレクトリの `devices.json`（surface ごとに ULID を 1 つ）。無ければ作って保存し、あれば同じ値を返す。壊れた・不正な ID・未知の schema は直さずエラー（`StoreError::InvalidDeviceId` など）。`is_valid_device_id` は `client-core` から公開（サーバーの検査と同じ）。
- **REST**（`RestClient`）: `list_devices` `put_device(id, name)` `delete_device(id)` `get_device_prefs(id)` `put_device_prefs(id, prefs)`。
- **項目の定義**（`crates/client-core/src/view/settings.rs`）: キー・保存先（`user` / `device` / `local`）・型（`Kind`）・既定値を一覧にした `DEFINITIONS`。`device_defaults()`、`normalize_device_prefs(raw)`（型の合わない値は既定、範囲外の数は範囲内に、定義に無いキーは残す）、`definitions_json()`。
  - 既定値は GUI の今の値と合わせる（`DEFAULT_CALL_SETTINGS` など）。テストで確かめている。
  - 既存のユーザー prefs（ホットキー・Enter・スラッシュの別名・「＋」メニュー・メッセージの表示）は、TypeScript の正規化のまま。ここには入れていない（形が複雑。後で判断）。
  - 下書き・プラグインの保存データ・テーマ CSS のキャッシュ・開発用フラグ（`disnans.rustApi` など）は、キーが動的か文字列の値のため、この一覧には入れていない（この端末だけの保存のまま）。
- **Tauri コマンド**（`app/src-tauri`）:
  - `client_device_id()` → `string`（この端末（tauri）の端末 ID。無ければ作る）
  - `api_settings_definitions()` → 項目の定義（`{ key, scope, default, kind }` の配列）
  - `api_device_register({ server, devUser?, id, name })` → 端末の登録・名前の変更（`PUT /api/me/devices/{id}`）
  - `api_device_prefs_read({ server, devUser?, id })` → `{ prefs, updatedAt, saved }`。`prefs` は正規化済み。設定が無い（404）ときは既定の値と `saved: false`（端末が未登録の場合も 404 になる。登録してから呼ぶ）。
  - `api_device_prefs_write({ server, devUser?, id, body })` → `{ prefs, updatedAt, saved: true }`。`body` は設定のオブジェクト。送る前に正規化する。
- **注意（GUI の移行で扱う）**: 現在の localStorage の値は文字列（例: `disnans.hideNavigationBar` は `'1'`）。サーバーの端末の設定では真偽値（`hideNavigationBar: true`）にする。移行の変換は GUI 側。
- **未実装**: 端末の一覧・削除の Tauri コマンド（設定画面の作業で追加する）。TUI の端末ごとの設定（ベル・通知対象・画像・タイムゾーン・Enter・密度）は後回し。

## 残りの作業

1. GUI の対応づけ（TypeScript）: 上の Tauri コマンドを呼ぶ。どの設定を端末単位にするかは分類どおり。
2. 移行の実装（サーバーに値がなければ、ローカルの値を取り込む）。
3. 設定画面での端末の一覧と名前の変更、古い端末の削除。
4. 実機での確認（Windows・Linux・Android で、端末ごとの設定が他の端末に混ざらないこと）。
