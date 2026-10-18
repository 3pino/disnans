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
nice -n 10 cargo test --workspace "${J[@]}" 2>&1 | grep -E "^test result|FAILED|panicked|^error" | grep -v "^test result: ok" || true
nice -n 10 cargo test --workspace "${J[@]}" -q >/dev/null 2>&1 && echo "test: ok" || { echo "test: FAILED"; exit 1; }
git diff --exit-code --stat app/src/lib/protocol && echo "protocol: ok"
