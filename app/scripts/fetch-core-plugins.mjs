#!/usr/bin/env node
// コアプラグインの取得（core-plugins.lock.json に書いた版を、GitHub のリリースから取って app/public/core-plugins/<id>/ に置く）。
// 取った成果物は、lock の sha256 と一致するものだけ使う（違えば失敗。キャッシュにも書かない）。
// 手順: キャッシュ（app/.cache/core-plugins）に全部そろって一致していれば、それを使う（オフラインでも動く）。無ければ取りに行く。
// 取れず、キャッシュも無ければ失敗。npm の predev / prebuild から呼ぶ。
// 使い方: node scripts/fetch-core-plugins.mjs   （GITHUB_TOKEN があれば、Authorization を付ける）
// 開発用の上書き: 環境変数 DISNANS_CORE_PLUGIN_DIR_<id>=<フォルダ> を付けると、そのフォルダの 4 ファイルを使う（例: DISNANS_CORE_PLUGIN_DIR_fixplor=~/fixplor/dist-plugin/fixplor-0.1.1）。
//   この場合は lock の sha256・manifest を確かめず、キャッシュにも書かない。大きく警告する。CI（環境変数 CI がある）では使えない。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FILE_NAMES = ['manifest.json', 'main.js', 'styles.css', 'icon.svg'];
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 開発用の上書きの環境変数の名前（id ごと） */
export const LOCAL_DIR_ENV_PREFIX = 'DISNANS_CORE_PLUGIN_DIR_';

/**
 * 環境変数から、上書きするフォルダを読む（{ id: フォルダ }）。CI では使わせない（失敗を投げる）。
 * id は lock に載っているものだけ。載っていない id の変数は無視せず、失敗を投げる（打ち間違いに気付くように）。
 */
export function localDirsFromEnv(env, lock) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LOCAL_DIR_ENV_PREFIX) || v === undefined || v === '') continue;
    const id = k.slice(LOCAL_DIR_ENV_PREFIX.length);
    if (!(id in lock)) throw new Error(`${k}: core-plugins.lock.json に無い id です`);
    out[id] = v;
  }
  if (Object.keys(out).length > 0 && env.CI) throw new Error('DISNANS_CORE_PLUGIN_DIR_<id>（開発用の上書き）は CI では使えません');
  return out;
}

/** app/src/lib/plugins/types.ts の API_VERSION を読む（この script は TypeScript を読み込めないので、文字で読む） */
export function apiVersionOf(typesTs) {
  const m = /export const API_VERSION = (\d+);/.exec(typesTs);
  if (!m) throw new Error('API_VERSION が見つかりません（app/src/lib/plugins/types.ts）');
  return Number(m[1]);
}

