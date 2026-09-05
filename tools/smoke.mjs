// Decode smoke test for the SHIPPED artifact.
//
// Loads dist/de265.js — the exact file jsDelivr serves — decodes an H.265
// Annex-B bitstream and checks the decoder produces frames at the expected
// dimensions. So a broken emscripten build or a bad copy into dist/ fails CI
// here rather than on a camera.
//
//   node tools/smoke.mjs <file.h265> <expectedWidth> <expectedHeight>
import { readFileSync } from 'node:fs';
import createDe265 from '../dist/de265.js';

const [, , file, ewArg, ehArg] = process.argv;
if (!file) { console.error('usage: smoke.mjs <file.h265> <w> <h>'); process.exit(2); }
const ew = +ewArg, eh = +ehArg;

const buf = new Uint8Array(readFileSync(file));
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

const M = await createDe265();
const d = M._de_create(-1);
let decoded = 0, w = 0, h = 0;
for (const nal of nals) {
	const t = type(nal);
	const p = M._de_malloc(nal.length);
	M.HEAPU8.set(nal, p);
	M._de_push(d, p, nal.length);
	M._de_free(p);
	if (!isVcl(t)) continue;
	M._de_end_frame(d);
	let flags, guard = 0;
	do {
		flags = M._de_step(d, 1000);
		if (flags & 2) { if (!w) { w = M._de_width(d); h = M._de_height(d); } decoded++; M._de_release(d); }
		if (flags & 8) { console.error('FAIL decoder error on ' + file); process.exit(1); }
	} while ((flags & 1) && ++guard < 64);
}
M._de_destroy(d);

const okDims = !ew || (w === ew && h === eh);
const pass = decoded > 0 && okDims;
console.log(`${pass ? 'ok  ' : 'FAIL'} ${file}: decoded=${decoded} ${w}x${h}` +
	(ew ? ` (expected ${ew}x${eh})` : ''));
process.exit(pass ? 0 : 1);
