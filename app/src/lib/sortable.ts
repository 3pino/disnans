/**
 * 並べ替えの純粋関数（ドラッグ・上下キーの両方で使う。DOM は使わない）。
 * 並べ替えの部品は components/ui/SortableList.svelte。テストは sortable.test.ts
 */

/**
 * ドラッグ中の差し込み位置（slot）。rows は並びの上から各行の上端と下端、y はポインターの縦位置。
 * 行の中央より上にある行の数を返す（0 なら先頭の前、rows.length なら末尾の後ろ）
 */
export function dropSlot(rows: { top: number; bottom: number }[], y: number): number {
  return rows.filter((r) => (r.top + r.bottom) / 2 < y).length;
}

/** 差し込み位置を、動かしたあとの並びの位置に直す（from の行を抜いた分だけ、後ろの位置が1つ詰まる） */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/**
 * 項目を from から to（動かしたあとの位置）に動かした新しい配列を返す。to は範囲に収める。
 * from が範囲外なら、同じ並びのコピーを返す
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/**
 * from の項目を to に動かしたとき、元の位置 k の項目が最終的に入る位置を、k 番目の要素として返す。
 * ドラッグの間、ほかの行をどれだけ動かすかを決めるのに使う
 */
export function finalPositions(n: number, from: number, to: number): number[] {
  const order = moveItem(
    Array.from({ length: n }, (_, i) => i),
    from,
    to,
  );
  const pos = new Array<number>(n);
  order.forEach((orig, p) => (pos[orig] = p));
  return pos;
}