/** lock の形を確かめる。違えば、何がおかしいかを言う */
export function validateLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('lock の形が違います');
  for (const [id, e] of Object.entries(lock)) {
    const where = `core-plugins.lock.json の ${id}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${where}: id の形が違います`);
    if (typeof e.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) throw new Error(`${where}: repo が違います`);
    if (typeof e.tag !== 'string' || e.tag === '') throw new Error(`${where}: tag がありません`);
    if (!Number.isInteger(e.minApiVersion)) throw new Error(`${where}: minApiVersion が整数ではありません`);
    if (!e.manifest || e.manifest.id !== id) throw new Error(`${where}: manifest.id が一致しません`);
    if (e.manifest.minApiVersion !== e.minApiVersion) throw new Error(`${where}: manifest.minApiVersion と lock の値が違います`);
    for (const name of FILE_NAMES) {
      if (!e.files || typeof e.files[name] !== 'string' || !HEX64.test(e.files[name])) throw new Error(`${where}: files.${name} の sha256 がありません`);
    }
    const extra = Object.keys(e.files).filter((n) => !FILE_NAMES.includes(n));
    if (extra.length) throw new Error(`${where}: 知らないファイル ${extra.join(', ')}`);
  }
  return lock;
}

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** リリースの SHA256SUMS（"<sha>  <name>" の行）を読む */
export function parseSums(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/**
 * コアプラグインを取って outDir に置く。
 * opts: { lock, apiVersion, outDir, cacheDir, baseUrl='https://github.com', token?, fetchImpl=fetch, log=()=>{}, localDirs={} }
 * localDirs: { id: フォルダ }（開発用。そのフォルダの 4 ファイルを使い、lock の sha256・manifest は確かめず、キャッシュにも書かない）
 * 成功すると、取り出した id の配列を返す。失敗は Error を投げる（何も置かない）。
 */
export async function fetchCorePlugins(opts) {
  const { apiVersion, outDir, cacheDir, baseUrl = 'https://github.com', token, fetchImpl = fetch, log = () => {}, localDirs = {} } = opts;
  const lock = validateLock(opts.lock);
  const done = [];
  for (const [id, e] of Object.entries(lock)) {
    if (e.minApiVersion > apiVersion) {
      throw new Error(`${id}: 必要な plugin API（v${e.minApiVersion}）が、この本体（v${apiVersion}）より新しい`);
    }
    const cached = join(cacheDir, id);
    const bytes = {};
    // キャッシュがそろって一致していれば、取りに行かない
    const cacheOk = FILE_NAMES.every((n) => existsSync(join(cached, n)) && sha256(readFileSync(join(cached, n))) === e.files[n]);
    if (localDirs[id] !== undefined) {
      // 開発用の上書き（確かめない・キャッシュに書かない）
      for (const n of FILE_NAMES) bytes[n] = readFileSync(join(localDirs[id], n));
      log(`!! ${id}: 開発用の上書きを使う（${localDirs[id]}）。lock の sha256 と manifest は確かめていません`);
    } else if (cacheOk) {
      for (const n of FILE_NAMES) bytes[n] = readFileSync(join(cached, n));
      log(`${id}: キャッシュを使う（${e.tag}）`);
    } else {
      const get = async (name) => {
        const url = `${baseUrl}/${e.repo}/releases/download/${e.tag}/${name}`;
        let res;
        try {
          res = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        } catch (err) {
          throw new Error(`${id}: ${name} を取れません（${url}）: ${err.message}。ネットワークを確かめてください（キャッシュも無いため）`);
        }
        if (!res.ok) throw new Error(`${id}: ${name} を取れません（HTTP ${res.status}: ${url}）`);
        return Buffer.from(await res.arrayBuffer());
      };
      // 公開の SHA256SUMS と lock が一致すること（リリースの中身の確かめ）
      const sums = parseSums(Buffer.from(await get('SHA256SUMS')).toString('utf8'));
      for (const n of FILE_NAMES) {
        bytes[n] = await get(n);
        const got = sha256(bytes[n]);
        if (got !== e.files[n]) throw new Error(`${id}: ${n} の sha256 が lock と違います（lock ${e.files[n]}・取れたもの ${got}）。版を確かめてください`);
        if (sums[n] !== undefined && sums[n] !== e.files[n]) throw new Error(`${id}: SHA256SUMS の ${n} が lock と違います`);
      }
      // キャッシュには、確かめたものだけ書く
      rmSync(cached, { recursive: true, force: true });
      mkdirSync(cached, { recursive: true });
      for (const n of FILE_NAMES) writeFileSync(join(cached, n), bytes[n]);
      log(`${id}: 取得して確かめました（${e.tag}）`);
    }
    // 中身の manifest が lock と同じこと（開発用の上書きでは確かめない）
    const manifest = JSON.parse(bytes['manifest.json'].toString('utf8'));
    if (localDirs[id] === undefined && !deepEqual(manifest, e.manifest)) throw new Error(`${id}: manifest.json が lock の manifest と違います`);

    // 置く（一時の場所に書いてから入れ替える）
    const target = join(outDir, id);
    const tmp = `${target}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const n of FILE_NAMES) writeFileSync(join(tmp, n), bytes[n]);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(tmp, target);
    done.push(id);
  }
  return done;
}

/** 置かれたもの（outDir）の中に、lock に無い id が残っていないか（残っていれば消す） */
export function pruneStale(outDir, lock) {
  if (!existsSync(outDir)) return;
  for (const d of readdirSync(outDir)) {
    if (!(d in lock) || d.endsWith('.tmp')) rmSync(join(outDir, d), { recursive: true, force: true });
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const appDir = join(here, '..');
  const lock = validateLock(JSON.parse(readFileSync(join(appDir, 'core-plugins.lock.json'), 'utf8')));
  const apiVersion = apiVersionOf(readFileSync(join(appDir, 'src/lib/plugins/types.ts'), 'utf8'));
  const outDir = join(appDir, 'public/core-plugins');
  const cacheDir = join(appDir, '.cache/core-plugins');
  const localDirs = localDirsFromEnv(process.env, lock);
  if (Object.keys(localDirs).length > 0) {
    const bar = '!'.repeat(60);
    console.warn(`${bar}\n[core-plugins] 警告: 開発用の上書きを使います（lock の sha256 と manifest は確かめません）:\n${Object.entries(localDirs).map(([k, v]) => `  ${k} <- ${v}`).join('\n')}\n${bar}`);
  }
  const ids = await fetchCorePlugins({
    lock,
    apiVersion,
    outDir,
    cacheDir,
    baseUrl: process.env.DISNANS_CORE_BASE ?? 'https://github.com',
    token: process.env.GITHUB_TOKEN,
    localDirs,
    log: (t) => console.log(`[core-plugins] ${t}`),
  });
  pruneStale(outDir, lock);
  console.log(`[core-plugins] 置きました: ${ids.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[core-plugins] 失敗: ${e.message}`);
    process.exit(1);
  });
}
