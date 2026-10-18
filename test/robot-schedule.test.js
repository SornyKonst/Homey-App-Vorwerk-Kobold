'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobotSchedule } = require('../lib/robot-schedule');

function event(overrides = {}) {
  return { day: 4, startTime: '08:30', mode: 2,
    boundary: { id: 'PRIVATE_BOUNDARY', name: '  Flur  ' }, mapId: 'PRIVATE_MAP', ...overrides };
}

test('normalizes actual schedule fields without assuming weekday labels', () => {
  assert.deepEqual(normalizeRobotSchedule({ enabled: false,
    events: [event(), event({ day: 5, startTime: '09:05', mode: 1, boundary: { name: 'Küche' } })],
  }), { enabled: false, events: [
    { day: 4, time: '08:30', mode: 'turbo', area: 'Flur' },
    { day: 5, time: '09:05', mode: 'eco', area: 'Küche' },
  ] });
});

test('known empty schedule preserves false while missing lists remain unknown', () => {
  assert.deepEqual(normalizeRobotSchedule({ enabled: false, events: [] }), { enabled: false, events: [] });
  assert.deepEqual(normalizeRobotSchedule({ enabled: true }), { enabled: true, events: null });
  assert.deepEqual(normalizeRobotSchedule({ events: [] }), { enabled: null, events: [] });
});

test('malformed sources and non-array lists stay unknown', () => {
  for (const value of [undefined, null, false, true, 0, '', 'schedule', []]) {
    assert.deepEqual(normalizeRobotSchedule(value), { enabled: null, events: null });
  }
  for (const value of [null, false, 0, '', {}, '[]']) {
    assert.deepEqual(normalizeRobotSchedule({ enabled: false, events: value }), { enabled: false, events: null });
  }
  for (const value of ['false', 'true', 0, 1, null]) {
    assert.equal(normalizeRobotSchedule({ enabled: value, events: [] }).enabled, null);
  }
});

test('rejects an entire schedule with an invalid weekday instead of displaying a partial list', () => {
  for (const day of [99, 7, -1, 1.5, '4', true, false, null, undefined, NaN, Infinity]) {
    assert.deepEqual(normalizeRobotSchedule({ enabled: true,
      events: [event(), event({ day })] }), { enabled: true, events: null });
  }
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(normalizeRobotSchedule({ events: [event({ day })] }).events[0].day, day);
  }
});

test('clock accepts exact 24-hour HH:mm and rejects malformed or out-of-range values', () => {
  for (const startTime of ['00:00', '09:05', '12:00', '23:59']) {
    assert.equal(normalizeRobotSchedule({ events: [event({ startTime })] }).events[0].time, startTime);
  }
  for (const startTime of ['24:00', '23:60', '9:05', '09:5', '09:05:00', ' 09:05', '09:05 ',
    '09:05\n', '09:05Z', '00:-1', 900, false, null, undefined]) {
    assert.equal(normalizeRobotSchedule({ events: [event(), event({ startTime })] }).events, null);
  }
});

test('unknown mode remains unknown without discarding a valid scheduled event', () => {
  for (const mode of [undefined, null, false, true, 0, 3, -1, '1', '2', NaN]) {
    const normalized = normalizeRobotSchedule({ events: [event({ mode })] });
    assert.deepEqual(normalized.events, [{ day: 4, time: '08:30', mode: null, area: 'Flur' }]);
  }
});

test('missing or unsafe area labels become unknown without losing known day and time', () => {
  for (const boundary of [undefined, null, false, [], {}, { name: false }, { name: '' }, { name: '   ' },
    { name: 'x'.repeat(257) }, { name: 'Flur\n' }, { name: 'Flur\u007f' }, { name: 'Flur\u0085' },
    { name: '\u202eFlur' }, { name: '\ud800' }, { name: 'https://private.example/map' },
    { name: 'www.private.example' }]) {
    assert.equal(normalizeRobotSchedule({ events: [event({ boundary })] }).events[0].area, null);
  }
  assert.equal(normalizeRobotSchedule({ events: [event({ boundary: { name: 'Äußere Diele' } })] }).events[0].area,
    'Äußere Diele');
});

test('bounded schedule limit accepts 100 events and rejects larger or sparse malformed arrays', () => {
  assert.equal(normalizeRobotSchedule({ events: Array.from({ length: 100 }, () => event()) }).events.length, 100);
  assert.equal(normalizeRobotSchedule({ events: Array.from({ length: 101 }, () => event()) }).events, null);
  assert.equal(normalizeRobotSchedule({ events: new Array(1) }).events, null);
  for (const value of [undefined, null, false, 4, [], 'event']) {
    assert.equal(normalizeRobotSchedule({ events: [event(), value] }).events, null);
  }
});

test('output contains no identifiers, account data, geometry, unknown fields, or input references', () => {
  const source = { enabled: false, serial: 'PRIVATE_SERIAL', secret: 'PRIVATE_SECRET',
    url: 'https://private.example/account', events: [event({ unknown: 'PRIVATE_UNKNOWN',
      boundary: { id: 'PRIVATE_BOUNDARY', name: 'Flur', geometry: [[0, 1], [2, 3]],
        url: 'https://private.example/map' } })] };
  const before = JSON.stringify(source);
  const normalized = normalizeRobotSchedule(source);
  assert.deepEqual(Object.keys(normalized).sort(), ['enabled', 'events']);
  assert.deepEqual(Object.keys(normalized.events[0]).sort(), ['area', 'day', 'mode', 'time']);
  assert.equal(JSON.stringify(normalized).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(normalized).includes('https:'), false);
  assert.equal(JSON.stringify(source), before);
  normalized.events[0].area = 'Other';
  assert.equal(source.events[0].boundary.name, 'Flur');
});
