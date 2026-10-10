#!/bin/bash
# 把 Chrome 扩展源码同步到 Safari Web Extension 工程内
# 用法：
#   ./sync-to-safari.sh                       # 默认从 ../ciba-plugin 同步
#   ./sync-to-safari.sh /path/to/ciba-plugin  # 指定源目录
# 同步完成后到 Xcode 里 ⌘B 重新构建即可。
set -e

# 源：Chrome 扩展工程根目录
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)/ciba-plugin}"
# 目标：本 Safari 工程的 Resources 目录
DEST="$(cd "$(dirname "$0")" && pwd)/CibaEnglish/CibaEnglish Extension/Resources"

if [ ! -f "$SRC/manifest.json" ]; then
  echo "❌ 源目录没找到 manifest.json: $SRC"
  echo "   请传入 Chrome 工程根目录作为第一个参数"
  exit 1
fi

if [ ! -d "$DEST" ]; then
  echo "❌ 目标 Resources 目录不存在: $DEST"
  exit 1
fi

echo "📦 同步: $SRC"
echo "   →    $DEST"

# 只同步扩展相关文件/目录；不动 Safari 原生代码（Swift、Info.plist、.xcodeproj 等）
rsync -a --delete \
  --include='/manifest.json' \
  --include='/js'          --include='/js/**' \
  --include='/css'         --include='/css/**' \
  --include='/images'      --include='/images/**' \
  --include='/icons'       --include='/icons/**' \
  --include='/pages'       --include='/pages/**' \
  --include='/privacy-policy.html' \
  --include='/readme.md' \
  --exclude='*' \
  "$SRC/" "$DEST/"

echo "✅ 同步完成。下一步：Xcode 里 ⌘B 重新构建。"
