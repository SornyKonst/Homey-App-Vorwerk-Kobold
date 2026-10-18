'use strict';

const { createHash } = require('node:crypto');

// Independent protocol implementation. Reference: pybotvac/account.py.
// Cloud image URLs may contain credentials and must stay inside this instance.
const ORIGIN = 'https://beehive.ksecosys.com';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15000;
const STATUSES = new Set(['ok', 'complete', 'completed', 'done', 'error', 'failed',
  'incomplete', 'stopped', 'canceled', 'cancelled']);

class KoboldAccountError extends Error {
  constructor(code, status) {
    super({
      INVALID_PARAMS: 'The account request is invalid.',
      INVALID_RESPONSE: 'The cloud returned invalid history or map data.',
      ACCOUNT_AUTHENTICATION_FAILED: 'Sign in to MyKobold again to access history and maps.',
      RATE_LIMITED: 'The cloud is receiving too many requests. Try again later.',
      HTTP_ERROR: 'The cloud request failed. Try again later.',
      NETWORK_ERROR: 'The cloud could not be reached.',
      TIMEOUT: 'The cloud request timed out.',
      RESPONSE_TOO_LARGE: 'The cloud response is too large.',
      IMAGE_UNAVAILABLE: 'The map image is unavailable or has expired. Refresh the list.',
      INVALID_IMAGE: 'The cloud did not return a supported map image.',
    }[code] || 'The account request failed.');
    this.name = 'KoboldAccountError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, limit = 256) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if (!result || result.length > limit || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(result)) return null;
  return result;
}

function validIdentifier(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && safeText(value) === value ? value : null;
}

function opaqueId(kind, serial, id) {
  return createHash('sha256').update(JSON.stringify([kind, serial, id])).digest('hex');
}

function requireSerial(serial) {
  if (typeof serial !== 'string' || safeText(serial) !== serial) {
    throw new KoboldAccountError('INVALID_PARAMS');
  }
  return serial;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const zone = match[7];
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function battery(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function errorCode(value) {
  return typeof value === 'string' && value.length <= 80 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    && /^[a-z0-9_]{1,80}$/i.test(value)
    && value !== 'ui_alert_invalid' ? value : null;
}

function normalizeHistory(data, serial) {
  requireSerial(serial);
  if (!isRecord(data) || !Array.isArray(data.maps) || data.maps.length > 500) {
    throw new KoboldAccountError('INVALID_RESPONSE');
  }
  const seen = new Set();
  const entries = [];
  for (const map of data.maps) {
    if (!isRecord(map)) throw new KoboldAccountError('INVALID_RESPONSE');
    const rawId = validIdentifier(map.id);
    if (rawId === null || seen.has(rawId)) throw new KoboldAccountError('INVALID_RESPONSE');
    seen.add(rawId);
    const startedAt = timestamp(map.start_at);
    const endedAt = timestamp(map.end_at);
    const elapsed = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : -1;
    entries.push({
      id: opaqueId('history', serial, rawId),
      startedAt,
      endedAt,
      // Elapsed duration includes pauses or charging stops. It is not an
      // estimate of time spent actively vacuuming.
      durationMinutes: elapsed >= 0 ? elapsed / 60000 : null,
      // Beehive cleaned_area is square metres, not square centimetres.
      areaSquareMetres: typeof map.cleaned_area === 'number' && Number.isFinite(map.cleaned_area)
        && map.cleaned_area >= 0 && map.cleaned_area <= 1e7 ? map.cleaned_area : null,
      mode: map.mode === 1 ? 'eco' : map.mode === 2 ? 'turbo' : null,
      status: STATUSES.has(map.status) ? map.status : 'unknown',
      error: errorCode(map.error),
      batteryStart: battery(map.run_charge_at_start),
      batteryEnd: battery(map.run_charge_at_end),
      hasImage: false,
    });
  }
  entries.sort((left, right) => (Date.parse(right.startedAt || '') || 0) - (Date.parse(left.startedAt || '') || 0));
  return { entries: entries.slice(0, 50) };
}

function normalizePersistentMaps(data, serial) {
  requireSerial(serial);
  if (!Array.isArray(data) || data.length > 100) throw new KoboldAccountError('INVALID_RESPONSE');
  const seen = new Set();
  const maps = [];
  for (const map of data) {
    if (!isRecord(map)) throw new KoboldAccountError('INVALID_RESPONSE');
    const rawId = validIdentifier(map.id);
    const name = safeText(map.name);
    if (rawId === null || name === null || seen.has(rawId)) throw new KoboldAccountError('INVALID_RESPONSE');
    seen.add(rawId);
    maps.push({ id: opaqueId('persistent', serial, rawId), name, hasImage: false });
  }
  return maps;
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host)) return null;
  return url;
}

class KoboldAccount {
  #fetch;
  #timeoutMs;
  #imageHosts;
  #images = new Map();
  #imageOrigins = new Set();
  #generation = 0;
  #serialGenerations = new Map();
  #now;

