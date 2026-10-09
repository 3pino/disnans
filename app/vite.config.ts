/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;
// 中継先のサーバー（既定は開発モードの Rust サーバー）
const apiTarget = process.env.DISNANS_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    proxy: {
      // 開発時は Rust サーバーへ中継する（WebSocket を含む）
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
