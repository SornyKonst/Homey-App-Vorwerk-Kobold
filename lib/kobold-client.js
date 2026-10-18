'use strict';

const { createHmac, randomUUID } = require('node:crypto');
const { getHouseCleaningService, normalizeRobotModel } = require('./robot-support');

// Protocol references (independent implementation; no upstream source copied):
// https://github.com/stianaske/pybotvac/blob/master/pybotvac/vorwerk.py
// https://github.com/stianaske/pybotvac/blob/master/pybotvac/session.py
// https://github.com/stianaske/pybotvac/blob/master/pybotvac/robot.py
// https://github.com/himbeles/node-kobold-control/blob/master/lib/robot.js
// https://github.com/bndtblds/homeassistant-vorwerk/blob/main/custom_components/vorwerk/config_flow.py
const AUTH_ORIGIN = 'https://mykobold.eu.auth0.com';
const BEEHIVE_ORIGIN = 'https://beehive.ksecosys.com';
const CLIENT_ID = 'KY4YbVAvtgB7lp8vIbWQ7zLk3hssZlhR';
const ROBOT_HOSTS = new Set(['nucleo.ksecosys.com']);
const COMMANDS = new Set([
  'startCleaning', 'stopCleaning', 'pauseCleaning', 'resumeCleaning', 'sendToBase',
]);
const ROBOT_RESULTS = new Set([
  'invalid_json', 'bad_request', 'command_not_found', 'command_rejected', 'ko',
  'not_on_charge_base',
]);

class KoboldError extends Error {
  constructor(code, message, { status, result } = {}) {
    super(message);
    this.name = 'KoboldError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    if (ROBOT_RESULTS.has(result)) this.result = result;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function isAccountToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384
    && /^[\x21-\x7e]+$/.test(value);
}

function isSessionFamily(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function accountSession(token, familyId, previousRefreshToken) {
  if (!isRecord(token) || !isAccountToken(token.id_token)
    || (token.refresh_token !== undefined && !isAccountToken(token.refresh_token))) {
    throw new KoboldError('ACCOUNT_AUTHENTICATION_FAILED', 'The account session could not be renewed. Sign in again.');
  }
  const session = { idToken: token.id_token, familyId };
  const refreshToken = token.refresh_token ?? previousRefreshToken;
  if (refreshToken !== undefined) session.refreshToken = refreshToken;
  // ID token exp is used only as a refresh scheduling hint, never as an
  // authorization decision. expires_in describes the separate access token.
  try {
    const parts = token.id_token.split('.');
    if (parts.length === 3 && /^[A-Za-z0-9_-]+$/.test(parts[1])) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (isRecord(claims) && Number.isSafeInteger(claims.exp)
        && claims.exp > 0 && claims.exp <= 8640000000000) {
        session.expiresAt = claims.exp * 1000;
      }
    }
  } catch {
    // An opaque or unparseable token has no local expiry hint. The account
    // endpoint still decides whether the bearer token is valid.
  }
  return session;
}

function valueType(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function areaDiagnostic(response, requestedMapId) {
  const data = response.data;
  const boundaries = isRecord(data) ? data.boundaries : undefined;
  const diagnostic = {
    messageAccepted: true,
    dataType: valueType(data),
    boundariesType: valueType(boundaries),
    mapIdType: valueType(isRecord(data) ? data.mapId : undefined),
  };
  if (requestedMapId !== null && isRecord(data) && data.mapId != null) {
    diagnostic.mapIdMatches = data.mapId === requestedMapId;
  }
  if (Array.isArray(boundaries)) {
    diagnostic.count = boundaries.length;
    diagnostic.sampledCount = Math.min(boundaries.length, 1000);
    diagnostic.boundaryTypes = { polygon: 0, polyline: 0, other: 0 };
    diagnostic.recordTypes = {};
    diagnostic.idTypes = {};
    diagnostic.nameTypes = {};
    const countType = (counts, value) => {
      const type = valueType(value);
      counts[type] = (counts[type] || 0) + 1;
    };
    for (const boundary of boundaries.slice(0, 1000)) {
      countType(diagnostic.recordTypes, boundary);
      const record = isRecord(boundary) ? boundary : {};
      const type = ['polygon', 'polyline'].includes(record.type) ? record.type : 'other';
      diagnostic.boundaryTypes[type] += 1;
      countType(diagnostic.idTypes, record.id);
      countType(diagnostic.nameTypes, record.name);
    }
  }
  return diagnostic;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    throw new KoboldError('INVALID_EMAIL', 'Enter a valid email address.');
  }
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new KoboldError('INVALID_EMAIL', 'Enter a valid email address.');
  }
  return email;
}

