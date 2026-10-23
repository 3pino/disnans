// node --test scripts/release-latest-json.test.mjs (bash / jq がある環境)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./release-latest-json.sh', import.meta.url));
function render(version) {
  const dir = mkdtempSync(join(tmpdir(), 'disnans-latest-json-'));
  try {
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = --dir ]; then shift; dest=$1; fi',
      '  shift',
      'done',
      'for name in "disnans_${TEST_VERSION}_amd64.AppImage" "disnans_${TEST_VERSION}_amd64.deb" "disnans_${TEST_VERSION}_x64-setup.exe"; do',
      '  printf "signature:%s\\n" "$name" > "$dest/$name.sig"',
      'done',
      '',
    ].join('\n'), { mode: 0o755 });
    execFileSync('bash', [script, `v${version}`, version, '3pino/disnans'], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, TEST_VERSION: version },
    });
    return JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('全プラットフォームの URL と署名を同じリリースのタグに固定する', () => {
  const data = render('0.2.1');
  assert.equal(data.version, '0.2.1');
  assert.equal(Object.keys(data.platforms).length, 5);
  for (const platform of Object.values(data.platforms)) {
    assert.match(platform.url, /^https:\/\/github\.com\/3pino\/disnans\/releases\/download\/v0\.2\.1\//);
    assert.equal(platform.signature.trim(), `signature:${platform.url.split('/').at(-1)}`);
  }
  const next = render('0.2.2');
  assert.match(next.platforms['windows-x86_64'].url, /\/v0\.2\.2\/disnans_0\.2\.2_x64-setup\.exe$/);
  // 次のリリースを作っても、古いメタデータの取得先が latest に依存しない。
  assert.ok(Object.values(data.platforms).every((p) => !p.url.includes('/latest/')));
});
