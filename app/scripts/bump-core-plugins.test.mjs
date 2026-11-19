// コアプラグインの版上げ（bump-core-plugins.mjs）の試験。ネットワークは使わない（仮の API と仮の配布）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpAll, cmpVer, splitTag } from './bump-core-plugins.mjs';
import { FILE_NAMES, sha256, validateLock } from './fetch-core-plugins.mjs';

const REPO = 'x/fixplor';
const manifestFor = (ver, minApiVersion) => ({
  id: 'fixplor', name: 'ファイル', version: ver, description: 'd', author: 'a', minApiVersion, icon: 'folder', permissions: ['files'],
});
/** 配布の中身（タグごと） */
function release(tag, { minApiVersion = 20, id = 'fixplor', ver = tag.split('-v')[1] } = {}) {
  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifestFor(ver, minApiVersion)).replace('"id":"fixplor"', `"id":"${id}"`)),
    'main.js': Buffer.from(`/* ${tag} */`),
    'styles.css': Buffer.from(`.x{}/* ${tag} */`),
    'icon.svg': Buffer.from('<svg/>'),
  };
  const sums = FILE_NAMES.map((n) => `${sha256(files[n])}  ${n}`).join('\n');
  return { ...files, SHA256SUMS: Buffer.from(sums) };
}
/** 仮の GitHub: releases（API の形）と、タグごとの配布 */
function fakeGitHub(list, dist = {}) {
  const base = 'https://gh.test';
  const api = 'https://api.test';
  const releases = list.map((r) => ({ tag_name: r.tag, draft: !!r.draft, prerelease: !!r.prerelease }));
  const fetchJson = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    const per = Number(u.searchParams.get('per_page'));
    assert.equal(per, 100);
    return releases.slice((page - 1) * per, page * per);
  };
  const fetchBytes = async (url) => {
    const m = url.match(/\/releases\/download\/([^/]+)\/(.+)$/);
    const tag = m[1];
    const body = dist[tag]?.[m[2]];
    if (!body) throw new Error(`404 ${url}`);
    return body;
  };
  return { api, base, fetchJson, fetchBytes };
}
function lockAt(tag, rel) {
  const e = {
    repo: REPO,
    tag,
    minApiVersion: rel['manifest.json'] ? JSON.parse(rel['manifest.json'].toString()).minApiVersion : 20,
    manifest: JSON.parse(rel['manifest.json'].toString()),
    files: Object.fromEntries(FILE_NAMES.map((n) => [n, sha256(rel[n])])),
  };
  return { fixplor: e };
}

test('タグを分ける・比べる', () => {
  assert.deepEqual(splitTag('plugin-fixplor-v0.1.2'), { prefix: 'plugin-fixplor-v', ver: [0, 1, 2] });
  assert.equal(splitTag('plugin-fixplor-0.1.2'), null);
  assert.ok(cmpVer([0, 1, 10], [0, 1, 2]) > 0, '0.1.10 は 0.1.2 より新しい');
});

test('互換な最新を選ぶ（semver で比べる。0.1.10 > 0.1.9）', async () => {
  const r = { 'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2'), 'plugin-fixplor-v0.1.10': release('plugin-fixplor-v0.1.10'), 'plugin-fixplor-v0.1.9': release('plugin-fixplor-v0.1.9') };
  const gh = fakeGitHub(Object.keys(r).map((tag) => ({ tag })), r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  const out = await bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes });
  assert.equal(out.next.fixplor.tag, 'plugin-fixplor-v0.1.10');
  assert.deepEqual(out.changed, ['fixplor: plugin-fixplor-v0.1.2 → plugin-fixplor-v0.1.10']);
  assert.equal(out.next.fixplor.files['main.js'], sha256(r['plugin-fixplor-v0.1.10']['main.js']));
  validateLock(out.next);
});

test('本体より新しい API を要る版は飛ばして、そう言う（より低い互換の版を選ぶ）', async () => {
  const r = {
    'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2', { minApiVersion: 20 }),
    'plugin-fixplor-v0.1.3': release('plugin-fixplor-v0.1.3', { minApiVersion: 21 }),
  };
  const gh = fakeGitHub([{ tag: 'plugin-fixplor-v0.1.3' }, { tag: 'plugin-fixplor-v0.1.2' }], r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  const out = await bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes });
  assert.deepEqual(out.skipped, { fixplor: ['plugin-fixplor-v0.1.3'] });
  assert.equal(out.changed.length, 0, '現在の版が最新の互換なので変えない');
  assert.equal(out.next.fixplor.tag, 'plugin-fixplor-v0.1.2');
});

test('下書き・プレリリース・別の接頭のタグは候補にしない', async () => {
  const r = { 'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2'), 'plugin-fixplor-v0.1.5': release('plugin-fixplor-v0.1.5') };
  const gh = fakeGitHub([
    { tag: 'plugin-fixplor-v0.1.5', draft: true },
    { tag: 'plugin-fixplor-v0.1.6', prerelease: true },
    { tag: 'plugin-other-v0.9.0' },
    { tag: 'plugin-fixplor-v0.1.2' },
  ], r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  const out = await bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes });
  assert.equal(out.changed.length, 0);
});

test('すでに最新なら変えない（書き換えの候補なし）', async () => {
  const r = { 'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2') };
  const gh = fakeGitHub([{ tag: 'plugin-fixplor-v0.1.2' }], r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  const out = await bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes });
  assert.equal(out.changed.length, 0);
  assert.deepEqual(out.next, lock);
});

test('SHA256SUMS と中身が違えば失敗する（何も書かない結果を返さない）', async () => {
  const r = { 'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2'), 'plugin-fixplor-v0.1.3': release('plugin-fixplor-v0.1.3') };
  r['plugin-fixplor-v0.1.3']['main.js'] = Buffer.from('tampered');
  const gh = fakeGitHub([{ tag: 'plugin-fixplor-v0.1.3' }, { tag: 'plugin-fixplor-v0.1.2' }], r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  await assert.rejects(bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes }), /SHA256SUMS と一致しません/);
});

test('manifest.id が違えば失敗する', async () => {
  const r = { 'plugin-fixplor-v0.1.2': release('plugin-fixplor-v0.1.2'), 'plugin-fixplor-v0.1.3': release('plugin-fixplor-v0.1.3', { id: 'other' }) };
  const gh = fakeGitHub([{ tag: 'plugin-fixplor-v0.1.3' }, { tag: 'plugin-fixplor-v0.1.2' }], r);
  const lock = lockAt('plugin-fixplor-v0.1.2', r['plugin-fixplor-v0.1.2']);
  await assert.rejects(bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes }), /manifest.id が違います/);
});

test('リリースの一覧は複数ページを読む', async () => {
  const tags = Array.from({ length: 130 }, (_, i) => `plugin-fixplor-v0.0.${i}`);
  const r = { 'plugin-fixplor-v0.0.0': release('plugin-fixplor-v0.0.0'), 'plugin-fixplor-v0.0.129': release('plugin-fixplor-v0.0.129') };
  const gh = fakeGitHub(tags.map((tag) => ({ tag })), r);
  const lock = lockAt('plugin-fixplor-v0.0.0', r['plugin-fixplor-v0.0.0']);
  const out = await bumpAll({ lock, apiVersion: 20, apiBase: gh.api, baseUrl: gh.base, fetchJson: gh.fetchJson, fetchBytes: gh.fetchBytes });
  assert.equal(out.next.fixplor.tag, 'plugin-fixplor-v0.0.129');
});
