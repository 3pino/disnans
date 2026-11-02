import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screen = readFileSync(new URL('../app/src-tauri/plugins/screen/android/src/main/java/ScreenPlugin.kt', import.meta.url), 'utf8');
const call = readFileSync(new URL('../app/src-tauri/plugins/notifier/android/src/main/java/NativeCallService.kt', import.meta.url), 'utf8');

// Android のフレームワークの動作試験ではなく、SDK コンパイルに加えるソースの契約確認。
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `method missing: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`method not closed: ${signature}`);
}

test('画面共有は旧通話サービスに依存せず、画面外でも WebView を再開する', () => {
  const pause = body(screen, 'override fun onPause()');
  assert.match(pause, /if\s*\(\s*!inPip\s*&&\s*!CaptureService\.running\s*\)\s*return/);
  assert.match(pause, /webView\?\.onResume\(\)/);
  assert.match(pause, /webView\?\.resumeTimers\(\)/);
  assert.doesNotMatch(pause, /(?:Native)?CallService\.running/);
  assert.match(pause, /SDK_INT\s*>=\s*Build\.VERSION_CODES\.O/);
  assert.match(pause, /setRendererPriorityPolicy\(WebView\.RENDERER_PRIORITY_IMPORTANT,\s*false\)/);
});

test('通常・準備中の通話通知をどちらもサイレントかつ再アラートなしで作る', () => {
  for (const signature of ['private fun build(', 'internal fun currentOrPlaceholder(']) {
    const notification = body(call, signature);
    assert.match(notification, /\.setOnlyAlertOnce\(true\)/);
    assert.match(notification, /\.setSilent\(true\)/);
  }
});

test('表示内容が同じ通話通知は再掲示しない', () => {
  const refresh = body(call, 'fun refreshNotification(');
  const guard = /if\s*\(!NativeCallNotice\.shouldRepost\(lastNotice,\s*key\)\)\s*return/;
  assert.match(refresh, guard);
  assert.ok(refresh.search(guard) < refresh.indexOf('nm.notify('));
  assert.match(body(call, 'internal fun clearLive('), /lastNotice\s*=\s*null/);
});
