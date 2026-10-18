'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { KoboldClient, KoboldError } = require('../lib/kobold-client');

const ROBOT = {
  name: 'Living room', serial: 'OPS12345-ABC123',
  secret: '0123456789abcdef0123456789abcdef',
  endpoint: 'https://nucleo.ksecosys.com:4443',
};
const STATE = {
  result: 'ok', state: 1, action: 0,
  details: { charge: 82, isCharging: true, isDocked: true },
  availableCommands: { start: true, stop: false, pause: false, resume: false, goToBase: false },
  availableServices: { houseCleaning: 'basic-4' },
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function idToken(claims) {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function fixture(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'Unexpected extra cloud request');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, options) : next;
  };
  return {
    client: new KoboldClient({ fetchImpl, now: () => new Date('2026-10-18T10:20:30Z') }),
    calls,
  };
}

test('requests an email OTP without sending an account password', async () => {
  const { client, calls } = fixture(response({ _id: 'not-retained' }));
  assert.equal(await client.requestCode('  ME@example.org '), undefined);
  assert.equal(calls[0].url, 'https://mykobold.eu.auth0.com/passwordless/start');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    client_id: 'KY4YbVAvtgB7lp8vIbWQ7zLk3hssZlhR',
    connection: 'email', email: 'me@example.org', send: 'code',
  });
});

test('exchanges the OTP with vendor fields and discovers robots using the ID token', async () => {
  const { client, calls } = fixture(
    response({ id_token: 'private-id-token', access_token: 'do-not-use-access-token' }),
    response([{
      name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret,
      nucleo_url: `${ROBOT.endpoint}/`, model: 'VR300', traits: [],
    }]),
  );
  const robots = await client.discoverRobots('ME@example.org', ' 123456 ');
  assert.deepEqual(robots, [{ ...ROBOT, model: 'VR300' }]);
  assert.equal(calls[0].url, 'https://mykobold.eu.auth0.com/oauth/token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    prompt: 'login', grant_type: 'http://auth0.com/oauth/grant-type/passwordless/otp',
    scope: 'openid email profile read:current_user offline_access', locale: 'en',
    otp: '123456', source: 'vorwerk_auth0', platform: 'ios',
    audience: 'https://mykobold.eu.auth0.com/userinfo', username: 'me@example.org',
    client_id: 'KY4YbVAvtgB7lp8vIbWQ7zLk3hssZlhR', realm: 'email', country_code: 'DE',
  });
  assert.equal(calls[1].url, 'https://beehive.ksecosys.com/users/me/robots');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers.Authorization, 'Auth0Bearer private-id-token');
  assert.equal(calls[1].options.headers.Accept, 'application/vnd.neato.beehive.v1+json');
  assert.ok(!JSON.stringify(robots).includes('private-id-token'));
  assert.ok(!Object.values(client).includes('private-id-token'));
  assert.equal(calls.length, 2);
});

