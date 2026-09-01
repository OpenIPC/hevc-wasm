/* The C side of the module: a RESUMABLE decode step, never a decode_frame().
 *
 * libde265 already works this way -- de265_decode() advances "some" and tells
 * you whether to call it again -- so the whole wrapper is about exposing that
 * honestly to JS along with a clock, rather than hiding it behind a
 * decode-this-frame call that blocks for as long as the frame takes.
 *
 * The budget is advisory: a step is only interruptible where libde265 has a
 * yield point, and on majestic's single-slice pictures that is once per
 * picture. de_step() therefore reports how long it actually took, so the caller
 * can tell "I stayed inside the budget" from "one indivisible unit of work
 * overran it by 4x".
 */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <libde265/de265.h>

typedef struct {
    de265_decoder_context *ctx;
    const struct de265_image *img;
    double last_step_ms;
    int pictures;
    double decode_ms_total;
} Dec;

/* de_step() result bits. */
#define STEP_MORE    1  /* de265_decode wants calling again */
#define STEP_PICTURE 2  /* a picture is waiting in takePicture */
#define STEP_BUDGET  4  /* returned because the budget ran out, not because
                         * the work finished -- the caller yielded early */
#define STEP_ERROR   8

/* accel: de265_acceleration, or -1 for the library default (AUTO). Exposed
 * because the fork's WASM SIMD path is from 2021 and has to be proven against
 * a current emscripten before it can be trusted -- see tools/measure.mjs. */
EMSCRIPTEN_KEEPALIVE Dec *de_create(int accel) {
    Dec *d = calloc(1, sizeof(Dec));
    if (!d) return 0;
    d->ctx = de265_new_decoder();
    if (!d->ctx) { free(d); return 0; }
    if (accel >= 0)
        de265_set_parameter_int(d->ctx, DE265_DECODER_PARAM_ACCELERATION_CODE, accel);
    /* Single-threaded on purpose: pthreads need SharedArrayBuffer, which needs
     * cross-origin isolation, which needs HTTPS. The camera is plain HTTP. */
    return d;
}

EMSCRIPTEN_KEEPALIVE int de_push(Dec *d, const uint8_t *data, int len) {
    return de265_push_data(d->ctx, data, len, 0, 0);
}

/* Without this a picture is not emitted until the NEXT access unit's first NAL
 * arrives -- one free frame of latency on a feature sold on latency. One
 * WebSocket message is exactly one AU, so the caller can always say so. */
EMSCRIPTEN_KEEPALIVE void de_end_frame(Dec *d) {
    de265_push_end_of_frame(d->ctx);
}

EMSCRIPTEN_KEEPALIVE int de_step(Dec *d, double budget_ms) {
    double t0 = emscripten_get_now();
    int flags = 0;
    for (;;) {
        int more = 0;
        de265_error err = de265_decode(d->ctx, &more);

        if (err != DE265_OK && err != DE265_ERROR_WAITING_FOR_INPUT_DATA &&
            err != DE265_ERROR_IMAGE_BUFFER_FULL) {
            flags |= STEP_ERROR;
            break;
        }
        /* Drain warnings or they accumulate inside the decoder. */
        while (de265_get_warning(d->ctx) != DE265_OK) {}

        const struct de265_image *img = de265_get_next_picture(d->ctx);
        if (img) { d->img = img; d->pictures++; flags |= STEP_PICTURE; }

        if (!more) break;
        if (flags & STEP_PICTURE) { flags |= STEP_MORE; break; }
        if (emscripten_get_now() - t0 >= budget_ms) {
            flags |= STEP_MORE | STEP_BUDGET;
            break;
        }
    }
    d->last_step_ms = emscripten_get_now() - t0;
    d->decode_ms_total += d->last_step_ms;
    return flags;
}

EMSCRIPTEN_KEEPALIVE double de_last_step_ms(Dec *d) { return d->last_step_ms; }
EMSCRIPTEN_KEEPALIVE int    de_pictures(Dec *d)     { return d->pictures; }
EMSCRIPTEN_KEEPALIVE double de_decode_ms(Dec *d)    { return d->decode_ms_total; }

EMSCRIPTEN_KEEPALIVE int de_width(Dec *d)  { return d->img ? de265_get_image_width(d->img, 0) : 0; }
EMSCRIPTEN_KEEPALIVE int de_height(Dec *d) { return d->img ? de265_get_image_height(d->img, 0) : 0; }

/* Planes stay in the decoder's own memory: the caller uploads straight from
 * the heap (texSubImage2D) rather than copying out. Valid until release. */
EMSCRIPTEN_KEEPALIVE const uint8_t *de_plane(Dec *d, int c, int *stride) {
    if (!d->img) return 0;
    return (const uint8_t *)de265_get_image_plane(d->img, c, stride);
}

EMSCRIPTEN_KEEPALIVE void de_release(Dec *d) {
    if (d->img) { de265_release_next_picture(d->ctx); d->img = 0; }
}

/* Mandatory after dropping to a random-access point: without it the DPB holds
 * references for pictures that will never arrive, and the decoder paints
 * garbage rather than reporting anything. */
EMSCRIPTEN_KEEPALIVE void de_reset(Dec *d) {
    de_release(d);
    de265_reset(d->ctx);
}

EMSCRIPTEN_KEEPALIVE void de_destroy(Dec *d) {
    if (!d) return;
    de_release(d);
    de265_free_decoder(d->ctx);
    free(d);
}

EMSCRIPTEN_KEEPALIVE void *de_malloc(int n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void  de_free(void *p) { free(p); }
