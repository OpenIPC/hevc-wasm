# Why the decode overruns instead of being split

An I-frame costs 7-11x an inter frame (measured: 39.7 ms against 4.9 ms at
1080p). The obvious fix is the one that made H.265 1080p30 viable on a 2013
MacBook: make the decode resumable and spread a heavy IDR across several render
ticks, so no single tick blows its frame budget.

libde265 is built for exactly that — `de265_decode(ctx, int* more)` is a
resumable step, and this module exposes it as `de_step(budget_ms)` rather than
as a `decode_frame()`. But it is **not** used to split I-frames, for three
reasons, in the order they were established.

## 1. There is no yield point inside a picture

majestic emits **one NAL per picture** at every resolution — measured, not
assumed (`tools/capture.mjs` reports `nalsPerPicture`). One `de265_decode()`
step is therefore one whole picture, and a budget cannot subdivide it.

The encoder cannot help either: majestic exposes slice control only for USB
cameras (`usbcam.sliceUnits`, H.264 only, over a UVC extension unit), never for
the SoC encoders that produce these streams. Getting a yield point would mean
patching libde265 to return at a CTU-row boundary inside slice decoding.

## 2. It would not help, because it creates no CPU time

Simulated against the real decode times: on a 4x-slower client at 1080p30 the
peak backlog is **5.8 frames at every buffer depth tried** (3, 5, 7, 8).
Yielding redistributes *when* work happens; the work is the same. A 174 ms
I-frame costs 174 ms however it is chopped.

## 3. What the split protects is a main thread, and there isn't one

The frame-budget argument is a main-thread argument: a 60 ms blocking decode
starves the compositor, input and layout. Here the decode is in a worker that
owns its own canvas through `transferControlToOffscreen()`, so nothing else
wants those milliseconds. The 2013-MacBook result came from a main-thread or
rAF-synchronous decoder — that architecture, not the codec, is what demanded
the split.

## What is used instead

- **The access-unit queue is the buffer.** Decode running ahead of display is
  what absorbs a late I-frame. Holding *decoded* frames back would need a
  second texture set or 3.1 MB of memcpy per 1080p frame, and would add latency
  to a live preview.
- **Two bounds on that queue.** Bytes, because AU sizes vary ~50x and a frame
  count says nothing about memory. And **time**, because bytes say nothing
  about delay — without it, 4K backed up to 121 queued frames, inside a 4 MiB
  byte bound and six seconds behind the camera.
- **Whole-GOP drops** when it cannot keep up, back to the newest random access
  point, followed by `de265_reset()` — mandatory, or the DPB holds references
  for pictures that will never arrive and paints garbage.
- **A rate limit on IDR requests.** Asking the camera for a fresh IDR when
  behind is a trap: measured against 4K it fired 32 times in 30 seconds, and
  each request costs an extra I-frame, which is the most expensive thing this
  decoder is ever handed, which puts the client further behind. Between
  requests, wait for the next natural random access point.

`de_step(budget_ms)` still earns its place — it bounds how long the worker goes
without returning to its event loop, so `destroy` and `setStream` are seen
promptly rather than after a 4K IDR. That is a different and smaller claim than
the one it was originally reached for, and it is worth stating plainly.

## The escape hatch, and why it is not taken here

Everything above assumes the page is not a secure context, which is the default
for a camera and not a law. An operator can change it — majestic serves TLS
itself (`system.httpsPort` and a certificate pair), or a reverse proxy
terminates HTTPS in front. Threads need more than that: cross-origin isolation
is HTTPS **plus** `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the page, and majestic sends
neither today. A proxy can add them without touching the daemon.

If that is done, two things change and both are larger than anything in this
document:

- **WebCodecs becomes available**, and on a client whose platform has HEVC that
  is *hardware* decode. It does not make this decoder faster; it makes it
  unnecessary on those machines, which is the better outcome.
- **pthreads become available**, which makes libde265's `frame-parallel` branch
  usable. Single-threaded 4K is ~49 ms/frame against a ~33 ms arrival interval,
  so threading is the only thing that could make 4K viable at all.

Nothing about the CDN choice blocks this: jsDelivr already serves
`access-control-allow-origin: *` and `cross-origin-resource-policy:
cross-origin`, so the module keeps loading under `require-corp`.

So the single-threaded, canvas-painting design here is the right answer for the
deployment almost everyone has, and the wrong answer for a deployment somebody
has deliberately hardened. Say which one you are describing.