function normalizeCode(value) {
  // Auth0 allows its tenant to configure OTP length.
  if (typeof value !== 'string' || !/^\d{4,12}$/.test(value.trim())) {
    throw new KoboldError('INVALID_CODE', 'Enter the code from the sign-in email.');
  }
  return value.trim();
}

function normalizeEndpoint(value) {
  let endpoint;
  try {
    if (typeof value !== 'string') throw new Error();
    endpoint = new URL(value);
  } catch {
    throw new KoboldError('UNSUPPORTED_ENDPOINT', 'The robot cloud endpoint is not supported.');
  }
  // Credentials are never sent to arbitrary origins or redirected elsewhere.
  if (endpoint.protocol !== 'https:' || !ROBOT_HOSTS.has(endpoint.hostname)
    || !['', '443', '4443'].includes(endpoint.port)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') {
    throw new KoboldError('UNSUPPORTED_ENDPOINT', 'The robot cloud endpoint is not supported.');
  }
  return endpoint.origin;
}

function normalizeRobot(robot) {
  if (!isRecord(robot) || typeof robot.serial !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(robot.serial)
    || typeof robot.secret !== 'string' || !robot.secret.length
    || robot.secret.length > 256 || /[\u0000-\u001f\u007f]/.test(robot.secret)) {
    throw new KoboldError('INVALID_ROBOT', 'The robot credentials are incomplete. Pair the robot again.');
  }
  return { serial: robot.serial, secret: robot.secret, endpoint: normalizeEndpoint(robot.endpoint) };
}

function cleaningParams(value, robot) {
  if (value !== undefined && !isRecord(value)) {
    throw new KoboldError('INVALID_PARAMS', 'The cleaning options are invalid.');
  }
  const supplied = value || {};
  const known = new Set(['category', 'mode', 'modifier', 'navigationMode', 'mapId', 'boundaryId']);
  if (Object.keys(supplied).some(key => !known.has(key))) {
    throw new KoboldError('INVALID_PARAMS', 'The cleaning options are invalid.');
  }
  // basic-1 (VR200) does not accept navigation or persistent-map options.
  // Reject explicit map/zone requests instead of turning them into a whole-
  // house cleaning. Never retry a rejected persistent-map start as category 2.
  const basicOne = getHouseCleaningService(robot) === 'basic-1'
    || normalizeRobotModel(robot?.model) === 'VR200';
  if (basicOne) {
    if (['navigationMode', 'mapId', 'boundaryId'].some(key => supplied[key] !== undefined)) {
      throw new KoboldError('INVALID_PARAMS', 'The cleaning options are not supported by this robot.');
    }
    const params = { category: 2, mode: 2, modifier: 1, ...supplied };
    if (params.category !== 2 || ![1, 2].includes(params.mode) || params.modifier !== 1) {
      throw new KoboldError('INVALID_PARAMS', 'The cleaning options are invalid.');
    }
    // Undefined optional properties must not introduce unsupported wire fields.
    return { category: params.category, mode: params.mode, modifier: params.modifier };
  }
  // Keep persistent maps and their no-go lines enabled unless explicitly changed.
  // Unlike some upstream clients, never silently retry with category 2.
  const params = { category: 4, mode: 2, modifier: 1, navigationMode: 1, ...supplied };
  if (![2, 4].includes(params.category) || ![1, 2].includes(params.mode)
    || params.modifier !== 1 || ![1, 2, 3].includes(params.navigationMode)) {
    throw new KoboldError('INVALID_PARAMS', 'The cleaning options are invalid.');
  }
  for (const key of ['mapId', 'boundaryId']) {
    if (params[key] !== undefined
      && (typeof params[key] !== 'string' || !params[key].length
        || params[key].length > 256 || /[\u0000-\u001f\u007f]/.test(params[key]))) {
      throw new KoboldError('INVALID_PARAMS', 'The map or zone identifier is invalid.');
    }
  }
  return params;
}

class KoboldClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 20000, now = () => new Date() } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
      throw new KoboldError('INVALID_OPTIONS', 'The cloud client options are invalid.');
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async requestCode(email) {
    await this._request(`${AUTH_ORIGIN}/passwordless/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID, connection: 'email', email: normalizeEmail(email), send: 'code',
      }),
    }, 'authentication');
  }

  async discoverRobots(email, code, options = {}) {
    if (!isRecord(options) || Object.keys(options).some(key => !['includeMaps', 'includeAccount'].includes(key))
      || ['includeMaps', 'includeAccount'].some(key => options[key] !== undefined && typeof options[key] !== 'boolean')) {
      throw new KoboldError('INVALID_PARAMS', 'The discovery options are invalid.');
    }
    const token = await this._request(`${AUTH_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'login',
        grant_type: 'http://auth0.com/oauth/grant-type/passwordless/otp',
        scope: 'openid email profile read:current_user offline_access',
        locale: 'en',
        otp: normalizeCode(code),
        source: 'vorwerk_auth0',
        platform: 'ios',
        audience: `${AUTH_ORIGIN}/userinfo`,
        username: normalizeEmail(email),
        client_id: CLIENT_ID,
        realm: 'email',
        country_code: 'DE',
      }),
    }, 'authentication');
    if (!isRecord(token) || !isAccountToken(token.id_token)) {
      throw new KoboldError('INVALID_RESPONSE', 'The cloud returned an invalid sign-in response.');
    }
    // The cloud requires the ID token here, not its OAuth access token. Basic
    // discovery discards tokens; explicit account access returns a separate
    // session for the caller's private credential store, never UI or logs.
    const session = options.includeAccount === true ? accountSession(token, randomUUID()) : null;
    const robots = await this._request(`${BEEHIVE_ORIGIN}/users/me/robots`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.neato.beehive.v1+json',
        Authorization: `Auth0Bearer ${token.id_token}`,
      },
    }, 'authentication');
    if (!Array.isArray(robots)) {
      throw new KoboldError('INVALID_RESPONSE', 'The cloud returned an invalid robot list.');
    }
    const discovered = robots.map(item => {
      if (!isRecord(item)) {
        throw new KoboldError('INVALID_RESPONSE', 'The cloud returned an invalid robot list.');
      }
      const robot = normalizeRobot({
        serial: item.serial, secret: item.secret_key, endpoint: item.nucleo_url,
      });
      return {
        name: typeof item.name === 'string' && item.name.trim() ? item.name
          : normalizeRobotModel(item.model) === 'VR200' ? 'Kobold VR200' : 'Kobold VR300',
        ...robot,
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
      };
    });
    if (options.includeMaps === true) {
      for (const robot of discovered) {
        if (normalizeRobotModel(robot.model) === 'VR200') {
          // VR200 has no persistent floor-plan/area catalog. Its pairing must
          // not depend on the VR300-only persistent_maps account endpoint.
          robot.maps = [];
          continue;
        }
        try {
          robot.maps = await this._getPersistentMaps(robot.serial, token.id_token);
        } catch (error) {
          // Some discovery responses omit the marketed model. Only after a
          // failed map import, one read-only status request can identify a
          // basic VR200. Known VR300/VR220 devices never take this path.
          if (normalizeRobotModel(robot.model) === null) {
            let state;
            try { state = await this.getState(robot); } catch { /* Keep the original map failure. */ }
            const model = normalizeRobotModel(state?.meta?.modelName);
            if (model !== 'VR300' && (model === 'VR200'
              || getHouseCleaningService(robot, state) === 'basic-1')) {
              robot.maps = [];
              if (model === 'VR200') robot.model = model;
              continue;
            }
          }
          // Do not return a partial catalog as if it were complete. A caller
          // repairing an existing device can keep its prior credentials intact.
          throw new KoboldError('MAP_DISCOVERY_FAILED', 'Saved maps could not be loaded. Try signing in again.', {
            status: error instanceof KoboldError ? error.status : undefined,
          });
        }
      }
    }
    if (session) {
      for (const robot of discovered) robot.accountSession = { ...session };
    }
    return discovered;
  }

  async refreshAccountSession(session) {
    if (!isRecord(session) || !isAccountToken(session.refreshToken) || !isSessionFamily(session.familyId)) {
      throw new KoboldError('ACCOUNT_AUTHENTICATION_FAILED', 'The account session expired. Sign in again.');
    }
    let token;
    try {
      token = await this._request(`${AUTH_ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: session.refreshToken,
        }),
      }, 'authentication');
    } catch (error) {
      if (error instanceof KoboldError && ['AUTHENTICATION_FAILED', 'INVALID_RESPONSE'].includes(error.code)) {
        throw new KoboldError('ACCOUNT_AUTHENTICATION_FAILED', 'The account session expired. Sign in again.', {
          status: error.status,
        });
      }
      throw error;
    }
    return accountSession(token, session.familyId, session.refreshToken);
  }

  async _getPersistentMaps(serial, idToken) {
    const maps = await this._request(
      `${BEEHIVE_ORIGIN}/users/me/robots/${encodeURIComponent(serial)}/persistent_maps`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.neato.beehive.v1+json',
          Authorization: `Auth0Bearer ${idToken}`,
        },
      },
      'authentication',
    );
    const invalid = () => new KoboldError('INVALID_RESPONSE', 'The cloud returned an invalid map list.');
    if (!Array.isArray(maps) || maps.length > 100) throw invalid();
    const seen = new Set();
    const catalog = [];
    for (const map of maps) {
      if (!isRecord(map)) throw invalid();
      // Some cloud versions use integer map IDs. Normalize them once so the
      // saved catalog and later signed area requests use the same identifier.
      const id = Number.isSafeInteger(map.id) && map.id >= 0 ? String(map.id) : map.id;
      if (!isIdentifier(id) || typeof map.name !== 'string' || !map.name.trim()
        || map.name.length > 256 || /[\u0000-\u001f\u007f]/.test(map.name)) throw invalid();
      if (seen.has(id)) continue;
      seen.add(id);
      // Image URLs may contain credentials. Only a minimal map catalog leaves
      // this call; no account tokens, URLs or floor plan contents are retained.
      catalog.push({ id, name: map.name.trim() });
    }
    return catalog;
  }

  async getState(robot) {
    const response = await this._message(robot, 'getRobotState');
    if (!Number.isInteger(response.state) || !isRecord(response.details)) {
      throw new KoboldError('INVALID_RESPONSE', 'The robot returned an invalid state.');
    }
    return response;
  }

  async getGeneralInfo(robot) {
    return this._dataMessage(robot, 'getGeneralInfo');
  }

  async getRobotInfo(robot) {
    return this._dataMessage(robot, 'getRobotInfo');
  }

  async getPreferences(robot) {
    return this._dataMessage(robot, 'getPreferences');
  }

  async getLocalStats(robot) {
    return this._dataMessage(robot, 'getLocalStats');
  }

  async getSchedule(robot) {
    return this._dataMessage(robot, 'getSchedule');
  }

  async getScheduleEvents(robot) {
    return this._dataMessage(robot, 'getScheduleEvents');
  }

  async _dataMessage(robot, command) {
    const response = await this._message(robot, command);
    if (!isRecord(response.data)) {
      throw new KoboldError('INVALID_RESPONSE', 'The robot returned invalid information.');
    }
    // Callers select supported fields before exposing or persisting them. These
    // optional reads neither change robot settings nor expand command().
    return response;
  }

  async getAreas(robot, options = {}) {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'mapId')
      || (options.mapId != null && !isIdentifier(options.mapId))) {
      throw new KoboldError('INVALID_PARAMS', 'The map identifier is invalid.');
    }
    const requestedMapId = options.mapId ?? null;
    let response;
    try {
      response = await this._message(robot, 'getMapBoundaries', { mapId: requestedMapId });
    } catch (error) {
      if (error instanceof KoboldError && error.code === 'INVALID_RESPONSE') {
        error.areaDiagnostic = { messageAccepted: false };
      }
      throw error;
    }
    const invalid = () => {
      const error = new KoboldError('INVALID_RESPONSE', 'The robot returned an invalid area list.');
      error.areaDiagnostic = areaDiagnostic(response, requestedMapId);
      return error;
    };
    // A missing list is not proof that there are no saved areas. Do not replace
    // a usable selection with an empty list after a malformed cloud response.
    if (!isRecord(response.data) || !Array.isArray(response.data.boundaries)
      || response.data.boundaries.length > 1000) {
      throw invalid();
    }
    const reportedMapId = response.data.mapId;
    if (reportedMapId != null && (!isIdentifier(reportedMapId)
      || (requestedMapId !== null && reportedMapId !== requestedMapId))) {
      throw invalid();
    }
    const mapId = requestedMapId ?? reportedMapId;
    const areas = [];
    const seen = new Set();
    for (const boundary of response.data.boundaries) {
      if (!isRecord(boundary) || typeof boundary.type !== 'string') throw invalid();
      // Polylines are no-go lines, not areas that can be cleaned. Unknown types
      // are deliberately not offered as cleaning targets either.
      if (boundary.type !== 'polygon') continue;
      if (!isIdentifier(boundary.id) || typeof boundary.name !== 'string'
        || !boundary.name.trim() || boundary.name.length > 256
        || /[\u0000-\u001f\u007f]/.test(boundary.name)) {
        throw invalid();
      }
      if (seen.has(boundary.id)) continue;
      seen.add(boundary.id);
      areas.push({ id: boundary.id, name: boundary.name.trim(), ...(mapId ? { mapId } : {}) });
    }
    // Only the names and identifiers needed for selection leave this method;
    // floor plan geometry and other cloud fields are never exposed or stored.
    return areas;
  }

  async command(robot, command, params) {
    if (!COMMANDS.has(command)) {
      throw new KoboldError('INVALID_COMMAND', 'The robot command is not supported.');
    }
    if (command === 'startCleaning') {
      return this._message(robot, command, cleaningParams(params, robot));
    }
    if (params !== undefined && (!isRecord(params) || Object.keys(params).length)) {
      throw new KoboldError('INVALID_PARAMS', 'This robot command does not accept options.');
    }
    return this._message(robot, command);
  }

  async _message(value, command, params) {
    const robot = normalizeRobot(value);
    const payload = { reqId: '1', cmd: command };
    if (params !== undefined) payload.params = params;
    const body = JSON.stringify(payload);
    const date = this.now().toUTCString();
    if (date === 'Invalid Date') {
      throw new KoboldError('INVALID_CLOCK', 'The current date is invalid.');
    }
    const signature = createHmac('sha256', robot.secret)
      .update(`${robot.serial.toLowerCase()}\n${date}\n${body}`, 'utf8')
      .digest('hex');
    const response = await this._request(
      `${robot.endpoint}/vendors/vorwerk/robots/${encodeURIComponent(robot.serial)}/messages`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.neato.nucleo.v1',
          'Content-Type': 'application/json',
          Date: date,
          Authorization: `NEATOAPP ${signature}`,
        },
        body,
      },
      'robot',
    );
    if (!isRecord(response) || typeof response.result !== 'string') {
      throw new KoboldError('INVALID_RESPONSE', 'The robot returned an invalid response.');
    }
    if (response.result !== 'ok') {
      throw new KoboldError('COMMAND_REJECTED', 'The robot rejected the command. Check its status in MyKobold.', {
        result: response.result,
      });
    }
    return response;
  }

  async _request(url, options, operation) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new KoboldError('TIMEOUT', 'The cloud request timed out. Try again.'));
      }, this.timeoutMs);
    });
    const request = async () => {
      // Native fetch checks TLS certificates. Never override its agent/dispatcher.
      const response = await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        const { status } = response;
        if (status === 429) {
          throw new KoboldError('RATE_LIMITED', 'The cloud is receiving too many requests. Wait before trying again.', { status });
        }
        if ([400, 401, 403].includes(status) && operation === 'authentication') {
          throw new KoboldError('AUTHENTICATION_FAILED', 'Sign-in failed. Request a new email code and try again.', { status });
        }
        if ([401, 403].includes(status)) {
          throw new KoboldError('ROBOT_AUTHENTICATION_FAILED', 'The robot credentials were rejected. Pair the robot again.', { status });
        }
        throw new KoboldError('HTTP_ERROR', 'The cloud request failed. Try again later.', { status });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new KoboldError('INVALID_RESPONSE', 'The cloud returned an invalid response.');
      }
      return body;
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch (error) {
      if (error instanceof KoboldError) throw error;
      if (controller.signal.aborted) {
        throw new KoboldError('TIMEOUT', 'The cloud request timed out. Try again.');
      }
      // Do not expose fetch errors, response bodies, URLs, OTPs or credentials.
      throw new KoboldError('NETWORK_ERROR', 'The cloud could not be reached. Check the connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { KoboldClient, KoboldError };
