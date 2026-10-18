'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobotState } = require('../lib/robot-state');

function robotState(overrides = {}) {
  return {
    result: 'ok',
    state: 1,
    action: 0,
    error: null,
    details: { charge: 83, isCharging: false, isDocked: false },
    availableCommands: { start: true },
    ...overrides,
  };
}

test('docked and charging are distinct Homey activities and retain both flags', () => {
  const snapshot = normalizeRobotState(robotState({
    details: { charge: 56, isCharging: true, isDocked: true },
  }));
  assert.deepEqual(snapshot, {
    state: 'charging',
    vacuumState: 'charging',
    battery: 56,
    charging: true,
    docked: true,
    errorCode: null,
    statusKey: 'charging',
    availableCommands: { start: true, stop: false, pause: false, resume: false, goToBase: false },
  });
  const docked = normalizeRobotState(robotState({
    details: { charge: 100, isCharging: false, isDocked: true },
  }));
  assert.equal(docked.state, 'docked');
  assert.equal(docked.vacuumState, 'docked');
});

test('busy suspended actions are paused at low and high battery levels', () => {
  for (const action of [6, 15]) {
    for (const charge of [1, 99]) {
      const snapshot = normalizeRobotState(robotState({
        state: 2,
        action,
        details: { charge },
        availableCommands: { resume: true, stop: true },
      }));
      assert.equal(snapshot.state, 'paused');
      assert.equal(snapshot.vacuumState, 'stopped');
      assert.equal(snapshot.availableCommands.resume, true);
      assert.equal(snapshot.availableCommands.start, false);
    }
  }
});

test('known active actions clean, docking returns, and maintenance stays busy', () => {
  for (const action of [1, 2, 3, 11, 12]) {
    const snapshot = normalizeRobotState(robotState({ state: 2, action }));
    assert.equal(snapshot.state, 'cleaning');
    assert.equal(snapshot.vacuumState, action === 2 ? 'spot_cleaning' : 'cleaning');
  }
  const returning = normalizeRobotState(robotState({ state: 2, action: 4 }));
  assert.equal(returning.state, 'returning');
  assert.equal(returning.vacuumState, 'stopped');
  for (const action of [0, 5, 7, 8, 9, 10, 13, 14, 99]) {
    const snapshot = normalizeRobotState(robotState({ state: 2, action }));
    assert.equal(snapshot.state, 'busy');
    assert.equal(snapshot.vacuumState, 'stopped');
  }
});

test('explicit pause and idle are represented without inferring commands', () => {
  const paused = normalizeRobotState(robotState({ state: 3, action: 1, availableCommands: {} }));
  assert.equal(paused.state, 'paused');
  assert.deepEqual(paused.availableCommands, {
    start: false, stop: false, pause: false, resume: false, goToBase: false,
  });
  assert.equal(normalizeRobotState(robotState()).state, 'idle');
});

test('actual errors win dock/charge flags while the legacy sentinel is ignored', () => {
  const snapshot = normalizeRobotState(robotState({
    error: 'ui_error_brush_stuck',
    details: { charge: 90, isCharging: true, isDocked: true },
  }));
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.statusKey, 'error');
  assert.equal(snapshot.vacuumState, 'stopped');
  assert.equal(snapshot.errorCode, 'ui_error_brush_stuck');
  assert.equal(snapshot.charging, true);
  assert.equal(snapshot.docked, true);

  const healthy = normalizeRobotState(robotState({ error: 'ui_alert_invalid' }));
  assert.equal(healthy.state, 'idle');
  assert.equal(healthy.errorCode, null);
  const errorWithoutCode = normalizeRobotState(robotState({ state: 4 }));
  assert.equal(errorWithoutCode.state, 'error');
  assert.equal(errorWithoutCode.errorCode, null);
});

test('malformed/offline responses throw a constant error without response content', () => {
  const malformed = [
    null, [], 'secret-token', {}, { result: 'ok' },
    robotState({ state: undefined }), robotState({ state: '1' }),
    robotState({ state: 0 }), robotState({ state: 99 }),
    robotState({ state: NaN }), robotState({ state: Infinity }), robotState({ state: 1.5 }),
    robotState({ details: undefined }), robotState({ details: [] }),
    robotState({ availableCommands: null }), robotState({ availableCommands: [] }),
    robotState({ result: 'offline', error: 'secret-token' }),
  ];
  for (const response of malformed) {
    assert.throws(() => normalizeRobotState(response), error => {
      assert.equal(error.code, 'INVALID_ROBOT_STATE');
      assert.equal(error.message, 'The robot did not return a valid status.');
      assert.equal(error.message.includes('secret-token'), false);
      return true;
    });
  }
});

test('partial details and command records are safe and do not coerce values', () => {
  const snapshot = normalizeRobotState(robotState({
    details: { isCharging: 'false', isDocked: 1 },
    availableCommands: { start: 'true', stop: 1, pause: true, resume: false },
  }));
  assert.equal(snapshot.battery, null);
  assert.equal(snapshot.charging, null);
  assert.equal(snapshot.docked, null);
  assert.deepEqual(snapshot.availableCommands, {
    start: false, stop: false, pause: true, resume: false, goToBase: false,
  });
});

test('invalid battery readings stay unknown instead of becoming false percentages', () => {
  for (const charge of [undefined, null, '', '42', false, -1, 101, NaN, Infinity, {}, []]) {
    const snapshot = normalizeRobotState(robotState({ details: { charge } }));
    assert.equal(snapshot.battery, null);
  }
  for (const charge of [0, 50.5, 100]) {
    const snapshot = normalizeRobotState(robotState({ details: { charge } }));
    assert.equal(snapshot.battery, charge);
  }
});

test('normalization is pure and returns an independent command record', () => {
  const raw = robotState();
  Object.freeze(raw.details);
  Object.freeze(raw.availableCommands);
  Object.freeze(raw);
  const snapshot = normalizeRobotState(raw);
  snapshot.availableCommands.start = false;
  assert.equal(raw.availableCommands.start, true);
});
