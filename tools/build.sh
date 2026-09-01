#!/bin/sh
# Build dist/ — the directory jsDelivr serves. Everything the browser loads ends
# up here and nowhere else, so the CDN URL and a local checkout are the same
# thing.
#
# Two flags below are not optional; see README.
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SRC=${SRC:-../libde265}
mkdir -p dist
emcc src/de265_wrapper.c -I"$SRC" -I"$SRC/build-wasm" \
  "$SRC/build-wasm/libde265/liblibde265.a" \
  -O3 -msimd128 -DLIBDE265_STATIC_BUILD \
  -s MODULARIZE=1 -s EXPORT_NAME=createDe265 -s ENVIRONMENT=node,web,worker \
  -s ALLOW_MEMORY_GROWTH=1 -s STACK_SIZE=5242880 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","getValue"]' -s EXPORT_ES6=1 \
  -o dist/de265.js
cp src/decoder-worker.js src/paint.js src/demux.js dist/
ls -l dist/
