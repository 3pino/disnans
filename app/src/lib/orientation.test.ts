import { describe, expect, it } from 'vitest';
import { DEFAULT_ORIENTATION, nativeOrientation, normalizeOrientationMode, orientationLock } from './orientation';

describe('normalizeOrientationMode', () => {
  it('読めない値は既定（自動回転）', () => {
    expect(DEFAULT_ORIENTATION).toBe('auto');
    expect(normalizeOrientationMode(null)).toBe('auto');
    expect(normalizeOrientationMode(undefined)).toBe('auto');
    expect(normalizeOrientationMode('landscape')).toBe('auto');
    expect(normalizeOrientationMode('')).toBe('auto');
  });

  it('3 択はそのまま', () => {
    expect(normalizeOrientationMode('portrait')).toBe('portrait');
    expect(normalizeOrientationMode('media')).toBe('media');
    expect(normalizeOrientationMode('auto')).toBe('auto');
  });
});

describe('orientationLock', () => {
  it('自動回転は、全画面かどうかによらず回す', () => {
    expect(orientationLock('auto', false)).toBe('unlocked');
    expect(orientationLock('auto', true)).toBe('unlocked');
  });

  it('向きを固定は、全画面でも縦に固定', () => {
    expect(orientationLock('portrait', false)).toBe('portrait');
    expect(orientationLock('portrait', true)).toBe('portrait');
  });

  it('メディアのみ自動回転は、全画面のメディアを見ている間だけ回す', () => {
    expect(orientationLock('media', false)).toBe('portrait');
    expect(orientationLock('media', true)).toBe('unlocked');
  });

  it('ネイティブへは portrait（縦固定）か user（システムに従う）で渡す', () => {
    expect(nativeOrientation('portrait')).toBe('portrait');
    expect(nativeOrientation('unlocked')).toBe('user');
  });
});