  constructor({ fetch: fetchImpl = globalThis.fetch, timeoutMs = MAX_TIMEOUT_MS,
    imageHosts = [], now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
      || !Array.isArray(imageHosts) || imageHosts.length > 20) {
      throw new KoboldAccountError('INVALID_PARAMS');
    }
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
    this.#imageHosts = new Set(imageHosts.map(host => {
      const candidate = typeof host === 'string' && imageUrl(`https://${host}/`);
      if (!candidate || candidate.hostname !== host || candidate.port || candidate.pathname !== '/') {
        throw new KoboldAccountError('INVALID_PARAMS');
      }
      return candidate.hostname;
    }));
  }

  clear(serial) {
    if (serial === undefined) {
      this.#generation += 1;
      this.#serialGenerations.clear();
      this.#images.clear();
      this.#imageOrigins.clear();
      return;
    }
    requireSerial(serial);
    this.#serialGenerations.set(serial, (this.#serialGenerations.get(serial) || 0) + 1);
    for (const [id, image] of this.#images) if (image.serial === serial) this.#images.delete(id);
  }

  // Opt-in diagnostics only. Do not expose this inventory through public APIs.
  getImageOrigins() {
    return [...this.#imageOrigins].sort();
  }

  async getHistory(serial, session) {
    requireSerial(serial);
    const generation = this.#currentGeneration(serial);
    const data = await this.#get(serial, session, 'maps');
    const normalized = normalizeHistory(data, serial);
    const rows = new Map(data.maps.map(map => [opaqueId('history', serial, validIdentifier(map.id)), map]));
    if (this.#generationMatches(serial, generation)) {
      this.#replaceImages(serial, 'history', normalized.entries, rows);
    }
    return normalized;
  }

  async getPersistentMaps(serial, session) {
    requireSerial(serial);
    const generation = this.#currentGeneration(serial);
    const data = await this.#get(serial, session, 'persistent_maps');
    const normalized = normalizePersistentMaps(data, serial);
    const rows = new Map(data.map(map => [opaqueId('persistent', serial, validIdentifier(map.id)), map]));
    if (this.#generationMatches(serial, generation)) {
      this.#replaceImages(serial, 'persistent', normalized, rows);
    }
    return normalized;
  }

  #currentGeneration(serial) {
    return [this.#generation, this.#serialGenerations.get(serial) || 0];
  }

  #generationMatches(serial, generation) {
    return generation[0] === this.#generation
      && generation[1] === (this.#serialGenerations.get(serial) || 0);
  }

  #replaceImages(serial, kind, summaries, rows) {
    for (const [id, image] of this.#images) {
      if (image.expiresAt <= this.#now() || (image.serial === serial && image.kind === kind)) {
        this.#images.delete(id);
      }
    }
    for (const summary of summaries) {
      const row = rows.get(summary.id);
      const url = imageUrl(row?.url);
      if (!url) continue;
      if (this.#imageOrigins.size < 100) this.#imageOrigins.add(url.origin);
      if (!this.#imageHosts.has(url.hostname)) continue;
      const ttl = Number.isFinite(row.url_valid_for_seconds) && row.url_valid_for_seconds >= 0
        ? Math.min(row.url_valid_for_seconds * 1000, 15 * 60 * 1000) : 300000;
      const expiresAt = this.#now() + ttl - 5000;
      if (expiresAt <= this.#now() || this.#images.size >= 1000) continue;
      this.#images.set(summary.id, { serial, kind, url: url.href, expiresAt });
      summary.hasImage = true;
    }
  }

  async #get(serial, session, kind) {
    requireSerial(serial);
    if (!isRecord(session) || typeof session.idToken !== 'string' || !session.idToken
      || session.idToken.length > 32768 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(session.idToken)) {
      throw new KoboldAccountError('ACCOUNT_AUTHENTICATION_FAILED');
    }
    const url = `${ORIGIN}/users/me/robots/${encodeURIComponent(serial)}/${kind}`;
    return this.#request(url, {
      method: 'GET', headers: { Accept: 'application/vnd.neato.beehive.v1+json',
        Authorization: `Auth0Bearer ${session.idToken}` },
    }, MAX_JSON_BYTES, async (response, bytes) => {
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new KoboldAccountError('INVALID_RESPONSE'); }
    }, true);
  }

  async getImage(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new KoboldAccountError('IMAGE_UNAVAILABLE');
    const image = this.#images.get(id);
    if (!image || image.expiresAt <= this.#now()) {
      this.#images.delete(id);
      throw new KoboldAccountError('IMAGE_UNAVAILABLE');
    }
    // Revalidate the private URL and host immediately before use. No account
    // token, robot credentials, cookies or referrer go to image storage.
    const url = imageUrl(image.url);
    if (!url || !this.#imageHosts.has(url.hostname)) throw new KoboldAccountError('IMAGE_UNAVAILABLE');
    return this.#request(url.href, { method: 'GET', headers: { Accept: 'image/png,image/jpeg' },
      credentials: 'omit', referrerPolicy: 'no-referrer' }, MAX_IMAGE_BYTES, async (response, bytes) => {
      const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new KoboldAccountError('INVALID_IMAGE');
      const mimeType = png ? 'image/png' : 'image/jpeg';
      const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (declared && declared !== 'application/octet-stream' && declared !== mimeType
        && !(declared === 'image/jpg' && jpeg)) throw new KoboldAccountError('INVALID_IMAGE');
      return { buffer: bytes, mimeType };
    }, false);
  }

  async #request(url, options, maxBytes, decode, accountRequest) {
    const controller = new AbortController();
    let timer;
    let activeReader;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        if (activeReader) void activeReader.cancel().catch(() => {});
        reject(new KoboldAccountError('TIMEOUT'));
      }, this.#timeoutMs);
    });
    const request = async () => {
      const response = await this.#fetch(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        if (response.body) void response.body.cancel().catch(() => {});
        if (accountRequest && [401, 403].includes(response.status)) {
          throw new KoboldAccountError('ACCOUNT_AUTHENTICATION_FAILED', response.status);
        }
        throw new KoboldAccountError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', response.status);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        controller.abort();
        if (response.body) void response.body.cancel().catch(() => {});
        throw new KoboldAccountError('RESPONSE_TOO_LARGE');
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new KoboldAccountError(accountRequest ? 'INVALID_RESPONSE' : 'INVALID_IMAGE');
      }
      const reader = response.body.getReader();
      activeReader = reader;
      const chunks = [];
      let size = 0;
      try {
        do {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            controller.abort();
            void reader.cancel().catch(() => {});
            throw new KoboldAccountError('RESPONSE_TOO_LARGE');
          }
          chunks.push(Buffer.from(value));
        } while (true);
      } finally {
        reader.releaseLock();
        activeReader = null;
      }
      return decode(response, Buffer.concat(chunks, size));
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch (error) {
      if (error instanceof KoboldAccountError) throw error;
      throw new KoboldAccountError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { KoboldAccount, KoboldAccountError, normalizeHistory, normalizePersistentMaps };