test('account access is explicit and returns only credential-session fields with one family per sign-in', async () => {
  const token = idToken({ exp: 1792322430, email: 'private@example.org', sub: 'private-account-id' });
  const second = { ...ROBOT, name: 'Second robot', serial: 'SECOND-ROBOT' };
  const { client, calls } = fixture(
    response({ id_token: token, refresh_token: 'private-refresh-token', access_token: 'discard-access-token',
      expires_in: 999999, scope: 'openid offline_access', arbitrary: 'discard-private-field' }),
    response([ROBOT, second].map(robot => ({
      name: robot.name, serial: robot.serial, secret_key: robot.secret, nucleo_url: robot.endpoint,
    }))),
  );
  const robots = await client.discoverRobots('me@example.org', '123456', { includeAccount: true });
  const session = robots[0].accountSession;
  assert.deepEqual(session, {
    idToken: token, refreshToken: 'private-refresh-token', expiresAt: 1792322430000, familyId: session.familyId,
  });
  assert.match(session.familyId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(robots[1].accountSession, session);
  assert.notEqual(robots[1].accountSession, session);
  assert.deepEqual(robots.map(({ accountSession, ...robot }) => robot), [ROBOT, second]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(robots).includes('discard-'), false);
  assert.equal(Object.values(client).includes(token), false);
});

test('opaque ID tokens and invalid expiry claims never use the access-token expires_in as ID expiry', async () => {
  for (const token of ['opaque-id-token', idToken({ exp: '1792322430' }), idToken({ exp: -1 }),
    idToken({ exp: 8640000000001 }), 'header.not-json.signature']) {
    const { client } = fixture(response({ id_token: token, expires_in: 3600 }),
      response([{ name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]));
    const [robot] = await client.discoverRobots('me@example.org', '123456', { includeAccount: true });
    assert.equal(robot.accountSession.idToken, token);
    assert.equal('expiresAt' in robot.accountSession, false);
    assert.equal('refreshToken' in robot.accountSession, false);
  }
});

test('refreshes the account with the public client grant and preserves or rotates only private session fields', async () => {
  const prior = { idToken: 'old-id-token', refreshToken: 'old-private-refresh', expiresAt: 1,
    familyId: '11111111-1111-4111-8111-111111111111' };
  const before = structuredClone(prior);
  const freshId = idToken({ exp: 1792322430 });
  const { client, calls } = fixture(
    response({ id_token: freshId, refresh_token: 'new-private-refresh', access_token: 'discard-private-access', expires_in: 2 }),
    response({ id_token: 'new-opaque-id', expires_in: 3600 }),
  );
  const rotated = await client.refreshAccountSession(prior);
  assert.deepEqual(rotated, { idToken: freshId, refreshToken: 'new-private-refresh',
    expiresAt: 1792322430000, familyId: prior.familyId });
  assert.deepEqual(await client.refreshAccountSession(rotated), {
    idToken: 'new-opaque-id', refreshToken: 'new-private-refresh', familyId: prior.familyId,
  });
  assert.deepEqual(prior, before);
  assert.equal(calls[0].url, 'https://mykobold.eu.auth0.com/oauth/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    grant_type: 'refresh_token', client_id: 'KY4YbVAvtgB7lp8vIbWQ7zLk3hssZlhR', refresh_token: prior.refreshToken,
  });
  assert.equal(JSON.parse(calls[1].options.body).refresh_token, 'new-private-refresh');
  assert.equal(JSON.stringify(rotated).includes('discard-private-access'), false);
  assert.equal(Object.values(client).includes('new-private-refresh'), false);
});

test('invalid refresh inputs make no request and never expose token values', async () => {
  const { client, calls } = fixture();
  for (const session of [undefined, null, false, [], {}, { idToken: 'private-id-token' },
    { refreshToken: 'private-token' }, { refreshToken: 'private-token', familyId: 'invalid-family' },
    ...['private\r\nheader', 'private token', 'private\u007f', 'privateé', 'x'.repeat(16385)].map(refreshToken => ({
      refreshToken, familyId: '11111111-1111-4111-8111-111111111111',
    }))]) {
    await assert.rejects(client.refreshAccountSession(session), error => {
      assert.equal(error.code, 'ACCOUNT_AUTHENTICATION_FAILED');
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private'));
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

test('refresh rejects missing or malformed new ID tokens without mutating the prior session', async () => {
  const prior = { idToken: 'old-private-id', refreshToken: 'old-private-refresh',
    familyId: '11111111-1111-4111-8111-111111111111' };
  const bodies = [{ access_token: 'private-access-only' }, { id_token: '' }, { id_token: 'private\nheader' },
    { id_token: 'private token' }, { id_token: 'new-id', refresh_token: null },
    { id_token: 'new-id', refresh_token: 'private\nrefresh' }];
  const { client } = fixture(...bodies.map(body => response(body)), response({ error: 'private-error' }, 401));
  const before = structuredClone(prior);
  for (let index = 0; index <= bodies.length; index += 1) {
    await assert.rejects(client.refreshAccountSession(prior), error => {
      assert.equal(error.code, 'ACCOUNT_AUTHENTICATION_FAILED');
      assert.equal(error.cause, undefined);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private'));
      return true;
    });
    assert.deepEqual(prior, before);
  }
});

test('imports only saved map identities using the same transient account ID token when requested', async () => {
  const privateValue = 'private-map-url-token-and-geometry';
  const { client, calls } = fixture(
    response({ id_token: 'private-id-token', access_token: 'do-not-use-access-token' }),
    response([{
      name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret,
      nucleo_url: ROBOT.endpoint,
    }]),
    response([
      { id: 'map-1', name: ' Ground floor ', url: `https://example.org/${privateValue}`,
        raw_floor_map_url: privateValue, geometry: [[123, 456]], token: privateValue },
      { id: 'map-1', name: 'Ground floor' },
      { id: 42, name: 'Upstairs' },
    ]),
  );
  const robots = await client.discoverRobots('me@example.org', '123456', { includeMaps: true });
  assert.deepEqual(robots, [{ ...ROBOT, maps: [
    { id: 'map-1', name: 'Ground floor' }, { id: '42', name: 'Upstairs' },
  ] }]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url,
    'https://beehive.ksecosys.com/users/me/robots/OPS12345-ABC123/persistent_maps');
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.body, undefined);
  assert.equal(calls[2].options.headers.Authorization, 'Auth0Bearer private-id-token');
  assert.equal(calls[2].options.headers.Accept, 'application/vnd.neato.beehive.v1+json');
  assert.equal(calls[2].options.redirect, 'error');
  assert.ok(!JSON.stringify(robots).includes(privateValue));
  assert.ok(!JSON.stringify(robots).includes('private-id-token'));
  assert.ok(!Object.values(client).includes('private-id-token'));
});

test('keeps map catalogs associated with each verified robot and accepts an empty catalog', async () => {
  const second = { ...ROBOT, serial: 'SECOND-ROBOT', name: 'Second robot' };
  const { client, calls } = fixture(
    response({ id_token: 'id-token' }),
    response([ROBOT, second].map(robot => ({
      name: robot.name, serial: robot.serial, secret_key: robot.secret, nucleo_url: robot.endpoint,
    }))),
    response([]),
    response([{ id: 'second-map', name: 'Second map' }]),
  );
  assert.deepEqual(await client.discoverRobots('me@example.org', '123456', { includeMaps: true }), [
    { ...ROBOT, maps: [] }, { ...second, maps: [{ id: 'second-map', name: 'Second map' }] },
  ]);
  assert.deepEqual(calls.slice(2).map(call => call.url), [
    'https://beehive.ksecosys.com/users/me/robots/OPS12345-ABC123/persistent_maps',
    'https://beehive.ksecosys.com/users/me/robots/SECOND-ROBOT/persistent_maps',
  ]);
});

test('mixed VR200 and VR300 discovery imports maps only for the supported model and retains both robots', async () => {
  const vr200 = { ...ROBOT, model: 'VR200', serial: 'VR200-DEMO', name: 'Demo VR200' };
  const vr300 = { ...ROBOT, model: 'VR300', serial: 'VR300-DEMO', name: 'Demo VR300' };
  const { client, calls } = fixture(
    response({ id_token: 'private-mixed-model-token', refresh_token: 'private-mixed-model-refresh' }),
    response([vr200, vr300].map(robot => ({ model: robot.model, name: robot.name, serial: robot.serial,
      secret_key: robot.secret, nucleo_url: robot.endpoint }))),
    response([{ id: 'demo-map', name: 'Demo floor' }]),
  );
  const robots = await client.discoverRobots('me@example.org', '123456', { includeMaps: true, includeAccount: true });
  assert.deepEqual(robots.map(({ serial, model }) => ({ serial, model })), [
    { serial: vr200.serial, model: 'VR200' }, { serial: vr300.serial, model: 'VR300' },
  ]);
  assert.deepEqual(robots[1].maps, [{ id: 'demo-map', name: 'Demo floor' }]);
  assert.ok(!robots[0].maps || robots[0].maps.length === 0, 'VR200 must not be given a fabricated persistent map');
  assert.deepEqual(calls.slice(2).map(call => call.url), [
    'https://beehive.ksecosys.com/users/me/robots/VR300-DEMO/persistent_maps',
  ]);
  assert.equal(robots[0].accountSession.familyId, robots[1].accountSession.familyId);
  assert.notEqual(robots[0].accountSession, robots[1].accountSession);
  assert.equal(robots[0].accountSession.idToken, 'private-mixed-model-token');
  assert.equal(calls.length, 3);
});

test('mixed model discovery still fails atomically when supported VR300 map import fails', async () => {
  const { client, calls } = fixture(response({ id_token: 'private-mixed-model-token' }),
    response(['VR200', 'VR300'].map(model => ({ model, serial: `${model}-DEMO`,
      secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }))),
    response({ private: 'must not be exposed' }, 403));
  await assert.rejects(client.discoverRobots('me@example.org', '123456', { includeMaps: true }), error => {
    assert.equal(error.code, 'MAP_DISCOVERY_FAILED');
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('private'), false);
    return true;
  });
  assert.deepEqual(calls.slice(2).map(call => call.url), [
    'https://beehive.ksecosys.com/users/me/robots/VR300-DEMO/persistent_maps',
  ]);
});

test('an unknown discovery model can recover one failed map import from a signed VR200 status probe', async () => {
  const { client, calls } = fixture(response({ id_token: 'private-probe-token' }),
    response([{ serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
    response({}, 403), response({ ...STATE, meta: { modelName: 'VR200' }, availableServices: { houseCleaning: 'basic-1' } }));
  const [robot] = await client.discoverRobots('me@example.org', '123456', { includeMaps: true });
  assert.equal(robot.model, 'VR200');
  assert.deepEqual(robot.maps, []);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].url, `https://nucleo.ksecosys.com:4443/vendors/vorwerk/robots/${ROBOT.serial}/messages`);
  assert.deepEqual(JSON.parse(calls[3].options.body), { reqId: '1', cmd: 'getRobotState' });
  assert.match(calls[3].options.headers.Authorization, /^NEATOAPP [a-f0-9]{64}$/);
  assert.equal(JSON.stringify(calls[3]).includes('private-probe-token'), false);
});

test('model-less basic-1 discovery can recover without inventing a model, but VR300 evidence remains strict', async () => {
  for (const modelName of [undefined, 'VR300', 'VR220']) {
    const { client, calls } = fixture(response({ id_token: 'private-probe-token' }),
      response([{ serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
      response({}, 403), response({ ...STATE, meta: { modelName }, availableServices: { houseCleaning: 'basic-1' } }));
    if (modelName) await assert.rejects(client.discoverRobots('me@example.org', '123456', { includeMaps: true }),
      { code: 'MAP_DISCOVERY_FAILED' });
    else {
      const [robot] = await client.discoverRobots('me@example.org', '123456', { includeMaps: true });
      assert.deepEqual(robot.maps, []);
      assert.equal(robot.model, undefined);
    }
    assert.equal(calls.length, 4, 'Only one read-only status probe is allowed');
  }
});

test('failed unknown-model status probes retain the original sanitized map-import error without repeated requests', async () => {
  for (const probe of [response({ private: 'probe response' }, 500), response({ result: 'ok', state: 'bad', details: {} })]) {
    const { client, calls } = fixture(response({ id_token: 'private-probe-token' }),
      response([{ serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
      response({ private: 'map response' }, 403), probe);
    await assert.rejects(client.discoverRobots('me@example.org', '123456', { includeMaps: true }), error => {
      assert.equal(error.code, 'MAP_DISCOVERY_FAILED');
      assert.equal(error.status, 403);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('private'), false);
      return true;
    });
    assert.equal(calls.length, 4);
  }
});

test('requested map imports reject malformed lists without returning a partial robot catalog', async () => {
  const malformed = [
    null, {}, { maps: [] }, [null], [{}], [{ id: 'map', name: '' }],
    [{ id: 'map', name: 'private\nname' }], [{ id: 'map', name: 'x'.repeat(257) }],
    [{ id: ' map ', name: 'Ground floor' }], [{ id: 'private\nmap', name: 'Ground floor' }],
    [{ id: -1, name: 'Ground floor' }], [{ id: 1.5, name: 'Ground floor' }],
    [{ id: Number.MAX_SAFE_INTEGER + 1, name: 'Ground floor' }],
    Array.from({ length: 101 }, () => ({ id: 'map', name: 'Ground floor' })),
  ];
  for (const maps of malformed) {
    const { client, calls } = fixture(
      response({ id_token: 'private-id-token' }),
      response([{ model: 'VR300', name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
      response(maps),
    );
    await assert.rejects(client.discoverRobots('me@example.org', '123456', { includeMaps: true }), error => {
      assert.equal(error.code, 'MAP_DISCOVERY_FAILED');
      assert.equal(error.cause, undefined);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private'));
      return true;
    });
    assert.equal(calls.length, 3);
  }
});

test('map-import permission and transport failures stay sanitized and default discovery skips the import', async () => {
  for (const failure of [response({ private: 'private-response' }, 403), () => { throw new Error('private-transport'); }]) {
    const { client, calls } = fixture(
      response({ id_token: 'private-id-token' }),
      response([{ model: 'VR300', name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
      failure,
    );
    await assert.rejects(client.discoverRobots('me@example.org', '123456', { includeMaps: true }), error => {
      assert.equal(error.code, 'MAP_DISCOVERY_FAILED');
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private'));
      return true;
    });
    assert.equal(calls.length, 3);
  }
  const { client, calls } = fixture(
    response({ id_token: 'id-token' }),
    response([{ name: ROBOT.name, serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: ROBOT.endpoint }]),
  );
  assert.deepEqual(await client.discoverRobots('me@example.org', '123456', { includeMaps: false }), [ROBOT]);
  assert.equal(calls.length, 2);
});

test('rejects invalid discovery options before requesting an account token', async () => {
  const { client, calls } = fixture();
  for (const options of [null, [], 'maps', { includeMaps: 'yes' }, { includeMaps: true, extra: true }]) {
    await assert.rejects(client.discoverRobots('me@example.org', '123456', options), { code: 'INVALID_PARAMS' });
  }
  assert.equal(calls.length, 0);
});

test('supports an account without linked robots', async () => {
  const { client } = fixture(response({ id_token: 'id-token' }), response([]));
  assert.deepEqual(await client.discoverRobots('me@example.org', '123456'), []);
});

test('signs exactly the JSON bytes sent to the discovered nucleo endpoint', async () => {
  const { client, calls } = fixture(response(STATE));
  assert.deepEqual(await client.getState(ROBOT), STATE);
  const { url, options } = calls[0];
  assert.equal(url, 'https://nucleo.ksecosys.com:4443/vendors/vorwerk/robots/OPS12345-ABC123/messages');
  assert.equal(options.body, '{"reqId":"1","cmd":"getRobotState"}');
  assert.equal(options.headers.Date, 'Sun, 18 Oct 2026 10:20:30 GMT');
  assert.equal(options.headers.Authorization, 'NEATOAPP 58becb94c5533e5768e339b683c1c595458b4902124769dd9bab56a9f9dbfe87');
  assert.equal(options.headers.Accept, 'application/vnd.neato.nucleo.v1');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.redirect, 'error');
  assert.equal(options.agent, undefined);
  assert.equal(options.dispatcher, undefined);
});

test('additional information reads sign only their literal read-only commands and preserve validated envelopes', async () => {
  const methods = ['getGeneralInfo', 'getRobotInfo', 'getPreferences', 'getLocalStats', 'getSchedule', 'getScheduleEvents'];
  const responses = methods.map((method, index) => ({ result: 'ok', data: { number: index, nested: {} } }));
  const { client, calls } = fixture(...responses.map(body => response(body)));
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index];
    assert.deepEqual(await client[method](ROBOT), responses[index]);
    const { url, options } = calls[index];
    assert.equal(url, 'https://nucleo.ksecosys.com:4443/vendors/vorwerk/robots/OPS12345-ABC123/messages');
    assert.equal(options.body, JSON.stringify({ reqId: '1', cmd: method }));
    const signature = createHmac('sha256', ROBOT.secret)
      .update(`${ROBOT.serial.toLowerCase()}\n${options.headers.Date}\n${options.body}`)
      .digest('hex');
    assert.equal(options.headers.Authorization, `NEATOAPP ${signature}`);
    assert.equal(options.redirect, 'error');
    await assert.rejects(client.command(ROBOT, method), { code: 'INVALID_COMMAND' });
  }
  assert.equal(calls.length, methods.length);
});

test('information reads reject malformed data and keep unsupported reads isolated from status', async () => {
  const methods = ['getGeneralInfo', 'getRobotInfo', 'getPreferences', 'getLocalStats', 'getSchedule', 'getScheduleEvents'];
  for (const method of methods) {
    for (const data of [undefined, null, [], 'private-response-value']) {
      const { client, calls } = fixture(response({ result: 'ok', data }));
      await assert.rejects(client[method](ROBOT), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private-response-value'));
        return true;
      });
      assert.equal(calls.length, 1);
    }
    const { client, calls } = fixture(response({ result: 'command_not_found' }), response(STATE));
    await assert.rejects(client[method](ROBOT), { code: 'COMMAND_REJECTED', result: 'command_not_found' });
    assert.deepEqual(await client.getState(ROBOT), STATE);
    assert.deepEqual(calls.map(call => JSON.parse(call.options.body).cmd), [method, 'getRobotState']);
  }
});

test('starts with persistent map and no-go-line behavior enabled by default', async () => {
  const { client, calls } = fixture(response({ result: 'ok' }));
  await client.command(ROBOT, 'startCleaning');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    reqId: '1', cmd: 'startCleaning',
    params: { category: 4, mode: 2, modifier: 1, navigationMode: 1 },
  });
});

test('VR200 basic-1 starts use only supported cleaning fields and preserve an explicit Eco mode', async () => {
  for (const robot of [{ ...ROBOT, model: 'VR200' },
    { ...ROBOT, availableServices: { houseCleaning: 'basic-1' } }]) {
    const { client, calls } = fixture(response({ result: 'ok' }), response({ result: 'ok' }));
    await client.command(robot, 'startCleaning');
    await client.command(robot, 'startCleaning', { category: 2, mode: 1, modifier: 1 });
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      reqId: '1', cmd: 'startCleaning', params: { category: 2, mode: 2, modifier: 1 },
    });
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      reqId: '1', cmd: 'startCleaning', params: { category: 2, mode: 1, modifier: 1 },
    });
  }
});

test('VR200 never silently discards requested map or navigation features and never retries a rejected basic clean', async () => {
  const robot = { ...ROBOT, model: 'VR200' };
  const { client, calls } = fixture(response({ result: 'command_rejected', private: 'do not expose' }));
  for (const params of [{ category: 4 }, { navigationMode: 1 }, { mapId: 'unsupported-map' },
    { boundaryId: 'unsupported-room' }, { category: 2, mode: 2, modifier: 1, mapId: 'unsupported-map' }]) {
    await assert.rejects(client.command(robot, 'startCleaning', params), { code: 'INVALID_PARAMS' });
  }
  assert.equal(calls.length, 0);
  await assert.rejects(client.command(robot, 'startCleaning'), { code: 'COMMAND_REJECTED' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).params.category, 2);
});

test('preserves explicit map, mode and navigation settings', async () => {
  const { client, calls } = fixture(response({ result: 'ok' }));
  await client.command(ROBOT, 'startCleaning', {
    category: 4, mode: 1, navigationMode: 3, mapId: 'my-map',
  });
  assert.deepEqual(JSON.parse(calls[0].options.body).params, {
    category: 4, mode: 1, modifier: 1, navigationMode: 3, mapId: 'my-map',
  });
});

test('reads saved polygon areas with a signed read-only message and no map geometry', async () => {
  const { client, calls } = fixture(response({
    result: 'ok', data: { mapId: 'map-1', boundaries: [
      { id: 'zone-1', name: ' Küche ', type: 'polygon', vertices: [[1, 2], [3, 4]], secret: 'not-returned' },
      { id: 'zone-1', name: 'Küche', type: 'polygon' },
      { id: 'line-1', name: '', type: 'polyline', vertices: [[1, 2]] },
      { id: 'future-1', name: 'Not a known cleaning target', type: 'future-shape' },
      { id: 'zone-2', name: 'Wohnzimmer', type: 'polygon' },
    ], private: 'not-returned' },
  }));
  assert.deepEqual(await client.getAreas(ROBOT), [
    { id: 'zone-1', name: 'Küche', mapId: 'map-1' },
    { id: 'zone-2', name: 'Wohnzimmer', mapId: 'map-1' },
  ]);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://nucleo.ksecosys.com:4443/vendors/vorwerk/robots/OPS12345-ABC123/messages');
  assert.equal(options.body, '{"reqId":"1","cmd":"getMapBoundaries","params":{"mapId":null}}');
  const signature = createHmac('sha256', ROBOT.secret)
    .update(`${ROBOT.serial.toLowerCase()}\n${options.headers.Date}\n${options.body}`)
    .digest('hex');
  assert.equal(options.headers.Authorization, `NEATOAPP ${signature}`);
  assert.equal(options.redirect, 'error');
  await assert.rejects(client.command(ROBOT, 'getMapBoundaries'), { code: 'INVALID_COMMAND' });
  assert.equal(calls.length, 1);
});

test('preserves the requested map identity and accepts an explicit empty area list', async () => {
  const { client, calls } = fixture(
    response({ result: 'ok', data: { boundaries: [{ id: 'zone', name: 'Kitchen', type: 'polygon' }] } }),
    response({ result: 'ok', data: { boundaries: [] } }),
    response({ result: 'ok', data: { mapId: null, boundaries: [] } }),
  );
  assert.deepEqual(await client.getAreas(ROBOT, { mapId: 'requested-map' }), [
    { id: 'zone', name: 'Kitchen', mapId: 'requested-map' },
  ]);
  assert.equal(JSON.parse(calls[0].options.body).params.mapId, 'requested-map');
  assert.deepEqual(await client.getAreas(ROBOT), []);
  assert.deepEqual(await client.getAreas(ROBOT, { mapId: null }), []);
});

test('does not invent a map identity when the area response has none', async () => {
  const { client } = fixture(response({
    result: 'ok', data: { boundaries: [{ id: 'zone-1', name: 'Kitchen', type: 'polygon', mapId: 'unverified' }] },
  }));
  assert.deepEqual(await client.getAreas(ROBOT), [{ id: 'zone-1', name: 'Kitchen' }]);
});

test('rejects malformed area responses instead of silently reporting no areas', async () => {
  const bodies = [
    {}, { data: null }, { data: [] }, { data: {} }, { data: { boundaries: null } },
    { data: { boundaries: {} } }, { data: { boundaries: [null] } },
    { data: { boundaries: [{}] } }, { data: { boundaries: [{ type: 'polygon' }] } },
    { data: { boundaries: [{ type: 'polygon', id: 'zone', name: '' }] } },
    { data: { boundaries: [{ type: 'polygon', id: 'zone', name: 'name\nprivate' }] } },
    { data: { boundaries: [{ type: 'polygon', id: 'zone', name: 'x'.repeat(257) }] } },
    { data: { boundaries: [{ type: 'polygon', id: '\tzone', name: 'Kitchen' }] } },
    { data: { boundaries: [{ type: 'polygon', id: 'x'.repeat(257), name: 'Kitchen' }] } },
    { data: { boundaries: Array.from({ length: 1001 }, () => ({ type: 'polyline' })) } },
    { data: { boundaries: [], mapId: 2 } },
    { data: { boundaries: [], mapId: 'private\nmap' } },
  ];
  const { client } = fixture(...bodies.map(body => response({ result: 'ok', ...body })));
  for (const body of bodies) {
    await assert.rejects(client.getAreas(ROBOT), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private'));
      return true;
    });
  }
});

test('rejects a mismatching returned map and invalid map options without leaking identifiers', async () => {
  const { client, calls } = fixture(response({
    result: 'ok', data: { mapId: 'unexpected-private-map', boundaries: [] },
  }));
  await assert.rejects(client.getAreas(ROBOT, { mapId: 'requested-map' }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('unexpected-private-map'));
    return true;
  });
  for (const options of [null, [], 'map', { mapId: '' }, { mapId: ' map ' },
    { mapId: 'x'.repeat(257) }, { mapId: 2 }, { mapId: 'map\n' }, { extra: true }]) {
    await assert.rejects(client.getAreas(ROBOT, options), { code: 'INVALID_PARAMS' });
  }
  assert.equal(calls.length, 1);
});

test('invalid area diagnostics expose only fixed type labels and counts', async () => {
  const privateValue = 'private-response-value-do-not-log';
  const { client } = fixture(response({ result: 'ok', data: {
    mapId: privateValue,
    [privateValue]: { secret: privateValue },
    boundaries: [
      { type: 'polygon', id: privateValue, name: { text: privateValue }, vertices: [[1234, 5678]] },
      { type: 'polyline', id: 3, name: privateValue },
      { type: privateValue, id: null, name: [privateValue] },
      null,
    ],
  } }));
  await assert.rejects(client.getAreas(ROBOT), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.deepEqual(error.areaDiagnostic, {
      messageAccepted: true,
      dataType: 'object', boundariesType: 'array', mapIdType: 'string', count: 4, sampledCount: 4,
      boundaryTypes: { polygon: 1, polyline: 1, other: 2 },
      recordTypes: { object: 3, null: 1 },
      idTypes: { string: 1, number: 1, null: 1, undefined: 1 },
      nameTypes: { object: 1, string: 1, array: 1, undefined: 1 },
    });
    const serialized = `${error.stack}${JSON.stringify(error)}`;
    for (const forbidden of [privateValue, 'vertices', '1234', '5678', 'secret']) {
      assert.ok(!serialized.includes(forbidden), `Unexpected response field in diagnostic: ${forbidden}`);
    }
    return true;
  });
});

test('area diagnostics distinguish a malformed envelope and missing boundaries without their contents', async () => {
  const { client } = fixture(
    response({ result: 'private-token' }),
    response({ private: 'private-token' }),
    response({ result: 'ok', data: 'private-token' }),
    response({ result: 'ok', data: { private: 'private-token' } }),
    response({ result: 'ok', data: { mapId: 'private-token', boundaries: [] } }),
  );
  await assert.rejects(client.getAreas(ROBOT), error => {
    assert.equal(error.code, 'COMMAND_REJECTED');
    assert.equal(error.areaDiagnostic, undefined);
    assert.ok(!JSON.stringify(error).includes('private-token'));
    return true;
  });
  const expected = [
    { messageAccepted: false },
    { messageAccepted: true, dataType: 'string', boundariesType: 'undefined', mapIdType: 'undefined' },
    { messageAccepted: true, dataType: 'object', boundariesType: 'undefined', mapIdType: 'undefined' },
    {
      messageAccepted: true, dataType: 'object', boundariesType: 'array', mapIdType: 'string',
      mapIdMatches: false, count: 0, sampledCount: 0,
      boundaryTypes: { polygon: 0, polyline: 0, other: 0 }, recordTypes: {}, idTypes: {}, nameTypes: {},
    },
  ];
  for (const diagnostic of expected) {
    await assert.rejects(client.getAreas(ROBOT, { mapId: 'requested-map' }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.deepEqual(error.areaDiagnostic, diagnostic);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private-token'));
      return true;
    });
  }
});

test('starts exactly the chosen map area and never falls back to a whole-house clean', async () => {
  const options = { category: 4, mode: 1, navigationMode: 2, mapId: 'map-1', boundaryId: 'zone-2' };
  const { client, calls } = fixture(
    response({ result: 'ok' }),
    response({ result: 'not_on_charge_base', alert: 'nav_floorplan_not_created' }),
  );
  await client.command(ROBOT, 'startCleaning', options);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    reqId: '1', cmd: 'startCleaning', params: { modifier: 1, ...options },
  });
  await assert.rejects(client.command(ROBOT, 'startCleaning', options), { code: 'COMMAND_REJECTED' });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body).params, JSON.parse(calls[0].options.body).params);
});

