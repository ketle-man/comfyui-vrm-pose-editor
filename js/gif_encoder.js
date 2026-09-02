// ============================================================
// gif_encoder.js — Animated GIF encoder with transparency
// NeuQuant color quantization: Anthony Dekker (1994)
// LZW encoder: GIF89a specification
// ============================================================

const _u16 = (arr, v) => arr.push(v & 0xFF, (v >> 8) & 0xFF);

// ---- NeuQuant 256-color quantization ----
// rgba: Uint8ClampedArray (RGBA), samplefac: 1(best)~30(fast)
function _neuquant(rgba, samplefac) {
    const NS = 256;
    const NBS = 4, IBS = 16, GS = 10, BS = 10, ABS = 10, RBS = 6, DRBS = 8;
    const IB = 1 << IBS, ALP = 1 << ABS, RAD = 1 << DRBS;
    const INITRAD = NS >> 3;
    const INRAD = INITRAD * (1 << RBS);
    const RADEC = 30, ARBS = ABS + DRBS;
    const BET = IB >> BS, BETG = IB << (GS - BS);

    // network[i] = Int32Array[b, g, r, _] (b,g,r order matches jsgif)
    const net = Array.from({ length: NS }, (_, i) => {
        const v = (i << (NBS + 8)) / NS | 0;
        return new Int32Array([v, v, v, 0]);
    });
    const freq = new Int32Array(NS).fill(IB / NS | 0);
    const bias = new Int32Array(NS);
    const rp   = new Int32Array(INITRAD);

    const updRad = rad => {
        for (let i = 0; i < rad; i++)
            rp[i] = (ALP * ((rad * rad - i * i) * RAD / (rad * rad))) | 0;
    };

    // collect opaque pixels as [b, g, r] triples, pre-shifted by NBS to match network scale
    const rgb = [];
    for (let i = 0; i < rgba.length; i += 4)
        if (rgba[i + 3] >= 128) rgb.push(rgba[i + 2] << NBS, rgba[i + 1] << NBS, rgba[i] << NBS);
    if (!rgb.length) return { palette: new Uint8Array(NS * 3), map: () => 0 };

    const nPix    = rgb.length / 3;
    const nSample = Math.max(1, (nPix / samplefac) | 0);
    const delta   = Math.max(1, (nSample / 100) | 0);
    let alpha = ALP, radius = INRAD;
    let rad = radius >> RBS;
    updRad(rad);

    const step = nPix < 499 ? 1 : nPix % 499 ? 499 : nPix % 491 ? 491 : nPix % 487 ? 487 : 503;
    let pos = 0, done = 0;

    for (let n = 0; n < nSample; pos = (pos + step) % nPix, n++) {
        const p = pos * 3, b = rgb[p], g = rgb[p + 1], r = rgb[p + 2];

        // find best and best-bias neurons
        let bestd = ~(1 << 31), bbd = bestd, best = -1, bbest = -1;
        for (let j = 0; j < NS; j++) {
            const nj = net[j];
            const d  = Math.abs(nj[0] - b) + Math.abs(nj[1] - g) + Math.abs(nj[2] - r);
            if (d < bestd) { bestd = d; best = j; }
            const bd = d - (bias[j] >> (IBS - NBS));
            if (bd < bbd)  { bbd = bd;  bbest = j; }
            const bf = freq[j] >> BS; freq[j] -= bf; bias[j] += bf << GS;
        }
        freq[best] += BET; bias[best] -= BETG;

        // move best-bias neuron towards pixel
        const nb = net[bbest];
        nb[0] -= (alpha * (nb[0] - b)) >> ABS;
        nb[1] -= (alpha * (nb[1] - g)) >> ABS;
        nb[2] -= (alpha * (nb[2] - r)) >> ABS;

        // move neighbors
        if (rad > 0) {
            const lo = Math.max(-1, bbest - rad), hi = Math.min(NS, bbest + rad);
            for (let j = bbest + 1, k = bbest - 1, m = 1; j < hi || k > lo; j++, k--, m++) {
                const a = m < INITRAD ? rp[m] : 0;
                if (j < hi) { const nj = net[j]; nj[0] -= (a * (nj[0] - b)) >> ARBS; nj[1] -= (a * (nj[1] - g)) >> ARBS; nj[2] -= (a * (nj[2] - r)) >> ARBS; }
                if (k > lo) { const nk = net[k]; nk[0] -= (a * (nk[0] - b)) >> ARBS; nk[1] -= (a * (nk[1] - g)) >> ARBS; nk[2] -= (a * (nk[2] - r)) >> ARBS; }
            }
        }

        if (++done >= delta) {
            done = 0; alpha -= alpha / 30; radius -= radius / RADEC;
            rad = radius >> RBS; if (rad <= 1) rad = 0; updRad(rad);
        }
    }

    // build palette (r,g,b order for output)
    const pal = new Uint8Array(NS * 3);
    for (let i = 0; i < NS; i++) {
        pal[i * 3]     = Math.min(255, Math.max(0, net[i][2] >> NBS)); // r
        pal[i * 3 + 1] = Math.min(255, Math.max(0, net[i][1] >> NBS)); // g
        pal[i * 3 + 2] = Math.min(255, Math.max(0, net[i][0] >> NBS)); // b
    }

    // build 64^3 lookup table for O(1) color mapping
    const lut = new Uint8Array(64 * 64 * 64);
    for (let ri = 0; ri < 64; ri++) {
        for (let gi = 0; gi < 64; gi++) {
            for (let bi = 0; bi < 64; bi++) {
                const tr = ri * 4 + 2, tg = gi * 4 + 2, tb = bi * 4 + 2;
                let best2 = 0, bestDist = Infinity;
                for (let i = 0; i < NS; i++) {
                    const dr = pal[i*3]-tr, dg = pal[i*3+1]-tg, db = pal[i*3+2]-tb;
                    const d  = dr*dr + dg*dg + db*db;
                    if (d < bestDist) { bestDist = d; best2 = i; }
                }
                lut[ri * 4096 + gi * 64 + bi] = best2;
            }
        }
    }
    const map = (r, g, b) => lut[(r >> 2) * 4096 + (g >> 2) * 64 + (b >> 2)];

    return { palette: pal, map };
}

