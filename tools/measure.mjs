// Stage 1's question, and the only one that matters yet: how long does ONE
// resumable step take on real majestic output, and how bad is the worst one?
//
// Both numbers, not one. The mean decides whether a client can keep up at all;
// the worst case decides whether a budgeted pump can hold a frame cadence, or
// whether an I-frame is one indivisible lump that blows through any budget it
// is given.
import { readFileSync } from 'node:fs';
import createDe265 from '../build/de265.mjs';

const file = process.argv[2];
const buf = new Uint8Array(readFileSync(file));

// Split Annex-B into NALs.
const nals = [];
for (let i = 0; i + 3 < buf.length; ) {
	if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
		let j = i + 4;
		while (j + 3 < buf.length &&
			!(buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 0 && buf[j + 3] === 1)) j++;
		nals.push(buf.subarray(i, j + 3 < buf.length ? j : buf.length));
		i = j;
	} else i++;
}
const type = (n) => (n[4] >> 1) & 0x3f;
const isVcl = (t) => t <= 31;
const isRap = (t) => t >= 16 && t <= 21;

const M = await createDe265();
const d = M._de_create(+(process.env.ACCEL ?? -1));
const steps = [];
let pushed = 0;

for (const nal of nals) {
	const t = type(nal);
	const p = M._de_malloc(nal.length);
	M.HEAPU8.set(nal, p);
	M._de_push(d, p, nal.length);
	M._de_free(p);
	if (!isVcl(t)) continue;          // VPS/SPS/PPS: no picture to wait for
	M._de_end_frame(d);               // one AU per picture on this wire format
	pushed++;

	// Budget deliberately set to one 60 Hz frame: the question is how often a
	// single step overruns it, not whether we can make it not overrun.
	let flags, guard = 0;
	do {
		flags = M._de_step(d, 16.7);
		const ms = M._de_last_step_ms(d);
		if (flags & 2) { steps.push({ ms, rap: isRap(t), bytes: nal.length }); M._de_release(d); }
	} while ((flags & 1) && !(flags & 8) && ++guard < 64);
}

const all = steps.map((s) => s.ms);
const rap = steps.filter((s) => s.rap).map((s) => s.ms);
const inter = steps.filter((s) => !s.rap).map((s) => s.ms);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (a, p) => {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
console.log(JSON.stringify({
	file: file.split('/').pop(),
	w: M._de_width(d), h: M._de_height(d),
	pushed, decoded: steps.length,
	meanMs: +mean(all).toFixed(2),
	p95Ms: +pct(all, 0.95).toFixed(2),
	worstMs: +Math.max(...all).toFixed(2),
	meanInterMs: +mean(inter).toFixed(2),
	meanRapMs: +mean(rap).toFixed(2),
	worstRapMs: rap.length ? +Math.max(...rap).toFixed(2) : 0,
	// The plan's actual decision point.
	stepsOver16_7ms: all.filter((m) => m > 16.7).length,
	sustainableFps: +(1000 / mean(all)).toFixed(1),
}));
M._de_destroy(d);
