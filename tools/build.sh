#!/bin/sh
# Link the wrapper against the prebuilt libde265 archive. See README for the
# two flags that are not optional.
set -e
SRC=${SRC:-../libde265}
emcc src/de265_wrapper.c -I"$SRC" -I"$SRC/build-wasm" \
  "$SRC/build-wasm/libde265/liblibde265.a" \
  -O3 -msimd128 -DLIBDE265_STATIC_BUILD \
  -s MODULARIZE=1 -s EXPORT_NAME=createDe265 -s ENVIRONMENT=node,web,worker \
  -s ALLOW_MEMORY_GROWTH=1 -s STACK_SIZE=5242880 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","getValue"]' -s EXPORT_ES6=1 \
  -o build/de265.js
echo "built build/de265.js + build/de265.wasm"
