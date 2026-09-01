// fMP4 -> Annex-B, for majestic's /ws/video wire format.
//
// The socket sends one text `init` frame, then binary frames: the first is the
// fMP4 init segment (ftyp+moov), each later one is a moof+mdat holding exactly
// one access unit with 4-byte length-prefixed NAL units.
//
// Two things have to come out of that: the parameter sets, which live in the
// moov's hvcC and never appear in the fragments, and each AU's NALs with the
// length prefixes swapped for start codes.

const SC = new Uint8Array([0, 0, 0, 1]);

export const be32 = (u8, i) =>
	((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;

export const fourcc = (u8, i) =>
	String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);

// Immediate children only, so a type that also appears deeper cannot be
// mistaken for the one being looked for. Returns [start, end] or null.
export function findBox(u8, from, end, type) {
	let at = from;
	while (at + 8 <= end) {
		const size = be32(u8, at);
		if (size < 8 || at + size > end) return null;
		if (fourcc(u8, at + 4) === type) return [at, at + size];
		at += size;
	}
	return null;
}

export function descend(u8, from, end, path) {
	let a = from, b = end;
	for (const t of path) {
		const box = findBox(u8, a, b, t);
		if (!box) return null;
		a = box[0] + 8;
		b = box[1];
	}
	return [a, b];
}

// hvcC sits under stsd's sample entry, which carries 8 bytes of box header plus
// 78 bytes of visual sample entry before its own child boxes start.
export function parseHvcC(init) {
	const stsd = descend(init, 0, init.length,
		['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
	if (!stsd) return null;
	// stsd is a full box: 4 bytes version/flags + 4 bytes entry_count.
	const entry = stsd[0] + 8;
	const hvcC = findBox(init, entry + 8 + 78, stsd[1], 'hvcC');
	if (!hvcC) return null;

	let at = hvcC[0] + 8;
	const lengthSize = (init[at + 21] & 3) + 1;
	const numArrays = init[at + 22];
	at += 23;
	const sets = [];
	for (let i = 0; i < numArrays; i++) {
		const count = (init[at + 1] << 8) | init[at + 2];
		at += 3;
		for (let n = 0; n < count; n++) {
			const len = (init[at] << 8) | init[at + 1];
			at += 2;
			sets.push(init.subarray(at, at + len));
			at += len;
		}
	}
	return { lengthSize, sets };
}

// The AU's bytes are the mdat payload. Walking the mdat directly rather than
// through trun sample sizes: for this wire format one fragment is one AU, and
// the length prefixes already delimit every NAL inside it.
export function fragmentNals(frag, lengthSize = 4) {
	const mdat = findBox(frag, 0, frag.length, 'mdat');
	if (!mdat) return [];
	const out = [];
	let at = mdat[0] + 8;
	while (at + lengthSize <= mdat[1]) {
		let len = 0;
		for (let i = 0; i < lengthSize; i++) len = (len << 8) | frag[at + i];
		at += lengthSize;
		if (len <= 0 || at + len > mdat[1]) break;
		out.push(frag.subarray(at, at + len));
		at += len;
	}
	return out;
}

export function toAnnexB(nals) {
	let n = 0;
	for (const x of nals) n += 4 + x.length;
	const out = new Uint8Array(n);
	let at = 0;
	for (const x of nals) {
		out.set(SC, at); at += 4;
		out.set(x, at); at += x.length;
	}
	return out;
}

// HEVC nal_unit_type is bits 1..6 of the first header byte.
export const nalType = (nal) => (nal[0] >> 1) & 0x3f;
// BLA_W_LP(16) .. CRA_NUT(21) are the random-access points.
export const isRap = (t) => t >= 16 && t <= 21;
