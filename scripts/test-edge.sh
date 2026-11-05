#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE="$ROOT/.cache/edge"
if [ -z "${NGINX_BIN:-}" ]; then
  NGINX_BIN="$CACHE/runtime/sbin/nginx"
  if [ ! -x "$NGINX_BIN" ] || ! "$NGINX_BIN" -v 2>&1 | grep -q "nginx/1.30.6"; then
    mkdir -p "$CACHE"
    curl -fLsS https://codeload.github.com/nginx/nginx/tar.gz/refs/tags/release-1.30.6 -o "$CACHE/nginx.tar.gz"
    printf '%s  %s\n' eecb978190f28a0c3dc074939087e6853f3d485eb549dedf522b96a67a7ae664 "$CACHE/nginx.tar.gz" | sha256sum -c -
    tar -xzf "$CACHE/nginx.tar.gz" -C "$CACHE"
    (cd "$CACHE/nginx-release-1.30.6" && ./auto/configure --prefix="$CACHE/runtime" --with-http_realip_module --without-http_rewrite_module --without-http_gzip_module --without-http_auth_basic_module > "$CACHE/configure.log" 2>&1 && make -j2 > "$CACHE/make.log" 2>&1 && make install >> "$CACHE/make.log" 2>&1)
  fi
fi
export NGINX_BIN
cd "$ROOT"
exec node --test test-edge/*.test.js
