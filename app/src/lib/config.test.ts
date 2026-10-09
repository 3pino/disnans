import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from './config';

describe('normalizeServerUrl', () => {
  it('スキームを補い、末尾のスラッシュを取る', () => {
    expect(normalizeServerUrl(' homeserver:8080/ ')).toBe('http://homeserver:8080');
    expect(normalizeServerUrl('https://a.b')).toBe('https://a.b');
  });

  it('全角で入力されたアドレスを半角にする', () => {
    expect(normalizeServerUrl('ｈｔｔｐ：／／１００．６４．０．１：８０８０')).toBe('http://100.64.0.1:8080');
  });
});
