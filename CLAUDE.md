# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

An H.265/HEVC decoder for browsers that do not have one, compiled to
WebAssembly from [OpenIPC/libde265](https://github.com/OpenIPC/libde265) — a
fork of strukturag/libde265 carrying WASM SIMD work.

Its consumer is OpenIPC's `majestic-webui`, whose Live page reaches it as the
last decode attempt before falling back to MJPEG. It is deliberately usable
from anything else: `fancyweb-ng` and `rnd-player` are the obvious candidates.

**`dist/` is committed on purpose.** jsDelivr serves this repository directly
(`cdn.jsdelivr.net/gh/OpenIPC/hevc-wasm@<tag>/dist/`), so the built artifacts
are the product. Rebuild with `tools/build.sh` and commit the result; a tag is
what consumers pin to.

## The constraints that decided the design

Do not redesign against these without re-checking them — every one was
verified, and each rules out an obvious alternative.

- **A camera serves plain HTTP _by default_.** So the page is normally **not a
  secure context**, and that removes: **WebCodecs** (`VideoDecoder` is
  `[SecureContext]`), **SharedArrayBuffer** and therefore **WASM pthreads**,
  and **MediaStreamTrackGenerator** (so a decoder cannot feed a `<video>`).
  WASM **SIMD** survives — it needs no cross-origin isolation — and so does
  **OffscreenCanvas**, which is what makes the worker design possible.

  **This is a default, not a law, and the distinction matters.** An operator can
  reach a secure context two ways: majestic serves TLS itself
  (`system.httpsPort`, `system.httpsCertificate`, `system.httpsCertificateKey`),
  or a reverse proxy terminates HTTPS in front of the camera. Do not write
  "plain HTTP" as a premise without saying which it is.

  HTTPS alone still is not enough for threads: `SharedArrayBuffer` needs
  **cross-origin isolation**, which is HTTPS *plus* `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page.
  majestic sends neither today, so that is the real gap — and a reverse proxy
  can add them without touching the daemon. jsDelivr already serves
  `access-control-allow-origin: *` and `cross-origin-resource-policy:
  cross-origin`, so the CDN-hosted decoder keeps loading under isolation.
- **Single-threaded, for the default deployment.** libde265's `frame-parallel`
  branch needs threads, so it is unusable as things stand — but it is the
  obvious upgrade for an isolated context, and single-threaded 4K measures
  ~49 ms/frame against a ~33 ms arrival interval, so threading is the only
  thing that could make 4K viable at all. On a secure context **WebCodecs is
  the bigger prize**: where the platform has HEVC it means hardware decode,
  which beats every path in this repository.
- **A Worker cannot be constructed from a cross-origin URL.** Consumers fetch
  `decoder-worker.js` as text and run it from a blob, rewriting its relative
  imports to absolute — the blob's base URL is useless.

## Architecture

One Web Worker owns the WebSocket, the fMP4 demux, the decoder and the canvas.
The main thread sends `start`/`setStream`/`idr`/`stats`/`destroy` and **never
sees a frame**: `transferControlToOffscreen()` gives the worker the WebGL
context, so a decoded picture goes from the wasm heap to `texSubImage2D`
without crossing a thread.

Demuxing on the main thread and posting access units in was considered and is
worse on both counts — it maximises boundary traffic and puts decode on the
wrong side of a postMessage from the canvas. It also breaks in a hidden tab,
where `requestAnimationFrame` is throttled to ~1 Hz or stops.

## The decode ABI is resumable, and is not used to split frames

`src/de265_wrapper.c` exposes `de_push` / `de_end_frame` /
`de_step(budget_ms)` / `de_plane` / `de_reset`, built on libde265's
`de265_decode(ctx, int* more)`. **Read `docs/design.md` before changing this.**
The short version: an I-frame costs 7–11x an inter frame, and splitting it
across render ticks is the classic fix — but majestic emits **one NAL per
picture**, so there is no yield point inside one; splitting creates no CPU
time; and the thing a split protects is a main thread, which this design does
not have. `budget_ms` bounds how long the worker goes without returning to its
event loop, nothing more.

Details that will bite if changed:

- **`de265_push_end_of_frame()` must be called** per access unit, or no picture
  emerges until the *next* AU's first NAL arrives — a free frame of latency.
- **`de265_get_warning()` must be drained** or warnings accumulate.
- **`de265_reset()` after any drop to a random access point is mandatory**, or
  the DPB holds references for pictures that will never arrive and paints
  garbage rather than reporting anything.

## Backpressure

Two bounds, because each alone lets the other run away: **bytes** (AU sizes vary
~50x, so a frame count says nothing about memory) and **time** (bytes say
nothing about delay — without the time bound, 4K reached 121 queued frames
inside a 4 MiB budget and six seconds behind the camera).

When it cannot keep up it drops **whole GOPs** back to the newest random access
point. Asking the camera for a fresh IDR is rate limited and must stay so:
unlimited, it fired 32 times in 30 seconds, and each request costs an extra
I-frame — the most expensive thing this decoder is handed — which puts the
client further behind, which triggers the next drop.

## Build

See README. Two flags are not optional and both fail confusingly:

- The fork defines `WASM_SIMD` but **never passes `-msimd128`**, so it must go
  in the C/CXX flags or the intrinsics compile scalar.
- **`-sSTACK_SIZE=5242880`.** Emscripten's 64 KB default overflows inside
  libde265's recursive `read_coding_quadtree` → `decode_prediction_unit`, and
  at `-O3` without assertions the symptom is a completely misleading
  `RuntimeError: table index is out of bounds`. Rebuild with
  `-O0 -g2 -sASSERTIONS=2` to see the real message.

## Testing

`tools/capture.mjs` pulls real bitstreams off a camera's `/ws/video`;
`tools/measure.mjs` reports per-step decode times; `tools/simulate.mjs` models
arrival cadence against them. **Use real camera output, not x265 clips** — GOP
shape, slice count per picture and IDR size are exactly what a synthetic clip
gets wrong, and they are what the design turns on.

## Licence

The wrapper and tools are MIT. **libde265 is LGPL**, and the built `.wasm` is a
derived work of it — the build script and the fork it is built from are
published here so the relinking freedom is real. Keep it that way: do not
vendor libde265 sources into this tree without carrying its licence with them.
