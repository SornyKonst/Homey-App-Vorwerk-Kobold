'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KoboldAccount, KoboldAccountError, normalizeHistory, normalizePersistentMaps } = require('../lib/kobold-account');

const SERIAL = 'VR300-PRIVATE-SERIAL';
const SESSION = { idToken: 'PRIVATE_ID_TOKEN', refreshToken: 'PRIVATE_REFRESH_TOKEN' };
const HOST = 'vorwerk.s3.eu-west-1.amazonaws.com';
const IMAGE_URL = `https://${HOST}/private/map.png?signature=PRIVATE_SIGNATURE`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aemkAAAAASUVORK5CYII=', 'base64');
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const map = (overrides = {}) => ({
  id: 'PRIVATE_MAP_ID', url: IMAGE_URL, url_valid_for_seconds: 300,
  status: 'complete', error: null, mode: 2,
  start_at: '2026-10-18T10:00:00Z', end_at: '2026-10-18T10:10:30Z',
  cleaned_area: 12.3456, run_charge_at_start: 99, run_charge_at_end: 94,
  serial: SERIAL, secret: 'PRIVATE_SECRET', geometry: [[1, 2]], ...overrides,
});
const expectCode = code => error => error instanceof KoboldAccountError && error.code === code;

test('normalizes history into opaque summaries and keeps measured zero values', () => {
  const normalized = normalizeHistory({ stats: { secret: 'PRIVATE_STATS' }, maps: [map({
    cleaned_area: 0, run_charge_at_start: 0, run_charge_at_end: 0,
  })] }, SERIAL);
  assert.equal(normalized.entries.length, 1);
  const entry = normalized.entries[0];
  assert.match(entry.id, /^[a-f0-9]{64}$/);
  assert.equal(entry.startedAt, '2026-10-18T10:00:00.000Z');
  assert.equal(entry.endedAt, '2026-10-18T10:10:30.000Z');
  assert.equal(entry.durationMinutes, 10.5);
  assert.equal(entry.areaSquareMetres, 0);
  assert.equal(entry.batteryStart, 0);
  assert.equal(entry.batteryEnd, 0);
  assert.equal(entry.hasImage, false);
  assert.equal(entry.mode, 'turbo');
  assert.equal(entry.status, 'complete');
  assert.equal(JSON.stringify(normalized).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(normalized).includes('https:'), false);
  assert.deepEqual(Object.keys(normalized), ['entries']);
});

test('invalid fields remain unknown rather than invented or coerced', () => {
  const entry = normalizeHistory({ maps: [map({ start_at: '2026-02-30T10:00:00Z',
    end_at: false, cleaned_area: '12', mode: '2', status: 'PRIVATE_UNKNOWN_STATUS',
    error: 'https://private.example/error', run_charge_at_start: false, run_charge_at_end: 101 })] }, SERIAL).entries[0];
  assert.equal(entry.startedAt, null);
  assert.equal(entry.endedAt, null);
  assert.equal(entry.durationMinutes, null);
  assert.equal(entry.areaSquareMetres, null);
  assert.equal(entry.mode, null);
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.error, null);
  assert.equal(entry.batteryStart, null);
  assert.equal(entry.batteryEnd, null);
  assert.equal(JSON.stringify(entry).includes('PRIVATE_'), false);
  assert.equal(normalizeHistory({ maps: [map({ error: 'maintenance_error\n' })] }, SERIAL).entries[0].error, null);
});

test('timestamps validate calendars and clocks, normalize zones, and do not invent negative durations', () => {
  const valid = normalizeHistory({ maps: [map({ start_at: '2024-02-29T12:00:00+02:00',
    end_at: '2024-02-29T10:10:00Z' })] }, SERIAL).entries[0];
  assert.equal(valid.startedAt, '2024-02-29T10:00:00.000Z');
  assert.equal(valid.durationMinutes, 10);
  for (const start_at of ['2023-02-29T10:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z',
    '2024-01-01', '2024-01-01T00:00:00Z\n', '2024-01-01T00:00:00+24:00']) {
    assert.equal(normalizeHistory({ maps: [map({ start_at })] }, SERIAL).entries[0].startedAt, null);
  }
  assert.equal(normalizeHistory({ maps: [map({ end_at: '2026-10-18T09:00:00Z' })] }, SERIAL).entries[0].durationMinutes, null);
});

