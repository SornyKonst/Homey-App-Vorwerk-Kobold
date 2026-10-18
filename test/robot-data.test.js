'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobotData } = require('../lib/robot-data');

const EMPTY = {
  cleaningMode: null, navigationMode: null, scheduleEnabled: null,
  firmware: null, model: null, chargeCount: null, area: null,
  warningCode: null, batteryVendor: null, batteryManufacturingDate: null, productNumber: null,
};

test('missing and malformed containers yield unknown data instead of invented defaults', () => {
  for (const value of [undefined, null, false, 0, '', [], 'invalid']) {
    assert.deepEqual(normalizeRobotData(value, value), EMPTY);
  }
  assert.deepEqual(normalizeRobotData({ cleaning: [], details: false, meta: null }, { battery: [] }), EMPTY);
});

test('maps strict cleaning and navigation enums and preserves false schedule state', () => {
  assert.deepEqual(normalizeRobotData({
    cleaning: { mode: 1, navigationMode: 1 }, details: { isScheduleEnabled: false },
  }), { ...EMPTY, cleaningMode: 'eco', navigationMode: 'normal', scheduleEnabled: false });
  assert.equal(normalizeRobotData({ cleaning: { mode: 2, navigationMode: 2 } }).cleaningMode, 'turbo');
  assert.equal(normalizeRobotData({ cleaning: { navigationMode: 2 } }).navigationMode, 'extra_care');
  assert.equal(normalizeRobotData({ cleaning: { navigationMode: 3 } }).navigationMode, 'deep');
  assert.equal(normalizeRobotData({ details: { isScheduleEnabled: true } }).scheduleEnabled, true);
});

test('string numbers, booleans and unsupported mode values stay unknown', () => {
  for (const value of ['1', '2', false, true, 0, null, 4, -1, NaN, Infinity]) {
    const normalized = normalizeRobotData({ cleaning: { mode: value, navigationMode: value },
      details: { isScheduleEnabled: value } });
    assert.equal(normalized.cleaningMode, null);
    assert.equal(normalized.navigationMode, null);
    assert.equal(normalized.scheduleEnabled, typeof value === 'boolean' ? value : null);
  }
});

test('general information takes precedence and metadata supplies safe fallbacks', () => {
  const raw = { meta: { modelName: 'VR220', firmware: '4.6.5-4' } };
  assert.equal(normalizeRobotData(raw).model, 'VR220');
  assert.equal(normalizeRobotData(raw).firmware, '4.6.5-4');
  const normalized = normalizeRobotData(raw, { model: 'VR300', firmware: 'v5.1.0-rc1' });
  assert.equal(normalized.model, 'VR300');
  assert.equal(normalized.firmware, 'v5.1.0-rc1');
  assert.equal(normalizeRobotData(raw, { model: false, firmware: 'https://private.example/secret' }).firmware, '4.6.5-4');
  assert.equal(normalizeRobotData(raw, { model: '', firmware: false }).model, 'VR220');
});

test('charge count retains zero and verified integers without interpreting them as full cycles', () => {
  for (const value of [0, 1135, 1e9]) {
    assert.equal(normalizeRobotData({}, { battery: { totalCharges: value } }).chargeCount, value);
  }
  for (const value of [false, true, null, '', '1135', -1, 1.5, 1e9 + 1, NaN, Infinity]) {
    assert.equal(normalizeRobotData({}, { battery: { totalCharges: value } }).chargeCount, null);
  }
});

test('area name is only exposed during busy or paused jobs, never as a stale idle area', () => {
  for (const state of [2, 3]) {
    assert.equal(normalizeRobotData({ state, cleaning: { boundary: { name: '  Flur  ' } } }).area, 'Flur');
  }
  for (const state of [undefined, 0, 1, 4, '2', true]) {
    assert.equal(normalizeRobotData({ state, cleaning: { boundary: { name: 'Flur' } } }).area, null);
  }
});

