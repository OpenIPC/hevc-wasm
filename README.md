# hevc-wasm

H.265/HEVC decoding in the browser, for cameras whose stream the browser will
not take. Built from [OpenIPC/libde265](https://github.com/OpenIPC/libde265)
(a fork of strukturag/libde265) with emscripten.

## Why

A camera on `video0.codec: h265` is unplayable in a browser without native
HEVC — WebRTC cannot negotiate what the browser will not decode, and MSE's
`isTypeSupported()` refuses the mime. This decodes it instead.

The constraint that shapes everything: a camera serves plain HTTP, so the page
is **not a secure context**. That rules out WebCodecs, SharedArrayBuffer (and
therefore WASM threads), and MediaStreamTrackGenerator. `OffscreenCanvas`
survives, which is what makes the design possible.

## Build

```sh
git clone https://github.com/OpenIPC/libde265 ../libde265
emcmake cmake -H../libde265 -B../libde265/build-wasm \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DDISABLE_TOOLS=ON -DENABLE_SDL=OFF -DENABLE_THREADS=OFF \
  -DCMAKE_C_FLAGS="-O3 -msimd128" -DCMAKE_CXX_FLAGS="-O3 -msimd128"
cmake --build ../libde265/build-wasm -j
sh tools/build.sh
```

Two traps, both costly to rediscover:

- The fork defines `WASM_SIMD` but **never passes `-msimd128`** itself, so it
  must go in the C/CXX flags or the intrinsics compile scalar.
- **`-sSTACK_SIZE` must be raised** (5 MB works). Emscripten's 64 KB default
  overflows inside libde265's recursive `read_coding_quadtree` →
  `decode_prediction_unit`, and at `-O3` with no assertions the symptom is a
  completely misleading `RuntimeError: table index is out of bounds`. Rebuild
  with `-O0 -g2 -sASSERTIONS=2` to see the real message.

Artifact: ~418 KB `.wasm`.

## Measured

Single-threaded + SIMD, x86 desktop, against bitstreams captured from a real
hi3516av300 rather than synthetic clips (`tools/capture.mjs`):

| stream | mean/frame | inter | I-frame | worst I | sustainable |
|---|---|---|---|---|---|
| 1280x720 | 4.33 ms | 2.79 ms | 30.63 ms | 59.52 ms | 231 fps |
| 1920x1080 | 6.87 ms | 4.94 ms | 39.70 ms | 60.53 ms | 146 fps |
| 3840x2160 | 48.66 ms | 43.91 ms | 129.54 ms | 173.73 ms | 20.5 fps |

An I-frame costs 7-11x an inter frame, and majestic emits **one NAL per
picture**, so there is no yield point inside one. That is why the decode runs
in a worker and is allowed to overrun rather than being split: splitting
redistributes when CPU is spent and creates none — see `docs/design.md`.

## Licence

This wrapper is MIT. **libde265 is LGPL**, and the built `.wasm` is a derived
work of it: the build script and the exact fork revision are published here so
the relinking freedom is real rather than nominal. See `COPYING.libde265`.
