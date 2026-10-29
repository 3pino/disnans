# Android の通話とプロセス終了からの復帰

状態: ネイティブ所有の設計を採用。実機での音声品質・経路・OS による再起動は未検証。

## 所有者

Android の Tauri アプリでは、`NativeCallService`（同じプロセス）がマイク・再生・通話専用 WebSocket・再接続・通知の操作を持つ。Activity と WebView は状態の表示と命令だけを行い、音声の PCM や base64 を JS へ渡さない。ネイティブが失敗しても、JS の通話へ自動で切り替えない。

Windows・Linux は従来の WebAudio を使う。汎用の `background.hold`、`CallService`、メッセージ通知の `NotifyService` は別に残す。音声経路は所有者ごとの保持を数え、一方の解放で他方の通話を解除しない。

サーバーの通話プロトコルは変更しない。16 kHz・モノラル・PCM16LE、通常は 800 サンプル（50 ms）を `call.emit` の `audio` として送る。通常の認証経路は既存の Android 通知サービスと同じで、別のトークン保存先は設けない。`hello` の利用者 ID を開始時の期待値と照合する。

## 復帰と明示的な停止

- 初回は利用者の操作からマイクの許可を求め、前景サービスを始める。
- サーバーの参加者一覧に載り、音声の開始が成功したあとにだけ、復帰の希望（`wanted`）を永続化する。
- OS による sticky 再起動で `wanted` が残っている場合に、保存した論理セッション・peer・設定で復帰する。切断中は 1、2、4、8、16、30 秒（以後 30 秒）で再試行する。
- 明示的な退出・通知の切断・キック・マイク許可の喪失は復帰の希望を解除する。停止命令の成功応答は、永続的な解除を確認してから返す。保存に失敗した場合は成功とせず、音声と OS のサービスを停止してエラーを知らせる。
- 再起動直後の状態読み取りや WebView の起動だけでは、サービスやマイクを開始しない。デバイスの再起動時も希望を消すだけで、通話は開始しない。
- Android の強制停止後の自動起動は行わない。OS がサービスを再起動しない場合まで、アプリ側だけで復帰を保証するものではない。

無音や相手不在を理由に退出したり、一定時間で強制ミュートしたりはしない。

同じ論理通話では peer を保ち、新しい明示的な参加では新しい peer を使う。他のデバイスの同じ利用者を一括で退出させない。古いソケット・録音・通知・許可の応答が、新しいセッションを操作しないように識別する。

通知のミュート・スピーカーミュート・切断は JS を経由しない。ミュートの操作で sticky 復帰を無効にしない。

## 音とプラグイン

入力は Android の通話用経路を使い、WebView の `deviceId` は流用しない。出力先は既存の選択 API を残し、保存先が使えなければ Android の既定経路を使う。

通常の入力は `VOICE_COMMUNICATION` と、利用できる AEC・NS・AGC を使う。Chromium の WebRTC APM と同じ処理ではないため、エコー・音質・Bluetooth などの実機確認が必要。新しい APM ライブラリは追加していない。

JS が動いている間は、既存の通話の非音声イベント・パネル・ボタンを利用できる。WebView が終了した場合、ネイティブ音声は復帰の対象になるが、画面共有などの JS の処理まで自動で再開するわけではない。

## 橋渡しと診断

橋渡しの項目は [TypeScript の型](../../app/src/lib/call/native.ts) と [Kotlin の DTO](../../app/src-tauri/plugins/notifier/android/src/main/java/NativeCallTypes.kt) に定義する。

notifier のコマンドは `native_call_start`・`native_call_stop`・`native_call_snapshot`・`native_call_control`・`native_call_kick`・`native_call_emit`。開始引数は平らなオブジェクトで、`args` には包まない。イベントは `call_native` の `state` または非音声の `relay`。

JS は購読を付けてから状態を読み、世代・通し番号・セッションで古い応答を除く。`start` の受理だけでは参加成功ではない。停止の応答が失敗した場合も、生きているネイティブ通話を画面から隠さない。

診断は状態・件数・音声処理の数だけを残す。音・base64・イベントの中身・認証情報・接続先・peer ID は記録しない。数が進むことだけでは相手への配信成功を証明しない。

## 自動試験と実機確認

既存の Gradle・Java・Android SDK を使う（下記はマイクや APK のインストールを行わない）。

```sh
gradle -p app/src-tauri/plugins/notifier/native-tests nativeCallTest
gradle -p app/src-tauri/plugins/notifier/android-check :notifier:assembleDebug :notifier:testDebugUnitTest
```

後者は `TAURI_ANDROID_DIR` にロック済み Tauri の `mobile/android` を指定できる。省略時は既存の `.tauri/tauri-api` を使う。

JVM の試験は純粋な PCM・ミキサー・状態機械・実行器・フェイク録音再生・実際のローカル WebSocket を対象とする。CI は同じコミットから Rust サーバーをビルドし、一時フォルダだけを使って相互接続も試す。ローカルでは `DISNANS_NATIVE_TEST_SERVER_BIN` に今回ビルドしたサーバーの絶対パスを指定すると、この試験も動く。`app/src/lib/call/nativeGolden.test.ts` は現在の WebAudio の純粋計算から照合値を再生成して検査する。権限ファイルは通常の `build.rs` で生成し直すか、`node app/scripts/generate-notifier-permissions.mjs` を使う。

これらは Android の実際の録音・エコー除去・経路・通知操作・長時間の背景動作・プロセス終了からの復帰の証明ではない。マイクの取得、APK のインストール、プロセス終了などの実機試験は、別途利用者の許可を得て行う。見た目の最終確認も利用者に依頼する。
