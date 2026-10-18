'use strict';

// Discovery uses the marketed model; VR300 firmware can report VR220 instead.
// Keep unknown devices compatible with existing installations, without guessing
// a generation from a serial number or an unrelated numeric substring.
function normalizeRobotModel(value) {
  if (typeof value !== 'string' || value.length > 128
    || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const model = value.trim().toUpperCase().replace(/[\s_-]+/g, '');
  const match = /^(?:VORWERK)?(?:KOBOLD)?VR(200|220|300)$/.exec(model);
  if (!match) return null;
  return match[1] === '200' ? 'VR200' : 'VR300';
}

function getHouseCleaningService(robot, state) {
  const service = state?.availableServices?.houseCleaning
    ?? robot?.availableServices?.houseCleaning;
  return ['basic-1', 'minimal-2', 'basic-2', 'basic-3', 'basic-4'].includes(service)
    ? service : null;
}

function getRobotSupport(robot, state) {
  const model = normalizeRobotModel(robot?.model)
    ?? normalizeRobotModel(state?.meta?.modelName);
  const supported = model !== 'VR200' && getHouseCleaningService(robot, state) !== 'basic-1';
  // A basic robot can still explicitly advertise the read-only information
  // service. Use fresh capabilities rather than hiding verified battery data.
  const generalInfo = supported
    || ['basic-1', 'basic-2', 'basic-3', 'basic-4'].includes(state?.availableServices?.generalInfo);
  return { model, areas: supported, history: supported, maps: supported,
    generalInfo, navigation: supported };
}

module.exports = { normalizeRobotModel, getHouseCleaningService, getRobotSupport };
