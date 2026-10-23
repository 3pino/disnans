import { describe, expect, it } from 'vitest';
import { nativeOrientation, orientationLock } from './orientation';

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
