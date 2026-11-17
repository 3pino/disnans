// Rust が入れるデバイスの事実のグローバルの名前（platform.rs の `window.__DISNANS_PLATFORM__`）を、土台に教える。
// 起動の最初（main.ts の先頭）と、試験の前処理（vite.config.ts の setupFiles）で読み込む。
// 土台（@3pino/app-kit-web/core/platform）を使うどの経路も、これより後に判定を読む。
import { configurePlatform } from '@3pino/app-kit-web/core/platform';

configurePlatform({ globalName: '__DISNANS_PLATFORM__' });
