'use strict';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, maxLength = 64) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if (!result || result.length > maxLength || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(result)) return null;
  return result;
}

function identifier(value) {
  const result = text(value);
  return result && /^[a-z0-9][a-z0-9 ._-]*$/i.test(result) ? result : null;
}

function version(value) {
  const result = text(value);
  return result && /^v?\d[a-z0-9._+-]*$/i.test(result) ? result : null;
}

function calendarDate(value) {
  const result = text(value);
  const match = result && /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(result);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Additional display data from known robot fields only. These values never
 * authorize motion. Cleaning settings can describe the last run while idle.
 * totalCharges is a charge counter, not a verified count of full cycles.
 */
function normalizeRobotData(raw, generalInfo = {}) {
  const state = record(raw);
  const info = record(generalInfo);
  const cleaning = record(state.cleaning);
  const details = record(state.details);
  const meta = record(state.meta);
  const battery = record(info.battery);
  const boundary = record(cleaning.boundary);
  const warning = text(state.alert, 80);
  const chargeCount = Number.isSafeInteger(battery.totalCharges)
    && battery.totalCharges >= 0 && battery.totalCharges <= 1e9 ? battery.totalCharges : null;

  return {
    cleaningMode: cleaning.mode === 1 ? 'eco' : cleaning.mode === 2 ? 'turbo' : null,
    navigationMode: cleaning.navigationMode === 1 ? 'normal'
      : cleaning.navigationMode === 2 ? 'extra_care' : cleaning.navigationMode === 3 ? 'deep' : null,
    scheduleEnabled: typeof details.isScheduleEnabled === 'boolean' ? details.isScheduleEnabled : null,
    firmware: version(info.firmware) || version(meta.firmware),
    model: identifier(info.model) || identifier(meta.modelName),
    chargeCount,
    area: state.state === 2 || state.state === 3 ? text(boundary.name, 256) : null,
    warningCode: warning && warning !== 'ui_alert_invalid' && /^[a-z0-9_]{1,80}$/i.test(warning)
      ? warning : null,
    batteryVendor: text(battery.vendor),
    batteryManufacturingDate: calendarDate(battery.manufacturingDate),
    productNumber: identifier(info.productNumber),
  };
}

module.exports = { normalizeRobotData };
