// The worker's FEED mode, under Node: a page that owns the transport posts
// the /ws/video messages in and reads what the worker would have sent out.
//
// No socket is opened, so this runs anywhere Node runs. The bitstream is an
// ffmpeg-made HEVC fMP4 with one fragment per frame and a closed GOP — the
// shape /ws/video sends — with a producer reference time put before every
// moof the way the camera does, so the lag path is exercised too. What is
// asserted: the feed acknowledgement with no socket; frames decoded and
// their lag measured; a `gap` holding decode until the next random access
// point; a keyframe request leaving as `send`, not a socket write; a
// `reset` followed by a new init decoding again.
//
//   node tools/feed-test.mjs <file.mp4>
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , file] = process.argv;
if (!file) { console.error('usage: feed-test.mjs <fragmented.mp4>'); process.exit(2); }

// The worker and its imports are ES modules in .js files; copy them to .mjs
// with absolute imports so Node loads them as ESM (see smoke.mjs).
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'feed-'));
for (const f of ['de265.js', 'demux.js', 'paint.js', 'decoder-worker.js']) {
	const dir = f === 'de265.js' ? fileURLToPath(new URL('../dist/', import.meta.url)) : srcDir;
	let text = readFileSync(dir + f, 'utf8');
	text = text.replace(/from '\.\/([a-z0-9_-]+)\.js'/g, (m, n) => "from '" + pathToFileURL(join(tmp, n + '.mjs')).href + "'");
	writeFileSync(join(tmp, f.replace(/\.js$/, '.mjs')), text);
}
copyFileSync(fileURLToPath(new URL('../dist/de265.wasm', import.meta.url)), join(tmp, 'de265.wasm'));

// What a worker expects of its environment: `self` with postMessage and an
// onmessage slot, and a canvas whose WebGL context accepts every call. The
// painter's calls all succeed and paint nothing; decode is what is tested.
const out = [];
const gl = new Proxy({}, {
	get(_, p) {
		if (p === 'canvas') return { width: 0, height: 0 };
		if (typeof p === 'string' && /^[A-Z0-9_]+$/.test(p)) return 1;
		return () => true;
	},
});
globalThis.self = {
	postMessage: (m) => out.push(m),
	onmessage: null,
};
await import(pathToFileURL(join(tmp, 'decoder-worker.mjs')).href);
const send = (m) => self.onmessage({ data: m });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (type) => { for (let i = out.length - 1; i >= 0; i--) if (out[i].type === type) return out[i]; return null; };
const count = (type) => out.filter((m) => m.type === type).length;
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

// ---- the bitstream, split the way the socket delivers it ----
const mp4 = new Uint8Array(readFileSync(file));
const be32 = (u8, i) => ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
const type = (u8, i) => String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
const boxes = [];
for (let at = 0; at + 8 <= mp4.length;) { const n = be32(mp4, at); if (n < 8) break; boxes.push({ t: type(mp4, at), a: at, b: at + n }); at += n; }
const moovEnd = boxes.find((b) => b.t === 'moov').b;
const init = mp4.subarray(0, moovEnd);
const frags = [];
for (let i = 0; i < boxes.length; i++) if (boxes[i].t === 'moof' && boxes[i + 1] && boxes[i + 1].t === 'mdat') frags.push(mp4.subarray(boxes[i].a, boxes[i + 1].b));
check(frags.length >= 20, 'fixture: ' + frags.length + ' fragments, init ' + init.length + ' bytes');

// The camera's producer reference time, made up: capture 120 ms ago.
function withPrft(frag, ageMs) {
	const box = new Uint8Array(32);
	const dv = new DataView(box.buffer);
	dv.setUint32(0, 32); box.set([0x70, 0x72, 0x66, 0x74], 4); box[8] = 1; dv.setUint32(12, 1);
	const wall = Date.now() - ageMs;
	dv.setUint32(16, Math.floor(wall / 1000) + 2208988800);
	dv.setUint32(20, Math.floor((wall % 1000) / 1000 * 4294967296));
	dv.setBigUint64(24, 0n);
	const o = new Uint8Array(32 + frag.length); o.set(box, 0); o.set(frag, 32);
	return o;
}
const isRapFrag = (frag) => {
	// One length-prefixed NAL per AU is not guaranteed for ffmpeg output;
	// look at every NAL in the mdat.
	let at = 0; while (at + 8 <= frag.length) { const n = be32(frag, at); if (type(frag, at) === 'mdat') { let p = at + 8; while (p + 4 < at + n) { const l = be32(frag, p); const t = (frag[p + 4] >> 1) & 0x3f; if (t >= 16 && t <= 21) return true; p += 4 + l; } return false; } at += n; }
	return false;
};

