# エクスプローラーを木で表すスケッチ

状態: **設計案(未実装)**。部品名・props は仮([vocabulary.md](vocabulary.md))。現行の画面は `app/src/components/FileExplorer.svelte`(約 1200 行)、状態は `stores/{fileExplorer,explorerView,explorerBuffer,explorerSelection,sharedIndex}.svelte.ts`、論理は `lib/{fileExplorer,sharedOps,sharedTransfer,sharedPath}.ts`。

## 状態(`init` / `update` が持つもの)

```ts
type State = {
  dir: string;                       // いまのフォルダ(パンくず)
  listing: 'loading' | 'ok' | 'missing' | { error: string };
  entries: SharedEntry[];            // 並びは view / sort で決める
  view: { mode: 'list' | 'grid'; sort: 'name' | 'date' | 'size'; asc: boolean };
  select: { on: boolean; paths: string[] };   // 選択モード
  buffer: { op: 'copy' | 'cut'; paths: string[] } | null;
  dialog: null | { kind: 'mkdir' | 'rename' | 'delete' | 'overwrite' | 'transfer'; … };
  uploads: { key: string; name: string; ratio: number; error?: string }[];
};
```
現行の `explorerSelection`・`explorerBuffer`・`explorerView`・`fileExplorer` を、UI 非依存の状態 + アクションにまとめたものと同じ(段階 0)。`files.onChange` はアクション `'files.changed'` になる。

## アクション(例)
`open(path)`・`up`・`crumb(path)`・`reload`・`toggleSelect`・`select(path)`・`copy`・`cut`・`paste`・`delete` → `confirm`・`rename` → `submit`・`mkdir` → `submit`・`upload(files)`・`sort(key)`・`setMode(mode)`・`openFile(path)`・`files.loaded`・`files.changed`・`upload.progress`。

## 木(`view(state)`)

```text
Screen(onBack: 'up' → 直下なら閉じる)
├ PanelBar
│   ├ breadcrumbs: [共有フォルダ, docs, 2026]            (press: 'crumb' + path)
│   └ actions: [IconButton upload (press: 'pick-upload'),
│                IconButton folder-plus (press: 'mkdir'),
│                Menu ≡ [ 表示:リスト/グリッド, 並び:名前/日付/サイズ, 選択モード, 貼り付け(buffer がある時) ]]
├ Stack(uploads)  ← uploads が空でない時だけ。行: 名前 + 進捗% + IconButton x
├ Status / List        ← listing に応じて
│   loading → Status(busy: '読み込み中…')
│   missing → Text(muted) + Button('共有フォルダへ戻る')
│   error   → Text(danger) + Button('再読み込み')
│   ok & 空 → Text(muted: 'このフォルダには、まだ何もありません。')
│   ok      → List(items, selectable: select.on, selected: select.paths)
│        行(key = path): [Icon(フォルダ/種類) , Text(名前), Text(muted: サイズ · 更新日時)]
│        行のイベント: press → open / openFile、context → 行のメニュー(名前の変更・コピー・切り取り・削除)
└ Dialog(dialog)       ← mkdir/rename は Input + 作る/キャンセル、delete/overwrite は確認
```
- 選択モード中は `PanelBar` の操作が「コピー・切り取り・削除・解除」に置き換わる(木が状態で変わるだけ)。

## GUI と TUI の描き分け

| 要素 | GUI | TUI |
|---|---|---|
| 行のサムネイル | 行に `gui: { thumbnail: { src, kind } }`(画像・PDF)。グリッド表示は `gui: { layout: 'grid' }` | 無視。種類のグリフ(Nerd Font)+名前 |
| 長押し・範囲選択・ドラッグでアップロード | `gui: { longPress, dropFiles }` で `context` / `upload` | `Space` で選択、`Enter` で開く、`m` でメニュー。アップロードはパスの入力(`Input`) |
| 行の文脈メニュー | 右クリック・長押し | 行で `m` |
| 戻る | Android の戻る・Alt+← | Esc(親フォルダ。直下で閉じる) |
| 画像の表示 | `Slot`(Lightbox)または `lightbox(src)` | 画像の描画層(対応端末だけ)、なければ「保存」 |
| ファイルを開く | ブラウザーのダウンロード / 新しいタブ | `save(path)`(保存先を聞く) |
| クリップボードの貼り付け(画像・テキスト) | `clipboard` + `upload` | 端末のペースト |

## 現行からの対応(移行で消える・残るもの)
- 木に載る: パンくず・一覧・状態の表示・メニュー・ダイアログ・選択・コピー/切り取り/貼り付け・削除・名前変更・フォルダ作成・アップロードの進捗・並び・表示形式。
- GUI のヒントになる: サムネイル(画像・PDF)、グリッド、長押し・ドロップ、アニメーション、Linux のクリップボード特例。
- `Slot` のまま: 画像の拡大(`lightbox` API で足りれば Slot は不要)。

## 作る順序(段階 0 〜 5 との対応)
0. 状態・アクションを分離(テストはそのまま移せる。`fileExplorer.test.ts` など)
2. L2 のコアプラグインとして、現行の Svelte の画面を同梱にする(状態は段階 0 のモジュールを使う)
5. 上の木で `view` を書き、Svelte の画面を捨てる(GUI は `TreeView`、TUI は ratatui の描画)
