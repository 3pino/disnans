import { describe, expect, it } from 'vitest';
import type { SharedEntry } from './protocol/SharedEntry';
import * as kit from '@3pino/explorer-kit';
import { SHARED_RULES, canOperate, inAttachments, nameError, overwriteConfirm, planUpload, renameTarget, renameAllowed, trashManyConfirm } from './sharedOps';

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
});

describe('SHARED_RULES は、Disnans の言葉・決まりを共有の部品へ渡す（部品は一般の文しか持たない）', () => {
  it('特別なフォルダは attachments。動かせない理由・内外の移動・フォルダの作成は、添付の言葉', () => {
    expect(SHARED_RULES.specialDir).toBe('attachments');
    expect(renameAllowed('attachments')).toEqual({ ok: false, message: '添付のフォルダは動かせません' });
    const f = (path: string): kit.TransferItem => ({ path, kind: 'file' } as kit.TransferItem);
    expect(kit.checkTransfer(SHARED_RULES, 'move', f('a.txt'), 'attachments')).toEqual({ ok: false, message: '共有フォルダと添付の間は移動できません（コピーしてください）' });
    expect(kit.ruleTexts(SHARED_RULES).noSubfolder).toBe('添付フォルダ内にフォルダは作れません');
    expect(kit.ruleTexts(SHARED_RULES).cutSkipped).toBe('添付・ゴミ箱のフォルダは動かせないので除きました');
  });

  it('ゴミ箱の項目は、元の場所（共有フォルダの直下）へだけ戻せる、と書く', () => {
    const item = {
      path: '.trash/ID--a.txt',
      kind: 'file',
      trash: { where: 'item', restoreTo: 'a.txt' },
    } as unknown as kit.TransferItem;
    expect(kit.checkTransfer(SHARED_RULES, 'move', item, 'docs')).toEqual({ ok: false, message: 'ゴミ箱の項目は、元の場所（共有フォルダの直下）へだけ戻せます' });
  });

  it('ゴミ箱へ移す確認・上書きの確認は、添付の中なら本文のリンクの注意を足す', () => {
    expect(trashManyConfirm([{ path: 'attachments/a.png', kind: 'file' }]).body).toBe('添付のものは、本文のリンクが「削除されたファイル」になります。ゴミ箱から元に戻せます');
    expect(trashManyConfirm([{ path: 'docs/a.png', kind: 'file' }]).body).toBe('ゴミ箱から元に戻せます');
    expect(overwriteConfirm('attachments/a.png').body).toBe('同じ添付の中身が入れ替わります。本文の表示も新しい中身になります。元に戻せません');
    expect(overwriteConfirm('docs/a.png').body).toContain('今のファイルは消えて');
  });

  it('ドラッグの印は、チャット側（ChatView の取り込みの除外）と共有の部品で同じ値を使う', () => {
    expect(kit.EXPLORER_DRAG_TYPE).toBe('application/x-explorer-kit-items');
  });
});