test('warning sentinel and invalid warning values remain absent', () => {
  for (const value of [undefined, null, '', '  ', 'ui_alert_invalid', false, 0,
    'https://private.example/error', 'malformed error', 'x'.repeat(81)]) {
    assert.equal(normalizeRobotData({ alert: value }).warningCode, null);
  }
  assert.equal(normalizeRobotData({ alert: 'maint_filter_change' }).warningCode, 'maint_filter_change');
  assert.equal(normalizeRobotData({ alert: 'clean_completed_to_start' }).warningCode, 'clean_completed_to_start');
});

test('calendar date validation handles leap years and normalizes unpadded dates', () => {
  for (const [value, expected] of [['2018-3-1', '2018-03-01'], ['2024-02-29', '2024-02-29'],
    ['2000-2-29', '2000-02-29'], ['2020-12-31', '2020-12-31']]) {
    assert.equal(normalizeRobotData({}, { battery: { manufacturingDate: value } }).batteryManufacturingDate, expected);
  }
  for (const value of ['1900-02-29', '2023-2-29', '2024-4-31', '2024-13-1', '2024-0-1',
    '2024-1-0', '0000-1-1', '24-1-1', '2024/1/1', '2024-1-1T00:00:00Z', false, 0, null]) {
    assert.equal(normalizeRobotData({}, { battery: { manufacturingDate: value } }).batteryManufacturingDate, null);
  }
});

test('bounded printable metadata accepts readable vendor and product labels', () => {
  const normalized = normalizeRobotData({}, {
    model: 'VR220', firmware: '4.6.5-4', productNumber: ' 12345678 ',
    battery: { vendor: '  Example Battery  ', manufacturingDate: '2018-03-01' },
  });
  assert.equal(normalized.productNumber, '12345678');
  assert.equal(normalized.batteryVendor, 'Example Battery');
  assert.equal(normalizeRobotData({}, { battery: { vendor: 'Hersteller Ä' } }).batteryVendor, 'Hersteller Ä');
});

test('metadata rejects control characters, bidi formatting, surrogates, URLs and oversized fields', () => {
  for (const value of ['secret\nvalue', 'secret\tvalue', 'secret\u007f', 'secret\u0085',
    'secret\u202evalue', 'secret\ud800', 'https://private.example/token', 'www.private.example', 'x'.repeat(65)]) {
    const normalized = normalizeRobotData({ state: 2, cleaning: { boundary: { name: value } } }, {
      model: value, firmware: value, productNumber: value, battery: { vendor: value },
    });
    assert.equal(normalized.model, null);
    assert.equal(normalized.firmware, null);
    assert.equal(normalized.productNumber, null);
    assert.equal(normalized.batteryVendor, null);
    if (value.length <= 64) assert.equal(normalized.area, null);
  }
  assert.equal(normalizeRobotData({ state: 2, cleaning: { boundary: { name: 'x'.repeat(257) } } }).area, null);
});

test('output whitelist excludes identities, geometry, unknown fields and unverified battery-time units', () => {
  const raw = {
    state: 2, serial: 'PRIVATE_SERIAL', secret: 'PRIVATE_SECRET', endpoint: 'https://private.example',
    cleaning: { mode: 2, navigationMode: 1, mapId: 'PRIVATE_MAP', boundaryId: 'PRIVATE_BOUNDARY',
      boundary: { id: 'PRIVATE_BOUNDARY', name: 'Flur', polygon: [[1, 2]] } },
    details: { isScheduleEnabled: false }, meta: { firmware: '4.6.5-4', modelName: 'VR220', unknown: 'PRIVATE_VALUE' },
  };
  const info = { serial: 'PRIVATE_SERIAL', battery: { serial: 'PRIVATE_BATTERY', totalCharges: 0,
    timeToEmpty: 65535, timeToFullCharge: 24, authorizationStatus: 1 }, unknown: 'PRIVATE_VALUE' };
  const before = JSON.stringify({ raw, info });
  const normalized = normalizeRobotData(raw, info);
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(EMPTY).sort());
  assert.equal(JSON.stringify(normalized).includes('PRIVATE_'), false);
  assert.equal('timeToEmpty' in normalized, false);
  assert.equal('timeToFullCharge' in normalized, false);
  assert.equal(JSON.stringify({ raw, info }), before);
});
