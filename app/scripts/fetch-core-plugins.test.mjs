// コアプラグインの取得（fetch-core-plugins.mjs）の試験。ネットワークは使わない（ローカルの仮の GitHub）
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiVersionOf, fetchCorePlugins, FILE_NAMES, parseSums, sha256, validateLock } from './fetch-core-plugins.mjs';

const REPO = 'x/fixplor';
const TAG = 'plugin-fixplor-v0.1.0';
const manifest = { id: 'fixplor', name: 'ファイル', version: '0.1.0', description: 'd', author: 'a', minApiVersion: 19, icon: 'folder', permissions: ['files'] };

/** 仮の配布: 名前 → 中身。SHA256SUMS は中身から作る */
function release(over = {}) {
  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'main.js': Buffer.from('export default class {}'),
    'styles.css': Buffer.from('.x{}'),
    'icon.svg': Buffer.from('<svg/>'),
    ...over,
  };
  const sums = FILE_NAMES.map((n) => `${sha256(files[n])}  ${n}`).join('\n') + '\n';
  return { ...files, SHA256SUMS: Buffer.from(sums) };
}
const lockOf = (rel, over = {}) => ({
  fixplor: {
    repo: REPO,
    tag: TAG,
    minApiVersion: 19,
    manifest,
    files: Object.fromEntries(FILE_NAMES.map((n) => [n, sha256(rel[n])])),
    ...over,
  },
});

/** 仮の GitHub。served は配布の中身（変えられる）。hits は取りに来た数 */
async function fakeGithub(served) {
  const hits = { n: 0 };
  const server = createServer((req, res) => {
    hits.n++;
    const name = req.url.split('/').pop();
    const body = served[name];
    if (!body || req.url !== `/${REPO}/releases/download/${TAG}/${name}`) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  // 二重に閉じても失敗しない（途中で失敗しても、finally で必ず閉じる）
  const close = () => (closed ? Promise.resolve() : ((closed = true), new Promise((r) => server.close(r))));
  return { base, hits, close };
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'h2-core-'));
  const out = join(root, 'public');
  const cache = join(root, 'cache');
  mkdirSync(out, { recursive: true });
  return { root, out, cache };
}

