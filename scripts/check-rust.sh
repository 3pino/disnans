#!/usr/bin/env bash
# ローカルの Rust 確認（軽量版）。デバッグ情報なし・並列は既定。app/src-tauri は対象外（CI で見る）。
# 使い方: scripts/check-rust.sh            （clippy + test、ts-rs の差分確認）
#         scripts/check-rust.sh clippy     （clippy だけ）
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
J=()
nice -n 10 cargo clippy --workspace --all-targets "${J[@]}" -- -D warnings
[ "${1:-}" = clippy ] && exit 0
# テストは 1 回だけ流す。全文は .pi/check-rust-test.log に残し、失敗したときは要点を出す（まれな失敗の原因を追えるように）
LOG=.pi/check-rust-test.log
mkdir -p .pi
if nice -n 10 cargo test --workspace "${J[@]}" --no-fail-fast >"$LOG" 2>&1; then
  echo "test: ok"
else
  grep -E "^test .* FAILED|panicked|^error|^---- " "$LOG" | head -40
  echo "test: FAILED（全文: $LOG）"
  exit 1
fi
git diff --exit-code --stat app/src/lib/protocol && echo "protocol: ok"
