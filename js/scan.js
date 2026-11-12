/* OMR AYW — scan engine (Phase 2)
 * input : RGBA image {width, height, data} (ImageData-like) + template JSON
 * output: student ID, subject code, 100 answers with status + raw darkness
 *
 * pipeline
 *   1. findPaper     largest bright low-saturation region → 4 corners (coarse)
 *   2. warp          photo → "paper frame" (PF, 2000 px wide)
 *   3. findBars      49 black timing bars along the bottom → similarity canonical→PF
 *   4. register      printed bubble rings (red channel) → per-block homography canonical→PF
 *   5. read          blue channel darkness inside 70 % of each bubble, local white reference
 *   6. decide        per question / digit: answered · multi · uncertain · blank
 * Browser: window.OMRScan · Node: module.exports
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const G = isNode ? require('./geom.js') : root.OMRGeom;
  const TP = isNode ? require('./template.js') : root.OMRTemplate;

  const DEFAULTS = {
    paperWidth: 2000,     // PF width in px
    chunkRows: 5,         // rows registered per step, bottom-up
    searchFirst: 14,      // search range (PF px) for the bottom chunk, predicted from the timing bars
    searchNext: 7,        // search range for later chunks, predicted from the rings already found
    readRadius: 0.7,      // fraction of bubble radius that is read
    thrMin: 0.18, thrMax: 0.45,
    multiRatio: 0.75,     // d2 ≥ ratio·d1 → multi
    clearRatio: 0.6,      // d2 < ratio·d1 → clear answer
    faintBand: 0.6,       // d1 < faintBand·T → blank, between → uncertain
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ---------- small image utils ---------- */
  function otsu(hist) {
    let total = 0, sum = 0;
    for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
    let wB = 0, sumB = 0, best = 0, first = 127, last = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best * (1 + 1e-9)) { best = v; first = last = t; }
      else if (v >= best * (1 - 1e-9)) last = t;
    }
    // an empty gap between the two classes gives a plateau → take its middle
    return (first + last) / 2;
  }
  function percentile(arr, p) {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  }

  // connected components (8-neighbour) on a Uint8 mask; returns labels + stats
  function components(mask, w, h) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      n++;
      let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = i; lab[i] = n;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id: n, area, cx: sx / area, cy: sy / area, x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return { lab, comps };
  }

  /* ---------- 1. paper ---------- */
  function findPaper(img) {
    const { width: W, height: H, data } = img;
    const f = Math.max(1, Math.ceil(Math.max(W, H) / 800));
    const w = Math.floor(W / f), h = Math.floor(H / f);
    // paper = low saturation (white/grey under any light); a wooden or coloured desk is saturated
    const mn = new Uint8Array(w * h), sat = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = ((y * f) * W + x * f) * 4, r = data[o], g = data[o + 1], b = data[o + 2];
      const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
      mn[y * w + x] = lo; sat[y * w + x] = hi - lo; hist[hi - lo]++;
    }
    const satThr = Math.min(60, Math.max(20, otsu(hist)));
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = sat[i] < satThr && mn[i] > 50 ? 1 : 0;
    // close small holes made by blue print / pencil inside the paper
    const closed = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) n++;
      }
      closed[y * w + x] = n >= 9 ? 1 : 0;
    }
    const { lab, comps } = components(closed, w, h);
    if (!comps.length) return null;
    const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
    if (big.area < 0.15 * w * h) return null;
    const inC = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === big.id;
    // extreme points along the diagonals → rough TL, TR, BR, BL
    let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
    const border = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!inC(x, y)) continue;
      const s = x + y, d = x - y;
      if (s < tl[2]) tl = [x, y, s]; if (s > br[2]) br = [x, y, s];
      if (d > tr[2]) tr = [x, y, d]; if (d < bl[2]) bl = [x, y, d];
      if (!inC(x - 1, y) || !inC(x + 1, y) || !inC(x, y - 1) || !inC(x, y + 1)) border.push([x + 0.5, y + 0.5]);
    }
    const rough = [tl, tr, br, bl].map(p => [p[0] + 0.5, p[1] + 0.5]);
    // refine: fit a straight line to the border points of each side (middle 80 %), intersect neighbours
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const A = rough[k], B = rough[(k + 1) % 4], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, tol = 0.03 * Math.max(w, h);
      const pts = border.filter(p => {
        const t = ((p[0] - A[0]) * ux + (p[1] - A[1]) * uy) / L, dist = Math.abs((p[0] - A[0]) * uy - (p[1] - A[1]) * ux);
        return t > 0.1 && t < 0.9 && dist < tol;
      });
      if (pts.length < 10) { lines.push(null); continue; }
      let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
      let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      lines.push({ p: [mx, my], d: [Math.cos(th), Math.sin(th)] });
    }
    const meet = (a, b) => {
      const det = a.d[0] * (-b.d[1]) - a.d[1] * (-b.d[0]); if (Math.abs(det) < 1e-6) return null;
      const rx = b.p[0] - a.p[0], ry = b.p[1] - a.p[1], t = (rx * (-b.d[1]) - ry * (-b.d[0])) / det;
      return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
    };
    const corners = rough.map((r, k) => {
      const a = lines[(k + 3) % 4], b = lines[k];
      const m = a && b ? meet(a, b) : null;
      return m && Math.hypot(m[0] - r[0], m[1] - r[1]) < 0.08 * Math.max(w, h) ? m : r;
    });
    return { corners: corners.map(p => [p[0] * f, p[1] * f]), areaFrac: big.area / (w * h) };
  }

  /* ---------- 2. warp to paper frame ---------- */
  // the detected corners can sit slightly inside the paper (shadow, curl) → keep a margin around them
  // heightScale corrects the aspect ratio, which the corner positions alone cannot give under strong tilt
  function warpPaper(img, c, PW, marginFrac, heightScale) {
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const m = Math.round(PW * (marginFrac == null ? 0.04 : marginFrac)), iw = PW - 2 * m;
    const ih = Math.round(iw * (heightScale || 1) * (d(c[0], c[3]) + d(c[1], c[2])) / (d(c[0], c[1]) + d(c[3], c[2])));
    const PH = ih + 2 * m;
    const Hpf2img = G.homography([[m, m], [PW - m, m], [PW - m, PH - m], [m, PH - m]], c);
    const data = G.warpPerspective(img.data, img.width, img.height, Hpf2img, PW, PH);
    return { width: PW, height: PH, data, Hpf2img };
  }

  /* ---------- 3. timing bars ---------- */
  function findBars(pf, tpl) {
    const { width: w, height: h, data } = pf;
    const tt = tpl.anchors.timingTrack, N = tt.barCount;
    const sc = w / tpl.canonical.width;
    const bw = (tt.barW || 0.006) * tpl.canonical.width * sc, bh = (tt.barH || 0.023) * tpl.canonical.height * sc;
    const y0 = Math.floor(h * 0.72), bandH = h - y0;
    const blue = new Uint8Array(w * bandH);
    for (let i = 0; i < w * bandH; i++) blue[i] = data[(y0 * w + i) * 4 + 2];
    const white = percentile(blue.filter((_, i) => i % 7 === 0), 0.95);
    const mask = new Uint8Array(w * bandH);
    for (let i = 0; i < w * bandH; i++) mask[i] = blue[i] < white * 0.5 ? 1 : 0;
    const { comps } = components(mask, w, bandH);
    const cand = comps.filter(c => {
      const asp = c.h / c.w;
      return c.area > 0.25 * bw * bh && c.area < 4 * bw * bh && asp > 1.4 && asp < 5.5 && c.h > 0.5 * bh && c.h < 2 * bh;
    });
    if (cand.length < N * 0.6) return { ok: false, found: cand.length, error: `พบแถบ timing ${cand.length}/${N} แท่ง` };
    // largest group on one horizontal line
    let best = [];
    for (const s of cand) {
      const g = cand.filter(c => Math.abs(c.cy - s.cy) < 0.8 * bh);
      if (g.length > best.length) best = g;
    }
    best.sort((a, b) => a.cx - b.cx);
    // drop blobs that break the regular spacing
    const steps = best.slice(1).map((c, i) => c.cx - best[i].cx), p = percentile(steps, 0.5);
    best = best.filter((c, i) => {
      const l = i > 0 ? c.cx - best[i - 1].cx : 0, r = i < best.length - 1 ? best[i + 1].cx - c.cx : 0;
      const fit = s => Math.abs(s / p - Math.round(s / p)) < 0.25 && s > 0.5 * p;
      return fit(l) || fit(r);
    });

    // index each bar: walk the row, a gap of k pitches means k−1 missing bars
    const idx = [0];
    for (let i = 1; i < best.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round((best[i].cx - best[i - 1].cx) / p)));
    let shift = null, square = null;
    // the black corner square sits above bar 0 → anchors the indexing when bars are missing at the ends
    const cs = tpl.anchors.cornerSquare;
    if (cs && cs.w > 0) {
      const sw = cs.w * tpl.canonical.width * sc, sh = cs.h * tpl.canonical.height * sc;
      const by = percentile(best.map(c => c.cy), 0.5);
      const sq = comps.filter(c => c.area > 0.4 * sw * sh && c.area < 2.5 * sw * sh && c.w / c.h > 0.6 && c.w / c.h < 1.6 &&
        c.cy < by && by - c.cy < 3 * bh).sort((a, b) => a.cx - b.cx)[0];
      if (sq) {
        const canonBar0 = tt.xStart * tpl.canonical.width, canonSq = (cs.x + cs.w / 2) * tpl.canonical.width;
        const bar0x = sq.cx - (canonSq - canonBar0) * sc;
        shift = Math.round((best[0].cx - bar0x) / p); // index of the first detected bar
        square = [sq.cx, sq.cy + y0];
      }
    }
    if (shift == null) {
      if (best.length !== N) return { ok: false, found: best.length, error: `พบแถบ timing ${best.length}/${N} แท่ง (ต้องเห็นแถบครบทั้งแถว)` };
      shift = 0;
    }
    const bars = [], index = [];
    best.forEach((c, i) => { const k = idx[i] + shift; if (k >= 0 && k < N) { bars.push([c.cx, c.cy + y0]); index.push(k); } });
    if (bars.length < 0.8 * N) return { ok: false, found: bars.length, error: `พบแถบ timing ${bars.length}/${N} แท่ง` };
    return { ok: true, bars, index, square, barSize: [bw, bh] };
  }

  /* ---------- 4. registration on printed rings ---------- */
  const ANG = 24, COS = [], SIN = [];
  for (let i = 0; i < ANG; i++) { COS.push(Math.cos(2 * Math.PI * i / ANG)); SIN.push(Math.sin(2 * Math.PI * i / ANG)); }

  function makeSampler(pf) {
    const { width: w, height: h, data } = pf;
    const at = (x, y, ch) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;
      return data[(yi * w + xi) * 4 + ch];
    };
    const ringDark = (x, y, r) => { let s = 0; for (let i = 0; i < ANG; i++) s += 255 - at(x + r * COS[i], y + r * SIN[i], 0); return s / ANG; };
    // printed ring is blue → dark in the red channel; positive when a ring of radius r is centred here.
    // compared with circles just inside/outside (±27 % r) so tinted column backgrounds cancel out
    // the ring itself is sampled on two radii (r ± 0.8 px) → a slightly wider, steadier peak.
    // the outside circle stays within 1.2 r: ID / subject columns have divider lines at ≈ 1.39 r
    const ringScore = (x, y, r) => 0.5 * (ringDark(x, y, r - 0.8) + ringDark(x, y, r + 0.8)) - 0.5 * (ringDark(x, y, 0.72 * r) + ringDark(x, y, 1.2 * r));
    return { at, ringDark, ringScore };
  }

  /* Vertical scale check: under strong tilt the paper-frame aspect ratio is wrong, so the bar-based
   * similarity (which only measures x) mispredicts y far above the bars. The 25 answer rows are
   * evenly spaced → the period of the vertical darkness profile through the answer columns gives the
   * real row pitch. Returns measured / expected (1 = correct aspect). */
  function estimateYScale(pf, tpl, sim, simScale, barY) {
    const S = makeSampler(pf), Wc = tpl.canonical.width, Hc = tpl.canonical.height;
    const ans = tpl.fields.find(f => f.type === 'mcq');
    if (!ans) return 1;
    const pitch = ans.blocks[0].dy * Hc * simScale, rp = tpl.bubbleRadius * Wc * simScale;
    const y1 = Math.floor(barY - 0.5 * pitch), y0 = Math.max(0, Math.floor(barY - 40 * pitch));
    const n = y1 - y0; if (n < 10 * pitch) return 1;
    const prof = new Float64Array(n);
    for (const b of ans.blocks) for (let c = 0; c < ans.choices; c++) {
      const x = G.applyH(sim, (b.origin.x + c * b.dx) * Wc, (b.origin.y + 12 * b.dy) * Hc)[0];
      for (let y = 0; y < n; y++) {
        let s = 0; for (let dx = -Math.round(0.6 * rp); dx <= Math.round(0.6 * rp); dx += 2) s += 255 - S.at(x + dx, y0 + y, 0);
        prof[y] += s;
      }
    }
    // remove slow trends (moving average over two pitches)
    const w = Math.round(2 * pitch), det = new Float64Array(n);
    let acc = 0; const q = [];
    for (let y = 0; y < n; y++) {
      const lo = Math.max(0, y - w), hi = Math.min(n - 1, y + w);
      if (y === 0) { for (let k = lo; k <= hi; k++) acc += prof[k]; }
      else { if (y - w - 1 >= 0) acc -= prof[y - w - 1]; if (y + w <= n - 1) acc += prof[y + w]; }
      det[y] = prof[y] - acc / (hi - lo + 1);
    }
    const lagLo = Math.floor(0.7 * pitch), lagHi = Math.ceil(1.45 * pitch), R = [];
    for (let L = lagLo; L <= lagHi; L++) { let s = 0; for (let y = 0; y + L < n; y++) s += det[y] * det[y + L]; R.push(s / (n - L)); }
    let k = 1; for (let i = 1; i < R.length - 1; i++) if (R[i] > R[k]) k = i;
    if (k <= 0 || k >= R.length - 1 || R[k] <= 0) return 1;
    const den = R[k - 1] - 2 * R[k] + R[k + 1], off = den < 0 ? 0.5 * (R[k - 1] - R[k + 1]) / den : 0;
    return (lagLo + k + off) / pitch;
  }

  function register(pf, tpl, sim, simScale, opt) {
    const S = makeSampler(pf);
    const Wc = tpl.canonical.width, Hc = tpl.canonical.height;
    const rp = tpl.bubbleRadius * Wc * simScale;
    const bubbles = TP.bubbles(tpl).map(b => {
      const cx = b.x * Wc, cy = b.y * Hc, p = G.applyH(sim, cx, cy);
      return Object.assign({}, b, { group: b.field + ':' + (b.block || 0), cx, cy, px: p[0], py: p[1] });
    });
    const groups = {};
    for (const b of bubbles) (groups[b.group] = groups[b.group] || []).push(b);

    // Track each block from its bottom rows (close to the timing bars, where the bar-based
    // prediction is accurate) upwards in chunks of rows: each chunk is predicted from an affine fit
    // of the rings already found, so the search window stays small and a grid can never slip by a
    // whole row or column even when the paper is curled or the paper corners were imprecise.
    const rowOf = b => (b.q != null ? b.q : b.row);
    const filledAt = b => {
      // filled bubble: centre much darker than the paper around (blue channel) → not a reliable ring centre
      let c = 0, w = 0;
      for (let i = 0; i < ANG; i += 3) {
        c += S.at(b.mx + 0.35 * rp * COS[i], b.my + 0.35 * rp * SIN[i], 2);
        w = Math.max(w, S.at(b.mx + 1.45 * rp * COS[i], b.my + 1.45 * rp * SIN[i], 2));
      }
      c /= ANG / 3;
      return w > 0 && (w - c) / w > 0.25;
    };
    const refine = (b, win) => {
      let bs = -Infinity, ox = 0, oy = 0;
      for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
        const s = S.ringScore(b.ex + dx, b.ey + dy, rp); if (s > bs) { bs = s; ox = dx; oy = dy; }
      }
      b.mx = b.ex + ox; b.my = b.ey + oy; b.ring = bs;
    };
    for (const g of Object.values(groups)) {
      const rowsDesc = [...new Set(g.map(rowOf))].sort((a, b) => b - a);
      const found = [];
      let model = null;
      for (let k = 0; k < rowsDesc.length; k += opt.chunkRows) {
        const rows = new Set(rowsDesc.slice(k, k + opt.chunkRows));
        const chunk = g.filter(b => rows.has(rowOf(b)));
        for (const b of chunk) { const p = model ? G.applyH(model, b.cx, b.cy) : [b.px, b.py]; b.ex = p[0]; b.ey = p[1]; }
        const W = k === 0 ? opt.searchFirst : opt.searchNext;
        let best = -Infinity, sx = 0, sy = 0;
        for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) {
          let s = 0; for (const b of chunk) s += S.ringScore(b.ex + dx, b.ey + dy, rp);
          if (s > best) { best = s; sx = dx; sy = dy; }
        }
        if (k === 0) g.shift = [sx, sy];
        for (const b of chunk) { b.ex += sx; b.ey += sy; refine(b, 2); b.filledGuess = filledAt(b); }
        const cm = percentile(chunk.map(b => b.ring), 0.5);
        for (const b of chunk) if (!b.filledGuess && b.ring > 0.4 * cm) found.push(b);
        if (found.length >= 6) {
          try { model = G.affineLS(found.map(b => [b.cx, b.cy]), found.map(b => [b.mx, b.my])); } catch (e) { /* collinear: keep previous */ }
        }
      }
      // whole-block polish: homography from all rings, re-predict, tight search
      for (const win of [3, 2]) {
        const gm = percentile(g.map(b => b.ring), 0.5);
        const gg = g.filter(b => !b.filledGuess && b.ring > 0.4 * gm);
        if (gg.length < 8) break;
        const Hb = G.homographyLS(gg.map(b => [b.cx, b.cy]), gg.map(b => [b.mx, b.my]));
        for (const b of g) { const p = G.applyH(Hb, b.cx, b.cy); b.ex = p[0]; b.ey = p[1]; refine(b, win); }
      }
    }

    // robust global homography canonical → PF
    const med = percentile(bubbles.map(b => b.ring), 0.5);
    let good = bubbles.filter(b => !b.filledGuess && b.ring > 0.4 * med);
    if (good.length < 40) return { error: 'จับตำแหน่งวงไม่ได้ (ภาพเบลอหรือมืดเกินไป)' };
    let Hg = G.homographyLS(good.map(b => [b.cx, b.cy]), good.map(b => [b.mx, b.my]));
    for (let it = 0; it < 2; it++) {
      good = good.filter(b => { const p = G.applyH(Hg, b.cx, b.cy); return Math.hypot(p[0] - b.mx, p[1] - b.my) < 2.5; });
      Hg = G.homographyLS(good.map(b => [b.cx, b.cy]), good.map(b => [b.mx, b.my]));
    }
    const rms = pts => Math.sqrt(pts.reduce((s, b) => { const p = G.applyH(b.H || Hg, b.cx, b.cy); return s + (p[0] - b.mx) ** 2 + (p[1] - b.my) ** 2; }, 0) / Math.max(1, pts.length));
    const globalRms = rms(good);

    // per-block homography from the block's own rings (handles paper curl and template scale error);
    // fall back to global. verifyGrid() below is the safety net against a slipped grid.
    const blockInfo = {};
    for (const [key, g] of Object.entries(groups)) {
      const gm = percentile(g.map(b => b.ring), 0.5);
      let gg = g.filter(b => !b.filledGuess && b.ring > 0.4 * gm);
      let H = Hg, used = 'global';
      if (gg.length >= Math.max(8, 0.3 * g.length)) {
        let Hb = G.homographyLS(gg.map(b => [b.cx, b.cy]), gg.map(b => [b.mx, b.my]));
        const err = b => { const p = G.applyH(Hb, b.cx, b.cy); return Math.hypot(p[0] - b.mx, p[1] - b.my); };
        const kept = gg.filter(b => err(b) < 2.5);
        if (kept.length >= 8 && kept.length < gg.length) { gg = kept; Hb = G.homographyLS(gg.map(b => [b.cx, b.cy]), gg.map(b => [b.mx, b.my])); }
        const e = Math.sqrt(gg.reduce((s, b) => s + err(b) ** 2, 0) / gg.length);
        if (e < 1.5) { H = Hb; used = 'block'; }
      } else {
        gg = good.filter(b => b.group === key);
      }
      for (const b of g) { const p = G.applyH(H, b.cx, b.cy); b.x0 = p[0]; b.y0 = p[1]; }
      blockInfo[key] = Object.assign({ used, good: gg.length, n: g.length, shift: g.shift }, verifyGrid(g, H, S, rp));
    }
    const bad = Object.entries(blockInfo).filter(([, v]) => !v.gridOk).map(([k]) => k);
    return { bubbles, rp, Hg, globalRms, nGood: good.length, blockInfo, gridError: bad.length ? bad : null };
  }

  /* A grid that slipped by one row/column still matches most rings, so check the
   * virtual row/column just OUTSIDE the block: it must not land on printed rings. */
  function verifyGrid(g, H, S, rp) {
    const rowOf = b => (b.q != null ? b.q : b.row), colOf = b => (b.q != null ? b.choice : b.col);
    const rows = g.map(rowOf), cols = g.map(colOf);
    const r0 = Math.min(...rows), c0 = Math.min(...cols), c1 = Math.max(...cols);
    const one = (r, c) => g.find(b => rowOf(b) === r && colOf(b) === c);
    const a = one(r0, c0), bx = one(r0, c0 + 1), by = one(r0 + 1, c0);
    if (!a || !bx || !by) return { gridOk: true };
    const dxc = bx.cx - a.cx, dyc = by.cy - a.cy;
    // best ring within ±3 px: extrapolating one step outside the block is only accurate to a few px,
    // and the ring peak is narrow — a real ring there must not be missed
    const score = (x, y) => {
      const p = G.applyH(H, x, y); let best = -Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) best = Math.max(best, S.ringScore(p[0] + dx, p[1] + dy, rp));
      return best;
    };
    const real = g.filter(b => !b.filledGuess).map(b => score(b.cx, b.cy));
    const median = arr => percentile(arr, 0.5);
    const realMed = median(real);
    const topRow = g.filter(b => rowOf(b) === r0), leftCol = g.filter(b => colOf(b) === c0), rightCol = g.filter(b => colOf(b) === c1);
    // bottom: one step below the last bubble of every column (handles the 11-row ท–ญ column)
    const bottom = [];
    for (let c = c0; c <= c1; c++) {
      const col = g.filter(b => colOf(b) === c); const last = col.reduce((p, q) => (rowOf(q) > rowOf(p) ? q : p));
      bottom.push(score(last.cx, last.cy + dyc));
    }
    const out = {
      above: median(topRow.map(b => score(b.cx, b.cy - dyc))),
      below: median(bottom),
      left: median(leftCol.map(b => score(b.cx - dxc, b.cy))),
      right: median(rightCol.map(b => score(b.cx + dxc, b.cy))),
    };
    const worst = Math.max(out.above, out.below, out.left, out.right);
    return { gridOk: realMed > 0 && worst < 0.55 * realMed, ringMed: +realMed.toFixed(1), outside: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.toFixed(1)])) };
  }

  /* ---------- 5. read darkness ---------- */
  function readDarkness(pf, reg, opt) {
    const S = makeSampler(pf), rp = reg.rp, rr = opt.readRadius * rp;
    const offs = [];
    const R = Math.ceil(rr);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= rr * rr) offs.push([dx, dy]);
    for (const b of reg.bubbles) {
      let s = 0;
      for (const [dx, dy] of offs) s += S.at(b.x0 + dx, b.y0 + dy, 2);
      const inside = s / offs.length;
      const ring = [];
      for (const k of [1.3, 1.45, 1.6]) for (let i = 0; i < ANG; i++) ring.push(S.at(b.x0 + k * rp * COS[i], b.y0 + k * rp * SIN[i], 2));
      const white = Math.max(percentile(ring, 0.75), 1);
      b.dark = Math.max(0, Math.min(1, (white - inside) / white));
    }
  }

  /* ---------- 6. decide ---------- */
  function threshold(darks, opt) {
    const hist = new Array(256).fill(0);
    for (const d of darks) hist[Math.min(255, Math.round(d * 255))]++;
    return Math.min(opt.thrMax, Math.max(opt.thrMin, otsu(hist) / 255));
  }

  // darks: darkness of each option; returns {status, choice, choices, d1, d2}
  function classify(darks, T, opt) {
    const idx = darks.map((d, i) => i).sort((a, b) => darks[b] - darks[a]);
    const d1 = darks[idx[0]], d2 = darks.length > 1 ? darks[idx[1]] : 0;
    const out = { d1, d2, choice: null, choices: [] };
    if (d1 < opt.faintBand * T) return Object.assign(out, { status: 'blank' });
    if (d1 < T) return Object.assign(out, { status: 'uncertain', reason: 'faint', choice: idx[0] });
    if (d2 >= T || d2 >= opt.multiRatio * d1) {
      const lim = Math.min(T, opt.multiRatio * d1);
      return Object.assign(out, { status: 'multi', choices: idx.filter(i => darks[i] >= lim).sort((a, b) => a - b) });
    }
    if (d2 >= opt.clearRatio * d1) return Object.assign(out, { status: 'uncertain', reason: 'ambiguous', choice: idx[0] });
    // a clear answer, but another option still carries a visible mark → most likely an incomplete erasure
    if (d2 >= (opt.erasedMin || opt.faintBand * T)) out.note = 'erased';
    return Object.assign(out, { status: 'ok', choice: idx[0], choices: [idx[0]] });
  }

  function decide(reg, tpl, opt) {
    const T = threshold(reg.bubbles.map(b => b.dark), opt);
    // "erased" note: clearly above what an untouched bubble reads on this sheet
    const blanks = reg.bubbles.map(b => b.dark).filter(d => d < 0.5 * T);
    opt = Object.assign({}, opt, { erasedMin: Math.max(0.35 * T, (blanks.length ? percentile(blanks, 0.99) : 0) + 0.04) });
    const byField = {};
    for (const b of reg.bubbles) (byField[b.field] = byField[b.field] || []).push(b);

    const readDigits = list => {
      const cols = [];
      for (const b of list) (cols[b.col] = cols[b.col] || []).push(b);
      const res = cols.map(col => {
        const d = col.map(b => b.dark), c = classify(d, T, opt);
        return { status: c.status, value: c.status === 'ok' ? col[c.choice].value : null, dark: d.map(v => +v.toFixed(3)), reason: c.reason, note: c.note };
      });
      const ok = res.every(r => r.status === 'ok');
      return { value: ok ? res.map(r => r.value).join('') : null, status: ok ? 'ok' : 'review', cols: res,
        partial: res.map(r => (r.status === 'ok' ? r.value : '?')).join('') };
    };

    const answers = [];
    const byQ = {};
    for (const b of byField.answers || []) (byQ[b.q] = byQ[b.q] || [])[b.choice] = b;
    for (const q of Object.keys(byQ).map(Number).sort((a, b) => a - b)) {
      const d = byQ[q].map(b => b.dark), c = classify(d, T, opt);
      answers.push({ q, status: c.status, choice: c.choice, choices: c.choices, reason: c.reason, note: c.note, dark: d.map(v => +v.toFixed(3)) });
    }
    return { threshold: T, studentId: readDigits(byField.studentId || []), subjectCode: readDigits(byField.subjectCode || []), answers };
  }

  /* ---------- main ---------- */
  function scanSheet(img, tpl, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const t0 = now(), timing = {};
    const paper = findPaper(img);
    timing.paper = now() - t0;
    if (!paper) return { ok: false, error: 'ไม่พบกระดาษ' };
    let lastErr = '', lastFound = -1, lastDebug = null;
    // try upright, then upside-down
    for (const rot of [0, 2]) {
      const c = paper.corners.slice(rot).concat(paper.corners.slice(0, rot));
      const t1 = now();
      let pf = warpPaper(img, c, opt.paperWidth);
      timing.warp = now() - t1;
      const t2 = now();
      let bars = findBars(pf, tpl);
      timing.bars = now() - t2;
      if (!bars.ok) { if (!lastErr || (bars.found || 0) > lastFound) { lastErr = bars.error; lastFound = bars.found || 0; } continue; }
      const tt = tpl.anchors.timingTrack, Wc = tpl.canonical.width, Hc = tpl.canonical.height, N = tt.barCount;
      const canonOf = b => b.index.map(i => [(tt.xStart + (tt.xEnd - tt.xStart) * i / (N - 1)) * Wc, tt.y * Hc]);
      let sim = G.similarityLS(canonOf(bars), bars.bars), simScale = Math.hypot(sim[0], sim[3]);
      const barY = bars.bars.reduce((s, p) => s + p[1], 0) / bars.bars.length;
      const ky = estimateYScale(pf, tpl, sim, simScale, barY);
      timing.yScale = ky;
      if (Math.abs(ky - 1) > 0.02 && ky > 0.6 && ky < 1.6) {
        // strong tilt: the paper frame is stretched vertically → re-warp with the measured aspect
        const pf2 = warpPaper(img, c, opt.paperWidth, null, 1 / ky);
        const bars2 = findBars(pf2, tpl);
        if (bars2.ok) {
          pf = pf2; bars = bars2;
          sim = G.similarityLS(canonOf(bars), bars.bars); simScale = Math.hypot(sim[0], sim[3]);
        }
      }
      const t3 = now();
      const reg = register(pf, tpl, sim, simScale, opt);
      timing.register = now() - t3;
      if (reg.error) { lastErr = reg.error; lastFound = Infinity; continue; }
      if (reg.gridError) {
        lastErr = 'วางตารางวงไม่แน่ใจ (' + reg.gridError.join(', ') + ') ถือกล้องให้ตรงและให้กระดาษเต็มเฟรมแล้วลองใหม่';
        lastFound = Infinity; lastDebug = reg.blockInfo; continue;
      }
      const t4 = now();
      readDarkness(pf, reg, opt);
      const res = decide(reg, tpl, opt);
      timing.read = now() - t4;
      timing.total = now() - t0;
      const toImg = (x, y) => G.applyH(pf.Hpf2img, x, y);
      return Object.assign({ ok: true, rotated: rot === 2, timing }, res, {
        debug: {
          paperCorners: c, pf: { width: pf.width, height: pf.height }, Hpf2img: pf.Hpf2img,
          bars: bars.bars.map(p => toImg(p[0], p[1])), fitRms: reg.globalRms, nGood: reg.nGood, blockInfo: reg.blockInfo,
          radiusImg: (() => { const a = toImg(pf.width / 2, pf.height / 2), b = toImg(pf.width / 2 + 10, pf.height / 2); return reg.rp * Math.hypot(b[0] - a[0], b[1] - a[1]) / 10; })(),
          bubbles: reg.bubbles.map(b => { const p = toImg(b.x0, b.y0); return { field: b.field, q: b.q, col: b.col, row: b.row, choice: b.choice, x: +p[0].toFixed(1), y: +p[1].toFixed(1), dark: +b.dark.toFixed(3) }; }),
          rp: reg.rp,
          // paper-frame measurements, used by tools/calibrate-template.js
          pfBars: bars.bars.map((p, i) => [bars.index[i], +p[0].toFixed(2), +p[1].toFixed(2)]),
          pfSquare: bars.square,
          pfRings: reg.bubbles.map(b => [+b.mx.toFixed(2), +b.my.toFixed(2), b.filledGuess ? 0 : +b.ring.toFixed(1)]),
        },
        pf: options && options.keepPF ? pf : undefined,
      });
    }
    return { ok: false, error: lastErr || 'อ่านไม่ได้', debug: lastDebug ? { blockInfo: lastDebug } : undefined };
  }

  const api = { scanSheet, findPaper, warpPaper, findBars, classify, DEFAULTS, _makeSampler: makeSampler };
  if (isNode) module.exports = api; else root.OMRScan = api;
})(typeof self !== 'undefined' ? self : this);
