/* OMR AYW — geometry helpers (homography + perspective warp)
 * ใช้ร่วมกันระหว่างเครื่องมือสร้าง template และเอนจินสแกน
 * Browser: window.OMRGeom · Node: module.exports
 */
(function (root) {
  'use strict';

  // Gaussian elimination with partial pivoting: solve A·x = b
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular matrix');
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // Homography H (row-major 3x3, h33 = 1) mapping src[i] -> dst[i], 4 point pairs [x,y]
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) throw new Error('singular homography');
    const inv = [
      A, -(b * i - c * h), b * f - c * e,
      B, a * i - c * g, -(a * f - c * d),
      C, -(a * h - b * g), a * e - b * d,
    ].map(v => v / det);
    const s = inv[8];
    return inv.map(v => v / s);
  }

  /* Warp RGBA source into W×H output. Hd2s maps destination px -> source px.
   * Bilinear sampling; outside the source becomes white. */
  function warpPerspective(src, srcW, srcH, Hd2s, W, H) {
    const out = new Uint8ClampedArray(W * H * 4);
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = Hd2s;
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < W; x++) {
        const xc = x + 0.5;
        const w = h6 * xc + h7 * yc + h8;
        const sx = (h0 * xc + h1 * yc + h2) / w - 0.5;
        const sy = (h3 * xc + h4 * yc + h5) / w - 0.5;
        const o = (y * W + x) * 4;
        if (sx < 0 || sy < 0 || sx > srcW - 1 || sy > srcH - 1) {
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
          continue;
        }
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcH - 1);
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * srcW + x0) * 4, i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4, i11 = (y1 * srcW + x1) * 4;
        for (let k = 0; k < 3; k++) {
          const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
          const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
          out[o + k] = top + (bot - top) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  function mul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  }

  // Hartley normalisation: centroid to origin, mean distance √2
  function normT(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    const s = Math.SQRT2 / (d / pts.length || 1);
    return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  }

  // Least-squares homography from n ≥ 4 point pairs (normalised, h33 = 1)
  function homographyLS(src, dst) {
    if (src.length < 4) throw new Error('need ≥ 4 points');
    const Ts = normT(src), Td = normT(dst);
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
    const add = (row, b) => {
      for (let i = 0; i < 8; i++) { Atb[i] += row[i] * b; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; }
    };
    for (let i = 0; i < src.length; i++) {
      const [x, y] = applyH(Ts, src[i][0], src[i][1]), [u, v] = applyH(Td, dst[i][0], dst[i][1]);
      add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    const h = solve(AtA, Atb);
    const H = mul3(invert3(Td), mul3([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1], Ts));
    return H.map(v => v / H[8]);
  }

  // Least-squares similarity (rotation + uniform scale + translation) as a 3x3 matrix
  function similarityLS(src, dst) {
    const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0)), Atb = new Array(4).fill(0);
    const add = (row, b) => {
      for (let i = 0; i < 4; i++) { Atb[i] += row[i] * b; for (let j = 0; j < 4; j++) AtA[i][j] += row[i] * row[j]; }
    };
    for (let i = 0; i < src.length; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      add([x, -y, 1, 0], u);
      add([y, x, 0, 1], v);
    }
    const [a, b, c, d] = solve(AtA, Atb);
    return [a, -b, c, b, a, d, 0, 0, 1];
  }

  // Least-squares affine map as a 3x3 matrix (needs ≥ 3 non-collinear points)
  function affineLS(src, dst) {
    const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
    for (let i = 0; i < src.length; i++) {
      const r = [src[i][0], src[i][1], 1];
      for (let a = 0; a < 3; a++) { bu[a] += r[a] * dst[i][0]; bv[a] += r[a] * dst[i][1]; for (let b = 0; b < 3; b++) AtA[a][b] += r[a] * r[b]; }
    }
    const u = solve(AtA, bu), v = solve(AtA, bv);
    return [u[0], u[1], u[2], v[0], v[1], v[2], 0, 0, 1];
  }

  const api = { solve, homography, homographyLS, similarityLS, affineLS, applyH, invert3, mul3, warpPerspective };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OMRGeom = api;
})(typeof self !== 'undefined' ? self : this);
