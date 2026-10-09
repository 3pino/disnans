/** リアクション用の、よく使う絵文字 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

export const EMOJI_SET = [
  '👍', '❤️', '😂', '🎉', '👀', '🙏',
  '😊', '😆', '🥹', '😭', '😮', '🤔',
  '😇', '😎', '🥳', '😴', '😱', '🤯',
  '🔥', '✨', '💯', '✅', '❌', '⭐',
  '👏', '🙌', '💪', '👌', '🤝', '🫡',
  '🍣', '🍺', '☕', '🍰', '🐱', '🌸',
];

/**
 * 入力欄の `:名前` の補完に使う、絵文字の英語名（ショートコード）。
 * EMOJI_SET の絵文字だけを、よく使う呼び名で引けるようにしたもの（先頭が代表の名前）
 */
export const EMOJI_NAMES: Record<string, string[]> = {
  '👍': ['thumbsup', '+1', 'like'],
  '❤️': ['heart', 'love'],
  '😂': ['joy', 'lol'],
  '🎉': ['tada', 'party'],
  '👀': ['eyes'],
  '🙏': ['pray', 'thanks'],
  '😊': ['blush', 'smile'],
  '😆': ['laughing', 'satisfied'],
  '🥹': ['holding_back_tears'],
  '😭': ['sob', 'cry'],
  '😮': ['open_mouth', 'wow'],
  '🤔': ['thinking'],
  '😇': ['innocent'],
  '😎': ['sunglasses', 'cool'],
  '🥳': ['partying_face'],
  '😴': ['sleeping'],
  '😱': ['scream'],
  '🤯': ['exploding_head', 'mind_blown'],
  '🔥': ['fire'],
  '✨': ['sparkles'],
  '💯': ['100'],
  '✅': ['white_check_mark', 'check'],
  '❌': ['x', 'cross'],
  '⭐': ['star'],
  '👏': ['clap'],
  '🙌': ['raised_hands'],
  '💪': ['muscle'],
  '👌': ['ok_hand', 'ok'],
  '🤝': ['handshake'],
  '🫡': ['saluting_face', 'salute'],
  '🍣': ['sushi'],
  '🍺': ['beer'],
  '☕': ['coffee'],
  '🍰': ['cake'],
  '🐱': ['cat'],
  '🌸': ['cherry_blossom', 'sakura'],
};
