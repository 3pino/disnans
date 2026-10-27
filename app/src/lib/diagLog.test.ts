// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { buildDiagReport, clearDiagLog, diagFileName, diagLog, flushDiagLog, resetDiagLogForTest } from './diagLog';

describe('診断ログ（Android 以外は localStorage に残す）', () => {
  afterEach(() => {
    resetDiagLogForTest();
    localStorage.clear();
  });

  it('行に時刻とレベルを付け、書き出しの全文に先頭の項目と一緒に載せる', async () => {
    diagLog('info', '[notify] 受信');
    diagLog('warn', '[call] 切れました\n2 行目');
    const text = await buildDiagReport([['版', 'v1.2.3']]);
    expect(text).toContain('disnans 診断ログ');
    expect(text).toContain('版: v1.2.3');
    expect(text).toMatch(/\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} I \[notify\] 受信/);
    // 改行は 1 行にまとめる
    expect(text).toMatch(/ W \[call\] 切れました 2 行目\n/);
  });

  it('localStorage に書き、消去で空にする', async () => {
    diagLog('error', 'x');
    flushDiagLog();
    expect(localStorage.getItem('disnans.diagLog')).toMatch(/ E x$/);
    await clearDiagLog();
    expect(localStorage.getItem('disnans.diagLog')).toBe('');
    expect(await buildDiagReport([])).not.toMatch(/ E x/);
  });

  it('ファイルの名前は作った時刻から付ける', () => {
    expect(diagFileName(new Date(2026, 9, 27, 8, 5, 9))).toBe('disnans-log-20261027-080509.txt');
  });
});
