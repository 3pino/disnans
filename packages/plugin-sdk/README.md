# @disnans/plugin-sdk

disnans のプラグインを書くための型定義（ホスト API バージョン 2）。

- `index.d.ts`: ホスト API の型。グローバルの `disnans` と、名前空間 `Disnans`（`Disnans.Session` など）を宣言する
- 実行時のコードは入っていない。ホスト API の実体は disnans 本体がグローバルの `disnans` として用意する
- 作り方のガイドは [`docs/PLUGINS.md`](../../docs/PLUGINS.md)、実例は [`examples/dice/`](../../examples/dice/)

## 素の JS で使う（ビルドなし）

`main.js` の先頭に次の2行を書くと、エディター（VS Code など）で補完と型チェックが効く。

```js
// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

const { Plugin } = disnans;

export default class MyPlugin extends Plugin {
  onload() {
    this.addSlashCommand({
      name: 'hello',
      description: 'あいさつする',
      run: () => disnans.ui.toast(`こんにちは、${this.app.me.display_name} さん`),
    });
  }
}
```

`reference path` は、`main.js` から見た `index.d.ts` の場所に合わせて書き換える。
JSDoc では `/** @type {Disnans.Session<MyState>} */` のように、名前空間 `Disnans` の型を使える。

コマンドラインで型チェックするなら、プラグインのフォルダに `tsconfig.json` を置く（`examples/dice/tsconfig.json` を参照）。

```sh
npx tsc -p path/to/my-plugin
```

## TypeScript で書く

`disnans` はグローバルなので、`import` は要らない（書かない）。型定義を読み込ませるだけでよい。
ビルドの出力は、**ES モジュール1ファイル**（`main.js`）で、`export default` が残っていること。

### フォルダの例

```
my-plugin/
├── package.json
├── tsconfig.json
├── src/
│   └── main.ts
├── manifest.json
├── styles.css        # 任意
└── main.js           # ビルドの出力（これを配布する）
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "path/to/disnans/packages/plugin-sdk/index.d.ts"]
}
```

`path/to/disnans` は disnans のリポジトリの場所。npm で入れる場合は
`npm i -D file:path/to/disnans/packages/plugin-sdk` として、`include` の代わりに
`"types": ["@disnans/plugin-sdk"]` を `compilerOptions` に書く。

### src/main.ts

```ts
type CounterState = { schema: 1; count: number };

export default class CounterPlugin extends disnans.Plugin {
  onload() {
    this.addSlashCommand({
      name: 'counter',
      description: 'みんなで数えるカウンター',
      run: async ({ threadId }) => {
        const session = await this.sessions.create<CounterState>({
          state: { schema: 1, count: 0 },
          card: { title: 'カウンター', text: '0' },
          threadId,
        });
        this.openView('counter', session);
      },
    });
    this.registerView<CounterState>('counter', (session) => ({
      onOpen: (el) => {
        el.textContent = String(session.state.count);
      },
    }));
  }
}
```

### esbuild（最小）

```sh
npm i -D esbuild typescript
```

```jsonc
// package.json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/main.ts --bundle --format=esm --target=es2022 --outfile=main.js",
    "watch": "esbuild src/main.ts --bundle --format=esm --target=es2022 --outfile=main.js --watch",
    "check": "tsc -p ."
  }
}
```

- `--format=esm` で ES モジュールとして出す（`export default` が残る）
- `--bundle` で、npm のライブラリを使ってもすべて1ファイルにまとまる
- esbuild は型をチェックしないので、型チェックは `npm run check`（`tsc`）で行う
- プラグインのフォルダを開発用フォルダの中に置いて `npm run watch` すると、保存のたびに `main.js` が書き換わり、アプリがホットリロードする

### Vite を使う場合

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '.',
    emptyOutDir: false, // manifest.json などを消さない
    lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.js' },
  },
});
```

## 型の要点

| 型 | 内容 |
|---|---|
| `Disnans.Host` | グローバルの `disnans`（`Plugin`, `ui`, `VersionConflictError`, `apiVersion`） |
| `Disnans.Plugin` | 継承するクラス。`add*` / `register*` / `sessions` / `notify` / `loadData` など |
| `Disnans.Session<S>` | セッション。`state` の型を `S` で指定する |
| `Disnans.View` | パネルに出す画面（`onOpen` / `onClose` / `title`） |
| `Disnans.Ui` | 本体と同じ見た目の部品 |
| `Disnans.VersionConflictError` | `session.update` が他の人の更新とぶつかったときのエラー |
