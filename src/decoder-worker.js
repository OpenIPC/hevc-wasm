// Everything that touches a frame runs here: the WebSocket, the fMP4 demux, the
// decoder and the canvas. The main thread sends four messages and receives
// state and stats — never a frame.
//
// WHY THE WORKER OWNS ALL OF IT, since the obvious design is to demux on the
// main thread and post access units in: that arrangement maximises boundary
// traffic (every AU in, every frame out) and puts decode on the wrong side of
// a postMessage from the canvas. With transferControlToOffscreen the worker
// holds the WebGL context, so a decoded picture goes from the wasm heap to
// texSubImage2D without crossing a thread at all.
//
// It also fixes a failure the main thread cannot: requestAnimationFrame is
// throttled to ~1 Hz in a hidden tab and stops outright in some. A pump driven
// from there stops decoding while the socket keeps delivering, and the backlog
// is unbounded. Here nothing is tied to the display clock.
import createDe265 from './de265.js';
import { makePainter } from './paint.js';
import { parseHvcC, fragmentNals, toAnnexB, nalType, isRap } from './demux.js';

let M = null, dec = null, ws = null, paint = null, gl = null;
let lengthSize = 4, started = false, closed = false;
let queue = [];             // access units waiting to be decoded
let queueBytes = 0;

// Reconnect ladder, mirroring the MSE player (preview.js) exactly, because the
// two rungs carry the same /ws/video bytes and a socket drop is no more fatal
// to one than to the other. Without it a single dropped socket ended this rung
// for good: the page's fallback chain reads one `unreachable` as "software
// decode gave up" and falls to MJPEG with no way back, so a transient blip —
// the camera's own reload, a lost packet on a remote link, majestic's
// data-frame-after-close race on a rapid channel reopen — stranded a working
// H.265 preview on MJPEG until the tab was reloaded (majestic-webui#288). So a
// socket that drops mid-session is retried here, up to six times with the same
// 1→2→4→8 s backoff the MSE player uses, and `unreachable` is reported only
// once the ladder is spent. A DELIBERATE reopen (a channel change, the first
// open) is not a failure and resets the ladder; a working reconnect (its init
// arrives) resets it too. `sockEpoch` fences a stale socket's late close event
// so it cannot start a reconnect after we have already moved on — the same
// hazard preview.js's `discard()` guards, one socket per generation.
const MAX_RECONNECTS = 6;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;
let sockEpoch = 0;
let reconnectTries = 0;
let reconnectBackoff = RECONNECT_BASE_MS;
let reconnectTimer = null;
const stats = {
	frames: 0, dropped: 0, gopDrops: 0, decodeMs: 0, bytes: 0,
	lastDecodeMs: 0, width: 0, height: 0, idrRequests: 0,
};

// TWO BOUNDS, because they answer different questions and each one alone lets
// the other run away.
//
// Bytes, because access-unit sizes vary ~50x (a 4K IDR is 190 KB against a
// 4 KB inter frame) so a frame count says nothing about memory.
//
// And TIME, because bytes say nothing about delay -- which is the bound that
// actually matters for a live preview, and the one whose absence showed up the
// first time this ran against 4K: 121 frames queued, comfortably inside a 4 MiB
// byte bound, and four to six seconds behind the camera. A preview that is six
// seconds late is not a preview.
//
// THE QUEUE IS THE BUFFER. There is no separate presentation buffer and there
// should not be: what absorbs a late I-frame is decode running ahead of
// display, which is exactly what queued access units are. Holding decoded
// frames back instead would need either a second texture set or 3.1 MB of
// memcpy per 1080p frame, and would add latency to the one feature whose whole
// pitch is that it is a real video path.
const MAX_QUEUE_BYTES = 4 << 20;
const MAX_LATENCY_MS = 500;
// Long enough to outlast a GOP, so the natural random access point wins the
// race whenever the stream has one coming.
const IDR_MIN_GAP_MS = 3000;
let lastIdrAt = 0;

const post = (type, data) => self.postMessage(Object.assign({ type }, data));

// The source interval, measured rather than configured: nothing tells this
// worker what videoN.fps says, and a camera does not always deliver what it is
// configured for anyway. Median of the last few gaps, so one late arrival does
// not move it.
let lastArrival = 0;
const gaps = [];
function noteArrival() {
	const now = Date.now();
	if (lastArrival) {
		gaps.push(now - lastArrival);
		if (gaps.length > 32) gaps.shift();
	}
	lastArrival = now;
}
function intervalMs() {
	if (gaps.length < 4) return 0;
	const s = [...gaps].sort((a, b) => a - b);
	return s[s.length >> 1];
}
function queuedMs() {
	const iv = intervalMs();
	return iv ? queue.length * iv : 0;
}

