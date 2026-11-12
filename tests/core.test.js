// node tests/core.test.js
const assert = require('assert');
const G = require('../js/geom.js');
const T = require('../js/template.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// homography maps the 4 points exactly and its inverse round-trips
{
  const src = [[103, 57], [1890, 80], [1925, 1302], [70, 1270]];
  const dst = [[0, 0], [2000, 0], [2000, 1414], [0, 1414]];
  const H = G.homography(src, dst);
  src.forEach((p, i) => { const q = G.applyH(H, p[0], p[1]); near(q[0], dst[i][0], 1e-6); near(q[1], dst[i][1], 1e-6); });
  const Hi = G.invert3(H);
  const q = G.applyH(H, 700, 600), back = G.applyH(Hi, q[0], q[1]);
  near(back[0], 700, 1e-6); near(back[1], 600, 1e-6);
}

// warp with identity copies pixels; outside becomes white
{
  const w = 4, h = 3, src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { src[i * 4] = i * 10; src[i * 4 + 1] = 0; src[i * 4 + 2] = 255 - i; src[i * 4 + 3] = 255; }
  const out = G.warpPerspective(src, w, h, [1, 0, 0, 0, 1, 0, 0, 0, 1], w, h);
  for (let i = 0; i < w * h * 4; i++) assert.strictEqual(out[i], src[i]);
  const shifted = G.warpPerspective(src, w, h, [1, 0, 10, 0, 1, 0, 0, 0, 1], w, h);
  assert.strictEqual(shifted[0], 255);
}

// template expansion: counts and positions
{
  const spec = (x, y, dx, dy, extra) => Object.assign({ origin: { x, y }, dx, dy }, extra || {});
  const tpl = {
    canonical: { width: 2000, height: 1414 },
    anchors: { cornerSquare: { x: .02, y: .9, w: .02, h: .02 }, timingTrack: { y: .97, xStart: .03, xEnd: .97, barCount: 40 },
      frameTopLeft: { x: .4, y: .1 }, frameTopRight: { x: .98, y: .1 } },
    bubbleRadius: 0.007,
    fields: [
      Object.assign({ key: 'studentId', type: 'digits', columns: 5, rows: '0-9' }, spec(.05, .5, .02, .03)),
      Object.assign({ key: 'subjectCode', type: 'code', columns: [{ rows: T.SUBJECT_LETTERS }, { rows: '0-9' }, { rows: '0-9' }, { rows: '0-9' }, { rows: '0-9' }, { rows: '0-9' }] }, spec(.2, .5, .02, .03)),
      { key: 'answers', type: 'mcq', choices: 5, blocks: [
        Object.assign({ from: 1, to: 25 }, spec(.4, .1, .02, .03, { groupSize: 5, groupGap: .01 })),
        Object.assign({ from: 26, to: 50 }, spec(.55, .1, .02, .03)),
        Object.assign({ from: 51, to: 75 }, spec(.7, .1, .02, .03)),
        Object.assign({ from: 76, to: 100 }, spec(.85, .1, .02, .03)),
      ] },
    ],
  };
  const bs = T.bubbles(tpl);
  assert.strictEqual(bs.length, 50 + 11 + 50 + 500);
  const q6 = bs.find(b => b.q === 6 && b.choice === 4);  // row 5 → one group gap
  near(q6.x, .4 + 4 * .02); near(q6.y, .1 + 5 * .03 + .01);
  const q25 = bs.find(b => b.q === 25 && b.choice === 0); // row 24 → 4 group gaps
  near(q25.y, .1 + 24 * .03 + 4 * .01);
  const yo = bs.find(b => b.field === 'subjectCode' && b.col === 0 && b.value === 'ญ');
  near(yo.y, .5 + 10 * .03);
  assert.deepStrictEqual(T.validate(tpl), []);

  const empty = JSON.parse(JSON.stringify(tpl)); empty.fields[2].blocks[3].dx = 0; empty.anchors.timingTrack.barCount = 0;
  assert.strictEqual(T.validate(empty).length, 2);
}

console.log('all tests passed');

// the measured school template is complete and expands to every bubble
{
  const tpl = require('../templates/ayw-standard-100.json');
  assert.deepStrictEqual(T.validate(tpl), []);
  const bs = T.bubbles(tpl);
  assert.strictEqual(bs.length, 611);
  // answer rows of the 4 blocks are printed on the same baseline
  const ys = tpl.fields[2].blocks.map(b => b.origin.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1 / tpl.canonical.height * 2, 'answer blocks not row-aligned');
  // every column has its own timing bar, inside the track
  for (const f of tpl.fields) for (const s of f.type === 'mcq' ? f.blocks : [f])
    assert.ok(s.barStart >= 0 && s.barStart + 5 < tpl.anchors.timingTrack.barCount);
  // bubbles stay on the canvas and do not overlap
  const r = tpl.bubbleRadius;
  bs.forEach(b => assert.ok(b.x > 0 && b.x < 1 && b.y > 0 && b.y < 1));
  assert.ok(tpl.fields[2].blocks.every(b => b.dx > 2 * r));
}
console.log('template file ok');
