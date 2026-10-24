import { EMOJI_NAMES } from './emojiNames.generated';

/** リアクション用の、よく使う絵文字 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

/** 絵文字ピッカーに出す絵文字（表の順）。表は core が正（emojiNames.generated.ts） */
export const EMOJI_SET = Object.keys(EMOJI_NAMES);

export { EMOJI_NAMES };
