/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // 共有の部品（エクスプローラー・UI 部品）は TypeScript と Svelte のソースのまま配られる。開発サーバーの依存の事前バンドル（JS だけを想定）には載せず、アプリのソースと同じ変換に通す
  optimizeDeps: { exclude: ['@3pino/explorer-kit', '@3pino/ui-kit-web', '@3pino/app-kit-web'] },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 土台の判定が読む、Rust の注入値の名前（起動の最初と同じ）
    setupFiles: ['./src/lib/platformGlobal.ts'],
    // 共有のパッケージ（ソースのまま）は、試験で vi.mock が効くように取り込む（node_modules のままだと外部扱いになり、モックが届かない）
    server: { deps: { inline: [/@3pino\/app-kit-web/] } },
  },
});
