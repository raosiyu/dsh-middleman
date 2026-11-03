#!/bin/sh
# dsh-whale-tail 一键安装。
#
# 桌面版（Electron 应用）的 profile 由应用自己管，命令行
# `dsh plugin --profile desktop add` 会被直接拒绝：
#   error: profile "desktop" is managed exclusively by the Electron application
#
# 所以这个脚本自己动手，做插件管理器做的同一件事：
#   1. 把包加进 profile 的 node_modules（pnpm add）
#   2. 把 bundle 名加进 profile package.json 的 dsh.profile.bundles
# 装完完全退出 DSH 再打开，插件才会加载。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/raosiyu/dsh-whale-tail/main/install.sh | sh
#   ./install.sh                    # 装到默认 profile
#   ./install.sh --profile web      # 装到别的 profile
#   ./install.sh --dry-run          # 只打印会发生什么
#   ./install.sh --uninstall        # 卸掉
set -eu

REPO="raosiyu/dsh-whale-tail"
PKG="dsh-whale-tail"
PROFILE="desktop"
DRY=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --profile) shift; PROFILE="${1:-$PROFILE}" ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi; }
die() { say "✗ $*"; exit 1; }

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ ! -d "$PROFILE_DIR" ]; then
  die "找不到 profile 目录：$PROFILE_DIR
用 --profile 指定别的 profile，或者先在应用里建一个。"
fi

PKG_JSON="$PROFILE_DIR/package.json"

# ── 卸掉 ────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  say "→ 从 $PROFILE 卸掉 $PKG"
  run node -e '
    const fs = require("fs")
    const file = process.argv[1]
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    if (pkg.dependencies) delete pkg.dependencies["dsh-whale-tail"]
    const bundles = pkg.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      pkg.dsh.profile.bundles = bundles.filter((name) => name !== "dsh-whale-tail")
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
  ' "$PKG_JSON"
  if [ "$DRY" = "0" ]; then
    ( cd "$PROFILE_DIR" && pnpm remove "$PKG" >/dev/null 2>&1 ) || true
  fi
  say "✓ 卸掉了。完全退出 DSH 再打开。"
  exit 0
fi

# ── 装 ──────────────────────────────────────────────────────────────
say "→ 装到 $PROFILE （$PROFILE_DIR ）"

# 1) 包进 node_modules。用 git URL，装的就是仓库本身，改代码即时生效。
run sh -c "cd '$PROFILE_DIR' && pnpm add 'git+https://github.com/$REPO.git'"

# 2) bundle 名进 profile 的 bundles 列表。装过的包里 bundle 会自动带自己的
#    cordis.patch.yml，但 profile 还得知道要挂它。
run node -e '
  const fs = require("fs")
  const file = process.argv[1]
  const name = process.argv[2]
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  const bundles = pkg.dsh.profile.bundles || (pkg.dsh.profile.bundles = [])
  if (!bundles.includes(name)) bundles.push(name)
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
' "$PKG_JSON" "$PKG"

if [ "$DRY" = "0" ]; then
  # 3) 自检：装进去的这份源码，测试要全绿。绿了才算装成功。
  say "→ 自检"
  if node --test "$PROFILE_DIR/node_modules/$PKG/test/"*.test.mjs >/dev/null 2>&1; then
    say "  ✓ 测试通过"
  else
    say "  ! 测试没过——装是装上了，但这份代码有问题，先别用"
  fi
fi

say ""
say "✓ 装好了。"
say ""
say "  1. 完全退出 DeepSeek Harness（不是关窗口）"
say "  2. 再打开"
say "  3. 侧边栏应该多一行「中台」"
say ""
say "想卸掉就跑：curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --uninstall"
