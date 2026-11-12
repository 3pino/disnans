// Windows だけの拡大（WebView2 の zoomHotkeysEnabled）の設定が、tauri.conf.json の窓の設定を消さずに足されていることを確かめる。
// Tauri は tauri.<os>.conf.json を RFC 7396 の merge で重ねる。配列（app.windows）は丸ごと置き換えられるので、
// tauri.windows.conf.json には窓の全部の項目を書く必要がある（書き忘れると、タイトル・大きさ・ドラッグが既定に戻る）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src-tauri');
const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

// RFC 7396（json-patch の merge と同じ。配列は置き換え、null は消す）
function merge(doc, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

const base = read('tauri.conf.json');

test('Windows: 窓は基本の設定に zoomHotkeysEnabled を足したもの（ほかの項目は変えない）', () => {
  const merged = merge(base, read('tauri.windows.conf.json'));
  assert.equal(merged.app.windows.length, 1);
  assert.deepEqual(merged.app.windows[0], { ...base.app.windows[0], zoomHotkeysEnabled: true });
});

test('Windows: 基本の窓の項目（タイトル・大きさ・ドラッグ）が残っている', () => {
  const win = merge(base, read('tauri.windows.conf.json')).app.windows[0];
  assert.equal(win.title, 'disnans');
  assert.equal(win.width, 1200);
  assert.equal(win.height, 800);
  assert.equal(win.minWidth, 360);
  assert.equal(win.minHeight, 480);
  assert.equal(win.dragDropEnabled, false, 'Windows は HTML5 のドロップで受けるので、OS のドロップは切ったまま');
});

test('Linux・Android は拡大の設定を持たない（既定の false のまま）', () => {
  const linux = merge(base, read('tauri.linux.conf.json')).app.windows[0];
  assert.equal(linux.zoomHotkeysEnabled, undefined);
  assert.equal(linux.dragDropEnabled, true);
});
