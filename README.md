# hevc-wasm

H.265/HEVC decoding in the browser, for cameras whose stream the browser will
not take. Built from [OpenIPC/libde265](https://github.com/OpenIPC/libde265)
(a fork of strukturag/libde265) with emscripten.

## Why

A camera on `video0.codec: h265` is unplayable in a browser without native
HEVC — WebRTC cannot negotiate what the browser will not decode, and MSE's
`isTypeSupported()` refuses the mime. This decodes it instead.

The constraint that shapes everything: a camera serves plain HTTP **by
default**, so the page is normally **not a secure context**. That rules out
WebCodecs, SharedArrayBuffer (and therefore WASM threads), and
MediaStreamTrackGenerator. `OffscreenCanvas` survives, which is what makes the
design possible.

It is a default rather than a limit — majestic can serve TLS itself, or a
reverse proxy can — but threads additionally need cross-origin isolation
(`COOP: same-origin` + `COEP: require-corp`), which majestic does not send
today. See `docs/design.md`.

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

## Feeding the worker yourself

By default the worker opens the camera's `/ws/video` socket itself (the
reasons are in the source: nothing frame-sized crosses a thread, and a
hidden tab cannot starve it). A page can own the transport instead — an
`RTCDataChannel` cannot be created in or transferred into a worker, and a
camera that carries the same bitstream over one needs exactly this:

```js
w.postMessage({ type: 'start', feed: true, url, canvas: off }, [off]);
// -> { type: 'feed', ok: true, protocol: 1 }   nothing was opened
// (send nothing before it: a message that arrives while the decoder is
//  still being created is dropped)
w.postMessage({ type: 'msg', data: initText });             // the text `init`
w.postMessage({ type: 'msg', data: initSegment, kind: 2 }); // ftyp+moov
w.postMessage({ type: 'msg', data: fragment, kind: 3 }, [fragment]); // [prft] moof+mdat
w.postMessage({ type: 'gap' });    // frames were lost: decode nothing until a RAP
w.postMessage({ type: 'reset' });  // the feed was replaced: a new init follows
w.postMessage({ type: 'open', url }); // hand the transport back to the worker
// <- { type: 'send', text }  what the worker would have written to the socket
```

`msg` carries a `/ws/video` message verbatim: the text `init`, the binary
init segment (`kind: 2`) or a fragment (`kind: 3`); without `kind`, the
first binary message is the init, as on the socket. A fragment that arrives
before any init is counted (`stats.noInit`) and dropped. `gap` is the
page's word that frames are missing — heard from the camera, or a hole it
found itself — and the worker then decodes nothing until the next random
access point; the request for a keyframe is the page's to make, so the two
do not double up. The `idr` message still works and leaves as `send`.

A fragment may start with a producer reference time (`prft`, ISO 14496-12
§8.16.5), which a camera puts there when it knows the frame's capture
instant. The worker strips it and reports capture-to-paint lag in `stats`:
`lag: { n, p50, p95, max }` and the raw `lagMs` samples since the last
report — the newest 240 of them, so a page that asks once a second sees
every frame and one that asks less often sees the latest stretch. The
spread is exact; the absolute figure carries the camera's clock offset from
this machine's.

`dist/test.html?feed=ws` runs this mode over a plain WebSocket the page
opens, so the byte compatibility can be checked against any camera;
`tools/feed-test.mjs` runs it under Node against an ffmpeg-made stream and
is part of CI.

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