test('malformed lists, invalid identifiers, duplicates and excessive record counts fail closed', () => {
  for (const source of [null, [], {}, { maps: null }, { maps: [null] }, { maps: [map({ id: false })] },
    { maps: [map(), map()] }, { maps: Array.from({ length: 501 }, (_, id) => map({ id })) }]) {
    assert.throws(() => normalizeHistory(source, SERIAL), expectCode('INVALID_RESPONSE'));
  }
  assert.deepEqual(normalizeHistory({ maps: [] }, SERIAL), { entries: [] });
  assert.throws(() => normalizeHistory({ maps: [] }, 'https://private.example'), expectCode('INVALID_PARAMS'));
});

test('history sorts newest first and limits output to 50 after validating the complete list', () => {
  const maps = Array.from({ length: 60 }, (_, id) => map({ id,
    start_at: new Date(Date.UTC(2026, 0, id + 1)).toISOString() }));
  const normalized = normalizeHistory({ maps }, SERIAL);
  assert.equal(normalized.entries.length, 50);
  assert.equal(normalized.entries[0].startedAt, maps[59].start_at);
  assert.equal(normalized.entries[49].startedAt, maps[10].start_at);
  assert.notEqual(normalizeHistory({ maps: [map()] }, SERIAL).entries[0].id,
    normalizeHistory({ maps: [map()] }, 'ANOTHER-ROBOT').entries[0].id);
});

test('persistent map names are sanitized while raw identifiers and floor-map URLs stay private', () => {
  const raw = [{ id: 0, name: '  Erdgeschoss  ', url: IMAGE_URL, raw_floor_map_url: 'https://private.example/raw' }];
  const before = JSON.stringify(raw);
  const normalized = normalizePersistentMaps(raw, SERIAL);
  assert.deepEqual(Object.keys(normalized[0]).sort(), ['hasImage', 'id', 'name']);
  assert.equal(normalized[0].name, 'Erdgeschoss');
  assert.equal(normalized[0].hasImage, false);
  assert.equal(JSON.stringify(normalized).includes('https:'), false);
  assert.equal(JSON.stringify(raw), before);
  for (const name of ['', 'Floor\n', '\u202eFloor', 'https://private.example', 'x'.repeat(257)]) {
    assert.throws(() => normalizePersistentMaps([{ id: 1, name }], SERIAL), expectCode('INVALID_RESPONSE'));
  }
  assert.throws(() => normalizePersistentMaps([{ id: 1, name: 'A' }, { id: '1', name: 'B' }], SERIAL),
    expectCode('INVALID_RESPONSE'));
  assert.throws(() => normalizePersistentMaps(new Array(1), SERIAL), expectCode('INVALID_RESPONSE'));
});

test('account GET uses fixed beehive paths, encoded serial and ID token only', async () => {
  const requests = [];
  const account = new KoboldAccount({ fetch: async (url, options) => {
    requests.push({ url, options });
    return json(url.endsWith('/persistent_maps') ? [{ id: 1, name: 'Home' }] : { maps: [map()] });
  } });
  await account.getHistory('ROBOT/path', SESSION);
  await account.getPersistentMaps('ROBOT/path', SESSION);
  assert.equal(requests[0].url, 'https://beehive.ksecosys.com/users/me/robots/ROBOT%2Fpath/maps');
  assert.equal(requests[1].url, 'https://beehive.ksecosys.com/users/me/robots/ROBOT%2Fpath/persistent_maps');
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Auth0Bearer ${SESSION.idToken}`);
    assert.equal(JSON.stringify(options).includes(SESSION.refreshToken), false);
  }
  assert.equal(JSON.stringify(account).includes('PRIVATE_'), false);
});

test('default empty CDN allowlist inventories origins but never fetches images', async () => {
  let calls = 0;
  const account = new KoboldAccount({ fetch: async () => { calls += 1; return json({ maps: [map()] }); } });
  const { entries } = await account.getHistory(SERIAL, SESSION);
  assert.equal(entries[0].hasImage, false);
  assert.deepEqual(account.getImageOrigins(), [`https://${HOST}`]);
  assert.equal(JSON.stringify(account.getImageOrigins()).includes('signature'), false);
  await assert.rejects(account.getImage(entries[0].id), expectCode('IMAGE_UNAVAILABLE'));
  assert.equal(calls, 1);
});

