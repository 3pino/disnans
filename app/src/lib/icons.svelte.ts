// アイコンの登録簿は、共有の UI 部品（@3pino/ui-kit-web/icons）にある。名前の引き方は次の順:
//   1. 本体の独自のアイコン（disnans-logo。ここで定義する）
//   2. プラグインが登録したもの（addIcon、プラグインの icon.svg は plugin:<id>）
//   3. Lucide
// ここは、これまでの取り込み先を変えないための入口で、本体の独自のアイコンを定義する。
// disnans-logo を使う部品（AppIcon・NavBar）は、この入口を取り込んで、定義されてから描くようにする
import { defineBuiltinIcon } from '@3pino/ui-kit-web/icons';

export * from '@3pino/ui-kit-web/icons';

// アプリのロゴ（app/public/icon.svg と同じ形）。Lucide のアイコンと並べて使えるように作ってある
defineBuiltinIcon('disnans-logo', {
  body: '<path d="m3.6 17.4-1.065 3.29a1 1 0 001.236 1.168l3.413-.998A10 10 0 103.6 6.4z"/>',
  attrs: {},
});
