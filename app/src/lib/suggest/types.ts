import type { User } from '../protocol/User';

/** 入力欄の中で、候補で置き換える範囲 */
export type SuggestRange = {
  start: number;
  end: number;
  /** 範囲の中で、候補を絞り込むのに使う文字列（`@al` なら `al`） */
  query: string;
};

/** 補完の候補1つ */
export type SuggestItem = {
  key: string;
  title: string;
  detail?: string;
  /** 左に出す絵文字 */
  emoji?: string;
  /** 左に出すアバター */
  user?: User;
  /** 範囲（start〜end）をこの文字列で置き換える */
  insert: string;
  /** 選んだあとに呼ぶ（メンションの対応表に足す、など） */
  picked?: () => void;
};

/**
 * 補完の出どころ（`@` のメンバー、`:` の絵文字、`/` のコマンドなど）。
 * キャレットの直前の文字列から、出すかどうかと候補を決める
 */
export type SuggestProvider = {
  /** 候補の一覧の aria-label */
  label: string;
  match(text: string, caret: number): SuggestRange | null;
  items(text: string, range: SuggestRange): SuggestItem[];
};

/** いま出す補完 */
export type Suggestion = SuggestRange & { label: string; items: SuggestItem[] };
