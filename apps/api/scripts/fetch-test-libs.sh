#!/usr/bin/env bash
# 集成测试通过 embedded-postgres（真实 PostgreSQL 二进制）在本机启动临时实例。
# linux/arm64 上官方二进制链接的是 Debian buster 时代的 libicuuc.so.60，
# Debian 12 等较新系统只自带 ICU72，需要把 ICU60 放到 test-libs/ 下，
# 测试运行时由 vitest globalSetup 注入 LD_LIBRARY_PATH。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$DIR/test-libs"
mkdir -p "$TARGET"

# pnpm 只在直接依赖里创建 embedded-postgres 符号链接，平台子包要从虚拟 store 解析。
ROOT="$(cd "$DIR/../.." && pwd)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) PLATFORM_PKG="linux-x64" ;;
  aarch64) PLATFORM_PKG="linux-arm64" ;;
  *) echo "架构 $ARCH 暂无 embedded-postgres 测试支持，请使用外部 PostgreSQL" >&2; exit 0 ;;
esac
BIN_DIR="$(find "$ROOT/node_modules/.pnpm" -type d -path "*@embedded-postgres+${PLATFORM_PKG}*/native/bin" 2>/dev/null | head -1)"
if [ -z "$BIN_DIR" ]; then
  echo "未找到 @embedded-postgres/${PLATFORM_PKG}，请先执行 pnpm install" >&2
  exit 1
fi

if ! ldd "$BIN_DIR/initdb" 2>/dev/null | grep -q "not found"; then
  echo "embedded-postgres 原生依赖已齐全，无需下载 test-libs"
  exit 0
fi

if [ "$PLATFORM_PKG" != "linux-arm64" ]; then
  echo "embedded-postgres 缺少系统库（$(ldd "$BIN_DIR/initdb" | grep 'not found')），请在系统中安装" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
URL="http://ports.ubuntu.com/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_arm64.deb"
echo "下载 $URL"
curl -fsSL "$URL" -o "$WORK/libicu60.deb"
(cd "$WORK" && ar x libicu60.deb && tar xf data.tar.*)
cp "$WORK/usr/lib/aarch64-linux-gnu/"libicu*.so.60* "$TARGET/"
echo "已安装 ICU60 运行库到 $TARGET"
