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
  // 共有の部品（エクスプローラー）は TypeScript と Svelte のソースのまま配られる。開発サーバーの依存の事前バンドル（JS だけを想定）には載せず、アプリのソースと同じ変換に通す
  optimizeDeps: { exclude: ['@3pino/explorer-kit'] },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
