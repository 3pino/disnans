// node --test scripts/prepare-cli.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtCliName,
  hostTripleFrom,
  isWindowsTriple,
  parseArgs,
  plan,
  run,
  sidecarFileName,
} from './prepare-cli.mjs';

const RUSTC_VV = 'rustc 1.95.0\nbinary: rustc\nhost: x86_64-unknown-linux-gnu\nrelease: 1.95.0\n';

/** 副作用を記録する io。cargo の終了コードと、出力の有無を指定できる。 */
function fakeIo({ cargoStatus = 0, produce = true } = {}) {
  const calls = { cargo: [], copy: [], writeEmpty: [], mkdirp: [], logs: [] };
  const existing = new Set();
  return {
    calls,
    existing,
    io: {
      rustcVerbose: () => RUSTC_VV,
      cargo: (args) => {
        calls.cargo.push(args);
        return cargoStatus;
      },
      exists: (path) => existing.has(path),
      copy: (from, to) => {
        calls.copy.push([from, to]);
      },
      mkdirp: (dir) => calls.mkdirp.push(dir),
      writeEmpty: (path) => calls.writeEmpty.push(path),
      log: (message) => calls.logs.push(message),
      _produce: produce,
    },
  };
}

test('parseArgs reads --stub and --target and rejects unknown arguments', () => {
  assert.deepEqual(parseArgs([], {}), { stub: false, target: null });
  assert.deepEqual(parseArgs(['--stub'], {}), { stub: true, target: null });
  assert.deepEqual(parseArgs(['--target', 'x86_64-pc-windows-gnu'], {}), {
    stub: false,
    target: 'x86_64-pc-windows-gnu',
  });
  assert.throws(() => parseArgs(['--bogus'], {}), /不明な引数/);
  assert.throws(() => parseArgs(['--target'], {}), /値が要ります/);
  assert.throws(() => parseArgs(['--target', '--stub'], {}), /値が要ります/);
});

test('an explicit --target wins over TAURI_ENV_TARGET_TRIPLE, which wins over the host', () => {
  assert.equal(parseArgs([], { TAURI_ENV_TARGET_TRIPLE: 'aarch64-unknown-linux-gnu' }).target, 'aarch64-unknown-linux-gnu');
  assert.equal(
    parseArgs(['--target', 'x86_64-pc-windows-gnu'], { TAURI_ENV_TARGET_TRIPLE: 'aarch64-unknown-linux-gnu' }).target,
    'x86_64-pc-windows-gnu',
  );
});

test('the host triple is read from rustc -vV', () => {
  assert.equal(hostTripleFrom(RUSTC_VV), 'x86_64-unknown-linux-gnu');
  assert.throws(() => hostTripleFrom('rustc 1.95.0\n'), /host の行がありません/);
});

test('Windows triples get .exe in both the sidecar and the built file names', () => {
  assert.equal(isWindowsTriple('x86_64-pc-windows-msvc'), true);
  assert.equal(isWindowsTriple('x86_64-unknown-linux-gnu'), false);
  assert.equal(sidecarFileName('x86_64-pc-windows-msvc'), 'disnans-x86_64-pc-windows-msvc.exe');
  assert.equal(sidecarFileName('x86_64-unknown-linux-gnu'), 'disnans-x86_64-unknown-linux-gnu');
  assert.equal(builtCliName('x86_64-pc-windows-gnu'), 'disnans.exe');
  assert.equal(builtCliName('x86_64-unknown-linux-gnu'), 'disnans');
});

test('plan: a real build uses the release CLI for the chosen triple and copies it to the sidecar name', () => {
  const p = plan({
    stub: false,
    target: 'x86_64-pc-windows-msvc',
    host: 'x86_64-unknown-linux-gnu',
    cargoTargetDir: '/t',
    appBinaries: '/app/binaries',
    repoRoot: '/repo',
  });
  assert.equal(p.mode, 'real');
  assert.deepEqual(p.cargo, ['build', '--release', '-p', 'disnans-cli', '--target', 'x86_64-pc-windows-msvc']);
  assert.equal(p.source, '/t/x86_64-pc-windows-msvc/release/disnans.exe');
  assert.equal(p.dest, '/app/binaries/disnans-x86_64-pc-windows-msvc.exe');
});

test('plan: the stub mode never runs cargo', () => {
  const p = plan({ stub: true, target: null, host: 'x86_64-unknown-linux-gnu', appBinaries: '/a' });
  assert.equal(p.mode, 'stub');
  assert.equal(p.dest, '/a/disnans-x86_64-unknown-linux-gnu');
  assert.equal(p.cargo, undefined);
});

test('run --stub writes an empty placeholder at the host name and does not call cargo', () => {
  const { io, calls } = fakeIo();
  const p = run(['--stub'], {}, io);
  assert.equal(p.mode, 'stub');
  assert.equal(calls.cargo.length, 0);
  assert.equal(calls.copy.length, 0);
  assert.equal(calls.writeEmpty.length, 1);
  assert.match(calls.writeEmpty[0], /disnans-x86_64-unknown-linux-gnu$/);
});

test('run (real) builds the CLI and copies it over the sidecar', () => {
  const env = {};
  const { io, calls, existing } = fakeIo();
  // 出力の場所（既定は repo/target/<triple>/release/disnans）を先に用意しておく
  const probe = plan({ stub: false, target: 'x86_64-unknown-linux-gnu', host: 'x', cargoTargetDir: undefined });
  existing.add(probe.source);
  const p = run(['--target', 'x86_64-unknown-linux-gnu'], env, io);
  assert.equal(calls.cargo.length, 1);
  assert.deepEqual(calls.cargo[0], ['build', '--release', '-p', 'disnans-cli', '--target', 'x86_64-unknown-linux-gnu']);
  assert.deepEqual(calls.copy, [[probe.source, p.dest]]);
});

test('run (real) fails when cargo fails, and never copies a stale file', () => {
  const { io, calls } = fakeIo({ cargoStatus: 101 });
  assert.throws(() => run(['--target', 'x86_64-unknown-linux-gnu'], {}, io), /cargo build が失敗/);
  assert.equal(calls.copy.length, 0);
});

test('run (real) fails when cargo succeeded but the built CLI is missing', () => {
  const { io, calls } = fakeIo();
  assert.throws(() => run(['--target', 'x86_64-unknown-linux-gnu'], {}, io), /ビルド結果が見つかりません/);
  assert.equal(calls.copy.length, 0);
});

test('CARGO_TARGET_DIR is respected for the built CLI location', () => {
  const { io, calls, existing } = fakeIo();
  const probe = plan({ stub: false, target: 'x86_64-pc-windows-gnu', host: 'x', cargoTargetDir: undefined });
  // CARGO_TARGET_DIR を使うと場所が変わるので、その場所を用意する
  const custom = plan({ stub: false, target: 'x86_64-pc-windows-gnu', host: 'x', cargoTargetDir: '/custom' });
  existing.add(custom.source);
  run(['--target', 'x86_64-pc-windows-gnu'], { CARGO_TARGET_DIR: '/custom' }, io);
  assert.equal(calls.copy.length, 1);
  assert.notEqual(probe.source, custom.source);
});
