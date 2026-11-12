// node tests/scan.test.js   (needs Sample/.cache from: python3 tools/prepare-samples.py)
// Reads every sample photo and checks it against Sample/expected.json, also under
// half resolution, 180° rotation and a synthetic ~25° camera tilt.
const fs = require('fs'), path = require('path'), assert = require('assert');
const G = require('../js/geom.js'), OS = require('../js/scan.js');
const tpl = require('../templates/ayw-standard-100.json');
const dir = path.join(__dirname, '..', 'Sample'), cache = path.join(dir, '.cache');
if (!fs.existsSync(path.join(cache, 'index.json'))) { console.log('skip: run python3 tools/prepare-samples.py first'); process.exit(0); }
const index = require(path.join(cache, 'index.json')), expected = require(path.join(dir, 'expected.json'));

const load = name => { const m = index[name], b = fs.readFileSync(path.join(cache, name + '.rgba')); return { width: m.width, height: m.height, data: new Uint8ClampedArray(b.buffer, b.byteOffset, b.length) }; };
const half = img => {
  const w = img.width >> 1, h = img.height >> 1, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) {
    const s = (i, j) => img.data[((2 * y + j) * img.width + 2 * x + i) * 4 + k];
    d[(y * w + x) * 4 + k] = (s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1)) >> 2;
  }
  return { width: w, height: h, data: d };
};
const rot180 = img => {
  const d = new Uint8ClampedArray(img.data.length), n = img.width * img.height;
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) d[(n - 1 - i) * 4 + k] = img.data[i * 4 + k];
  return { width: img.width, height: img.height, data: d };
};
// view from a camera tilted toward the top of the sheet: top edge shrinks (keystone ≈ 25°);
// the area uncovered by the warp is filled with a wood colour, as a real desk would be
const tilt = img => {
  const W = img.width, H = img.height, k = 0.12 * W;
  const Hd2s = G.homography([[k, 0], [W - k, 0], [W, H], [0, H]], [[0, 0], [W, 0], [W, H], [0, H]]);
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sx, sy] = G.applyH(Hd2s, x + 0.5, y + 0.5), xi = sx | 0, yi = sy | 0, o = (y * W + x) * 4;
    if (sx < 0 || sy < 0 || xi >= W || yi >= H) { d[o] = 125; d[o + 1] = 92; d[o + 2] = 50; d[o + 3] = 255; continue; }
    const s = (yi * W + xi) * 4; d[o] = img.data[s]; d[o + 1] = img.data[s + 1]; d[o + 2] = img.data[s + 2]; d[o + 3] = 255;
  }
  return { width: W, height: H, data: d };
};

const letters = 'ABCDE';
let checks = 0, worst = 0;
for (const [name, exp] of Object.entries(expected)) {
  if (name.startsWith('_') || exp.isKey || !index[name]) continue;
  const base = load(name);
  for (const [variant, img] of [['full', base], ['half', half(base)], ['rot180', rot180(base)], ['tilt', tilt(base)]]) {
    const r = OS.scanSheet(img, tpl);
    const tag = `${name}/${variant}`;
    assert.ok(r.ok, `${tag}: ${r.error}`);
    assert.strictEqual(r.studentId.value, exp.studentId, `${tag} studentId`);
    assert.strictEqual(r.subjectCode.value, exp.subjectCode, `${tag} subjectCode`);
    r.answers.forEach((a, i) => {
      if (i < exp.answers.length) {
        assert.strictEqual(a.status, 'ok', `${tag} q${a.q} status ${a.status}`);
        assert.strictEqual(letters[a.choice], exp.answers[i], `${tag} q${a.q}`);
      } else assert.strictEqual(a.status, 'blank', `${tag} q${a.q} should be blank, got ${a.status}`);
    });
    for (const q of exp.erased || []) assert.strictEqual(r.answers[q - 1].note, 'erased', `${tag} q${q} erased note`);
    assert.strictEqual(r.rotated, variant === 'rot180', `${tag} rotation`);
    worst = Math.max(worst, r.timing.total); checks++;
    console.log(`ok ${tag.padEnd(18)} ${Math.round(r.timing.total)} ms`);
  }
}
// scanning the key sheet gives the key, and grading every sheet with it reproduces the teacher's score
{
  const keyName = Object.keys(expected).find(k => expected[k].isKey && index[k]);
  if (keyName) {
    const k = OS.scanSheet(load(keyName), tpl);
    assert.ok(k.ok, 'key: ' + k.error);
    assert.strictEqual(k.subjectCode.value, expected[keyName].subjectCode, 'key subjectCode');
    const keyStr = expected[keyName].answers;
    keyStr.split('').forEach((c, i) => assert.strictEqual(letters[k.answers[i].choice], c, `key q${i + 1}`));
    assert.ok(k.answers.slice(keyStr.length).every(a => a.status === 'blank'), 'key: questions after the key must be blank');
    for (const [name, exp] of Object.entries(expected)) {
      if (name.startsWith('_') || exp.isKey || exp.scoreOnSheet == null || !index[name]) continue;
      const r = OS.scanSheet(load(name), tpl);
      const score = r.answers.slice(0, keyStr.length).filter((a, i) => a.status === 'ok' && a.choice === k.answers[i].choice).length;
      assert.strictEqual(score, exp.scoreOnSheet, `${name}: score ${score} vs teacher ${exp.scoreOnSheet}`);
      console.log(`ok ${name} score ${score}/${keyStr.length} = teacher's score`);
    }
  }
}

// "no silent misread": a template whose answer block is off by one whole row (or column) must be
// rejected, never read with every answer shifted to the neighbouring question/choice
{
  const name = Object.keys(expected).find(k => !k.startsWith('_') && index[k]);
  const img = half(load(name));
  for (const [what, mutate] of [
    ['row', b => { b.origin.y += b.dy; }],
    ['column', b => { b.origin.x += b.dx; }],
  ]) {
    const bad = JSON.parse(JSON.stringify(tpl));
    mutate(bad.fields.find(f => f.key === 'answers').blocks[0]);
    const r = OS.scanSheet(img, bad);
    if (r.ok) {
      const exp = expected[name].answers;
      const same = r.answers.slice(0, 25).every((a, i) => a.status === 'ok' && letters[a.choice] === exp[i]);
      assert.ok(same, `template off by one ${what}: read wrong answers without an error`);
    }
    console.log(`ok template off by one ${what} → ${r.ok ? 'still read correctly' : 'rejected: ' + r.error}`);
  }
}
console.log(`scan tests passed: ${checks} readings, slowest ${Math.round(worst)} ms`);
