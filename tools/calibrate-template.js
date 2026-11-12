#!/usr/bin/env node
/* Refine the student-ID, subject-code and timing-track geometry of a template from real photos.
 *
 * The answer blocks (500 rings, measured from the blank sheet) define the reference frame:
 * for every photo a homography canonical→paper-frame is fitted on the answer-block rings only,
 * then the measured ID / subject rings and the timing bars are mapped back into canonical space
 * and averaged over all photos.
 *
 * usage: node tools/calibrate-template.js [templates/ayw-standard-100.json] [Sample] [--write]
 * needs Sample/.cache from tools/prepare-samples.py
 */
const fs = require('fs'), path = require('path');
const G = require('../js/geom.js'), T = require('../js/template.js'), OS = require('../js/scan.js');

const args = process.argv.slice(2), write = args.includes('--write');
const pos = args.filter(a => !a.startsWith('--'));
const tplPath = pos[0] || path.join(__dirname, '..', 'templates', 'ayw-standard-100.json');
const dir = pos[1] || path.join(__dirname, '..', 'Sample');
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'index.json'), 'utf8'));
const Wc = tpl.canonical.width, Hc = tpl.canonical.height;
const bubbles = T.bubbles(tpl);

const acc = bubbles.map(() => []), bars = {}, squares = [];
let used = 0;
for (const [name, meta] of Object.entries(index)) {
  const buf = fs.readFileSync(path.join(dir, '.cache', name + '.rgba'));
  const r = OS.scanSheet({ width: meta.width, height: meta.height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) }, tpl);
  if (!r.ok) { console.log(name, 'skipped:', r.error); continue; }
  const rings = r.debug.pfRings;
  const ans = bubbles.map((b, i) => [b, rings[i]]).filter(([b, m]) => b.field === 'answers' && m[2] > 0);
  let H = G.homographyLS(ans.map(([b]) => [b.x * Wc, b.y * Hc]), ans.map(([, m]) => [m[0], m[1]]));
  const res = ([b, m]) => { const p = G.applyH(H, b.x * Wc, b.y * Hc); return Math.hypot(p[0] - m[0], p[1] - m[1]); };
  const keep = ans.filter(a => res(a) < 2.5);
  H = G.homographyLS(keep.map(([b]) => [b.x * Wc, b.y * Hc]), keep.map(([, m]) => [m[0], m[1]]));
  const Hi = G.invert3(H);
  bubbles.forEach((b, i) => { if (b.field !== 'answers' && rings[i][2] > 0) acc[i].push(G.applyH(Hi, rings[i][0], rings[i][1])); });
  for (const [k, x, y] of r.debug.pfBars) (bars[k] = bars[k] || []).push(G.applyH(Hi, x, y));
  if (r.debug.pfSquare) squares.push(G.applyH(Hi, r.debug.pfSquare[0], r.debug.pfSquare[1]));
  used++;
  console.log(name, `answer-frame fit on ${keep.length} rings`);
}
if (used < 2) { console.error('need at least 2 readable photos'); process.exit(1); }

const mean = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
// least squares x = ox + c·dx, y = oy + r·dy
function fitGrid(field) {
  const f = tpl.fields.find(q => q.key === field);
  const pts = [];
  bubbles.forEach((b, i) => {
    if (b.field !== field || acc[i].length < 2) return;
    const off = f.type === 'code' ? (f.columns[b.col].rowOffset || 0) : 0;
    pts.push({ c: b.col, r: b.row + off, p: mean(acc[i]) });
  });
  const lin = (u, v) => { const n = u.length, mu = u.reduce((a, b) => a + b) / n, mv = v.reduce((a, b) => a + b) / n;
    let num = 0, den = 0; u.forEach((x, i) => { num += (x - mu) * (v[i] - mv); den += (x - mu) ** 2; }); const k = num / den; return [mv - k * mu, k]; };
  const [ox, dx] = lin(pts.map(q => q.c), pts.map(q => q.p[0]));
  const [oy, dy] = lin(pts.map(q => q.r), pts.map(q => q.p[1]));
  const rms = Math.sqrt(pts.reduce((s, q) => s + (ox + q.c * dx - q.p[0]) ** 2 + (oy + q.r * dy - q.p[1]) ** 2, 0) / pts.length);
  const old = [f.origin.x * Wc, f.origin.y * Hc, f.dx * Wc, f.dy * Hc];
  console.log(`${field}: ${pts.length} rings, fit rms ${rms.toFixed(2)} px | origin (${old[0].toFixed(1)}, ${old[1].toFixed(1)}) → (${ox.toFixed(1)}, ${oy.toFixed(1)}) | dx ${old[2].toFixed(2)} → ${dx.toFixed(2)} | dy ${old[3].toFixed(2)} → ${dy.toFixed(2)}`);
  f.origin = { x: +(ox / Wc).toFixed(6), y: +(oy / Hc).toFixed(6) }; f.dx = +(dx / Wc).toFixed(6); f.dy = +(dy / Hc).toFixed(6);
}
fitGrid('studentId');
fitGrid('subjectCode');

const tt = tpl.anchors.timingTrack, N = tt.barCount;
const bk = Object.keys(bars).map(Number).filter(k => bars[k].length >= 2);
const bm = bk.map(k => mean(bars[k]));
{
  const n = bk.length, mk = bk.reduce((a, b) => a + b) / n, mx = bm.reduce((a, p) => a + p[0], 0) / n;
  let num = 0, den = 0; bk.forEach((k, i) => { num += (k - mk) * (bm[i][0] - mx); den += (k - mk) ** 2; });
  const step = num / den, x0 = mx - step * mk, y = bm.reduce((a, p) => a + p[1], 0) / n;
  console.log(`timing: ${n} bars | xStart ${(tt.xStart * Wc).toFixed(1)} → ${x0.toFixed(1)} | xEnd ${(tt.xEnd * Wc).toFixed(1)} → ${(x0 + step * (N - 1)).toFixed(1)} | y ${(tt.y * Hc).toFixed(1)} → ${y.toFixed(1)}`);
  tt.xStart = +(x0 / Wc).toFixed(6); tt.xEnd = +((x0 + step * (N - 1)) / Wc).toFixed(6); tt.y = +(y / Hc).toFixed(6);
}
if (squares.length >= 2) {
  const cs = tpl.anchors.cornerSquare, [cx, cy] = mean(squares);
  const ox = (cs.x + cs.w / 2) * Wc, oy = (cs.y + cs.h / 2) * Hc;
  console.log(`corner square centre: (${ox.toFixed(1)}, ${oy.toFixed(1)}) → (${cx.toFixed(1)}, ${cy.toFixed(1)}) from ${squares.length} photos`);
  cs.x = +((cx / Wc) - cs.w / 2).toFixed(6); cs.y = +((cy / Hc) - cs.h / 2).toFixed(6);
}
tpl.source = Object.assign({}, tpl.source, {
  calibration: `studentId, subjectCode และแถบ timing ปรับเทียบจากภาพถ่ายจริง ${used} แผ่น (tools/calibrate-template.js) โดยยึดบล็อกคำตอบเป็นกรอบอ้างอิง`,
});
if (write) { fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2) + '\n'); console.log('written', tplPath); }
else console.log('(dry run — add --write to save)');
