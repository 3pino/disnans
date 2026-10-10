import { describe, expect, it } from 'vitest';
import { canBackgroundCheck, isCheckDue, versionToNotify } from './updateCheck';
import type { UpdateState } from './stores/updater.svelte';

const HOUR = 60 * 60 * 1000;

describe('isCheckDue', () => {
  it('記録がなければ確認する', () => {
    expect(isCheckDue(1000, null, 6 * HOUR)).toBe(true);
  });
  it('間隔がたっていれば確認する', () => {
    expect(isCheckDue(6 * HOUR, 0, 6 * HOUR)).toBe(true);
    expect(isCheckDue(7 * HOUR, 0, 6 * HOUR)).toBe(true);
  });
  it('間隔がたっていなければ確認しない', () => {
    expect(isCheckDue(HOUR, 0, 6 * HOUR)).toBe(false);
  });
  it('時計が戻ったら確認する', () => {
    expect(isCheckDue(0, 10 * HOUR, 6 * HOUR)).toBe(true);
  });
  it('間隔が 0 なら、いつでも確認する（起動時）', () => {
    expect(isCheckDue(5, 5, 0)).toBe(true);
  });
});

describe('canBackgroundCheck', () => {
  it('待機中・最新・エラーのときだけ確認する', () => {
    expect(canBackgroundCheck({ kind: 'idle' })).toBe(true);
    expect(canBackgroundCheck({ kind: 'latest' })).toBe(true);
    expect(canBackgroundCheck({ kind: 'error', message: 'x' })).toBe(true);
  });
  it('確認中・新しい版あり・ダウンロード中などは確認しない', () => {
    const busy: UpdateState[] = [
      { kind: 'checking' },
      { kind: 'available', version: '0.2.0', notes: null },
      { kind: 'permission' },
      { kind: 'downloading', downloaded: 0, total: null },
      { kind: 'installing' },
    ];
    for (const s of busy) expect(canBackgroundCheck(s)).toBe(false);
  });
});

describe('versionToNotify', () => {
  const available: UpdateState = { kind: 'available', version: '0.2.0', notes: null };
  it('新しい版を見つけたら、その版番号', () => {
    expect(versionToNotify(available, null)).toBe('0.2.0');
    expect(versionToNotify(available, '0.1.5')).toBe('0.2.0');
  });
  it('同じ版をもう知らせていれば null', () => {
    expect(versionToNotify(available, '0.2.0')).toBeNull();
  });
  it('新しい版がなければ null', () => {
    expect(versionToNotify({ kind: 'latest' }, null)).toBeNull();
    expect(versionToNotify({ kind: 'error', message: 'x' }, null)).toBeNull();
  });
});
