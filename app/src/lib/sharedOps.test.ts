import { describe, expect, it } from 'vitest';
import type { SharedEntry } from './protocol/SharedEntry';
import { canOperate, deleteConfirm, deleteManyConfirm, inAttachments, nameError, overwriteConfirm, planUpload, renameNote, renameTarget } from './sharedOps';

const file = (name: string, path = name): SharedEntry => ({
  name,
  path,
  kind: 'file',
  size: 1,
  modified: 0,
  mime: null,
  message_id: null,
  file_id: null,
});
const dir = (name: string, path = name): SharedEntry => ({ ...file(name, path), kind: 'dir' });
const ok = (...items: SharedEntry[]) => ({ kind: 'ok', entries: new Map(items.map((e) => [e.name, e])) });

describe('共有フォルダの名前', () => {
  it('分かりやすい名前は使える', () => {
    expect(nameError('docs', 'a (2).txt')).toBeNull();
    expect(nameError('', '日本語 の名前.pdf')).toBeNull();
  });

  it('Windows で使えない文字・予約名・末尾の . や空白・空・. .. は止める', () => {
    expect(nameError('', 'a:b')).not.toBeNull();
    expect(nameError('', 'a/b')).not.toBeNull();
    expect(nameError('', 'a\nb')).not.toBeNull();
    expect(nameError('', 'a.')).not.toBeNull();
    expect(nameError('', 'a ')).not.toBeNull();
    expect(nameError('', 'CON.txt')).not.toBeNull();
    expect(nameError('', '  ')).not.toBeNull();
    expect(nameError('', '..')).not.toBeNull();
    expect(nameError('', '.disnans-x')).not.toBeNull();
  });

  it('attachments/ の中は本文のリンクの文字（[ ] |）も使えない', () => {
    expect(nameError('attachments', 'a[1].png')).not.toBeNull();
    expect(nameError('docs', 'a[1].png')).toBeNull();
  });
});

describe('添付と項目の決まり', () => {
  it('attachments/ そのものは動かさない。その中と共有の中は動かせる', () => {
    expect(canOperate('attachments')).toBe(false);
    expect(canOperate('attachments/a.png')).toBe(true);
    expect(canOperate('docs')).toBe(true);
    expect(inAttachments('attachments')).toBe(true);
    expect(inAttachments('attachmentsX/a')).toBe(false);
  });

  it('名前の変更の先は同じフォルダの中', () => {
    expect(renameTarget('attachments/a.png', 'b.png')).toBe('attachments/b.png');
    expect(renameTarget('docs/sub/a.txt', 'b.txt')).toBe('docs/sub/b.txt');
    expect(renameTarget('a.txt', 'b.txt')).toBe('b.txt');
  });

  it('名前の変更の案内: attachments/ は出さない、ほかは本文のリンクが切れる旨', () => {
    expect(renameNote('attachments/a.png')).toBeNull();
    expect(renameNote('docs/a.txt')).toContain('リンクは切れます');
  });

  it('削除の確認: 添付は本文のリンクが「削除されたファイル」になる、フォルダは中身も消える、ほかは元に戻せない', () => {
    expect(deleteConfirm('attachments/a.png', false).body).toContain('削除されたファイル');
    expect(deleteConfirm('docs', true).body).toContain('中身もすべて消えます');
    expect(deleteConfirm('docs/a.txt', false).body).toBe('元に戻せません');
    expect(deleteConfirm('docs/a.txt', false).danger).toBe(true);
  });

  it('上書きの確認は必ず文を出す（添付は本文の表示も新しい中身になる旨）', () => {
    expect(overwriteConfirm('attachments/a.png').body).toContain('本文の表示も新しい中身');
    expect(overwriteConfirm('docs/a.txt').body).toContain('消えて');
    expect(overwriteConfirm('docs/a.txt').okLabel).toBe('上書き');
  });
});

describe('アップロードの同名の扱い', () => {
  it('同名がなければ作成', () => {
    expect(planUpload('docs', 'new.txt', ok(file('old.txt')))).toEqual({ kind: 'create', path: 'docs/new.txt' });
  });

  it('同名のファイルは上書き（確認は呼ぶ側）', () => {
    expect(planUpload('docs', 'a.txt', ok(file('a.txt', 'docs/a.txt')))).toEqual({ kind: 'overwrite', path: 'docs/a.txt' });
  });

  it('attachments/ は大文字・小文字を区別せず、今ある添付の名前で上書きする（同じ添付の中身を差し替える）', () => {
    const p = planUpload('attachments', 'PHOTO.png', ok(file('photo.png', 'attachments/photo.png')));
    expect(p).toEqual({ kind: 'overwrite', path: 'attachments/photo.png' });
  });

  it('共有フォルダの中は大文字・小文字を区別する（別のファイル）', () => {
    expect(planUpload('docs', 'A.txt', ok(file('a.txt', 'docs/a.txt')))).toEqual({ kind: 'create', path: 'docs/A.txt' });
  });

  it('同名がフォルダなら止める', () => {
    expect(planUpload('', 'docs', ok(dir('docs')))).toEqual({ kind: 'blocked', message: '同じ名前のフォルダがあります' });
  });

  it('一覧が読み終わっていなければ止める（黙って上書きしないため）', () => {
    expect(planUpload('docs', 'a.txt', { kind: 'loading' }).kind).toBe('blocked');
    expect(planUpload('docs', 'a.txt', { kind: 'error' }).kind).toBe('blocked');
  });

  it('名前が使えなければ止める（送る前に）', () => {
    expect(planUpload('', 'a:b.txt', ok())).toMatchObject({ kind: 'blocked' });
  });

  it('複数の削除の確認は、件数を出し、フォルダ・添付の旨を入れて、まとめて 1 回', () => {
    const c = deleteManyConfirm([
      { path: 'docs', kind: 'dir' },
      { path: 'attachments/x.png', kind: 'file' },
    ]);
    expect(c.title).toBe('2 件を削除しますか');
    expect(c.body).toContain('フォルダは中身もすべて消えます');
    expect(c.body).toContain('削除されたファイル');
    expect(c.body).toContain('元に戻せません');
    expect(deleteManyConfirm([{ path: 'a.txt', kind: 'file' }]).body).toBe('元に戻せません');
  });
});
