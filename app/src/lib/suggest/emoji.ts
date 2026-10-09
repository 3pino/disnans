import { EMOJI_NAMES } from '../emoji';
import { rankByName, tokenBefore } from './index';
import type { SuggestProvider } from './types';

const entries = Object.entries(EMOJI_NAMES);

/** `:` ＋2文字以上で絵文字を出す。選んだら絵文字そのものを入れる */
export function emojiProvider(): SuggestProvider {
  return {
    label: '絵文字',
    match(text, caret) {
      const q = tokenBefore(text, caret, ':', '[A-Za-z0-9_+-]', { min: 2 });
      return q && { ...q, end: caret };
    },
    items(_text, range) {
      const q = range.query.toLowerCase();
      return rankByName(entries, ([, names]) => names, q).map(([emoji, names]) => {
        // 打った文字に合う名前を見せる
        const name = names.find((n) => n.startsWith(q)) ?? names.find((n) => n.includes(q)) ?? names[0];
        return { key: emoji, title: `:${name}:`, emoji, insert: emoji };
      });
    },
  };
}
