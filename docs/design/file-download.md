# ファイルの保存（ダウンロード）

チャットの添付・ファイルへのリンク・拡大表示・共有フォルダのファイルを、保存するときの経路。

## 経路

| 環境 | 経路 |
| --- | --- |
| Tauri（Windows・Linux・Android） | フロントの `lib/download.ts` の `downloadFile` が Rust の `api_download` を呼ぶ。外部のブラウザーは通らない |
| ブラウザーでの開発 | 従来どおり `<a href download>`（右クリック・中クリックも残る） |

押す場所は、どちらも `<a href download>` のまま。Tauri では、その押しを `interceptDownload` が受けて既定の動きを止める（左クリックで、修飾キーなし、このサーバーの `/api/files/` と `/api/shared/` だけ）。

## 保存（Rust: `app/src-tauri/src/downloads.rs`）

- 取得は client-core の `RestClient::download`。読取・書込と同じ接続先・開発用ヘッダー・証明書の設定を使い、時間制限は付けない（大きいファイルのため）。
- 取得してよいパスは `/api/files/...` と `/api/shared/...` だけ。クエリ・`\`・`..`・制御文字は拒む。
- 上限は 2 GiB。取得の前に宣言された大きさを見て、途中でも超えたら止める。
- デスクトップ: ダウンロードフォルダへ保存する。同じ名前が無いことを、作成と同時に確かめて予約する（上書きしない）。
  - 番号は拡張子の前に付ける: `archive.tar.gz` → `archive.tar (2).gz`、`.bashrc` → `.bashrc (2)`、`docs` → `docs (2)`。
  - 途中で失敗したら、書きかけのファイルは消す（中途半端なファイルを残さない）。
- Android: キャッシュの一時ファイル（`downloads/download.part`）へ書き、Kotlin の `saveDownload`（apk-updater プラグイン）が MediaStore の Downloads へ移す。一時ファイルは Rust が消す。Android 10 未満は保存しない。
- ファイル名は、区切り・Windows で使えない文字・制御文字を `_` にし、空や `.` は `download` にする。Windows の予約名（CON・NUL・COM1 など）は先頭に `_` を付ける。200 文字を超えたら、拡張子を残して切る。
- 失敗は固定の code（`network` `timeout` `not_found` `too_large` `permission` `no_space` `io` など）と短い日本語で返す。パス・URL・ID は出さない。

## 開く

- 「開く」は、この実行で保存したものだけを、ハンドル（`dl1`…）で指す。任意のパスは開かない（開くのは Rust の保存済みの一覧だけ）。
- デスクトップ: `tauri-plugin-opener` の `open_path`（Rust から呼ぶので、WebView の権限は増えない）。
- Android: Kotlin の `openDownload` が、MediaStore の保存先の uri だけを ACTION_VIEW で開く（読み取りの権限だけを付ける）。

## トースト

- 取得中: 「ダウンロード中: 名前」を、終わるまで出し続ける（時間では消えない。割合は出さない）。終わったら消して、成功か失敗を出す。
- 成功: 「ダウンロードしました: 名前」と「開く」（8 秒）。
- 失敗: 「ダウンロードできませんでした: 理由」（エラー・「開く」は付けない）。
- 同じパスの取得中は、2 回目の押しを受けない（ダブルタップ）。

## 確かめ方と限界

- 自動で確かめるもの: パスの検査・ファイル名・番号・型（Rust の単体テスト）、保存の上書きなし・途中失敗で残らないこと（Rust の単体テスト、偽のサーバーに対して）、Android の純粋な部分（Kotlin の JVM テスト `DownloadRulesTest`）、トーストと押しの横取り（Vitest `download.test.ts`）。
- 実機で確かめていないもの: MediaStore への保存と、その後の ACTION_VIEW、Windows での「開く」、Android の証明書の扱い。