function fail(reason) {
	if (closed) return;
	closed = true;
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
	post('state', { state: 'mjpeg', detail: reason });
	try { ws && ws.close(); } catch (e) {}
}

// Arbitrary NALs cannot be dropped from HEVC and still decode, so the only
// clean unit is a whole GOP: throw everything away up to the newest random
// access point and reset the decoder, or the DPB keeps references for pictures
// that will never arrive and paints garbage rather than reporting anything.
function dropToRap() {
	let cut = -1;
	for (let i = queue.length - 1; i >= 0; i--) if (queue[i].rap) { cut = i; break; }
	if (cut <= 0) {
		// No random access point in hand, so nothing queued can start a decode
		// and the queue is worthless either way.
		//
		// Asking the camera for a fresh IDR is the obvious move and it is a
		// TRAP on a client that is simply too slow: measured against 4K, this
		// path fired 32 times in 30 seconds. Each request costs the camera an
		// extra I-frame, an I-frame is the most expensive thing this decoder
		// will ever be handed, and decoding it puts the client further behind
		// -- which triggers the next drop, which asks again. A feedback loop
		// that spends the camera's encoder to make the client slower.
		//
		// So the request is rate limited, and between requests we simply wait
		// for the next natural random access point. At a ~0.6 s GOP that is a
		// cheaper wait than the IDR would have been.
		stats.dropped += queue.length;
		queue = []; queueBytes = 0;
		const now = Date.now();
		if (now - lastIdrAt > IDR_MIN_GAP_MS) { lastIdrAt = now; requestIdr(); }
		return;
	}
	stats.dropped += cut;
	queue = queue.slice(cut);
	queueBytes = queue.reduce((n, a) => n + a.bytes.length, 0);
	stats.gopDrops++;
	M._de_reset(dec);
}

function requestIdr() {
	if (ws && ws.readyState === 1) {
		ws.send(JSON.stringify({ request: 'idr' }));
		stats.idrRequests++;
	}
}

function pushAndDecode(au) {
	const p = M._de_malloc(au.length);
	M.HEAPU8.set(au, p);
	M._de_push(dec, p, au.length);
	M._de_free(p);
	// One WebSocket message is exactly one access unit, so say so: without it
	// no picture emerges until the NEXT frame's first NAL arrives, which is a
	// whole frame of latency given away for nothing.
	M._de_end_frame(dec);

	let flags, guard = 0;
	do {
		// The budget is not a frame budget — nothing here shares a thread with a
		// compositor. It bounds how long this loop can go without returning to
		// the event loop, so `destroy` and `setStream` are seen promptly rather
		// than after a 4K IDR.
		flags = M._de_step(dec, 50);
		stats.lastDecodeMs = M._de_last_step_ms(dec);
		stats.decodeMs += stats.lastDecodeMs;
		if (flags & 2) {
			drawCurrent();
			M._de_release(dec);
			stats.frames++;
		}
		if (flags & 8) { fail('decoder-error'); return; }
	} while ((flags & 1) && ++guard < 64);
}

function drawCurrent() {
	const w = M._de_width(dec), h = M._de_height(dec);
	if (!w || !h) return;
	if (w !== stats.width || h !== stats.height) {
		stats.width = w; stats.height = h;
		post('codec', { codec: 'h265', width: w, height: h });
	}
	const sp = M._de_malloc(4);
	const planes = [0, 1, 2].map((c) => {
		const ptr = M._de_plane(dec, c, sp);
		const stride = M.getValue(sp, 'i32');
		const pw = c ? (w + 1) >> 1 : w;
		const ph = c ? (h + 1) >> 1 : h;
		return { data: M.HEAPU8.subarray(ptr, ptr + stride * ph), stride, w: pw, h: ph };
	});
	M._de_free(sp);
	paint(planes, w, h);
}

// Free-running: decode whatever is queued, yielding to the event loop between
// access units so messages are seen. Not paced by any display clock.
function pump() {
	if (closed) return;
	if (queue.length) {
		const au = queue.shift();
		queueBytes -= au.bytes.length;
		pushAndDecode(au.bytes);
		if (!started) { started = true; post('state', { state: 'playing' }); }
	}
	setTimeout(pump, queue.length ? 0 : 8);
}

async function start(opts) {
	try {
		M = await createDe265();
	} catch (e) {
		return fail('decoder-unavailable');
	}
	dec = M._de_create(-1);
	if (!dec) return fail('decoder-unavailable');

	gl = opts.canvas.getContext('webgl', {
		alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false,
	});
	if (!gl) return fail('no-webgl');
	paint = makePainter(gl);

	openSocket(opts.url);
	pump();
}

