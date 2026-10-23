import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VIEW_TEXT_DEFAULTS, viewTexts } from './viewTexts';

const FIXTURE = fileURLToPath(new URL('../../../crates/client-core/tests/fixtures/view/texts.json', import.meta.url));

describe('表示の文言（viewTexts）', () => {
  it('TS の値は fixtures/view/texts.json（core の UNKNOWN_USER_NAME と同じ値）', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { unknownUser: string };
    expect(VIEW_TEXT_DEFAULTS.unknownUser).toBe(f.unknownUser);
    expect(viewTexts.unknownUser).toBe(f.unknownUser);
  });
});
