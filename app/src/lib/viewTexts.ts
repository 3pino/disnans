/**
 * 表示の文言。正は core の `view::UNKNOWN_USER_NAME`。GUI は同じ値をここに持ち、
 * `crates/client-core/tests/fixtures/view/texts.json` と一致することを viewTexts.test.ts と Rust の view_fixtures で確かめる。
 * 起動のときに core から読むことはしない（起動を待たせないため）。
 */
export const VIEW_TEXT_DEFAULTS = { unknownUser: '不明なユーザー' } as const;

/** 表示に使う文言。名前が分からない人の表示 */
export const viewTexts: { unknownUser: string } = { ...VIEW_TEXT_DEFAULTS };
