#!/usr/bin/env bash
# 使い方: scripts/release-latest-json.sh <TAG> <VERSION> <REPO>  → ./latest.json を作る
# リリースの各 .sig から、Tauri の更新情報（latest.json）を作る。tauri-action が作るものと同じ形（v0.2.21 で照合済み）。
# デスクトップのビルドを並列にするため、各ジョブには latest.json を書かせず、公開の前にここでまとめて作る。
set -euo pipefail
TAG=$1; VERSION=$2; REPO=$3
dir=$(mktemp -d)
gh release download "$TAG" --repo "$REPO" --dir "$dir" --pattern '*.sig'
base="https://github.com/$REPO/releases/latest/download"
APPIMAGE="disnans_${VERSION}_amd64.AppImage"
DEB="disnans_${VERSION}_amd64.deb"
NSIS="disnans_${VERSION}_x64-setup.exe"
for f in "$APPIMAGE" "$DEB" "$NSIS"; do
  test -s "$dir/$f.sig" || { echo "::error::$f.sig がありません"; exit 1; }
done
jq -n --arg v "$VERSION" --arg date "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg ai "$base/$APPIMAGE" --rawfile ais "$dir/$APPIMAGE.sig" \
  --arg deb "$base/$DEB" --rawfile debs "$dir/$DEB.sig" \
  --arg ns "$base/$NSIS" --rawfile nss "$dir/$NSIS.sig" \
  '{version:$v, notes:"", pub_date:$date, platforms:{
     "linux-x86_64":{signature:$ais,url:$ai},
     "linux-x86_64-appimage":{signature:$ais,url:$ai},
     "linux-x86_64-deb":{signature:$debs,url:$deb},
     "windows-x86_64":{signature:$nss,url:$ns},
     "windows-x86_64-nsis":{signature:$nss,url:$ns}}}' > latest.json
