# TUI でプラグインを動かす案（JS エンジンの調査）

状態: 保留(調査のみ。未実装)

TUI（ターミナル）でプラグインを動かすには、CLI に JS エンジンを組み込む必要がある。2026-10 に cli-tui が調べた結果を残す。試作は `/tmp/qjs`・`/tmp/boa`(リポジトリには入れていない)。

## 前提と未決

- 現行のプラグインは `document.createElement` で DOM を組み立てる(命令型)。たとえば `examples/dice/main.js`(741 行)は `const {Plugin,ui}=disnans` をグローバルで参照し、`export default class extends Plugin` で DOM を描く。DOM のないターミナルでは、そのままでは動かない。
- 「画面を宣言的な木にして、GUI と TUI の両方が同じ木を描く」案は取り下げた([ideas.md](ideas.md))。したがって、**TUI 用のプラグイン API をどうするかは未決**。JS エンジンの調査は、その API が決まったときの土台として残す。

## 推奨するエンジン: rquickjs

rquickjs(QuickJS-ng 系、MIT)を推奨する。

| | rquickjs 0.11(+ tokio) | boa_engine 0.21 |
|---|---|---|
| 最小バイナリ(Linux、`opt-level=z`・LTO・strip) | 1.2 MB | 4.8 MB |
| クリーンビルド | 約 14 秒 | 約 40 秒 |
| 実装 | C(`cc` クレートで組む) | 純 Rust(C 不要。ただし遅く重い) |

- `deno_core`(V8)は未測定。数十 MB でビルドも大きいので採用しない。
- CI: Windows は dtolnay stable の既定(MSVC、`windows-latest`)、Linux は ubuntu。rquickjs は `cc` クレートで C を組むだけで、MSVC と gcc のどちらも既定で通る。**Windows 実機のビルドは未検証**(CI で 1 回確かめる必要がある)。

## 動作確認したこと(`/tmp/qjs`)

- ES モジュール(`Module::declare` / `eval`)。`export default class` が constructor として取れる。
- Promise / async / await、JSON。
- Rust の async 関数をホスト関数にできる: `shared_list` を `Async()` で登録し、`await` で結果を受け、JSON を `serde_json` で Rust にパースできた。
- 標準で無いもの: `setTimeout`(`tokio::sleep` を包んで自前で足せた)、`TextEncoder` / `URL` / `structuredClone`(自前で足す。`TextEncoder` は簡易版で足りた)。`fetch` / `require` / `std` も無い。既定でネットワークと FS が使えない = **ホスト関数だけのサンドボックス**。
- `examples/dice/main.js` は、`disnans` / `window` / `document` のスタブ(`Proxy`)を置けば読み込めて、`default` が constructor になる(`onload` の実行までは未確認)。

## 安全

- `set_memory_limit(64MB)` で暴走した確保は "out of memory" で止まる。
- `set_interrupt_handler` で `while(true){}` が期限(200ms)で中断できる。スタックの上限も設定できる。

## 設計メモ

- `client-core`(または cli 内の `plugin_host`)に JS ホストを置く。1 プラグイン = 1 つの `AsyncRuntime` + `AsyncContext`(専用スレッドか `LocalSet`。QuickJS は `!Send`)。
- `disnans.*` は Rust の関数を `Function::new(ctx, Async(f))` で登録する(REST と WebSocket は `RestClient` / `ChatSession` を `Arc` で渡す)。戻り値は JSON 文字列で受け渡し、`serde` で読む。
- WebSocket のイベントは `mpsc` で JS のコールバックへ送る。
- 読み込み元: サーバー配布(`manifest.json` と `main.js` を REST で取得してキャッシュ)と、`~/.config` の開発フォルダ(既存の plugin devdir)。
- 実行ごとにタイムアウトを `interrupt handler` で設定する。
- 共有フォルダの REST は `client-core/src/rest_api.rs` の `shared_*` にあり、`this.files` のホスト関数に使える。

## 作業量の目安

- JS ホスト + 標準 API(`setTimeout` / `TextEncoder` / `URL` / `console`)+ `disnans.*` の主要関数: 約 1 週間。
- プラグインの画面を TUI に描く部分は、TUI 用の API(未決)による。調査時点の見積もりは、画面の木を ratatui で描いて操作を JS に戻す部分で 1〜2 週間(木の仕様に依存)。
- Windows のビルド確認は CI で 1 回。
