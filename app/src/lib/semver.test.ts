import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer } from './semver';

describe('compareVersions', () => {
  it('数値として比べる', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });
  it('先頭の v を無視する', () => {
    expect(compareVersions('v0.1.1', '0.1.0')).toBeGreaterThan(0);
  });
  it('プレリリースは正式版より古い', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
  });
  it('解釈できないときは null', () => {
    expect(compareVersions('latest', '0.1.0')).toBeNull();
  });
});

describe('isNewer', () => {
  it('新しいときだけ true', () => {
    expect(isNewer('v0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('v0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });
});
