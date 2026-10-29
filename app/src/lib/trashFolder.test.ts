import { describe, expect, it } from 'vitest';
import type { SharedEntry } from './protocol/SharedEntry';
import type { SharedTrashEntry } from './protocol/SharedTrashEntry';
import { displayEntry, entryLabel, trashPlace, virtualDir, writeBlockReason, restoreParent } from './trashFolder';
import type { DirState } from './stores/sharedIndex.svelte';

const base = (name: string, path: string, kind: 'file' | 'dir' = 'file'): SharedEntry => ({
  name, path, kind, size: 1, modified: 0, mime: null, message_id: null, file_id: null,
});
const trashed = (id: string, original: string, kind: 'file' | 'dir' = 'file'): SharedTrashEntry => ({
  id, original_path: original, kind, size: 1, deleted_at: 0,
});
const item = (id: string, original: string, kind: 'file' | 'dir' = 'file'): SharedEntry => {
  const leaf = original.split('/').pop()!;
  return { ...base(`${id}--${leaf}`, `.trash/${id}--${leaf}`, kind), trash: { kind: 'item', entry: trashed(id, original, kind) } };
};
const ok = (entries: SharedEntry[]): DirState => ({ kind: 'ok', entries: new Map(entries.map((e) => [e.name, e])) });
const ROOT_VIRTUAL = base('.trash', '.trash', 'dir');
ROOT_VIRTUAL.trash = { kind: 'root' };

describe('ゴミ箱の表示名（元の名前。要求の path は変えない）', () => {
  it('直下の項目は、元の名前（original_path の末尾）で表す。パスは別名のまま', () => {
    const e = item('01HZX0000000000000000000AB', 'docs/report.pdf');
    expect(entryLabel(e)).toBe('report.pdf');
    const shown = displayEntry(e);
    expect(shown.name).toBe('report.pdf');
    expect(shown.path).toBe('.trash/01HZX0000000000000000000AB--report.pdf');
    expect(shown.trash).toEqual(e.trash);
  });

  it('同じ元の名前が二つあっても、表示は同じでも、別の項目として別々のパスを持つ', () => {
    const a = item('01HZX0000000000000000000AA', 'a/x.txt');
    const b = item('01HZX0000000000000000000BB', 'b/x.txt');
    expect(entryLabel(a)).toBe(entryLabel(b));
    expect(a.path).not.toBe(b.path);
  });

  it('ゴミ箱の印の無い項目（ふつう・中身・ルート）は、名前をそのまま出す', () => {
    const plain = base('a.txt', 'a.txt');
    expect(displayEntry(plain)).toBe(plain);
    expect(entryLabel({ ...base('.trash', '.trash', 'dir'), trash: { kind: 'root' } })).toBe('.trash');
    const inner = { ...base('sub', '.trash/X--d/sub', 'dir'), trash: { kind: 'descendant' as const, id: 'X' } };
    expect(entryLabel(inner)).toBe('sub');
  });
});

describe('仮想のゴミ箱の場所（印で決める。.trash という名前だけでは決めない）', () => {
  it('共有フォルダの直下に、ルートの印の .trash があれば、.trash は仮想', () => {
    const root = ok([ROOT_VIRTUAL, base('docs', 'docs', 'dir')]);
    expect(virtualDir('.trash', root)).toBe('root');
    expect(virtualDir('.trash/X--a', root)).toBe('inside');
    expect(virtualDir('.trash/X--a/sub', root)).toBe('inside');
    expect(virtualDir('docs', root)).toBe('normal');
  });

  it('実在の .trash（印なし）は、ふつうのフォルダとして扱う（書ける）', () => {
    const root = ok([base('.trash', '.trash', 'dir')]);
    expect(virtualDir('.trash', root)).toBe('normal');
    expect(virtualDir('.trash/anything', root)).toBe('normal');
    expect(writeBlockReason(virtualDir('.trash', root))).toBeNull();
  });

  it('直下の一覧が無い・読めないときは、.trash の下を unknown にして書き込みを止める', () => {
    expect(virtualDir('.trash/X--a', undefined)).toBe('unknown');
    expect(virtualDir('.trash', { kind: 'loading' })).toBe('unknown');
    expect(virtualDir('.trash', { kind: 'error', message: 'x' })).toBe('unknown');
    expect(writeBlockReason('unknown')).toContain('確かめて');
    expect(writeBlockReason('root')).toContain('中には書き込めません');
  });

  it('直下の一覧が無くても、.trash 以外のフォルダは normal（余計な確認をしない）', () => {
    expect(virtualDir('docs', undefined)).toBe('normal');
    expect(virtualDir('', undefined)).toBe('normal');
    expect(virtualDir('.trashy', undefined)).toBe('normal');
  });
});

describe('項目の場所と元の場所', () => {
  it('印で場所が決まる', () => {
    expect(trashPlace(ROOT_VIRTUAL)).toBe('root');
    expect(trashPlace(item('01HZX0000000000000000000AB', 'a.txt'))).toBe('item');
    expect(trashPlace(base('a.txt', 'a.txt'))).toBe('normal');
  });

  it('直下の項目の元の場所は、元の親のフォルダ（直下は空）', () => {
    expect(restoreParent(item('01HZX0000000000000000000AB', 'docs/a.txt'))).toBe('docs');
    expect(restoreParent(item('01HZX0000000000000000000AB', 'a.txt'))).toBe('');
    expect(restoreParent(base('a.txt', 'a.txt'))).toBeNull();
  });
});
