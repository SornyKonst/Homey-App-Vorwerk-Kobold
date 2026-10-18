'use strict';

const ACTIVE_CLEANING_ACTIONS = new Set([1, 2, 3, 11, 12]);
const SUSPENDED_ACTIONS = new Set([6, 15]);
const COMMANDS = ['start', 'stop', 'pause', 'resume', 'goToBase'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidState() {
  // Never put a cloud response in an exception: it may contain account data.
  const error = new Error('The robot did not return a valid status.');
  error.code = 'INVALID_ROBOT_STATE';
  return error;
}

/**
 * Normalize a getRobotState response without modifying it.
 *
 * Partial details/availableCommands objects are accepted. Unknown battery
 * readings become null and missing commands are unavailable; neither is
 * invented from the current activity.
 */
function normalizeRobotState(raw) {
  if (!isRecord(raw)
    || !Number.isInteger(raw.state)
    || raw.state < 1 || raw.state > 4
    || !isRecord(raw.details)
    || !isRecord(raw.availableCommands)
    || (raw.result !== undefined && raw.result !== 'ok')) {
    throw invalidState();
  }

  const { details } = raw;
  const battery = typeof details.charge === 'number'
    && Number.isFinite(details.charge)
    && details.charge >= 0 && details.charge <= 100
    ? details.charge : null;
  const charging = typeof details.isCharging === 'boolean' ? details.isCharging : null;
  const docked = typeof details.isDocked === 'boolean' ? details.isDocked : null;
  const reportedError = typeof raw.error === 'string' ? raw.error.trim() : '';
  // Older Kobold firmware returns this sentinel during healthy operation.
  const errorCode = reportedError && reportedError !== 'ui_alert_invalid'
    ? reportedError : null;

  let state;
  let vacuumState = 'stopped';
  if (raw.state === 4 || errorCode !== null) {
    state = 'error';
  } else if (raw.state === 3 || (raw.state === 2 && SUSPENDED_ACTIONS.has(raw.action))) {
    // A suspended run still reports BUSY on some firmware. Battery level is
    // unrelated to the paused/cleaning distinction.
    state = 'paused';
  } else if (raw.state === 1 && charging) {
    state = 'charging';
    vacuumState = 'charging';
  } else if (raw.state === 1 && docked) {
    state = 'docked';
    vacuumState = 'docked';
  } else if (raw.state === 1) {
    state = 'idle';
  } else if (ACTIVE_CLEANING_ACTIONS.has(raw.action)) {
    state = 'cleaning';
    vacuumState = raw.action === 2 ? 'spot_cleaning' : 'cleaning';
  } else if (raw.action === 4) {
    state = 'returning';
  } else {
    state = 'busy';
  }

  return {
    state,
    vacuumState,
    battery,
    charging,
    docked,
    errorCode,
    statusKey: state,
    availableCommands: Object.fromEntries(
      COMMANDS.map(command => [command, raw.availableCommands[command] === true]),
    ),
  };
}

module.exports = { normalizeRobotState };
