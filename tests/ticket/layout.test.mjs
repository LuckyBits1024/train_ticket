import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stationLayout,
  wrapNameLines,
  dateRuns,
  sanitizeFileName,
  drawRuns,
} from '../../public/js/ticket/layout.js';

const ctx = {
  font: '',
  textAlign: 'left',
  fillStyle: '#000',
  measureText(text) {
    return { width: String(text).length * 10, actualBoundingBoxDescent: 2 };
  },
  fillText() {},
};

test('station layout follows the 12306 formulas', () => {
  assert.deepEqual(stationLayout('start', '北京南', 60), { x: 60, target: 160, suffixX: 225 });
  assert.deepEqual(stationLayout('start', '北京朝阳', 60), {
    x: 45,
    target: 190,
    suffixX: 258,
  });
  assert.deepEqual(stationLayout('end', '天津西', 550), { x: 550, target: 160, suffixX: 715 });
  assert.deepEqual(stationLayout('end', '北京朝阳', 550), {
    x: 530,
    target: 190,
    suffixX: 740,
  });
});

test('name wrap balances two lines', () => {
  const lines = wrapNameLines(ctx, '李某某某某某某', 40);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.length * 10 <= 40));
});

test('date runs insert a 12px spacer before time', () => {
  const runs = dateRuns('2026-09-16', '10:24');
  assert.equal(runs.length, 9);
  assert.deepEqual(runs[6], { text: '', gap: 12 });
  assert.equal(runs[7].text, '10:24');
});

test('fileName is sanitized and bounded', () => {
  const name = sanitizeFileName('a/b:c*?"<>|' + 'x'.repeat(200));
  assert.ok(!/[\\/:*?"<>|]/.test(name));
  assert.ok(name.length <= 120);
});

test('drawRuns advances through spacer', () => {
  const calls = [];
  const local = { ...ctx, fillText(text, x) { calls.push([text, x]); } };
  drawRuns(local, [{ text: 'A', size: 10, family: 'Arial' }, { text: '', gap: 12 }, { text: 'B', size: 10, family: 'Arial' }], 0, 0, 5);
  assert.deepEqual(calls.map(([text]) => text), ['A', 'B']);
  assert.equal(calls[1][1], 27);
});
