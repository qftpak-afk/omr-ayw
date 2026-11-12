/* OMR AYW — template helpers
 * ขยาย template JSON (normalized 0–1) เป็นรายการวงทั้งหมด + ตรวจความครบถ้วน
 * Browser: window.OMRTemplate · Node: module.exports
 *
 * ตำแหน่งแถว r (เริ่ม 0) ของบล็อก/ช่อง:
 *   y = origin.y + r*dy + floor(r / groupSize) * groupGap   (groupSize = 0 → ไม่มีช่องว่างระหว่างกลุ่ม)
 *   x = origin.x + c*dx
 */
(function (root) {
  'use strict';

  const SUBJECT_LETTERS = ['ท', 'ค', 'ว', 'ส', 'พ', 'ศ', 'ง', 'อ', 'ฝ', 'จ', 'ญ'];

  function expandRows(rows) {
    if (Array.isArray(rows)) return rows;
    const m = /^(\d)-(\d)$/.exec(String(rows));
    if (!m) throw new Error('rows ไม่ถูกรูปแบบ: ' + rows);
    const out = [];
    for (let i = +m[1]; i <= +m[2]; i++) out.push(String(i));
    return out;
  }

  function rowY(spec, r) {
    const g = spec.groupSize | 0;
    return spec.origin.y + r * spec.dy + (g > 0 ? Math.floor(r / g) * (spec.groupGap || 0) : 0);
  }

  // คืนรายการวงทั้งหมด (พิกัด normalized)
  function bubbles(tpl) {
    const out = [];
    for (const f of tpl.fields) {
      if (f.type === 'digits') {
        const rows = expandRows(f.rows);
        for (let c = 0; c < f.columns; c++)
          for (let r = 0; r < rows.length; r++)
            out.push({ field: f.key, col: c, row: r, value: rows[r], x: f.origin.x + c * f.dx, y: rowY(f, r) });
      } else if (f.type === 'code') {
        f.columns.forEach((col, c) => {
          const rows = expandRows(col.rows);
          const off = col.rowOffset || 0;
          for (let r = 0; r < rows.length; r++)
            out.push({ field: f.key, col: c, row: r, value: rows[r], x: f.origin.x + c * f.dx, y: rowY(f, r + off) });
        });
      } else if (f.type === 'mcq') {
        f.blocks.forEach((b, bi) => {
          const n = b.to - b.from + 1;
          for (let i = 0; i < n; i++)
            for (let c = 0; c < f.choices; c++)
              out.push({ field: f.key, block: bi, q: b.from + i, choice: c, x: b.origin.x + c * b.dx, y: rowY(b, i) });
        });
      }
    }
    return out;
  }

  // ตรวจว่า template วัดครบหรือยัง คืนรายการปัญหา (ว่าง = ครบ)
  function validate(tpl) {
    const p = [];
    const pos = v => typeof v === 'number' && v > 0;
    const pt = o => o && pos(o.x) && pos(o.y);
    if (!tpl.canonical || !pos(tpl.canonical.width) || !pos(tpl.canonical.height)) p.push('ยังไม่มีขนาด canonical');
    const a = tpl.anchors || {};
    if (!a.cornerSquare || !pos(a.cornerSquare.w) || !pos(a.cornerSquare.h)) p.push('ยังไม่ได้วัดสี่เหลี่ยมดำมุมซ้ายล่าง');
    if (!a.timingTrack || !pos(a.timingTrack.xEnd) || !(a.timingTrack.barCount > 1)) p.push('ยังไม่ได้วัดแถบ timing (หรือจำนวนแท่งยังเป็น 0)');
    if (!pt(a.frameTopLeft) || !pt(a.frameTopRight)) p.push('ยังไม่ได้วัดมุมบนของกรอบตาราง');
    if (!pos(tpl.bubbleRadius)) p.push('ยังไม่ได้กำหนดรัศมีวง');
    for (const f of tpl.fields || []) {
      const specs = f.type === 'mcq' ? f.blocks.map(b => [b, `ข้อ ${b.from}–${b.to}`]) : [[f, f.key]];
      for (const [s, name] of specs)
        if (!pt(s.origin) || !pos(s.dx) || !pos(s.dy)) p.push(`ยังไม่ได้วัดตำแหน่งวง: ${name}`);
    }
    return p;
  }

  const api = { SUBJECT_LETTERS, expandRows, rowY, bubbles, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OMRTemplate = api;
})(typeof self !== 'undefined' ? self : this);