// ---- 1. feed mode acknowledges, opens no socket ----
globalThis.WebSocket = function () { throw new Error('a socket was opened in feed mode'); };
send({ type: 'start', feed: true, url: 'ws://camera/ws/video?stream=0', canvas: { getContext: () => gl } });
for (let i = 0; i < 100 && !last('feed'); i++) await sleep(20);
check(last('feed') && last('feed').ok && last('feed').protocol === 1, 'feed acknowledged with protocol 1, no socket');

// ---- 2. init + frames decode, lag measured ----
send({ type: 'msg', data: JSON.stringify({ type: 'init', codec: 'h265', codecString: 'hvc1.1.6.L93.B0', width: 1280, height: 720 }) });
send({ type: 'msg', data: init, kind: 2 });
const N = Math.min(frags.length, 24);
for (let i = 0; i < N; i++) send({ type: 'msg', data: withPrft(frags[i], 120), kind: 3 });
for (let i = 0; i < 200; i++) { send({ type: 'stats' }); if ((last('stats').stats.frames | 0) >= N - 4) break; await sleep(25); }
let st = last('stats').stats;
check(st.frames >= N - 4, 'decoded ' + st.frames + ' of ' + N + ' frames');
check(st.prft === true && st.lag && st.lag.n > 0, 'lag measured from prft: n=' + (st.lag && st.lag.n));
check(st.lag && st.lag.p50 >= 100 && st.lag.p50 < 5000, 'lag p50 ' + (st.lag && st.lag.p50) + ' ms is the synthetic 120 ms plus decode');
check(count('state') > 0 && last('state').state === 'playing', 'state playing');

// ---- 3. a gap holds decode until the next random access point ----
send({ type: 'gap' });
send({ type: 'stats' });
check(last('stats').stats.awaitingRap === true && last('stats').stats.gaps === 1, 'gap: awaiting a RAP');
const before = last('stats').stats.frames;
let fed = 0, sawRap = false;
for (let i = N; i < frags.length; i++) {
	const rap = isRapFrag(frags[i]);
	if (!sawRap && rap) sawRap = true;
	send({ type: 'msg', data: withPrft(frags[i], 100), kind: 3 });
	fed++;
	if (sawRap && fed > 8) break;
}
for (let i = 0; i < 200; i++) { send({ type: 'stats' }); if (last('stats').stats.frames > before) break; await sleep(25); }
st = last('stats').stats;
check(sawRap, 'the fixture had a random access point after the gap');
check(st.awaitingRap === false && st.frames > before, 'resumed at the RAP: ' + (st.frames - before) + ' more frames, ' + st.dropped + ' dropped');

// ---- 4. a keyframe request leaves as `send`, not a socket write ----
send({ type: 'idr' });
check(last('send') && /"idr"/.test(last('send').text), 'idr request posted as send');

// ---- 5. reset, then a new init decodes again ----
send({ type: 'reset' });
send({ type: 'stats' });
const framesAtReset = last('stats').stats.frames;
send({ type: 'msg', data: init, kind: 2 });
for (let i = 0; i < 12; i++) send({ type: 'msg', data: withPrft(frags[i], 50), kind: 3 });
for (let i = 0; i < 200; i++) { send({ type: 'stats' }); if (last('stats').stats.frames > framesAtReset + 4) break; await sleep(25); }
check(last('stats').stats.frames > framesAtReset + 4, 'after reset + new init: ' + (last('stats').stats.frames - framesAtReset) + ' frames');

// ---- 6. a frame before any init is dropped, not decoded ----
send({ type: 'reset' });
send({ type: 'msg', data: withPrft(frags[0], 50), kind: 3 });
send({ type: 'stats' });
check(last('stats').stats.noInit >= 1, 'a frame before an init is counted, not decoded');

send({ type: 'destroy' });
console.log(failed ? 'FEED TEST FAILED (' + failed + ')' : 'FEED TEST PASSED');
process.exit(failed ? 1 : 0);
