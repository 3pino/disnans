// cli-path-harness.exe が書いた結果を、期待値と比べる。
//   node scripts/nsis/check-cli-path-results.mjs <cli-path-results.txt>
// 期待値は下の表。一致しなければ終了コード 1。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED = [
  'started|1',
  'find|A;B;C|B|1',
  'find|A;B;C|BC|0',
  'find|A;BC|B|0',
  'find|B|B|1',
  'find|A;B|A|1',
  'find|A;B|C|0',
  'find||X|0',
  'remove|A;B;C|B|[A;C]',
  'remove|B|B|[]',
  'remove|A;B|A|[B]',
  'remove|A;B|B|[A]',
  'remove|A;E;B;E|E|[A;B;E]',
  'remove|E;E|E|[E]',
  'remove|ABC|B|[ABC]',
  'remove|A;BC;D|B|[A;BC;D]',
  'remove|A;B|C|[A;B]',
  'remove|E;A;E|E|[A;E]',
];

/** 結果の全行が期待どおりか。失敗の一覧（空なら成功）を返す。 */
export function check(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const failures = [];
  for (const expected of EXPECTED) {
    if (!lines.includes(expected)) {
      failures.push(`期待した行がありません: ${expected}`);
    }
  }
  const maxlen = lines.find((l) => l.startsWith('maxlen|'));
  if (!maxlen) {
    failures.push('maxlen の行がありません');
  } else if (Number(maxlen.split('|')[1]) < 2560) {
    failures.push(`文字列が切り詰められています: ${maxlen}`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node check-cli-path-results.mjs <cli-path-results.txt>');
    process.exit(2);
  }
  const failures = check(readFileSync(file, 'utf8'));
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`cli-path harness: ${EXPECTED.length} 件すべて期待どおり`);
}
