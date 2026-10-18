#!/usr/bin/env bash
# Linux の診断用起動。普段のランチャー・ターミナルの設定は変更しない。
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '使い方: %s [実行ファイル [引数...]]\n' "$0"
  printf '既定: disnans-app（deb）。AppImage はそのパスを指定。\n'
  printf '先にトレイの「終了」で完全に終了してください。\n'
  printf '保存先: ${XDG_STATE_HOME:-$HOME/.local/state}/disnans/logs\n'
  printf 'DISNANS_LOG_DIR / GST_DEBUG / G_MESSAGES_DEBUG / RUST_BACKTRACE で変更できます。\n'
  exit 0
fi

if [[ $(uname -s) != Linux ]]; then
  echo 'このスクリプトは Linux 用です。' >&2
  exit 1
fi
if command -v pgrep >/dev/null && pgrep -u "$(id -u)" -x disnans-app >/dev/null; then
  echo 'disnans が起動中です。トレイの「終了」で完全に終了してから実行してください。' >&2
  exit 2
fi
if [[ $# == 0 ]]; then set -- disnans-app; fi
if ! command -v "$1" >/dev/null; then
  echo "実行ファイルを開けません: $1（AppImage は実行権限も確認してください）" >&2
  exit 1
fi

umask 077
log_dir="${DISNANS_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/disnans/logs}"
mkdir -p "$log_dir"
log="$(mktemp "$log_dir/linux-$(date +%Y%m%d-%H%M%S)-XXXXXX.log")"
{
  printf '# disnans Linux diagnostic log\n# started: %s\n' "$(date -Is)"
  printf '# kernel: %s\n# session: %s\n' "$(uname -sr)" "${XDG_SESSION_TYPE:-unknown}"
  printf '# Native GTK/GStreamer/Rust logs; not a saved JavaScript console.\n'
} >> "$log"
nohup env \
  RUST_BACKTRACE="${RUST_BACKTRACE:-1}" \
  GST_DEBUG="${GST_DEBUG:-3}" GST_DEBUG_NO_COLOR=1 \
  G_MESSAGES_DEBUG="${G_MESSAGES_DEBUG:-all}" \
  "$@" >> "$log" 2>&1 </dev/null &
pid=$!
printf '診断用に起動しました（PID: %s）。ログ: %s\n' "$pid" "$log"
printf '通話などで再現してください。ログにはマシン名・パスなどが含まれる場合があります。\n'
