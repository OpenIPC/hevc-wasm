// YUV420 -> RGB on the GPU. Three single-channel textures and one shader, which
// is the cheapest way to get a decoder's native output onto a canvas: the
// alternative is converting on the CPU, and at 1080p30 that is another 3 MB of
// pixel shuffling per frame on the thread that just spent its budget decoding.
//
// BT.709 coefficients: every stream this plays comes from a camera encoder, and
// 709 is what they signal. A stream that says otherwise is not worth a branch
// until one turns up.
const VERT = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// sy/sc are visible-width / stride per plane. The decoder's rows are padded and
// WebGL1 has no UNPACK_ROW_LENGTH, so the padding is uploaded as image and then
// sampled away here — which costs one multiply per fetch, against repacking
// every row on the CPU.
const FRAG = `
precision mediump float;
varying vec2 uv;
uniform sampler2D ty, tu, tv;
uniform float sy, sc;
void main() {
  float y = texture2D(ty, vec2(uv.x * sy, uv.y)).r;
  float u = texture2D(tu, vec2(uv.x * sc, uv.y)).r - 0.5;
  float v = texture2D(tv, vec2(uv.x * sc, uv.y)).r - 0.5;
  // Limited range (16-235) is what an encoder emits unless it says otherwise.
  y = (y - 0.0625) * 1.1643;
  gl_FragColor = vec4(
    y + 1.7927 * v,
    y - 0.2132 * u - 0.5329 * v,
    y + 2.1124 * u,
    1.0);
}`;

export function makePainter(gl) {
	const sh = (type, src) => {
		const s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
			throw new Error('shader: ' + gl.getShaderInfoLog(s));
		return s;
	};
	const prog = gl.createProgram();
	gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
	gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
	gl.linkProgram(prog);
	gl.useProgram(prog);

	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER,
		new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(prog, 'p');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	// One texture per plane, each bound to a fixed unit for the life of the
	// painter — rebinding per frame is pure overhead when nothing else draws.
	const tex = [0, 1, 2].map((i) => {
		const t = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0 + i);
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	});
	['ty', 'tu', 'tv'].forEach((n, i) =>
		gl.uniform1i(gl.getUniformLocation(prog, n), i));
	const uSy = gl.getUniformLocation(prog, 'sy');
	const uSc = gl.getUniformLocation(prog, 'sc');

	const sizes = [null, null, null];

	// planes: [{data, stride, w, h}, ...] pointing INTO the wasm heap. The upload
	// is the only copy, and it goes where the pixels have to end up anyway.
	return function paint(planes, w, h) {
		if (gl.canvas.width !== w || gl.canvas.height !== h) {
			gl.canvas.width = w;
			gl.canvas.height = h;
		}
		gl.viewport(0, 0, w, h);
		gl.uniform1f(uSy, w / planes[0].stride);
		gl.uniform1f(uSc, planes[1].w / planes[1].stride);
		for (let i = 0; i < 3; i++) {
			const p = planes[i];
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, tex[i]);
			// The decoder's stride is almost never the visible width, and
			// UNPACK_ROW_LENGTH is WebGL2-only — so on WebGL1 the row padding
			// would be sampled as image. Upload the padded width and scale the
			// sampling instead of repacking rows on the CPU.
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			const key = p.stride + 'x' + p.h;
			if (sizes[i] !== key) {
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, p.stride, p.h, 0,
					gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
				sizes[i] = key;
			}
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.stride, p.h,
				gl.LUMINANCE, gl.UNSIGNED_BYTE, p.data);
		}
		// Drawn as soon as it is decoded. Holding frames back to present on a
		// schedule was considered and dropped: with one texture set it would
		// stall the next decode behind the display, and a second set (or a CPU
		// copy) buys smoothing that the measurements say is not needed --
		// decode is 9.5 ms against a 33-50 ms interval, so the only jitter is
		// one I-frame per GOP. What absorbs THAT is decode running ahead of
		// display, which is the access-unit queue, not a frame buffer.
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	};
}
