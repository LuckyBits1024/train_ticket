import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demoDraft,
  normalizeCoach,
  normalizePrice,
  normalizeSeat,
  normalizeTicket,
  maskIdentity,
} from '../../public/js/ticket/validate.js';

test('demo draft is exportable', () => {
  const { value, errors } = normalizeTicket(demoDraft());
  assert.deepEqual(errors, {});
  assert.equal(value.startStation, '北京南');
  assert.equal(value.endStation, '天津西');
  assert.equal(value.trainNo, 'G2884');
  assert.equal(value.price, '381.0');
  assert.equal(value.identity, '110101********1234');
});

test('maskIdentity keeps 6 + 4 for long ids', () => {
  assert.equal(maskIdentity('110101199001011234'), '110101********1234');
  assert.equal(maskIdentity('110101********1234'), '110101********1234');
  assert.equal(maskIdentity('123456'), '******');
});

test('normalizeTicket reports missing required fields', () => {
  const { errors } = normalizeTicket({});
  assert.ok(errors.startStation);
  assert.ok(errors.endStation);
  assert.ok(errors.trainNo);
  assert.ok(errors.date);
});

test('coach / seat / price rules', () => {
  assert.deepEqual(normalizeCoach('3'), { value: '03', error: '' });
  assert.equal(normalizeCoach('100').error.length > 0, true);
  assert.deepEqual(normalizeSeat('11f'), { value: '11F', error: '' });
  assert.deepEqual(normalizeSeat('无座'), { value: '无座', error: '' });
  assert.equal(normalizeSeat('A1').error.length > 0, true);
  assert.deepEqual(normalizePrice('381'), { value: '381.0', error: '' });
  assert.equal(normalizePrice('-1').error.length > 0, true);
});

test('invalid date is rejected', () => {
  const { errors } = normalizeTicket({ ...demoDraft(), date: '2026-02-31' });
  assert.ok(errors.date);
});
