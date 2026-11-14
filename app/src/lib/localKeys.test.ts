// localStorage / sessionStorage の規則を止める（本体のソースだけを読む。テストと test-support は除く）。
// 1. 直接の localStorage / sessionStorage は、lib/storage.ts と、移行用の厳しい版（lib/desktopStorage.ts）だけ。
// 2. 本体が使う disnans.* のキーは、すべて lib/localKeys.ts に登録してある（動的なキーは prefix で当てる）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_KEYS, registeredKey } from './localKeys';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const TEST_HELPERS = join(SRC, 'test-support');
/** 直接の localStorage を読んでよいファイル（src からの相対） */
const DIRECT_ALLOWED = new Set(['lib/storage.ts', 'lib/desktopStorage.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === TEST_HELPERS) continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if ((name.endsWith('.ts') || name.endsWith('.svelte')) && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** コメントだけの行（// や /* や * で始まる行）は、コードとして数えない */
function codeLines(text: string): string[] {
  return text.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
  });
}

const FILES = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }));

describe('localStorage の直接の利用は、許された場所だけ', () => {
  it('走査は本体のソースを読めている（空振りで通らないように）', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === 'lib/storage.ts')).toBe(true);
  });

  it('lib/storage.ts と lib/desktopStorage.ts 以外に、localStorage・sessionStorage のコードは無い', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (DIRECT_ALLOWED.has(f.rel)) continue;
      for (const line of codeLines(f.text)) {
        if (/\b(localStorage|sessionStorage)\b/.test(line)) bad.push(`${f.rel}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('移行用の厳しい版（desktopStorage）は、window.localStorage を直接読むことを許す（それ以外の規則は変えない）', () => {
    const d = FILES.find((f) => f.rel === 'lib/desktopStorage.ts');
    expect(d?.text).toContain('window.localStorage');
  });
});

describe('本体が使う disnans.* のキーは、すべて登録してある', () => {
  // 'disnans.xxx' や `disnans.xxx${...}` の文字列の中の、キーの部分
  const LITERAL = /(['"`])(disnans\.[A-Za-z0-9_.\-]*)/g;

  it('ソースの文字列のキーは、LOCAL_KEYS（完全一致か prefix）で当たる', () => {
    const missing: string[] = [];
    for (const f of FILES) {
      for (const line of codeLines(f.text)) {
        for (const m of line.matchAll(LITERAL)) {
          const key = m[2];
          if (!registeredKey(key)) missing.push(`${f.rel}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('登録の一覧に、同じキーが二度入っていない', () => {
    const keys = LOCAL_KEYS.map((k) => `${k.prefix ? 'prefix:' : ''}${k.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('既知のキーは、期待の種類で当たる（取り込みは legacy-import、プラグインは plugin）', () => {
    expect(registeredKey('disnans.plugin.voice.data')?.kind).toBe('legacy-import');
    expect(registeredKey('disnans.plugin.abc.data')?.kind).toBe('plugin');
    expect(registeredKey('disnans.keepWebViewResumed')).toBeUndefined();
    expect(registeredKey('disnans.nope')).toBeUndefined();
  });
});
