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
import { parseHvcC, parsePrft, fragmentNals, toAnnexB, nalType, isRap } from './demux.js';

let M = null, dec = null, ws = null, paint = null, gl = null;
let lengthSize = 4, started = false, closed = false;
let queue = [];             // access units waiting to be decoded
let queueBytes = 0;

// FEED MODE. The page can own the transport instead of this worker: it sends
// `start` with `feed: true`, gets `feed` back, and then posts every message
// the transport delivers as `msg` — the /ws/video text and binary frames,
// verbatim — and receives `send` for what this worker would have written to
// the socket (a keyframe request). Nothing is opened here in that mode and
// the reconnect ladder is idle; a `gap` says the feed lost frames (the page
// heard so from the camera, or saw a hole itself), `reset` that the feed was
// replaced (a channel change), and `open` hands the transport back to this
// worker with a URL, from which point everything behaves as before. A page
// that never sends `feed` sees no difference at all.
//
// Why a feed exists: an RTCDataChannel cannot be created in, or transferred
// into, a worker, and it is the transport that lets the same bytes arrive
// with a lost packet costing one frame rather than a growing delay.
let feed = false;
// The init segment seen so far — hoisted from the socket handler so a feed
// can replace it, and so a frame that arrives before any init is dropped
// rather than handed to a decoder with no parameter sets.
let init = null;
// After a gap: nothing until the next random access point.
let awaitRap = false;
// Capture-to-paint lag, from the camera's producer reference time (prft)
// when it sends one: the wall-clock capture instant of each decoded picture
// is kept in arrival order and read out when the picture is painted. Both
// clocks are this machine's for the paint half only, so the spread is exact
// and the absolute figure carries the camera's clock offset.
const pendingWall = [];
let lagMs = [];
const LAG_KEEP = 240;

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
	gaps: 0, noInit: 0, prft: false,
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

