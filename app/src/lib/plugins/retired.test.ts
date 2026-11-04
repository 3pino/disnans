import { describe, expect, it } from 'vitest';
import { RETIRED_PLUGIN_IDS, isRetiredPlugin } from './retired';

describe('旧いプラグインの扱い（本体の機能に入ったもの）', () => {
  it('画面共有の旧いプラグインは、読み込み・一覧・オンにすることの対象（retired）', () => {
    expect(RETIRED_PLUGIN_IDS).toContain('screenshare');
    expect(isRetiredPlugin('screenshare')).toBe(true);
  });

  it('ほかのプラグインは対象外（配布の一覧や読み込みは変わらない）', () => {
    for (const id of ['dice', 'voice', 'bot', 'screenshare-next', 'Screenshare', '']) {
      expect(isRetiredPlugin(id), id).toBe(false);
    }
  });
});
