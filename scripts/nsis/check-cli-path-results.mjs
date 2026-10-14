// cli-path-harness.exe が書いた結果（cli-path-results.txt）を、期待値と比べる。
//   node scripts/nsis/check-cli-path-results.mjs <cli-path-results.txt>
// 失敗した項目を標準エラーに出し、1 つでもあれば終了コード 1。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 文字列の操作（DISNANS_FIND / DISNANS_REMOVE）の期待値
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

const CONCAT_LENGTH = 10240; // 40 文字を 2^8 回つないだ長さ（上限で切れるはず）

/** 行の値（`prefix|値` の値部分）を返す。無ければ undefined。 */
function valueOf(lines, prefix) {
  const line = lines.find((l) => l.startsWith(`${prefix}|`));
  return line === undefined ? undefined : line.slice(prefix.length + 1);
}

/**
 * 結果の全項目が期待どおりか。失敗の一覧（空なら成功）を返す。
 * ビルドの NSIS_MAX_STRLEN（limit）から、期待値を計算する。
 */
export function check(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const failures = [];
  for (const expected of EXPECTED) {
    if (!lines.includes(expected)) {
      failures.push(`期待した行がありません: ${expected}`);
    }
  }

  // 上限: ビルドが定義する NSIS_MAX_STRLEN
  const limit = Number(valueOf(lines, 'limit'));
  if (!Number.isInteger(limit) || limit < 512) {
    failures.push(`limit の行が不正です: ${valueOf(lines, 'limit')}`);
    return failures;
  }
  // 扱ってよい長さ: 上限より 200 文字少ない（マクロ DISNANS_PATH_MAX と同じ計算）
  const pathMax = limit - 200;
  if (valueOf(lines, 'pathmax') !== String(pathMax)) {
    failures.push(`pathmax が ${pathMax} ではありません: ${valueOf(lines, 'pathmax')}`);
  }

  // 連結は上限で切れる（切り詰めの確認。切れないなら、長さ判定の前提が崩れる）
  const concat = Number(valueOf(lines, 'concat'));
  const expectedConcat = Math.min(CONCAT_LENGTH, limit - 1);
  if (concat !== expectedConcat) {
    failures.push(`連結の長さが ${expectedConcat} ではありません: ${valueOf(lines, 'concat')}`);
  }

  // 長さの判定（DISNANS_LEN_OK）: pathMax 以下は 1、それより長い（切り詰めの値を含む）は 0
  for (const n of [100, pathMax, pathMax + 1, limit - 1]) {
    const want = n <= pathMax ? 1 : 0;
    const line = `guard|${n}|${want}`;
    if (!lines.includes(line)) {
      failures.push(`長さの判定が期待と違います（長さ ${n}、期待 ${want}）`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node check-cli-path-results.mjs <cli-path-results.txt>');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const failures = check(text);
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  const limit = valueOf(text.split(/\r?\n/), 'limit');
  console.log(`cli-path harness: NSIS_MAX_STRLEN=${limit} で、すべて期待どおり`);
}
