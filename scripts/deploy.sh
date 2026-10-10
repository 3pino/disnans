#!/usr/bin/env bash
# 本番サーバー（cucum-ubu24）へ disnans-server を配信し、プラグインの見本を ~/repos/disnans-plugin に写す。
#
#   scripts/deploy.sh                 # 最新のリリースのサーバーを配信・再起動し、プラグインを写す
#   scripts/deploy.sh v0.1.8          # タグを指定して配信する
#   scripts/deploy.sh --migrate-data  # 初回だけ: 手元の data/ を本番へ移してから配信する
#   scripts/deploy.sh --plugins-only  # プラグインを写すだけ
#
# サーバーはビルドしない。GitHub のリリースに添付されたもの（.github/workflows/server.yml が
# ubuntu-24.04 でビルドする）を本番が直接ダウンロードする。
# 本番では systemd のユーザーサービス（disnans.service）として動かす。
set -euo pipefail

HOST="${DISNANS_HOST:-cucum-ubu24}"
REMOTE_DIR="${DISNANS_REMOTE_DIR:-disnans}"          # 本番のホームからの相対パス
BIND_PORT="${DISNANS_PORT:-8080}"
PLUGIN_DEST="${DISNANS_PLUGIN_DEST:-$HOME/repos/disnans-plugins}"
REPO="${DISNANS_REPO:-3pino/disnans}"
ASSET=disnans-server_linux-x64

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATE=0
PLUGINS_ONLY=0
TAG=""
for arg in "$@"; do
  case "$arg" in
    --migrate-data) MIGRATE=1 ;;
    --plugins-only) PLUGINS_ONLY=1 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    v*) TAG="$arg" ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

sync_plugins() {
  step "プラグインの見本を $PLUGIN_DEST に写す（上書き）"
  mkdir -p "$PLUGIN_DEST"
  # examples/ はテストが参照しているので、移動ではなく写す。写し先の .git は残す
  rsync -a --delete --exclude .git "$ROOT/examples/" "$PLUGIN_DEST/"
  ls "$PLUGIN_DEST"
}

if [[ $PLUGINS_ONLY == 1 ]]; then
  sync_plugins
  exit 0
fi

if [[ -z $TAG ]]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName)"
fi
URL="https://github.com/$REPO/releases/download/$TAG"
step "配信するリリース: $TAG"
if ! curl -sfIL -o /dev/null "$URL/$ASSET"; then
  echo "$TAG のリリースにサーバー（$ASSET）がありません。Server のワークフローが終わるのを待つか、" >&2
  echo "手動で実行してください: gh workflow run server.yml --repo $REPO -f tag=$TAG" >&2
  exit 1
fi

step "$HOST に接続できるか確認"
REMOTE_IP="$(ssh "$HOST" 'tailscale ip -4 | head -1')"
[[ -n $REMOTE_IP ]] || { echo "$HOST の Tailscale の IP が分かりません" >&2; exit 1; }
echo "本番: $HOST ($REMOTE_IP:$BIND_PORT)"
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/bin ~/$REMOTE_DIR/data ~/$REMOTE_DIR/backup"

if [[ $MIGRATE == 1 ]]; then
  step "手元の data/ を本番へ移す"
  if ssh "$HOST" "test -f ~/$REMOTE_DIR/data/disnans.db"; then
    echo "本番にすでに DB があります。上書きしないので、消してからやり直してください" >&2
    exit 1
  fi
  ssh "$HOST" "systemctl --user stop disnans.service 2>/dev/null || true"
  # 手元のサーバーを止めてから写す（止めないと、移したあとの書き込みが失われる）
  if pkill -x disnans-server; then sleep 1; fi
  ts="$(date +%Y%m%d-%H%M%S)"
  sqlite3 "$ROOT/data/disnans.db" ".backup '$ROOT/data/backup-$ts.db'"
  rsync -a --exclude 'backup-*.db' --exclude tmp --exclude 'disnans.db*' "$ROOT/data/" "$HOST:$REMOTE_DIR/data/"
  rsync -a "$ROOT/data/backup-$ts.db" "$HOST:$REMOTE_DIR/data/disnans.db"
  echo "手元のサーバーは止めました（以後は本番だけを使う）"
elif ! ssh "$HOST" "test -f ~/$REMOTE_DIR/data/disnans.db"; then
  echo "本番に DB がありません。初回は --migrate-data で手元の data/ を移してください" >&2
  exit 1
fi

step "ダウンロードして入れ替え、再起動する"
ssh "$HOST" bash -s -- "$REMOTE_DIR" "$REMOTE_IP" "$BIND_PORT" "$URL" "$ASSET" <<'REMOTE'
set -euo pipefail
dir="$HOME/$1"; ip="$2"; port="$3"; url="$4"; asset="$5"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sfL -o "$tmp/$asset" "$url/$asset"
curl -sfL -o "$tmp/$asset.sha256" "$url/$asset.sha256"
(cd "$tmp" && sha256sum -c --quiet "$asset.sha256")

unit="$HOME/.config/systemd/user/disnans.service"
mkdir -p "$(dirname "$unit")"
cat >"$unit" <<UNIT
[Unit]
Description=disnans server
After=network-online.target tailscaled.service

[Service]
ExecStart=$dir/bin/disnans-server
Environment=DISNANS_DATA_DIR=$dir/data
Environment=DISNANS_BIND=$ip:$port
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user stop disnans.service 2>/dev/null || true
if [ -f "$dir/data/disnans.db" ]; then
  cp "$dir/data/disnans.db" "$dir/backup/disnans-$(date +%Y%m%d-%H%M%S).db"
  # バックアップは新しい 20 個だけ残す
  ls -1t "$dir"/backup/disnans-*.db | tail -n +21 | xargs -r rm --
fi
install -m 755 "$tmp/$asset" "$dir/bin/disnans-server"
systemctl --user enable disnans.service >/dev/null 2>&1
systemctl --user restart disnans.service
REMOTE

step "応答を確認する"
code=000
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://$REMOTE_IP:$BIND_PORT/api/plugins" || true)"
  [[ $code == 200 ]] && break
  sleep 1
done
if [[ $code != 200 ]]; then
  echo "応答がありません（$code）。ログ: ssh $HOST journalctl --user -u disnans -n 50" >&2
  exit 1
fi
echo "OK: http://$REMOTE_IP:$BIND_PORT（ログ: ssh $HOST journalctl --user -u disnans -f）"

sync_plugins
