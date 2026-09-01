// Pull real bitstreams off a camera's /ws/video and write Annex-B fixtures.
//
// Fixtures have to come from majestic itself rather than from x265: the whole
// point of the measurement is what THIS encoder emits — GOP shape, slice count
// per picture, IDR size — and those are exactly what a synthetic clip gets
// wrong.
import { writeFileSync } from 'node:fs';
import { parseHvcC, fragmentNals, toAnnexB, nalType, isRap } from './demux-fmp4.mjs';

const HOST = process.env.CAM || 'openipc-hi3516av300.dlab.torturelabs.com';
const PW = process.env.PW || '123456';
const STREAM = process.env.STREAM || '0';
const WANT = +(process.env.FRAMES || 120);
const OUT = process.env.OUT || '/home/ai/git/hevc-wasm/fixtures/cam.h265';

const auth = 'Basic ' + Buffer.from('root:' + PW).toString('base64');
const ws = new WebSocket(`ws://${HOST}/ws/video?stream=${STREAM}`, {
	headers: { Authorization: auth },
});
ws.binaryType = 'arraybuffer';

let init = null, info = null;
const aus = [];
const sizes = [];

const done = () => {
	if (!init || !info) { console.error('no init'); process.exit(1); }
	const { lengthSize, sets } = parseHvcC(init);
	// Parameter sets first, once: they live in hvcC and never in a fragment,
	// so a decoder fed only the fragments has no SPS and refuses everything.
	const parts = [toAnnexB(sets)];
	for (const au of aus) parts.push(toAnnexB(fragmentNals(au, lengthSize)));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	writeFileSync(OUT, out);

	const raps = sizes.filter((s) => s.rap);
	console.log(JSON.stringify({
		codec: info.codec, size: info.width + 'x' + info.height,
		lengthSize, paramSets: sets.length,
		frames: aus.length, bytes: total,
		rapCount: raps.length,
		meanAuBytes: Math.round(sizes.reduce((n, s) => n + s.n, 0) / sizes.length),
		maxRapBytes: raps.length ? Math.max(...raps.map((s) => s.n)) : 0,
		// The number the plan turns on: how many NALs a picture is cut into.
		// One means there is no yield point inside a slice.
		nalsPerPicture: [...new Set(sizes.map((s) => s.nals))].sort((a, b) => a - b),
	}, null, 1));
	process.exit(0);
};

ws.onmessage = (e) => {
	if (typeof e.data === 'string') { info = JSON.parse(e.data); return; }
	const u8 = new Uint8Array(e.data);
	if (!init) { init = u8; return; }
	aus.push(u8);
	const nals = fragmentNals(u8, 4);
	sizes.push({
		n: u8.length, nals: nals.length,
		rap: nals.some((x) => isRap(nalType(x))),
	});
	if (aus.length >= WANT) { ws.close(); done(); }
};
ws.onerror = (e) => { console.error('ws error', e.message || e); process.exit(1); };
setTimeout(() => { console.error('timeout'); done(); }, 30000);
