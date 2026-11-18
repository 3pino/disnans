// 【移行の検査・移行を消すときは一緒に消す】API 20 で「共有フォルダを開く」の旧い ID（app:open-files）を、コアの navItem の ID に読み替える。
import { describe, expect, it } from 'vitest';
import { migrateLegacyNavItems, migrateLegacyNavLabels } from './legacyNavIds';
import { addNavItem, NAV_CHAT_ID, NAV_SETTINGS_ID } from './navBar';

describe('旧い並び（app:open-files）の読み替え', () => {
  it('旧い ID は、コアの「ファイル」の命令の ID（plugin-nav:fixplor:files）になる。位置は変えない', () => {
    expect(migrateLegacyNavItems([NAV_CHAT_ID, 'app:open-files', NAV_SETTINGS_ID])).toEqual([NAV_CHAT_ID, 'plugin-nav:fixplor:files', NAV_SETTINGS_ID]);
  });

  it('新しい ID が既にあれば、二重にしない（先のものだけ残す）', () => {
    expect(migrateLegacyNavItems(['plugin-nav:fixplor:files', 'app:open-files'])).toEqual(['plugin-nav:fixplor:files']);
  });

  it('関係ない ID や、もう新しい並びは、そのまま', () => {
    const list = [NAV_CHAT_ID, NAV_SETTINGS_ID, 'plugin-nav:dice:roll'];
    expect(migrateLegacyNavItems(list)).toEqual(list);
    expect(migrateLegacyNavItems(addNavItem([], 'plugin-nav:fixplor:files'))).toEqual(['plugin-nav:fixplor:files']);
  });

  it('読み替えを 2 回しても同じ（冪等）', () => {
    const once = migrateLegacyNavItems(['app:open-files']);
    expect(migrateLegacyNavItems(once)).toEqual(once);
  });

  it('表示名も、旧い ID の設定を新しい ID へ移す（新しい ID に設定があれば、そちらを残す）', () => {
    expect(migrateLegacyNavLabels({ 'app:open-files': 'ファイル' })).toEqual({ 'plugin-nav:fixplor:files': 'ファイル' });
    expect(migrateLegacyNavLabels({ 'app:open-files': 'A', 'plugin-nav:fixplor:files': 'B' })).toEqual({ 'plugin-nav:fixplor:files': 'B' });
    expect(migrateLegacyNavLabels({ 'app:open-chat': 'C' })).toEqual({ 'app:open-chat': 'C' });
  });
});
