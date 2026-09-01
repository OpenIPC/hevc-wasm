// Does the worker actually need to yield inside an I-frame, or does a small
// presentation buffer absorb it?
//
// The decode times are real (tools/measure.mjs); what is simulated is only the
// arrival cadence -- frames land every 1000/fps ms -- and a jitter buffer of N
// frames before the first paint. `slow` scales every decode time to stand in
// for a weaker client than this desktop.
import { readFileSync } from 'node:fs';
import createDe265 from '../build/de265.mjs';

const file = process.argv[2];
const fps = +(process.env.FPS || 30);
const slow = +(process.env.SLOW || 1);
const buffer = +(process.env.BUFFER || 2);

const buf = new Uint8Array(readFileSync(file));
const nals = [];
for (let i = 0; i + 3 < buf.length; ) {
	if (!buf[i] && !buf[i+1] && !buf[i+2] && buf[i+3] === 1) {
		let j = i + 4;
		while (j + 3 < buf.length && !(!buf[j] && !buf[j+1] && !buf[j+2] && buf[j+3] === 1)) j++;
		nals.push(buf.subarray(i, j + 3 < buf.length ? j : buf.length));
		i = j;
	} else i++;
}
const M = await createDe265();
const d = M._de_create(-1);
const times = [];
for (const nal of nals) {
	const t = (nal[4] >> 1) & 0x3f;
	const p = M._de_malloc(nal.length);
	M.HEAPU8.set(nal, p); M._de_push(d, p, nal.length); M._de_free(p);
	if (t > 31) continue;
	M._de_end_frame(d);
	let flags, guard = 0;
	do {
		flags = M._de_step(d, 1e9);
		if (flags & 2) { times.push(M._de_last_step_ms(d) * slow); M._de_release(d); }
	} while ((flags & 1) && ++guard < 64);
}
M._de_destroy(d);

// Arrival every `iv` ms. Decode is serial. A frame is presented at
// max(arrival, decoder free) + decode, and is due at arrival + buffer*iv.
const iv = 1000 / fps;
let free = 0, late = 0, worstLate = 0, backlogPeak = 0;
for (let i = 0; i < times.length; i++) {
	const arrive = i * iv;
	const start = Math.max(arrive, free);
	free = start + times[i];
	const due = arrive + buffer * iv;
	const lateBy = free - due;
	if (lateBy > 0) { late++; worstLate = Math.max(worstLate, lateBy); }
	backlogPeak = Math.max(backlogPeak, (free - arrive) / iv);
}
console.log(JSON.stringify({
	file: file.split('/').pop(), fps, slowdown: slow + 'x', bufferFrames: buffer,
	frames: times.length,
	meanDecodeMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
	worstDecodeMs: +Math.max(...times).toFixed(1),
	framesPresentedLate: late,
	worstLatenessMs: +worstLate.toFixed(1),
	peakBacklogFrames: +backlogPeak.toFixed(1),
	verdict: late === 0 ? 'buffer absorbs it' : (backlogPeak > times.length / 4
		? 'permanent deficit — only dropping helps' : 'visible hitching'),
}));
