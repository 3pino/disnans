// 実際の build.rs と、ロック済みの tauri-plugin の通常の生成器を使う。
// GTK を必要とする Tauri 本体を組まずに、notifier の権限ファイルだけを更新する。
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(app, 'src-tauri/plugins/notifier');
const lock = join(app, 'src-tauri/Cargo.lock');
const version = /name = "tauri-plugin"\nversion = "([^"]+)"/.exec(await readFile(lock, 'utf8'))?.[1];
if (!version) throw new Error('Locked tauri-plugin version not found');
const temp = await mkdtemp(join(tmpdir(), 'disnans-notifier-permissions-'));
try {
  await mkdir(join(temp, 'src'));
  await writeFile(join(temp, 'src/lib.rs'), '// Permission generation only.\n');
  await writeFile(join(temp, 'Cargo.toml'), `[package]
name = "tauri-plugin-notifier"
version = "0.1.0"
edition = "2021"
links = "tauri-plugin-notifier"
build = ${JSON.stringify(join(plugin, 'build.rs'))}

[build-dependencies]
tauri-plugin = { version = "=${version}", features = ["build"] }
`);
  await copyFile(lock, join(temp, 'Cargo.lock'));
  await symlink(join(plugin, 'permissions'), join(temp, 'permissions'), 'dir');
  const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(temp, 'Cargo.toml')], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(app, 'src-tauri/target') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
