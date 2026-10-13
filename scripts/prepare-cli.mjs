#!/usr/bin/env node
// CLI（disnans）を app/src-tauri/binaries/ に置く。Tauri の externalBin がこの配置物を読む。
//
//   node scripts/prepare-cli.mjs            本物の CLI を release でビルドして配置する（tauri build / tauri dev が使う）
//   node scripts/prepare-cli.mjs --stub     空のプレースホルダだけを置く（cargo test / clippy / check のため）
//   options: --target <triple>   省略時は環境変数 TAURI_ENV_TARGET_TRIPLE、無ければ rustc の host
//
// 注意: --stub の配置物は本物ではない（0 バイト）。インストーラに入れてはいけない。
// tauri build / tauri dev は beforeBuildCommand / beforeDevCommand からこのスクリプトを本物モードで呼ぶので、
// 本物で必ず上書きされる。リリースの検証（release.yml）でもサイズとバージョン表示で確かめる。

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_BINARIES = join(REPO_ROOT, 'app', 'src-tauri', 'binaries');

/** 引数を読む。不正な引数は例外。 */
export function parseArgs(argv, env = {}) {
  let stub = false;
  let target = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stub') {
      stub = true;
    } else if (arg === '--target') {
      i += 1;
      if (!argv[i] || argv[i].startsWith('--')) {
        throw new Error('--target には値が要ります');
      }
      target = argv[i];
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }
  if (target === null && env.TAURI_ENV_TARGET_TRIPLE) {
    target = env.TAURI_ENV_TARGET_TRIPLE;
  }
  return { stub, target };
}

/** `rustc -vV` の出力から host のトリプルを取る。 */
export function hostTripleFrom(rustcVerbose) {
  const line = rustcVerbose.split('\n').find((l) => l.startsWith('host: '));
  if (!line) {
    throw new Error('rustc -vV に host の行がありません');
  }
  return line.slice('host: '.length).trim();
}

/** Windows のトリプルか（拡張子 .exe が要るか）。 */
export function isWindowsTriple(triple) {
  return triple.includes('windows');
}

/** externalBin の配置名（tauri-utils の external_binaries と同じ規則）。 */
export function sidecarFileName(triple) {
  return `disnans-${triple}${isWindowsTriple(triple) ? '.exe' : ''}`;
}

/** cargo が作る CLI の実行ファイル名（--target を付けたビルドの出力先）。 */
export function builtCliName(triple) {
  return `disnans${isWindowsTriple(triple) ? '.exe' : ''}`;
}

/**
 * 配置の計画（副作用なし）。テストでは fs / 子プロセスを差し替えずに使える。
 * 戻り値: { mode, triple, dest, cargo?, source? }
 */
export function plan({ stub, target, host, cargoTargetDir, appBinaries = APP_BINARIES, repoRoot = REPO_ROOT }) {
  const triple = target ?? host;
  const dest = join(appBinaries, sidecarFileName(triple));
  if (stub) {
    return { mode: 'stub', triple, dest };
  }
  const targetDir = cargoTargetDir ?? join(repoRoot, 'target');
  return {
    mode: 'real',
    triple,
    dest,
    cargo: ['build', '--release', '-p', 'disnans-cli', '--target', triple],
    source: join(targetDir, triple, 'release', builtCliName(triple)),
  };
}

/**
 * 計画を実行する。`io` は差し替え可能（テスト用）。
 * 本物モードでは cargo が出した実行ファイルが無ければ失敗する（古い配置物を残さない）。
 */
export function run(argv, env, io = defaultIo()) {
  const args = parseArgs(argv, env);
  const host = args.target ? null : hostTripleFrom(io.rustcVerbose());
  const p = plan({
    stub: args.stub,
    target: args.target,
    host: host ?? args.target,
    cargoTargetDir: env.CARGO_TARGET_DIR ? resolve(REPO_ROOT, env.CARGO_TARGET_DIR) : undefined,
  });
  io.mkdirp(dirname(p.dest));
  if (p.mode === 'stub') {
    io.writeEmpty(p.dest);
    io.log(`stub を置きました（本物ではない）: ${p.dest}`);
    return p;
  }
  const status = io.cargo(p.cargo);
  if (status !== 0) {
    throw new Error(`cargo build が失敗しました（終了コード ${status}）`);
  }
  if (!io.exists(p.source)) {
    throw new Error(`ビルド結果が見つかりません: ${p.source}`);
  }
  io.copy(p.source, p.dest);
  io.log(`CLI を置きました: ${p.dest}`);
  return p;
}

function defaultIo() {
  return {
    rustcVerbose: () => {
      const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error('rustc -vV が失敗しました（Rust が入っていますか）');
      }
      return r.stdout;
    },
    cargo: (args) => {
      // ビルドの出力はそのまま見せる
      const r = spawnSync('cargo', args, { cwd: REPO_ROOT, stdio: 'inherit' });
      return r.status ?? 1;
    },
    exists: (path) => existsSync(path),
    copy: (from, to) => copyFileSync(from, to),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    writeEmpty: (path) => writeFileSync(path, ''),
    log: (message) => console.log(message),
  };
}

// 直接実行されたときだけ動く（テストから import しても副作用は無い）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`prepare-cli: ${error.message}`);
    process.exit(1);
  }
}
