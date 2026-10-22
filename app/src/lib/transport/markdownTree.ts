import type { Block } from '../markdown';
import { isTauri } from '../platform';
import type { Invoke } from './types';
import { tauriInvoke } from './tauri';

/**
 * 本文の構文木を Rust（core）に作らせる。送信・編集の仮表示に使う（1 回の invoke）。
 * ブラウザー（開発）は null（仮表示はプレーンのまま）。呼び出し・形の失敗も null（プレーンのまま）。
 */
export async function markdownTreeOf(body: string, deps: { tauri?: boolean; invoke?: Invoke } = {}): Promise<Block[] | null> {
  const tauri = deps.tauri ?? isTauri();
  if (!tauri) return null;
  try {
    const tree = await (deps.invoke ?? tauriInvoke)<unknown>('api_markdown_tree', { body });
    return Array.isArray(tree) ? (tree as Block[]) : null;
  } catch {
    return null;
  }
}
