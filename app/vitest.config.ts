import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// DOM の部品テストでは Svelte のクライアント実装を使う。本番の解決条件は変えない。
export default mergeConfig(viteConfig, defineConfig({
  resolve: { conditions: ['browser'] },
}));