// A socket dropped mid-session: retry, or give up once the ladder is spent.
// `reconnect` is true when this drop is the ladder itself firing, so the first
// unprompted failure schedules from a fresh backoff rather than inheriting a
// stale one. Deliberate reopens (channel change, first open) never come here.
function scheduleReconnect() {
	if (closed || reconnectTimer) return;
	if (++reconnectTries > MAX_RECONNECTS) { fail('unreachable'); return; }
	const wait = reconnectBackoff;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		reconnectBackoff = Math.min(reconnectBackoff * 2, RECONNECT_MAX_MS);
		openSocket(wsUrl, true);
	}, wait);
}

// The socket lives here, so a channel change is reopened here too rather than
// costing the page a whole new player -- and the decoder is reset with it,
// because the parameter sets of the channel being left do not describe the one
// being joined.
//
// `reconnect` distinguishes the ladder firing from a deliberate (re)open. A
// deliberate open is a fresh start: cancel any pending retry and reset the
// ladder, because the person changed channel or the session is only now
// beginning, and neither is a failure to count against `unreachable`.
let wsUrl = '';
function openSocket(url, reconnect) {
	wsUrl = url;
	if (!reconnect) {
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		reconnectTries = 0;
		reconnectBackoff = RECONNECT_BASE_MS;
	}
	const myEpoch = ++sockEpoch;
	if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) {} }
	queue = []; queueBytes = 0;
	if (dec) M._de_reset(dec);
	ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	let init = null;

	ws.onmessage = (e) => {
		if (typeof e.data === 'string') {
			let info; try { info = JSON.parse(e.data); } catch (_) { return; }
			if (!info || info.type !== 'init') return;
			// A channel switch can change the CODEC, not just the size: a
			// camera commonly runs H.265 on the main channel and H.264 on the
			// sub. This decoder only speaks H.265, so the honest move is to
			// stand down and let the chain run again — MSE will take an H.264
			// substream natively, which is a better answer than this rung
			// quietly feeding H.264 to an H.265 decoder.
			if (info.codec && !/^h265$|^hevc$/i.test(info.codec)) {
				return fail('codec-changed ' + info.codec);
			}
			post('info', { info });
			return;
		}
		const u8 = new Uint8Array(e.data);
		stats.bytes += u8.length;
		if (!init) {
			// The parameter sets live in the moov's hvcC and never appear in a
			// fragment, so a decoder fed only fragments has no SPS and refuses
			// every slice it is given.
			init = u8;
			// A reconnect that reached its init is a working socket again, so
			// the next drop starts a fresh ladder rather than counting toward an
			// `unreachable` that has already been recovered from.
			reconnectTries = 0;
			reconnectBackoff = RECONNECT_BASE_MS;
			const hv = parseHvcC(u8);
			if (!hv) return fail('demux-failed');
			lengthSize = hv.lengthSize;
			pushAndDecode(toAnnexB(hv.sets));
			return;
		}
		const nals = fragmentNals(u8, lengthSize);
		if (!nals.length) return;
		const bytes = toAnnexB(nals);
		noteArrival();
		queue.push({ bytes, rap: nals.some((n) => isRap(nalType(n))) });
		queueBytes += bytes.length;
		if (queueBytes > MAX_QUEUE_BYTES || queuedMs() > MAX_LATENCY_MS) dropToRap();
	};
	// A drop, not an ending: retry rather than fall to MJPEG. Fenced by the
	// epoch so a close event from a socket we have already replaced (a channel
	// change landed between this open and this close) cannot start a reconnect
	// on top of the live one. onerror is followed by onclose, so let onclose be
	// the single place that schedules.
	ws.onclose = () => { if (!closed && myEpoch === sockEpoch) scheduleReconnect(); };
	ws.onerror = () => {};
}

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === 'start') start(m);
	else if (m.type === 'idr') requestIdr();
	else if (m.type === 'setStream') {
		openSocket(wsUrl.replace(/stream=\d+/, 'stream=' + (m.stream | 0)));
	}
	else if (m.type === 'stats') post('stats', { stats: Object.assign({}, stats, {
		queuedBytes: queueBytes, queuedFrames: queue.length,
		// What the page needs to decide whether to warn: how far behind the
		// camera this client is, and how much of the interval decode eats.
		queuedMs: Math.round(queuedMs()),
		sourceIntervalMs: intervalMs(),
	}) });
	else if (m.type === 'destroy') {
		closed = true;
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		try { ws && ws.close(); } catch (err) {}
		if (dec) { M._de_destroy(dec); dec = null; }
	}
};
