'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobotModel, getHouseCleaningService, getRobotSupport } = require('../lib/robot-support');

test('model recognition accepts marketed variants and the VR300 firmware alias without guessing from other numbers', () => {
  for (const value of ['VR200', ' vr 200 ', 'Vorwerk Kobold VR_200', 'Kobold VR-200']) {
    assert.equal(normalizeRobotModel(value), 'VR200');
  }
  for (const value of ['VR300', 'VR220', 'Vorwerk Kobold VR 220']) assert.equal(normalizeRobotModel(value), 'VR300');
  for (const value of [undefined, null, 200, {}, 'VR2000', 'serial-200', 'VR200-unverified', 'VR200\n', 'x'.repeat(129)]) {
    assert.equal(normalizeRobotModel(value), null);
  }
});

test('support uses discovery identity before firmware metadata and keeps unknown existing installations compatible', () => {
  assert.equal(getRobotSupport({ model: 'VR300' }, { meta: { modelName: 'VR200' } }).model, 'VR300');
  assert.equal(getRobotSupport({}, { meta: { modelName: 'VR220' } }).model, 'VR300');
  const unknown = getRobotSupport({ serial: 'VR200-untrusted-serial' });
  assert.deepEqual(unknown, { model: null, areas: true, history: true, maps: true, generalInfo: true, navigation: true });
  unknown.maps = false;
  assert.equal(getRobotSupport({}).maps, true, 'Callers must not be able to mutate subsequent support results');
});

test('VR200 and basic-1 responses disable advanced features even when stale model or service data suggests otherwise', () => {
  const disabled = { areas: false, history: false, maps: false, generalInfo: false, navigation: false };
  assert.deepEqual(getRobotSupport({ model: 'VR200' }, { availableServices: { houseCleaning: 'basic-4' } }),
    { model: 'VR200', ...disabled });
  assert.deepEqual(getRobotSupport({ model: 'VR300', availableServices: { houseCleaning: 'basic-4' } },
    { availableServices: { houseCleaning: 'basic-1' } }), { model: 'VR300', ...disabled });
  assert.deepEqual(getRobotSupport({}, { meta: { modelName: 'VR200' } }), { model: 'VR200', ...disabled });
});

test('fresh service versions take precedence and unsupported version labels do not become a supported protocol', () => {
  const robot = { availableServices: { houseCleaning: 'basic-1' } };
  assert.equal(getHouseCleaningService(robot), 'basic-1');
  assert.equal(getHouseCleaningService(robot, { availableServices: { houseCleaning: 'basic-4' } }), 'basic-4');
  for (const version of ['basic-999', 'basic-1\n', true, 1]) {
    assert.equal(getHouseCleaningService(robot, { availableServices: { houseCleaning: version } }), null);
  }
});

test('VR200 general information is offered only when the live response explicitly advertises a supported service', () => {
  for (const service of ['basic-1', 'basic-2', 'basic-3', 'basic-4']) {
    const support = getRobotSupport({ model: 'VR200' }, { availableServices: { generalInfo: service } });
    assert.equal(support.generalInfo, true);
    assert.equal(support.areas, false);
    assert.equal(support.history, false);
    assert.equal(support.navigation, false);
  }
  for (const service of [undefined, 'basic-999', true]) {
    assert.equal(getRobotSupport({ model: 'VR200' }, { availableServices: { generalInfo: service } }).generalInfo, false);
  }
});