test('verified image host receives no account authorization, cookies or referrer and returns raster bytes', async () => {
  const requests = [];
  const account = new KoboldAccount({ imageHosts: [HOST], fetch: async (url, options) => {
    requests.push({ url, options });
    return url.startsWith('https://beehive.') ? json({ maps: [map()] })
      : new Response(PNG, { headers: { 'content-type': 'image/png' } });
  } });
  const { entries } = await account.getHistory(SERIAL, SESSION);
  assert.equal(entries[0].hasImage, true);
  const image = await account.getImage(entries[0].id);
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(image.buffer, PNG);
  const options = requests[1].options;
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal('Authorization' in options.headers, false);
  assert.equal('Cookie' in options.headers, false);
  assert.equal(JSON.stringify(options).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(entries).includes('signature'), false);
});

test('unverified hosts, credentials, local targets, insecure URLs and redirects cannot acquire an image', async () => {
  for (const url of ['http://' + HOST + '/map.png', 'https://127.0.0.1/map', 'https://[::1]/map',
    'https://localhost/map', 'https://router.local/map', `https://user:password@${HOST}/map`,
    `https://${HOST}:4443/map`, `https://${HOST}.evil.example/map`, 'https://evil.example/map',
    `https://${HOST}/map#fragment`]) {
    let calls = 0;
    const account = new KoboldAccount({ imageHosts: [HOST], fetch: async () => {
      calls += 1; return json({ maps: [map({ url })] });
    } });
    const { entries } = await account.getHistory(SERIAL, SESSION);
    assert.equal(entries[0].hasImage, false, url);
    await assert.rejects(account.getImage(entries[0].id), expectCode('IMAGE_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
  assert.throws(() => new KoboldAccount({ imageHosts: ['127.0.0.1'] }), expectCode('INVALID_PARAMS'));
  assert.throws(() => new KoboldAccount({ imageHosts: [`${HOST}/unsafe`] }), expectCode('INVALID_PARAMS'));
});

test('image URLs expire before their declared validity and cache can be cleared per robot', async () => {
  let now = 1000;
  const account = new KoboldAccount({ imageHosts: [HOST], now: () => now,
    fetch: async () => json({ maps: [map({ url_valid_for_seconds: 10 })] }) });
  const { entries } = await account.getHistory(SERIAL, SESSION);
  assert.equal(entries[0].hasImage, true);
  now = 6000;
  await assert.rejects(account.getImage(entries[0].id), expectCode('IMAGE_UNAVAILABLE'));
  now = 1000;
  await account.getHistory(SERIAL, SESSION);
  account.clear(SERIAL);
  await assert.rejects(account.getImage(entries[0].id), expectCode('IMAGE_UNAVAILABLE'));
  account.clear();
  assert.deepEqual(account.getImageOrigins(), []);
});

test('clearing during a pending history or map request prevents private cache repopulation', async () => {
  for (const kind of ['history', 'persistent']) {
    for (const scope of ['all', 'serial']) {
      let resolveResponse;
      const account = new KoboldAccount({ imageHosts: [HOST], fetch: () =>
        new Promise(resolve => { resolveResponse = resolve; }) });
      const pending = kind === 'history' ? account.getHistory(SERIAL, SESSION)
        : account.getPersistentMaps(SERIAL, SESSION);
      if (scope === 'all') account.clear();
      else account.clear(SERIAL);
      resolveResponse(json(kind === 'history' ? { maps: [map()] }
        : [{ id: 1, name: 'Home', url: IMAGE_URL, url_valid_for_seconds: 300 }]));
      const result = await pending;
      const rows = kind === 'history' ? result.entries : result;
      assert.equal(rows[0].hasImage, false, `${kind}/${scope}`);
      assert.deepEqual(account.getImageOrigins(), [], `${kind}/${scope}`);
      await assert.rejects(account.getImage(rows[0].id), expectCode('IMAGE_UNAVAILABLE'));
    }
  }
});

test('clearing one robot leaves another robot pending request eligible for caching', async () => {
  let resolveResponse;
  const account = new KoboldAccount({ imageHosts: [HOST], fetch: () =>
    new Promise(resolve => { resolveResponse = resolve; }) });
  const pending = account.getHistory(SERIAL, SESSION);
  account.clear('ANOTHER-ROBOT');
  resolveResponse(json({ maps: [map()] }));
  const { entries } = await pending;
  assert.equal(entries[0].hasImage, true);
  assert.deepEqual(account.getImageOrigins(), [`https://${HOST}`]);
});

test('PNG or JPEG magic is required and MIME mismatches or SVG are rejected', async () => {
  for (const [bytes, type] of [[Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'],
    [Buffer.from('not an image'), 'image/png'], [PNG, 'text/html'], [PNG, 'image/jpeg']]) {
    const account = new KoboldAccount({ imageHosts: [HOST], fetch: async url =>
      url.startsWith('https://beehive.') ? json({ maps: [map()] }) : new Response(bytes, { headers: { 'content-type': type } }) });
    const { entries } = await account.getHistory(SERIAL, SESSION);
    await assert.rejects(account.getImage(entries[0].id), expectCode('INVALID_IMAGE'));
  }
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);
  const account = new KoboldAccount({ imageHosts: [HOST], fetch: async url =>
    url.startsWith('https://beehive.') ? json({ maps: [map()] }) : new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }) });
  const { entries } = await account.getHistory(SERIAL, SESSION);
  assert.equal((await account.getImage(entries[0].id)).mimeType, 'image/jpeg');
});

test('response size limits apply to content length and streamed bodies', async () => {
  for (const includeLength of [true, false]) {
    const account = new KoboldAccount({ imageHosts: [HOST], fetch: async url => {
      if (url.startsWith('https://beehive.')) return json({ maps: [map()] });
      return new Response(Buffer.alloc(5 * 1024 * 1024 + 1), {
        headers: includeLength ? { 'content-length': String(5 * 1024 * 1024 + 1) } : {},
      });
    } });
    const { entries } = await account.getHistory(SERIAL, SESSION);
    await assert.rejects(account.getImage(entries[0].id), expectCode('RESPONSE_TOO_LARGE'));
  }
  const account = new KoboldAccount({ fetch: async () => new Response('x', {
    headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
  }) });
  await assert.rejects(account.getHistory(SERIAL, SESSION), expectCode('RESPONSE_TOO_LARGE'));
});

test('deadline includes body consumption and cancels a stalled stream', async () => {
  let cancelled = false;
  let signal;
  const account = new KoboldAccount({ timeoutMs: 20, fetch: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  } });
  await assert.rejects(account.getHistory(SERIAL, SESSION), expectCode('TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('an ignored fetch abort times out and its late response cannot populate the private image cache', async () => {
  let finishResponse;
  let signal;
  let calls = 0;
  const account = new KoboldAccount({ timeoutMs: 20, imageHosts: [HOST], fetch: (url, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise(resolve => { finishResponse = resolve; });
  } });
  await assert.rejects(account.getHistory(SERIAL, SESSION), expectCode('TIMEOUT'));
  assert.equal(signal.aborted, true);
  finishResponse(json({ maps: [map()] }));
  await new Promise(resolve => setImmediate(resolve));
  const { entries } = normalizeHistory({ maps: [map()] }, SERIAL);
  await assert.rejects(account.getImage(entries[0].id), expectCode('IMAGE_UNAVAILABLE'));
  assert.deepEqual(account.getImageOrigins(), []);
  assert.equal(calls, 1);
});

test('authentication, HTTP, parse and network errors never leak private response data', async () => {
  for (const status of [401, 403]) {
    const account = new KoboldAccount({ fetch: async () => new Response('PRIVATE_RESPONSE_BODY', { status }) });
    await assert.rejects(account.getHistory(SERIAL, SESSION), error =>
      expectCode('ACCOUNT_AUTHENTICATION_FAILED')(error) && !JSON.stringify(error).includes('PRIVATE_'));
  }
  const limited = new KoboldAccount({ fetch: async () => new Response('private', { status: 429 }) });
  await assert.rejects(limited.getHistory(SERIAL, SESSION), expectCode('RATE_LIMITED'));
  const invalid = new KoboldAccount({ fetch: async () => new Response('PRIVATE_INVALID_JSON') });
  await assert.rejects(invalid.getHistory(SERIAL, SESSION), expectCode('INVALID_RESPONSE'));
  const failed = new KoboldAccount({ fetch: async () => { throw new Error(IMAGE_URL); } });
  await assert.rejects(failed.getHistory(SERIAL, SESSION), error =>
    expectCode('NETWORK_ERROR')(error) && !error.message.includes(IMAGE_URL));
  const calls = [];
  const never = new KoboldAccount({ fetch: async (...args) => { calls.push(args); return json({ maps: [] }); } });
  for (const session of [null, {}, { idToken: false }, { idToken: '' }, { idToken: 'token\nInjected' }]) {
    await assert.rejects(never.getHistory(SERIAL, session), expectCode('ACCOUNT_AUTHENTICATION_FAILED'));
  }
  assert.equal(calls.length, 0);
});
