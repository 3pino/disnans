import { describe, expect, it } from 'vitest';
import { markdownTreeOf } from './markdownTree';
import type { Invoke } from './types';

const tree = [{ type: 'paragraph', lines: [[{ type: 'text', text: 'x' }]] }];

/** 呼ばれた命令と引数を記録する Invoke。result が返す値（または失敗）を返す */
function fakeInvoke(result: () => Promise<unknown>) {
  const calls: { command: string; args: unknown }[] = [];
  const invoke = (<T>(command: string, args?: unknown) => {
    calls.push({ command, args });
    return result() as Promise<T>;
  }) as Invoke;
  return { invoke, calls };
}

describe('markdownTreeOf（送信・編集の仮表示の木）', () => {
  it('Tauri の外（想定外の環境）では呼ばず、null（プレーンのまま）', async () => {
    const f = fakeInvoke(async () => tree);
    expect(await markdownTreeOf('a', { tauri: false, invoke: f.invoke })).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('Tauri では api_markdown_tree を 1 回だけ呼び、返った木を使う', async () => {
    const f = fakeInvoke(async () => tree);
    expect(await markdownTreeOf('a **b**', { tauri: true, invoke: f.invoke })).toEqual(tree);
    expect(f.calls).toEqual([{ command: 'api_markdown_tree', args: { body: 'a **b**' } }]);
  });

  it('呼び出しが失敗したら null（プレーンのまま。再送はしない）', async () => {
    const f = fakeInvoke(async () => {
      throw new Error('boom');
    });
    expect(await markdownTreeOf('a', { tauri: true, invoke: f.invoke })).toBeNull();
    expect(f.calls.length).toBe(1);
  });

  it('配列でない応答は使わない', async () => {
    const f = fakeInvoke(async () => ({ not: 'a tree' }));
    expect(await markdownTreeOf('a', { tauri: true, invoke: f.invoke })).toBeNull();
  });
});