// ---- GIF LZW encoder ----
function _lzw(indices, mcs) {
    const cc = 1 << mcs, ei = cc + 1;
    let cs = mcs + 1, nc = ei + 1, dict = new Map();
    const out = []; let buf = 0, blen = 0;
    const write = c => { buf |= c << blen; blen += cs; while (blen >= 8) { out.push(buf & 0xFF); buf >>>= 8; blen -= 8; } };
    const clr = () => { dict = new Map(); nc = ei + 1; cs = mcs + 1; };
    clr(); write(cc);
    if (!indices.length) { write(ei); if (blen) out.push(buf & 0xFF); return new Uint8Array(out); }
    let px = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i], key = (px << 8) | k, f = dict.get(key);
        if (f !== undefined) { px = f; }
        else {
            write(px);
            if (nc <= 4095) { dict.set(key, nc++); if (nc > (1 << cs) && cs < 12) cs++; }
            else { write(cc); clr(); }
            px = k;
        }
    }
    write(px); write(ei); if (blen) out.push(buf & 0xFF);
    return new Uint8Array(out);
}

// write LZW data as GIF sub-blocks (max 255 bytes each)
function _sub(arr, data) {
    let p = 0;
    while (p < data.length) {
        const n = Math.min(255, data.length - p);
        arr.push(n);
        for (let i = 0; i < n; i++) arr.push(data[p + i]);
        p += n;
    }
    arr.push(0); // block terminator
}

// ---- AnimGifEncoder ----
export class AnimGifEncoder {
    constructor(w, h) {
        this.w = w; this.h = h;
        this._f   = [];
        this._fps = 10;
        this._q   = 4; // samplefac
    }
    setFps(fps)   { this._fps = Math.max(1, fps); }
    setQuality(q) { this._q   = Math.max(1, Math.min(30, q)); }
    addFrame(img) { this._f.push(new Uint8ClampedArray(img.data)); }

    encode() {
        const { w, h } = this;
        const delay = Math.max(1, Math.round(100 / this._fps));
        const TR = 0; // palette index 0 reserved for transparency
        const out = [];

        // GIF89a header
        for (const c of "GIF89a") out.push(c.charCodeAt(0));
        _u16(out, w); _u16(out, h);
        out.push(0x00, 0x00, 0x00); // no GCT, bg index=0, aspect=0

        // Netscape 2.0 loop extension (infinite loop)
        out.push(0x21, 0xFF, 0x0B);
        for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0));
        out.push(0x03, 0x01); _u16(out, 0); out.push(0x00);

        for (const rgba of this._f) {
            // quantize: get 256-color palette; index 0 = transparent (black)
            const { palette, map } = _neuquant(rgba, this._q);

            // Local Color Table: [0]=(0,0,0)[transparent], [1~255]=palette[0~254]
            const lct = new Uint8Array(256 * 3);
            for (let i = 0; i < 255; i++) {
                lct[(i + 1) * 3]     = palette[i * 3];
                lct[(i + 1) * 3 + 1] = palette[i * 3 + 1];
                lct[(i + 1) * 3 + 2] = palette[i * 3 + 2];
            }

            // build index array
            // alpha < 32  → transparent (only near-fully-transparent pixels)
            // alpha >= 32 → opaque; clamp palette result to 0~254 so +1 never wraps to 0 (transparent)
            const idx = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) {
                const b = i * 4;
                const a = rgba[b + 3];
                if (a < 32) {
                    idx[i] = TR;
                } else {
                    // alpha-premultiply semi-transparent pixels before color lookup
                    const af = a / 255;
                    const r = a === 255 ? rgba[b]     : Math.round(rgba[b]     * af);
                    const g = a === 255 ? rgba[b + 1] : Math.round(rgba[b + 1] * af);
                    const bl = a === 255 ? rgba[b + 2] : Math.round(rgba[b + 2] * af);
                    idx[i] = Math.min(254, map(r, g, bl)) + 1; // 1~255, never wraps to 0
                }
            }

            // Graphic Control Extension
            // disposal=2 (restore to bg color), transparent color flag=1
            out.push(0x21, 0xF9, 0x04, 0x09); // packed: 0b00001001
            _u16(out, delay); out.push(TR, 0x00);

            // Image Descriptor + Local Color Table (256 colors = size field 7)
            out.push(0x2C);
            _u16(out, 0); _u16(out, 0); _u16(out, w); _u16(out, h);
            out.push(0x87); // LCT present, not interlaced, LCT size=7 → 2^8=256 colors
            for (const b of lct) out.push(b);

            // Image Data (minCodeSize=8 for 256-color palette)
            out.push(8);
            _sub(out, _lzw(idx, 8));
        }

        out.push(0x3B); // GIF trailer
        return new Uint8Array(out);
    }
}
