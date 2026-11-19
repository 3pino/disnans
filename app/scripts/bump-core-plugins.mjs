#!/usr/bin/env node
// コアプラグインの版上げ（core-plugins.lock.json を、互換な最新のリリースへ書き換える）。
// 対象: lock の各 id。リポジトリのリリースから、lock の tag と同じ接頭（plugin-<id>-v）で、下書き・プレリリースでないもの。
// 版は semver で一番高いもの。manifest.minApiVersion が本体の API_VERSION より新しいものは飛ばして、そう言う。
// 取ったものは、SHA256SUMS と照合してから書く（照合できなければ何も書かない）。
// 使い方: node scripts/bump-core-plugins.mjs          （lock を書き換える）
//         node scripts/bump-core-plugins.mjs --check  （新しい互換の版があれば終了コード 1。書かない）
// GITHUB_TOKEN があれば付ける（API の上限を避ける）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiVersionOf, FILE_NAMES, parseSums, sha256, validateLock } from './fetch-core-plugins.mjs';

const SEMVER_TAG = /^(.*-v)(\d+)\.(\d+)\.(\d+)$/;

/** タグ「plugin-fixplor-v0.1.2」→ { prefix: 'plugin-fixplor-v', ver: [0,1,2] }。形が違えば null */
export function splitTag(tag) {
  const m = SEMVER_TAG.exec(tag);
  return m ? { prefix: m[1], ver: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
}

/** 版の大小（負: a < b） */
export function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * 1 つの id について、互換な最新の版を探す。
 * fetchJson(url) → JSON、fetchBytes(url) → Buffer を使う（テストで差し替える）。
 * 返す: { entry（更新後の lock の項目）| null（すでに最新・候補なし）, newer: 互換でない新しい版のタグ一覧 }
 */
export async function bumpEntry({ id, current, apiVersion, apiBase, baseUrl, fetchJson, fetchBytes }) {
  const cur = splitTag(current.tag);
  if (!cur) throw new Error(`${id}: 現在のタグの形が違います（${current.tag}）`);
  const releases = await fetchAllReleases(`${apiBase}/repos/${current.repo}/releases`, fetchJson);
  const cands = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ tag: r.tag_name, p: splitTag(r.tag_name) }))
    .filter((c) => c.p && c.p.prefix === cur.prefix && cmpVer(c.p.ver, cur.ver) >= 0)
    .sort((a, b) => cmpVer(b.p.ver, a.p.ver));
  const newer = [];
  for (const c of cands) {
    if (c.tag === current.tag) return { entry: null, newer };
    const base = `${baseUrl}/${current.repo}/releases/download/${c.tag}`;
    const sums = parseSums((await fetchBytes(`${base}/SHA256SUMS`)).toString('utf8'));
    const manifestBytes = await fetchBytes(`${base}/manifest.json`);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.id !== id) throw new Error(`${id}: ${c.tag} の manifest.id が違います（${manifest.id}）`);
    if (!Number.isInteger(manifest.minApiVersion)) throw new Error(`${id}: ${c.tag} の manifest.minApiVersion が整数ではありません`);
    if (manifest.minApiVersion > apiVersion) {
      newer.push(c.tag);
      continue;
    }
    const bytes = { 'manifest.json': manifestBytes };
    for (const n of FILE_NAMES.slice(1)) bytes[n] = await fetchBytes(`${base}/${n}`);
    const files = {};
    for (const n of FILE_NAMES) {
      const got = sha256(bytes[n]);
      if (sums[n] !== got) throw new Error(`${id}: ${c.tag} の ${n} が SHA256SUMS と一致しません（書きません）`);
      files[n] = got;
    }
    return {
      entry: { repo: current.repo, tag: c.tag, minApiVersion: manifest.minApiVersion, manifest, files },
      newer,
    };
  }
  return { entry: null, newer };
}

async function fetchAllReleases(url, fetchJson) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await fetchJson(`${url}?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

/** lock 全体。書き換えが要る id と、飛ばした新しい版を返す（書かない） */
export async function bumpAll({ lock, apiVersion, apiBase, baseUrl, fetchJson, fetchBytes }) {
  validateLock(lock);
  const next = structuredClone(lock);
  const changed = [];
  const skipped = {};
  for (const [id, e] of Object.entries(lock)) {
    const r = await bumpEntry({ id, current: e, apiVersion, apiBase, baseUrl, fetchJson, fetchBytes });
    if (r.newer.length) skipped[id] = r.newer;
    if (r.entry) {
      next[id] = { ...e, ...r.entry };
      changed.push(`${id}: ${e.tag} → ${r.entry.tag}`);
    }
  }
  validateLock(next);
  return { next, changed, skipped };
}

async function main() {
  const check = process.argv.includes('--check');
  const here = dirname(fileURLToPath(import.meta.url));
  const appDir = join(here, '..');
  const lockPath = join(appDir, 'core-plugins.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const apiVersion = apiVersionOf(readFileSync(join(appDir, 'src/lib/plugins/types.ts'), 'utf8'));
  const token = process.env.GITHUB_TOKEN;
  const apiBase = process.env.DISNANS_GITHUB_API ?? 'https://api.github.com';
  const baseUrl = process.env.DISNANS_CORE_BASE ?? 'https://github.com';
  const headers = (extra = {}) => ({ Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
  const fetchJson = async (url) => {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  };
  const fetchBytes = async (url) => {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const { next, changed, skipped } = await bumpAll({ lock, apiVersion, apiBase, baseUrl, fetchJson, fetchBytes });
  for (const [id, tags] of Object.entries(skipped)) {
    console.log(`[core-bump] ${id}: 本体（API v${apiVersion}）より新しい版のため飛ばした: ${tags.join(', ')}`);
  }
  if (changed.length === 0) {
    console.log('[core-bump] 最新です（変更なし）');
    return 0;
  }
  if (check) {
    console.log(`[core-bump] 新しい互換の版があります: ${changed.join(' / ')}`);
    return 1;
  }
  writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[core-bump] 更新しました: ${changed.join(' / ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[core-bump] 失敗: ${e.message}`);
      process.exit(2);
    },
  );
}