// The feed lost frames, or the stream was replaced: throw the queue away,
// reset the decoder, and decode nothing until a random access point.
function flushToRap() {
	stats.dropped += queue.length;
	queue = []; queueBytes = 0;
	pendingWall.length = 0;
	if (dec) M._de_reset(dec);
	awaitRap = true;
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
	const text = JSON.stringify({ request: 'idr' });
	if (feed) {
		post('send', { text });
		stats.idrRequests++;
	} else if (ws && ws.readyState === 1) {
		ws.send(text);
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
			// Pictures come out in the order they went in — a camera stream
			// has no reordering — so the oldest capture time still pending is
			// this picture's.
			if (pendingWall.length) {
				const wall = pendingWall.shift();
				if (wall) {
					lagMs.push(Date.now() - wall);
					if (lagMs.length > LAG_KEEP) lagMs.shift();
				}
			}
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
		pendingWall.push(au.wallMs || 0);
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

	if (opts.feed) {
		feed = true;
		wsUrl = opts.url || '';
		post('feed', { ok: true, protocol: 1 });
	} else {
		openSocket(opts.url);
	}
	pump();
}

// One text message from the transport: the camera's `init` line.
function onText(text) {
	let info; try { info = JSON.parse(text); } catch (_) { return false; }
	if (!info || info.type !== 'init') return false;
	// A channel switch can change the CODEC, not just the size: a camera
	// commonly runs H.265 on the main channel and H.264 on the sub. This
	// decoder only speaks H.265, so the honest move is to stand down and let
	// the chain run again — MSE will take an H.264 substream natively, which
	// is a better answer than this rung quietly feeding H.264 to an H.265
	// decoder.
	if (info.codec && !/^h265$|^hevc$/i.test(info.codec)) {
		fail('codec-changed ' + info.codec);
		return false;
	}
	post('info', { info });
	return true;
}

// One binary message: the init segment, or a fragment. `isInit` is what a
// feed says outright; a socket says nothing, and there the first binary
// message is the init. Returns true when the init just landed.
function onBinary(u8, isInit) {
	stats.bytes += u8.length;
	if (isInit || !init) {
		if (!isInit && init) return false;
		// The parameter sets live in the moov's hvcC and never appear in a
		// fragment, so a decoder fed only fragments has no SPS and refuses
		// every slice it is given.
		init = u8;
		const hv = parseHvcC(u8);
		if (!hv) { fail('demux-failed'); return false; }
		lengthSize = hv.lengthSize;
		pushAndDecode(toAnnexB(hv.sets));
		return true;
	}
	let wallMs = 0;
	let frag = u8;
	const pr = parsePrft(u8);
	if (pr) { wallMs = pr.wallMs; frag = u8.subarray(pr.next); stats.prft = true; }
	const nals = fragmentNals(frag, lengthSize);
	if (!nals.length) return false;
	const rap = nals.some((n) => isRap(nalType(n)));
	if (awaitRap) {
		// Only a random access point restarts the picture after a gap;
		// anything else references frames that never arrived.
		if (!rap) { stats.dropped++; return false; }
		awaitRap = false;
	}
	const bytes = toAnnexB(nals);
	noteArrival();
	queue.push({ bytes, rap, wallMs });
	queueBytes += bytes.length;
	if (queueBytes > MAX_QUEUE_BYTES || queuedMs() > MAX_LATENCY_MS) dropToRap();
	return false;
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
	init = null;
	pendingWall.length = 0;

	ws.onmessage = (e) => {
		if (typeof e.data === 'string') { onText(e.data); return; }
		if (onBinary(new Uint8Array(e.data), false)) {
			// A reconnect that reached its init is a working socket again, so
			// the next drop starts a fresh ladder rather than counting toward an
			// `unreachable` that has already been recovered from.
			reconnectTries = 0;
			reconnectBackoff = RECONNECT_BASE_MS;
		}
	};
	// A drop, not an ending: retry rather than fall to MJPEG. Fenced by the
	// epoch so a close event from a socket we have already replaced (a channel
	// change landed between this open and this close) cannot start a reconnect
	// on top of the live one. onerror is followed by onclose, so let onclose be
	// the single place that schedules.
	ws.onclose = () => { if (!closed && myEpoch === sockEpoch) scheduleReconnect(); };
	ws.onerror = () => {};
}

// The lag samples, summarised: count, median, 95th percentile and maximum
// of the capture-to-paint times seen since the last report was taken.
function lagSummary() {
	if (!lagMs.length) return { n: 0 };
	const s = [...lagMs].sort((a, b) => a - b);
	const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === 'start') start(m);
	else if (m.type === 'idr') requestIdr();
	else if (m.type === 'msg') {
		// The feed's delivery: a text frame is the init line, a binary one
		// the init segment (`kind` 2, said outright) or a fragment.
		if (!feed || closed) return;
		if (typeof m.data === 'string') { onText(m.data); return; }
		const u8 = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
		if (!init && m.kind !== 2 && m.kind !== undefined) { stats.noInit++; return; }
		onBinary(u8, m.kind === 2);
	}
	else if (m.type === 'gap') {
		// The feed lost frames: the page heard so from the camera, or saw a
		// hole in its own sequence. The camera asks its own encoder for the
		// keyframe when it flagged the gap; a page that found the hole itself
		// asks through `idr` — not from here, which would double the request.
		if (feed) { flushToRap(); stats.gaps++; }
	}
	else if (m.type === 'reset') {
		// The feed was replaced (a channel change): the next init is a new
		// stream's, and nothing from the old one may reach the decoder.
		if (feed) { init = null; flushToRap(); awaitRap = false; lagMs = []; }
	}
	else if (m.type === 'open') {
		// The page hands the transport back: from here the socket, its
		// ladder and everything else behave as without a feed.
		feed = false;
		init = null;
		openSocket(m.url || wsUrl);
	}
	else if (m.type === 'setStream') {
		if (feed) { init = null; flushToRap(); awaitRap = false; return; }
		openSocket(wsUrl.replace(/stream=\d+/, 'stream=' + (m.stream | 0)));
	}
	else if (m.type === 'stats') {
		const lag = lagSummary();
		const samples = lagMs;
		lagMs = [];
		post('stats', { stats: Object.assign({}, stats, {
			queuedBytes: queueBytes, queuedFrames: queue.length,
			// What the page needs to decide whether to warn: how far behind the
			// camera this client is, and how much of the interval decode eats.
			queuedMs: Math.round(queuedMs()),
			sourceIntervalMs: intervalMs(),
			feed, awaitingRap: awaitRap,
			// Capture-to-paint, when the camera stamps its fragments: the
			// summary and the raw samples since the last report, so a page
			// or a harness can compute its own percentiles over a window.
			lag, lagMs: samples,
		}) });
	}
	else if (m.type === 'destroy') {
		closed = true;
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		try { ws && ws.close(); } catch (err) {}
		if (dec) { M._de_destroy(dec); dec = null; }
	}
};
