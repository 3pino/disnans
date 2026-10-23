import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sakura = readFileSync(new URL('../../../examples/theme-sakura/theme.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../node_modules/@3pino/design-system/src/tokens.css', import.meta.url), 'utf8');
const keys = (css: string) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);

describe('theme-sakura と共有デザインシステムの契約', () => {
  it('上書きする変数は現行 tokens.css に存在する', () => {
    const known = new Set(keys(tokens));
    expect([...new Set(keys(sakura))].filter((key) => !known.has(key))).toEqual([]);
  });

  it('旧来の個別色だけでなく、フォーカス・幕等が参照するパレットも上書きする', () => {
    const light = sakura.match(/:root\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(light).toMatch(/--hue:\s*350\s*;/);
    expect(light).toMatch(/--chroma:\s*0\.012\s*;/);
    expect(light).toMatch(/--hue-accent:\s*355\s*;/);
    for (const key of ['border-focus', 'field-focus-bg', 'border-hover', 'ring', 'scrim', 'on-scrim']) {
      expect(tokens).toMatch(new RegExp(`--${key}:\\s*[^;]*var\\(--hue\\)`));
    }
  });

  it('自動ダークと明示ダークの上書きは一致する', () => {
    const auto = sakura.match(/:root:not\(\[data-theme='light'\]\)\s*\{([^}]+)\}/)?.[1] ?? '';
    const explicit = sakura.match(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/)?.[1] ?? '';
    const declarations = (css: string) => [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
    expect(declarations(auto).length).toBeGreaterThan(0);
    expect(declarations(auto)).toEqual(declarations(explicit));
  });
});
