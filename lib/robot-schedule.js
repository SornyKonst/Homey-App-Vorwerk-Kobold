'use strict';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function areaName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(name)) return null;
  return name;
}

/**
 * Normalize getScheduleEvents.data without retaining map/boundary identifiers.
 * Unknown or malformed lists remain null; [] means a known empty schedule.
 * Weekdays retain their numeric vendor values until display mapping is known.
 */
function normalizeRobotSchedule(data) {
  const source = record(data);
  const result = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    events: null,
  };
  if (!Array.isArray(source.events) || source.events.length > 100) return result;
  const events = [];
  for (const value of source.events) {
    const event = record(value);
    if (!Number.isInteger(event.day) || event.day < 0 || event.day > 6
      || typeof event.startTime !== 'string'
      || event.startTime.length !== 5
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.startTime)) return result;
    events.push({
      day: event.day,
      time: event.startTime,
      mode: event.mode === 1 ? 'eco' : event.mode === 2 ? 'turbo' : null,
      area: areaName(record(event.boundary).name),
    });
  }
  result.events = events;
  return result;
}

module.exports = { normalizeRobotSchedule };
