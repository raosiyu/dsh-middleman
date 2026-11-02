#!/bin/sh
# dsh-middleman 一键安装。
#
# 桌面版（Electron 应用）的 profile 由应用自己管，命令行 `dsh plugin --profile desktop`
# 会被拒绝。所以这个脚本不碰命令行，它把仓库拉下来，然后告诉你在应用里粘贴哪个路径。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/raosiyu/dsh-middleman/main/install.sh | sh
#   ./install.sh               # 从本地副本装
#   ./install.sh --dry-run     # 只打印会发生什么
set -eu

REPO="raosiyu/dsh-middleman"
TARBALL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
DEST="${DSH_MIDDLEMAN_DIR:-$HOME/.dsh/plugins-src/dsh-middleman}"
DRY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi }

if [ -f "./package.json" ] && grep -q '"name": *"dsh-middleman"' ./package.json 2>/dev/null; then
  SRC="$(pwd)"
  say "→ 用当前目录：$SRC"
else
  say "→ 下载 $REPO"
  TMP="$(mktemp -d)"
  if [ "$DRY" = "0" ]; then
    mkdir -p "$DEST"
    curl -fsSL "$TARBALL" -o "$TMP/src.tar.gz"
    tar -xzf "$TMP/src.tar.gz" -C "$TMP"
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    mv "$TMP/dsh-middleman-main" "$DEST"
    rm -rf "$TMP"
  fi
  SRC="$DEST"
fi

if [ "$DRY" = "0" ] && [ -d "$SRC/test" ]; then
  say "→ 跑测试"
  if ( cd "$SRC" && node --test test/*.test.mjs >/dev/null 2>&1 ); then
    say "  ✓ 测试通过"
  else
    say "  ! 测试没过，源码可能被改过；仍继续"
  fi
fi

say ""
say "════════════════════════════════════════"
say " 最后一步（桌面版只能由应用自己写 profile）"
say "════════════════════════════════════════"
say ""
say "  1. 打开 DeepSeek Harness"
say "  2. 侧边栏 → 插件 → 安装"
say "  3. 粘贴这个路径："
say ""
say "       $SRC"
say ""
say "  4. 完全退出应用，再打开"
say ""
say "  侧边栏出现「中台」就装好了。"