test('取得して、sha256 を確かめ、置く（キャッシュにも残す）', async () => {
  const rel = release();
  const gh = await fakeGithub(rel);
  const d = dirs();
  try {
    const ids = await fetchCorePlugins({ lock: lockOf(rel), apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch });
    assert.deepEqual(ids, ['fixplor']);
    for (const n of FILE_NAMES) assert.equal(readFileSync(join(d.out, 'fixplor', n)).toString(), rel[n].toString());
    assert.ok(existsSync(join(d.cache, 'fixplor', 'main.js')));
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('main.js の sha256 が lock と違えば失敗し、何も置かない・キャッシュにも書かない', async () => {
  const rel = release();
  const lock = lockOf(rel);
  const gh = await fakeGithub(release({ 'main.js': Buffer.from('tampered') }));
  const d = dirs();
  try {
    await assert.rejects(
      fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch }),
      /main\.js の sha256 が lock と違います/,
    );
    assert.ok(!existsSync(join(d.out, 'fixplor')));
    assert.ok(!existsSync(join(d.cache, 'fixplor')));
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('SHA256SUMS が lock と違えば失敗する（リリースの中身の確かめ）', async () => {
  const rel = release();
  const lock = lockOf(rel);
  const bad = release();
  bad['SHA256SUMS'] = Buffer.from(FILE_NAMES.map((n) => `${'0'.repeat(64)}  ${n}`).join('\n'));
  const gh = await fakeGithub(bad);
  const d = dirs();
  try {
    await assert.rejects(
      fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch }),
      /SHA256SUMS の .* が lock と違います|sha256 が lock と違います/,
    );
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('manifest.json の中身が lock の manifest と違えば失敗する', async () => {
  const rel = release({ 'manifest.json': Buffer.from(JSON.stringify({ ...manifest, name: 'ほかの名前' })) });
  const lock = lockOf(rel);
  const gh = await fakeGithub(rel);
  const d = dirs();
  try {
    await assert.rejects(
      fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch }),
      /manifest\.json が lock の manifest と違います/,
    );
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('必要な plugin API が本体より新しければ、取る前に失敗する', async () => {
  const rel = release();
  const lock = lockOf(rel, { minApiVersion: 20 });
  lock.fixplor.manifest = { ...manifest, minApiVersion: 20 };
  const gh = await fakeGithub(rel);
  const hitsBefore = gh.hits.n;
  const d = dirs();
  try {
    await assert.rejects(
      fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch }),
      /必要な plugin API（v20）が、この本体（v19）より新しい/,
    );
    assert.equal(gh.hits.n, hitsBefore);
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('キャッシュがそろって一致していれば、取りに行かない（オフラインでも動く）', async () => {
  const rel = release();
  const lock = lockOf(rel);
  const gh = await fakeGithub(rel);
  const d = dirs();
  try {
    await fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch });
    await gh.close(); // 以後は取れない
    const hitsAfterClose = gh.hits.n;
    const again = await fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch });
    assert.deepEqual(again, ['fixplor']);
    assert.equal(gh.hits.n, hitsAfterClose, 'キャッシュがあるのに取りに行った');
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('取れず、キャッシュも無ければ失敗する（オフラインの決まり）', async () => {
  const rel = release();
  const lock = lockOf(rel);
  const d = dirs();
  await assert.rejects(
    fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: 'http://127.0.0.1:1', fetchImpl: fetch }),
    /取れません.*キャッシュも無い/,
  );
  rmSync(d.root, { recursive: true, force: true });
});

test('キャッシュの中身が違えば使わず、取り直す（壊れたキャッシュ）', async () => {
  const rel = release();
  const lock = lockOf(rel);
  const gh = await fakeGithub(rel);
  const d = dirs();
  try {
    mkdirSync(join(d.cache, 'fixplor'), { recursive: true });
    for (const n of FILE_NAMES) writeFileSync(join(d.cache, 'fixplor', n), 'broken');
    await fetchCorePlugins({ lock, apiVersion: 19, outDir: d.out, cacheDir: d.cache, baseUrl: gh.base, fetchImpl: fetch });
    assert.ok(gh.hits.n > 0);
    assert.equal(readFileSync(join(d.out, 'fixplor', 'main.js')).toString(), rel['main.js'].toString());
  } finally {
    await gh.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('lock の形が違えば、何が違うかを言う', () => {
  const rel = release();
  const good = lockOf(rel);
  assert.doesNotThrow(() => validateLock(good));
  assert.throws(() => validateLock({ fixplor: { ...good.fixplor, repo: 'bad' } }), /repo が違います/);
  assert.throws(() => validateLock({ fixplor: { ...good.fixplor, manifest: { ...manifest, id: 'x' } } }), /manifest\.id が一致しません/);
  const { 'main.js': _m, ...rest } = good.fixplor.files;
  assert.throws(() => validateLock({ fixplor: { ...good.fixplor, files: rest } }), /files\.main\.js/);
  assert.throws(() => validateLock({ fixplor: { ...good.fixplor, files: { ...good.fixplor.files, 'x.js': 'a'.repeat(64) } } }), /知らないファイル/);
});

test('API_VERSION は本体の定義を文字で読む / SHA256SUMS の行を読む', () => {
  assert.equal(apiVersionOf('export const API_VERSION = 19;\n'), 19);
  assert.throws(() => apiVersionOf('nothing'), /API_VERSION が見つかりません/);
  const s = parseSums(`${'a'.repeat(64)}  main.js\n${'b'.repeat(64)} *icon.svg\n`);
  assert.equal(s['main.js'], 'a'.repeat(64));
  assert.equal(s['icon.svg'], 'b'.repeat(64));
});