test('sends basic commands without unsupported empty params', async () => {
  const { client, calls } = fixture(...Array.from({ length: 4 }, () => response({ result: 'ok' })));
  for (const command of ['stopCleaning', 'pauseCleaning', 'resumeCleaning', 'sendToBase']) {
    await client.command(ROBOT, command);
  }
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body)), [
    { reqId: '1', cmd: 'stopCleaning' }, { reqId: '1', cmd: 'pauseCleaning' },
    { reqId: '1', cmd: 'resumeCleaning' }, { reqId: '1', cmd: 'sendToBase' },
  ]);
});

test('does not retry a rejected persistent-map clean without no-go lines', async () => {
  const { client, calls } = fixture(response({
    result: 'not_on_charge_base', alert: 'nav_floorplan_not_created',
  }));
  await assert.rejects(client.command(ROBOT, 'startCleaning'), error => {
    assert.ok(error instanceof KoboldError);
    assert.equal(error.code, 'COMMAND_REJECTED');
    assert.equal(error.result, 'not_on_charge_base');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('rejects every documented failure result and never exposes an unknown result', async () => {
  const results = [
    'invalid_json', 'bad_request', 'command_not_found', 'command_rejected',
    'ko', 'not_on_charge_base', 'private-token-as-result',
  ];
  const { client, calls } = fixture(...results.map(result => response({ result })));
  for (const result of results) {
    await assert.rejects(client.command(ROBOT, 'pauseCleaning'), error => {
      assert.equal(error.code, 'COMMAND_REJECTED');
      assert.equal(error.result, result === 'private-token-as-result' ? undefined : result);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('private-token-as-result'));
      return true;
    });
  }
  assert.equal(calls.length, results.length);
});

test('returns reported command availability unchanged instead of guessing from activity', async () => {
  const state = {
    result: 'ok', state: 3, action: 1, details: { charge: 3 },
    availableCommands: { resume: true },
  };
  const { client } = fixture(response(state));
  assert.deepEqual(await client.getState(ROBOT), state);
});

test('rejects endpoints that could leak robot credentials before making any request', async () => {
  const { client, calls } = fixture();
  for (const endpoint of [
    'http://nucleo.ksecosys.com:4443', 'https://nucleo.ksecosys.com.evil.example',
    'https://evil.example', 'https://127.0.0.1', 'https://nucleo.ksecosys.com:8443',
    'https://nucleo.ksecosys.com/secret-path', 'https://nucleo.ksecosys.com/?token=secret',
    'https://nucleo.ksecosys.com/#fragment', 'https://user:password@nucleo.ksecosys.com',
  ]) {
    await assert.rejects(client.getState({ ...ROBOT, endpoint }), { code: 'UNSUPPORTED_ENDPOINT' });
  }
  await assert.rejects(client.getState({ ...ROBOT, serial: '../other' }), { code: 'INVALID_ROBOT' });
  assert.equal(calls.length, 0);
});

test('validates discovered endpoints before returning any credential-bearing robot record', async () => {
  const { client, calls } = fixture(response({ id_token: 'id-token' }), response([{
    name: 'robot', serial: ROBOT.serial, secret_key: ROBOT.secret, nucleo_url: 'https://evil.example',
  }]));
  await assert.rejects(client.discoverRobots('me@example.org', '123456'), { code: 'UNSUPPORTED_ENDPOINT' });
  assert.equal(calls.length, 2);
});

test('rejects invalid user inputs and commands before network access', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.requestCode('invalid'), { code: 'INVALID_EMAIL' });
  await assert.rejects(client.discoverRobots('me@example.org', '123'), { code: 'INVALID_CODE' });
  await assert.rejects(client.command(ROBOT, 'factoryReset'), { code: 'INVALID_COMMAND' });
  await assert.rejects(client.command(ROBOT, 'pauseCleaning', { mode: 2 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.command(ROBOT, 'startCleaning', { category: 3 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.command(ROBOT, 'startCleaning', { mode: 9 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.command(ROBOT, 'startCleaning', { override: true }), { code: 'INVALID_PARAMS' });
  assert.equal(calls.length, 0);
});

test('does not expose cloud response bodies or underlying fetch errors', async () => {
  const leaked = 'me@example.org 123456 private-token robot-secret';
  const { client } = fixture(
    response({ error_description: leaked }, 401),
    () => { throw new Error(leaked); },
    new Response(leaked),
  );
  for (const expected of ['AUTHENTICATION_FAILED', 'NETWORK_ERROR', 'INVALID_RESPONSE']) {
    await assert.rejects(client.requestCode('me@example.org'), error => {
      assert.equal(error.code, expected);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(leaked));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('handles rate limits, robot auth rejection and server errors with safe codes', async () => {
  const { client } = fixture(response({}, 429), response({}, 403), response({}, 503));
  await assert.rejects(client.requestCode('me@example.org'), { code: 'RATE_LIMITED', status: 429 });
  await assert.rejects(client.getState(ROBOT), { code: 'ROBOT_AUTHENTICATION_FAILED', status: 403 });
  await assert.rejects(client.getState(ROBOT), { code: 'HTTP_ERROR', status: 503 });
});

test('aborts hung fetches even when the injected transport ignores its abort signal', async () => {
  let signal;
  const client = new KoboldClient({
    timeoutMs: 15,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(client.getState(ROBOT), { code: 'TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('the timeout also covers a response body that never finishes', async () => {
  const client = new KoboldClient({
    timeoutMs: 15,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  await assert.rejects(client.getState(ROBOT), { code: 'TIMEOUT' });
});

test('rejects missing ID tokens, malformed robot lists and malformed state', async () => {
  const { client } = fixture(
    response({ access_token: 'access-token-only' }),
    response({ id_token: 'id-token' }), response({ robots: [] }),
    response({ result: 'ok' }), response({ result: 'ok', state: 1 }),
  );
  await assert.rejects(client.discoverRobots('me@example.org', '123456'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(client.discoverRobots('me@example.org', '123456'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(client.getState(ROBOT), { code: 'INVALID_RESPONSE' });
  await assert.rejects(client.getState(ROBOT), { code: 'INVALID_RESPONSE' });
});
