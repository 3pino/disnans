// ステップ7・P4: 端末の判定（UA・platform の文字列・Tauri の内部・Rust の注入値）を読んでよいのは platform.ts だけ。
// 他の場所で直接読むと、Rust の値を優先する仕組みをすり抜けるので、ここで止める。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const ALLOWED = join(here, 'platform.ts');

/** src 以下の .ts と .svelte（テストは除く） */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if ((name.endsWith('.ts') || name.endsWith('.svelte')) && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** 禁止する読み方。見つかったら、その場所（ファイルと行）を返す */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'navigator.userAgent / navigator.platform', pattern: /navigator\s*\.\s*(userAgent|platform)\b/ },
  { label: 'Tauri の内部オブジェクト', pattern: /__TAURI_INTERNALS__/ },
  { label: 'Rust の注入値', pattern: /__DISNANS_PLATFORM__/ },
];

describe('端末の判定は platform.ts だけで読む（P4）', () => {
  const files = sourceFiles(SRC).filter((f) => f !== ALLOWED);

  it('ソースを見つけている（検査が空振りしていない）', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(sourceFiles(SRC)).toContain(ALLOWED);
  });

  for (const { label, pattern } of FORBIDDEN) {
    it(`${label} を platform.ts 以外で読まない`, () => {
      const hits: string[] = [];
      for (const file of files) {
        readFileSync(file, 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}`);
          });
      }
      expect(hits).toEqual([]);
    });
  }
});
