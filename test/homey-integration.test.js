'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROBOT = {
  serial: 'VR300-TEST',
  name: 'Living room',
  secret: 'test-only-robot-secret',
  endpoint: 'https://nucleo.ksecosys.com:4443',
};
const VR200_ROBOT = { ...ROBOT, serial: 'VR200-TEST', name: 'Demo VR200', model: 'VR200' };
const CORE_CAPABILITIES = ['vacuumcleaner_state', 'measure_battery', 'alarm_generic', 'kobold_status', 'kobold_charging'];
const EXTRA_CAPABILITIES = ['kobold_cleaning_mode', 'kobold_navigation_mode', 'kobold_schedule_enabled',
  'kobold_firmware', 'kobold_model', 'kobold_charge_count', 'kobold_warning', 'kobold_current_area'];
const HISTORY_CAPABILITIES = ['kobold_last_cleaned_area', 'kobold_last_duration', 'kobold_last_cleaning'];
const BUTTON_CAPABILITIES = ['kobold_start', 'kobold_pause', 'kobold_resume', 'kobold_stop', 'kobold_dock'];
const AREA_CAPABILITIES = ['kobold_area', 'kobold_start_area'];
const VR200_CAPABILITIES = [...CORE_CAPABILITIES, ...BUTTON_CAPABILITIES,
  'kobold_cleaning_mode', 'kobold_schedule_enabled', 'kobold_firmware', 'kobold_model', 'kobold_warning'];
const VR200_UNSUPPORTED_CAPABILITIES = ['kobold_navigation_mode', 'kobold_charge_count', 'kobold_current_area',
  ...HISTORY_CAPABILITIES, ...AREA_CAPABILITIES];

// Exercise the actual app/driver/device modules with only the Homey runtime
// replaced. No production source is copied into the test implementation.
class FakeDevice {
  constructor() {
    this.data = { id: ROBOT.serial };
    this.store = { robot: { ...ROBOT } };
    this.capabilities = {};
    this.capabilityWrites = [];
    this.capabilityOptions = {};
    this.capabilityOptionsErrors = new Map();
    this.capabilityOptionsWrites = [];
    this.capabilityIds = new Set(CORE_CAPABILITIES);
    this.addedCapabilities = [];
    this.listeners = {};
    this.available = true;
    this.unavailableMessage = null;
    this.loggedErrors = [];
  }

  getData() { return this.data; }
  getName() { return 'Demo robot'; }
  async ready() {}
  getStoreValue(key) { return this.store[key]; }
  async setStoreValue(key, value) { this.store[key] = value; }
  getSetting() { return 60; }
  hasCapability(key) { return this.capabilityIds.has(key); }
  getCapabilities() { return [...this.capabilityIds]; }
  getCapabilityValue(key) { return this.capabilities[key]; }
  getCapabilityOptions(key) {
    assert.equal(this.hasCapability(key), true, `Capability ${key} must exist before reading options`);
    if (this.capabilityOptionsErrors.has(key)) throw this.capabilityOptionsErrors.get(key);
    return structuredClone(this.capabilityOptions[key] || {});
  }
  async setCapabilityOptions(key, options) {
    assert.equal(this.hasCapability(key), true, `Capability ${key} must exist before updating options`);
    this.capabilityOptions[key] = structuredClone(options);
    this.capabilityOptionsWrites.push({ key, options: structuredClone(options) });
  }
  async addCapability(key) {
    assert.equal(this.hasCapability(key), false, `Capability ${key} must only be added once`);
    this.capabilityIds.add(key);
    this.addedCapabilities.push(key);
  }
  registerCapabilityListener(key, listener) { this.listeners[key] = listener; }
  async setCapabilityValue(key, value) {
    assert.equal(this.hasCapability(key), true, `Capability ${key} must exist before setting a value`);
    this.capabilityWrites.push({ key, value });
    this.capabilities[key] = value;
  }
  getAvailable() { return this.available; }
  async setAvailable() { this.available = true; this.unavailableMessage = null; }
  async setUnavailable(message) { this.available = false; this.unavailableMessage = message; }
  error(message) { this.loggedErrors.push(message); }
}

const sdk = { App: class {}, Driver: class {}, Device: FakeDevice };
function loadProduction(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const nativeRequire = Module.createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  wrapper(module.exports, id => id === 'homey' ? sdk : nativeRequire(id), module, filename, path.dirname(filename));
  return module.exports;
}

const KoboldApp = loadProduction('app.js');
const Vr300Device = loadProduction('drivers/vr300/device.js');
const Vr300Driver = loadProduction('drivers/vr300/driver.js');

function state(overrides = {}) {
  return {
    result: 'ok', state: 1, action: 0, error: null,
    details: { charge: 75, isCharging: false, isDocked: false },
    availableCommands: { start: true, stop: false, pause: false, resume: false, goToBase: false },
    ...overrides,
  };
}

const IDLE = state();
const CLEANING = state({ state: 2, action: 1, availableCommands: { pause: true, stop: true } });
const DOCKED = state({ details: { charge: 100, isDocked: true, isCharging: false } });
const CHARGING = state({ details: { charge: 32, isDocked: true, isCharging: true } });
const VR200_DOCKED = state({ ...DOCKED, alert: null,
  availableServices: { houseCleaning: 'basic-1', schedule: 'basic-1' },
  cleaning: { category: 2, mode: 1 },
});
const PAUSED = state({ state: 2, action: 6, availableCommands: { resume: true, stop: true, goToBase: true } });
const RETURNING = state({ state: 2, action: 4, availableCommands: { stop: true } });
const ROBOT_ERROR = state({ state: 4, error: 'ui_error_brush_stuck' });
const AREAS = [
  { id: 'room-1', name: 'Küche', mapId: 'ground-floor' },
  { id: 'room-2', name: 'Wohnzimmer', mapId: 'ground-floor' },
  { id: 'room-1', name: 'Schlafzimmer', mapId: 'upper-floor' },
];
const MAPS = [{ id: 'ground-floor', name: 'Erdgeschoss' }, { id: 'upper-floor', name: 'Obergeschoss' }];
const IMPORTED_ROBOT = { ...ROBOT, maps: MAPS };
const GENERAL_INFO = { data: {
  model: 'VR300', firmware: '2.1.3', productNumber: 'VR300-123',
  battery: { totalCharges: 42, vendor: 'Battery Vendor', manufacturingDate: '2020-2-9' },
} };
const EXTRA_STATE = state({
  ...CLEANING,
  details: { ...CLEANING.details, charge: 63, isScheduleEnabled: false },
  cleaning: { category: 4, mode: 1, navigationMode: 2, boundary: { name: 'Flur' } },
  alert: 'ui_alert_invalid', availableServices: { schedule: 'basic-2' },
});
const ACCOUNT_FAMILY = '598978d0-46ab-4d76-b00f-8466ae733d9a';
function accountSession(overrides = {}) {
  return { idToken: 'private-account-id-token', refreshToken: 'private-account-refresh-token',
    expiresAt: Date.now() + 3600000, familyId: ACCOUNT_FAMILY, ...overrides };
}
const HISTORY_ENTRY = {
  id: 'a'.repeat(64), startedAt: '2026-10-18T08:00:00.000Z', endedAt: '2026-10-18T08:20:00.000Z',
  durationMinutes: 20, areaSquareMetres: 9.5, mode: 'eco', status: 'completed', error: null,
  batteryStart: 99, batteryEnd: 96, hasImage: true,
};
const HISTORY_MAP = { id: 'b'.repeat(64), name: 'Erdgeschoss', hasImage: true };

async function environment(t, snapshots = [IDLE], { diagnosticsEnabled = false, selectedArea, robotData = ROBOT,
  existingCapabilities = CORE_CAPABILITIES, additional = {}, capabilityOptionsErrors = {} } = {}) {
  const actionCards = new Map();
  const conditionCards = new Map();
  const triggerCards = new Map();
  const events = [];
  const timers = new Map();
  const settingsWrites = [];
  const settings = new Map([['diagnostics_enabled', diagnosticsEnabled]]);
  let timerId = 0;
  function card(registry, id) {
    if (!registry.has(id)) registry.set(id, {
      registerRunListener(listener) { this.run = listener; return this; },
      registerArgumentAutocompleteListener(name, listener) {
        this.autocomplete ||= {};
        this.autocomplete[name] = listener;
        return this;
      },
      async trigger(device, tokens) { events.push({ id, device, tokens }); },
    });
    return registry.get(id);
  }
  let driver;
  const homey = {
    __: key => key,
    settings: {
      get: key => settings.get(key),
      set(key, value) {
        settings.set(key, value);
        settingsWrites.push({ key, value });
      },
    },
    flow: {
      getActionCard: id => card(actionCards, id),
      getConditionCard: id => card(conditionCards, id),
      getDeviceTriggerCard: id => card(triggerCards, id),
    },
    drivers: {
      getDriver(id) {
        assert.equal(id, 'vr300');
        return driver;
      },
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      // The dock handshake waits one second between state reads. Complete
      // those waits immediately while leaving polling/follow-up timers manual.
      if (delay === 1000) queueMicrotask(callback);
      else timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const queue = [...snapshots];
  let lastState = snapshots[0];
  const cloud = {
    stateCalls: [], commands: [], areaCalls: [], areas: [], areasByMap: new Map(),
    generalInfoCalls: [], scheduleCalls: [], scheduleEventCalls: [],
    accountRefreshCalls: [],
    generalInfo: { data: {} }, schedule: { data: { enabled: false, events: [] } },
    async getState(robot) {
      this.stateCalls.push(robot);
      if (queue.length) lastState = queue.shift();
      if (lastState instanceof Error) throw lastState;
      return structuredClone(lastState);
    },
    async command(robot, command, params) {
      this.commands.push({ robot, command, params });
      if (this.commandError) throw this.commandError;
      return { result: 'ok' };
    },
    async getAreas(robot, options) {
      this.areaCalls.push({ robot, options });
      if (this.areaError) throw this.areaError;
      if (this.areasByMap.has(options?.mapId)) return structuredClone(this.areasByMap.get(options.mapId));
      return structuredClone(this.areas);
    },
    async getGeneralInfo(robot) {
      this.generalInfoCalls.push(robot);
      if (this.generalInfoError) throw this.generalInfoError;
      return structuredClone(this.generalInfo);
    },
    async getSchedule(robot) {
      this.scheduleCalls.push(robot);
      if (this.scheduleError) throw this.scheduleError;
      return structuredClone(this.schedule);
    },
    async getScheduleEvents(robot) {
      this.scheduleEventCalls.push(robot);
      if (this.scheduleEventsError) throw this.scheduleEventsError;
      return structuredClone(this.schedule);
    },
    async refreshAccountSession(account) {
      this.accountRefreshCalls.push(structuredClone(account));
      if (this.accountRefreshError) throw this.accountRefreshError;
      return accountSession({ idToken: 'private-rotated-id-token', refreshToken: 'private-rotated-refresh-token' });
    },
    async requestCode(email) { this.requestedEmail = email; },
    async discoverRobots(email, code, options) { this.verified = { email, code, options }; return [{ ...ROBOT }]; },
  };
  Object.assign(cloud, additional);
  const app = new KoboldApp();
  app.homey = homey;
  app.manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app.json'), 'utf8'));
  homey.app = app;
  await app.onInit();
  app.kobold = cloud;
  const device = new Vr300Device();
  device.capabilityIds = new Set(existingCapabilities);
  device.capabilityOptionsErrors = new Map(Object.entries(capabilityOptionsErrors));
  device.data = { id: robotData.serial };
  device.store.robot = structuredClone(robotData);
  if (selectedArea !== undefined) device.store.selected_area = selectedArea;
  device.homey = homey;
  await device.onInit();
  const initialAreaCalls = structuredClone(cloud.areaCalls);
  const account = {
    historyCalls: [], mapCalls: [], imageCalls: [], clearCalls: 0,
    history: { entries: [] }, maps: [],
    async getHistory(serial, session) {
      this.historyCalls.push({ serial, session: structuredClone(session) });
      if (this.historyError) throw this.historyError;
      return structuredClone(this.history);
    },
    async getPersistentMaps(serial, session) {
      this.mapCalls.push({ serial, session: structuredClone(session) });
      if (this.mapError) throw this.mapError;
      return structuredClone(this.maps);
    },
    async getImage(id) {
      this.imageCalls.push(id);
      if (this.imageError) throw this.imageError;
      return { mimeType: 'image/png', buffer: Buffer.from('test image bytes') };
    },
    getImageOrigins() { return []; },
    clear() { this.clearCalls += 1; },
  };
  device._account = account;
  t.after(() => device.onUninit());
  driver = new Vr300Driver();
  driver.homey = homey;
  driver.getDevices = () => [device];
  driver.getDevice = data => {
    if (data.id !== device.getData().id) throw new Error('unknown device');
    return device;
  };
  return {
    app, homey, device, driver, cloud, account, events, actionCards, conditionCards, triggerCards, timers, settingsWrites, initialAreaCalls,
    enqueue(...items) { queue.push(...items); },
    async fireTimer(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(found, `Expected a scheduled timer after ${delay}ms`);
      timers.delete(found[0]);
      await found[1].callback();
    },
  };
}

function session() {
  const handlers = new Map();
  return {
    setHandler(name, handler) { handlers.set(name, handler); },
    run(name, data) { assert.ok(handlers.has(name), `Missing session handler ${name}`); return handlers.get(name)(data); },
  };
}

function nativeAreaValues(device) {
  const values = device.getCapabilityOptions('kobold_area').values;
  assert.ok(Array.isArray(values), 'The native area picker must expose enum options');
  return values;
}

function nativeAreaOption(device, name) {
  const option = nativeAreaValues(device).find(value => typeof value.title === 'string'
    ? value.title === name : Object.values(value.title || {}).includes(name));
  assert.ok(option, `Missing native area option ${name}`);
  return option.id;
}

test('app registers all flow actions/conditions and forwards device-trigger arguments', async t => {
  const env = await environment(t);
  const expected = {
    start_cleaning: 'start', pause_cleaning: 'pause', resume_cleaning: 'resume',
    stop_cleaning: 'stop', return_to_base: 'dock', refresh_status: 'refresh',
    clean: 'start', dock: 'dock', stop: 'stop',
  };
  assert.deepEqual([...env.actionCards.keys()].sort(), [...Object.keys(expected), 'spot_clean', 'clean_area', 'refresh_areas', 'refresh_robot_data', 'refresh_history'].sort());
  assert.deepEqual([...env.conditionCards.keys()].sort(), ['is_charging', 'is_cleaning', 'is_docked',
    'is_eco_mode', 'is_robot_schedule_enabled', 'has_robot_warning', 'navigation_is', 'charge_count_above',
    'last_cleaned_area_above', 'last_duration_above', 'last_cleaning_successful', 'vacuumcleaner_state_is'].sort());
  assert.deepEqual([...env.triggerCards.keys()].sort(), ['cleaning_finished', 'cleaning_started', 'robot_error', 'state_changed',
    'cleaning_mode_changed', 'robot_schedule_changed', 'robot_warning_changed', 'history_entry_added', 'vacuumcleaner_state_changed'].sort());
  assert.equal(env.actionCards.size + env.conditionCards.size + env.triggerCards.size, 35);
  const received = [];
  const deviceArgument = {
    async executeAction(action) { received.push(action); },
    async refreshAreas() { received.push('areas'); },
    async refreshRobotData() { received.push('robot_data'); },
    async refreshHistory() { received.push('history'); return { available: true, historyAvailable: true, mapsAvailable: true }; },
    async startArea(area) { received.push(area); return true; },
  };
  for (const [id, command] of Object.entries(expected)) {
    assert.equal(await env.actionCards.get(id).run({ device: deviceArgument }), true);
    assert.equal(received.at(-1), command);
  }
  assert.equal(await env.actionCards.get('refresh_areas').run({ device: deviceArgument }), true);
  assert.equal(received.at(-1), 'areas');
  assert.equal(await env.actionCards.get('refresh_robot_data').run({ device: deviceArgument }), true);
  assert.equal(received.at(-1), 'robot_data');
  assert.equal(await env.actionCards.get('refresh_history').run({ device: deviceArgument }), true);
  assert.equal(received.at(-1), 'history');
  const area = { id: 'kitchen', name: 'Kitchen', mapId: 'ground-floor' };
  assert.equal(await env.actionCards.get('clean_area').run({ device: deviceArgument, area }), true);
  assert.deepEqual(received.at(-1), area);
  const tokens = { state: 'returning', status: 'Returning' };
  await env.app.triggerDevice('state_changed', deviceArgument, tokens);
  assert.deepEqual(env.events, [{ id: 'state_changed', device: deviceArgument, tokens }]);
});

test('the packaged manifest retains every Flow ID and limits optional cards to their corresponding capability', async t => {
  const env = await environment(t);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app.json'), 'utf8'));
  const registries = { actions: env.actionCards, conditions: env.conditionCards, triggers: env.triggerCards };
  const optionalFilters = {
    clean_area: 'kobold_area', refresh_areas: 'kobold_area', refresh_history: 'kobold_last_cleaned_area',
    navigation_is: 'kobold_navigation_mode', charge_count_above: 'kobold_charge_count',
    last_cleaned_area_above: 'kobold_last_cleaned_area', last_duration_above: 'kobold_last_duration',
    last_cleaning_successful: 'kobold_last_cleaning', history_entry_added: 'kobold_last_cleaned_area',
  };
  for (const [group, registry] of Object.entries(registries)) {
    assert.deepEqual(manifest.flow[group].map(card => card.id).sort(), [...registry.keys()].sort());
    for (const card of manifest.flow[group]) {
      const deviceArgument = card.args.find(arg => arg.name === 'device');
      assert.equal(deviceArgument.type, 'device');
      const filters = new URLSearchParams(deviceArgument.filter);
      assert.equal(filters.get('driver_id'), 'vr300');
      assert.equal(filters.get('capabilities'), optionalFilters[card.id] || null,
        `${card.id} must use the intended supported-capability selector`);
    }
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('legacy action card IDs use the same guarded robot command path as their current equivalents', async t => {
  for (const [id, before, after, command] of [
    ['clean', DOCKED, CLEANING, 'startCleaning'],
    ['dock', PAUSED, RETURNING, 'sendToBase'],
    ['stop', CLEANING, IDLE, 'stopCleaning'],
  ]) {
    const env = await environment(t, [before, before, after]);
    assert.equal(await env.actionCards.get(id).run({ device: env.device }), true);
    assert.deepEqual(env.cloud.commands.map(item => item.command), [command]);
    assert.equal(env.cloud.stateCalls.length, 3);
  }
  const unavailable = await environment(t, [DOCKED]);
  await assert.rejects(unavailable.actionCards.get('stop').run({ device: unavailable.device }), /errors.command_unavailable/);
  assert.deepEqual(unavailable.cloud.commands, []);
});

test('the legacy spot-clean card rejects an unsupported operation without reading or controlling the robot', async t => {
  const env = await environment(t, [DOCKED]);
  await assert.rejects(env.actionCards.get('spot_clean').run({ device: env.device }), /errors.unsupported_action/);
  assert.equal(env.cloud.stateCalls.length, 1, 'A rejected spot action must not start a preflight or another command');
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'docked');
});

test('legacy state conditions and trigger filters retain every original state value', async t => {
  const env = await environment(t);
  const states = ['cleaning', 'spot_cleaning', 'docked', 'charging', 'stopped'];
  for (const value of states) {
    await env.device.setCapabilityValue('vacuumcleaner_state', value);
    for (const requested of states) {
      const args = { device: env.device, state: requested };
      assert.equal(await env.conditionCards.get('vacuumcleaner_state_is').run(args), value === requested);
      assert.equal(await env.triggerCards.get('vacuumcleaner_state_changed').run(args), value === requested);
      assert.equal(!await env.conditionCards.get('vacuumcleaner_state_is').run(args), value !== requested);
    }
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('unknown legacy states abort ordinary, inverted and trigger filters instead of becoming a successful negative check', async t => {
  const env = await environment(t);
  const condition = env.conditionCards.get('vacuumcleaner_state_is');
  const trigger = env.triggerCards.get('vacuumcleaner_state_changed');
  for (const value of [undefined, null, '', 'idle', 'returning', 'unknown', 0, false, {}]) {
    await env.device.setCapabilityValue('vacuumcleaner_state', value);
    const args = { device: env.device, state: 'cleaning' };
    await assert.rejects(async () => condition.run(args), /errors.flow_value_unknown/);
    await assert.rejects(async () => !await condition.run(args), /errors.flow_value_unknown/);
    await assert.rejects(async () => trigger.run(args), /errors.flow_value_unknown/);
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('observed legacy state updates rely on Homey to emit the compatibility trigger once', async t => {
  const env = await environment(t, [IDLE, CLEANING]);
  await env.device.refreshStatus();
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'cleaning');
  assert.equal(env.events.filter(event => event.id === 'state_changed').length, 1);
  assert.equal(env.events.filter(event => event.id === 'vacuumcleaner_state_changed').length, 0,
    'The app must not explicitly duplicate Homey\'s automatic capability trigger');
  assert.equal(await env.triggerCards.get('vacuumcleaner_state_changed').run({ device: env.device, state: 'cleaning' }), true);
  assert.deepEqual(env.cloud.commands, []);
});

test('initial state is a silent baseline, including a first error snapshot', async t => {
  for (const initial of [IDLE, CLEANING, DOCKED, CHARGING, PAUSED, ROBOT_ERROR]) {
    const env = await environment(t, [initial]);
    assert.deepEqual(env.events, []);
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.capabilities.alarm_generic, initial === ROBOT_ERROR);
  }
});

test('a newly paired VR200 adds only supported native controls and keeps status and schedule reads available', async t => {
  const env = await environment(t, [VR200_DOCKED], { robotData: VR200_ROBOT });
  assert.deepEqual(env.device.getCapabilities().sort(), [...VR200_CAPABILITIES].sort());
  assert.equal(env.device.getCapabilities().length, 15);
  assert.deepEqual(env.device.getSupport(), { model: 'VR200', areas: false, history: false,
    maps: false, generalInfo: false, navigation: false });
  assert.deepEqual(env.cloud.areaCalls, []);
  assert.deepEqual(env.cloud.generalInfoCalls, []);
  assert.equal(env.cloud.scheduleCalls.length, 1);
  assert.deepEqual(env.cloud.scheduleEventCalls, []);
  assert.equal(env.device.capabilities.measure_battery, 100);
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'docked');
  assert.equal(env.device.capabilities.kobold_cleaning_mode, 'eco');
  assert.equal(env.device.capabilities.kobold_schedule_enabled, false);
  assert.equal(env.device.getAvailable(), true);
  const [dto] = await env.app.getAreaDevices();
  assert.deepEqual(dto.support, env.device.getSupport());
  assert.equal(JSON.stringify(dto).includes(ROBOT.secret), false);
  const copy = env.device.getSupport(); copy.areas = true;
  assert.equal(env.device.getSupport().areas, false);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('VR200 migration retains every existing capability and Flow card while hiding unsupported native components', async t => {
  const existingCapabilities = [...CORE_CAPABILITIES, ...EXTRA_CAPABILITIES, ...HISTORY_CAPABILITIES,
    ...BUTTON_CAPABILITIES, ...AREA_CAPABILITIES];
  const env = await environment(t, [VR200_DOCKED], { robotData: VR200_ROBOT, existingCapabilities });
  assert.deepEqual(env.device.getCapabilities().sort(), [...existingCapabilities].sort());
  assert.deepEqual(env.device.addedCapabilities, []);
  for (const id of VR200_UNSUPPORTED_CAPABILITIES) {
    assert.equal(env.device.getCapabilityOptions(id).uiComponent, null, `Unsupported ${id} must be hidden without removing it`);
  }
  for (const id of BUTTON_CAPABILITIES) {
    assert.equal(typeof env.device.listeners[id], 'function');
    assert.notEqual(env.device.getCapabilityOptions(id).uiComponent, null);
  }
  assert.equal(typeof env.device.listeners.vacuumcleaner_state, 'function');
  assert.equal(env.actionCards.size + env.conditionCards.size + env.triggerCards.size, 35);
  await env.device.onUninit();
  await env.device.onInit();
  assert.deepEqual(env.device.addedCapabilities, []);
  assert.deepEqual(env.device.getCapabilities().sort(), [...existingCapabilities].sort());
  assert.deepEqual(env.cloud.commands, []);
});

test('VR200 explicitly advertised general information is readable without enabling maps or navigation', async t => {
  const supportedInfo = state({ ...VR200_DOCKED,
    availableServices: { ...VR200_DOCKED.availableServices, generalInfo: 'basic-1' },
  });
  const env = await environment(t, [supportedInfo], { robotData: VR200_ROBOT, additional: { generalInfo: GENERAL_INFO } });
  assert.equal(env.device.getSupport().generalInfo, true);
  assert.equal(env.device.getSupport().areas, false);
  assert.equal(env.device.getSupport().history, false);
  assert.equal(env.device.getSupport().navigation, false);
  assert.equal(env.cloud.generalInfoCalls.length, 1);
  assert.equal(env.device.getRobotData().chargeCount, 42);
  assert.equal(env.device.getInfoAvailable(), true);
  assert.ok(env.device.hasCapability('kobold_charge_count'));
  assert.notEqual(env.device.getCapabilityOptions('kobold_charge_count').uiComponent, null);
  assert.deepEqual(env.cloud.areaCalls, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('a VR300 firmware identity survives partial metadata without losing features or invalidating read-only caches', async t => {
  const services = { houseCleaning: 'basic-3', schedule: 'basic-2' };
  const initial = state({ ...DOCKED, meta: { modelName: 'VR220' }, availableServices: services,
    cleaning: { category: 4, mode: 1, navigationMode: 2 } });
  const env = await environment(t, [initial], { robotData: { ...ROBOT, accountSession: accountSession() },
    additional: { areas: AREAS, generalInfo: GENERAL_INFO } });
  await env.device.selectArea(AREAS[0]);
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  const before = {
    support: env.device.getSupport(), info: env.cloud.generalInfoCalls.length,
    schedule: env.cloud.scheduleEventCalls.length, options: env.device.capabilityOptionsWrites.length,
    areaReads: env.cloud.areaCalls.length, selected: env.device.getSelectedArea(),
    picker: env.device.getCapabilityValue('kobold_area'), history: env.device.getCleaningHistory(),
  };
  assert.equal(before.support.model, 'VR300');
  env.enqueue(state({ ...DOCKED, availableServices: services,
    cleaning: { category: 4, mode: 1, navigationMode: 2 } }));
  await env.device.refreshStatus();
  assert.deepEqual({
    support: env.device.getSupport(), info: env.cloud.generalInfoCalls.length,
    schedule: env.cloud.scheduleEventCalls.length, options: env.device.capabilityOptionsWrites.length,
    areaReads: env.cloud.areaCalls.length, selected: env.device.getSelectedArea(),
    picker: env.device.getCapabilityValue('kobold_area'), history: env.device.getCleaningHistory(),
  }, before);
  assert.equal(env.device.getCapabilities().length, 23);
  assert.equal(env.device.getAvailable(), true);
  assert.deepEqual(env.events, []);
  env.enqueue(state({ ...VR200_DOCKED, meta: { modelName: 'VR200' } }));
  await env.device.refreshStatus();
  assert.equal(env.device.getSupport().model, 'VR200', 'New recognized firmware evidence must override the remembered identity');
  assert.equal(env.device.getSupport().areas, false);
  assert.equal(env.device.getSupport().history, false);
  assert.deepEqual(env.cloud.commands, []);
});

test('VR200 start uses basic-1 options from a fresh state and excludes stale navigation or map fields', async t => {
  const staleAdvancedState = state({ ...VR200_DOCKED,
    cleaning: { category: 4, mode: 1, navigationMode: 3, mapId: 'stale-map', boundaryId: 'stale-room' },
  });
  const env = await environment(t, [VR200_DOCKED, staleAdvancedState, CLEANING], { robotData: VR200_ROBOT });
  await env.device.listeners.kobold_start(true);
  assert.deepEqual(env.cloud.commands.map(({ command, params }) => ({ command, params })), [{
    command: 'startCleaning', params: { category: 2, mode: 1, modifier: 1 },
  }]);
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'cleaning');
  assert.equal(env.cloud.commands.length, 1);
});

test('VR200 unsupported area and history paths fail explicitly without account, catalog or motion requests', async t => {
  const env = await environment(t, [VR200_DOCKED], { robotData: { ...VR200_ROBOT, accountSession: accountSession() } });
  const [dto] = await env.app.getAreaDevices();
  for (const work of [
    () => env.device.refreshAreas(), () => env.device.selectArea(AREAS[0]), () => env.device.startArea(AREAS[0]),
    () => env.device.refreshHistory(), () => env.device.getHistoryImage(HISTORY_MAP.id),
    () => env.app.refreshDeviceAreas(dto.id), () => env.app.startDeviceArea(dto.id, AREAS[0]),
    () => env.app.refreshDeviceHistory(dto.id),
    () => env.actionCards.get('clean_area').run({ device: env.device, area: AREAS[0] }),
    () => env.actionCards.get('refresh_history').run({ device: env.device }),
  ]) await assert.rejects(async () => work(), /errors.feature_unsupported/);
  assert.deepEqual(env.cloud.areaCalls, []);
  assert.deepEqual(env.account.historyCalls, []);
  assert.deepEqual(env.account.mapCalls, []);
  assert.deepEqual(env.account.imageCalls, []);
  assert.deepEqual(env.cloud.accountRefreshCalls, []);
  assert.deepEqual(env.cloud.commands, []);
  assert.equal(env.device.getAvailable(), true);
});

test('existing devices gain only missing additional capabilities without removing older values', async t => {
  const existingCapabilities = [...CORE_CAPABILITIES, 'kobold_firmware', 'kobold_pause', 'kobold_stop', 'kobold_area'];
  const env = await environment(t, [IDLE], { existingCapabilities });
  const allCapabilities = [...CORE_CAPABILITIES, ...EXTRA_CAPABILITIES, ...HISTORY_CAPABILITIES, ...BUTTON_CAPABILITIES, ...AREA_CAPABILITIES];
  assert.deepEqual(env.device.addedCapabilities.sort(), allCapabilities.filter(id => !existingCapabilities.includes(id)).sort());
  assert.deepEqual(env.device.getCapabilities().sort(), allCapabilities.sort());
  assert.deepEqual(BUTTON_CAPABILITIES.filter(id => typeof env.device.listeners[id] !== 'function'), []);
  assert.equal(typeof env.device.listeners.kobold_area, 'function');
  assert.equal(typeof env.device.listeners.kobold_start_area, 'function');
  assert.equal(typeof env.device.listeners.vacuumcleaner_state, 'function');
  await env.device.onUninit();
  const additions = [...env.device.addedCapabilities];
  await env.device.onInit();
  assert.deepEqual(env.device.addedCapabilities, additions);
  assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => BUTTON_CAPABILITIES.includes(key)), []);
  assert.deepEqual(env.cloud.commands, []);
});

test('VR300 initialization tolerates missing readable SDK options for its existing stateless area button', async t => {
  const env = await environment(t, [DOCKED], { capabilityOptionsErrors: {
    kobold_start_area: new Error('Invalid Capability: kobold_start_area'),
  } });
  assert.ok(env.device.hasCapability('kobold_start_area'));
  assert.equal(env.app.manifest.capabilities.kobold_start_area.getable, false);
  assert.equal(typeof env.device.listeners.kobold_start_area, 'function');
  assert.equal(env.device.getAvailable(), true);
  assert.equal(env.device.unavailableMessage, null);
  assert.equal(env.device.getSnapshot().state, 'docked');
  assert.equal(env.device.capabilities.measure_battery, 100);
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => key === 'kobold_start_area'), []);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('SDK options failures on readable capabilities or unrelated errors are not mistaken for stateless button options', async t => {
  for (const [capability, message] of [
    ['kobold_area', 'Invalid Capability: kobold_area'],
    ['kobold_start_area', 'Synthetic SDK options transport error'],
  ]) {
    await assert.rejects(environment(t, [DOCKED], { capabilityOptionsErrors: {
      [capability]: new Error(message),
    } }), error => {
      assert.equal(error.message, message);
      return true;
    });
  }
});

for (const [capability, before, after, command] of [
  ['kobold_start', DOCKED, CLEANING, 'startCleaning'],
  ['kobold_pause', CLEANING, PAUSED, 'pauseCleaning'],
  ['kobold_resume', PAUSED, CLEANING, 'resumeCleaning'],
  ['kobold_stop', CLEANING, IDLE, 'stopCleaning'],
  ['kobold_dock', PAUSED, RETURNING, 'sendToBase'],
]) {
  test(`native ${capability} button dispatches its command without a persistent button value`, async t => {
    for (const value of [undefined, true, false]) {
      const env = await environment(t, [before, before, after]);
      assert.equal(typeof env.device.listeners[capability], 'function');
      await env.device.listeners[capability](value);
      assert.deepEqual(env.cloud.commands.map(({ command: sent, params }) => ({ command: sent, params })), [{
        command, params: command === 'startCleaning' ? { category: 4, mode: 2, modifier: 1, navigationMode: 1 } : undefined,
      }]);
      assert.equal(env.cloud.stateCalls.length, 3, 'The button must use a current preflight and a confirming read');
      assert.equal(env.device.capabilities.vacuumcleaner_state,
        after === RETURNING || after === IDLE || after === PAUSED ? 'stopped' : 'cleaning');
      assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => BUTTON_CAPABILITIES.includes(key)), []);
      assert.equal(env.device.getCapabilityValue(capability), undefined);
    }
  });
}

test('a native button acknowledgement preserves the observed status until the robot confirms a change', async t => {
  const env = await environment(t, [DOCKED]);
  let acknowledge;
  let commandStarted;
  const started = new Promise(resolve => { commandStarted = resolve; });
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  env.cloud.command = async function (robot, command, params) {
    this.commands.push({ robot, command, params });
    commandStarted();
    return acknowledgement;
  };
  const action = env.device.listeners.kobold_start();
  await started;
  const assertObservedDock = () => {
    assert.equal(env.device.getSnapshot().state, 'docked');
    assert.equal(env.device.capabilities.vacuumcleaner_state, 'docked');
    assert.equal(env.device.capabilities.kobold_status, 'status.docked');
    assert.deepEqual(env.events, []);
    assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => BUTTON_CAPABILITIES.includes(key)), []);
  };
  try { assertObservedDock(); } finally { acknowledge({ result: 'ok' }); }
  await action;
  assertObservedDock();
  assert.equal(env.cloud.commands.length, 1);
  await env.fireTimer(5000);
  assertObservedDock();
  assert.equal(env.cloud.commands.length, 1, 'Polling an unchanged state must not repeat the button action');
});

test('native button failures propagate without status guesses or fallback commands', async t => {
  const unavailable = await environment(t, [IDLE]);
  await assert.rejects(unavailable.device.listeners.kobold_resume(), /errors.command_unavailable/);
  assert.deepEqual(unavailable.cloud.commands, []);
  assert.equal(unavailable.device.capabilities.vacuumcleaner_state, 'stopped');
  assert.deepEqual(unavailable.events, []);
  const rejected = await environment(t, [DOCKED]);
  rejected.cloud.commandError = new Error('Synthetic failed acknowledgement');
  await assert.rejects(rejected.device.listeners.kobold_start(), /errors.command_failed/);
  assert.equal(rejected.cloud.commands.length, 1);
  assert.equal(rejected.device.capabilities.vacuumcleaner_state, 'docked');
  assert.deepEqual(rejected.events, []);
  assert.deepEqual(rejected.device.capabilityWrites.filter(({ key }) => BUTTON_CAPABILITIES.includes(key)), []);
});

test('legacy vacuum state listener continues accepting existing control values alongside native buttons', async t => {
  for (const [value, before, after, command] of [
    ['cleaning', DOCKED, CLEANING, 'startCleaning'],
    ['stopped', CLEANING, IDLE, 'stopCleaning'],
    ['docked', PAUSED, RETURNING, 'sendToBase'],
    ['charging', PAUSED, RETURNING, 'sendToBase'],
  ]) {
    const env = await environment(t, [before, before, after]);
    await env.device.listeners.vacuumcleaner_state(value);
    assert.deepEqual(env.cloud.commands.map(item => item.command), [command]);
    assert.deepEqual(BUTTON_CAPABILITIES.filter(id => typeof env.device.listeners[id] !== 'function'), []);
  }
});

test('additional values combine live state and general information without losing false or zero', async t => {
  const info = structuredClone(GENERAL_INFO);
  info.data.battery.totalCharges = 0;
  const env = await environment(t, [EXTRA_STATE], { additional: { generalInfo: info } });
  const data = env.device.getRobotData();
  assert.equal(data.cleaningMode, 'eco');
  assert.equal(data.navigationMode, 'extra_care');
  assert.equal(data.scheduleEnabled, false);
  assert.equal(data.firmware, '2.1.3');
  assert.equal(data.model, 'VR300');
  assert.equal(data.chargeCount, 0);
  assert.equal(data.area, 'Flur');
  assert.equal(data.warningCode, null);
  assert.equal(data.warningKnown, true);
  assert.equal(data.batteryVendor, 'Battery Vendor');
  assert.equal(data.batteryManufacturingDate, '2020-02-09');
  assert.equal(data.productNumber, 'VR300-123');
  assert.equal(typeof data.warning, 'string');
  assert.equal(env.device.capabilities.kobold_cleaning_mode, 'eco');
  assert.equal(env.device.capabilities.kobold_navigation_mode, 'extra_care');
  assert.equal(env.device.capabilities.kobold_schedule_enabled, false);
  assert.equal(env.device.capabilities.kobold_charge_count, 0);
  assert.equal(env.device.capabilities.kobold_current_area, 'Flur');
  assert.equal(env.device.getInfoAvailable(), true);
  assert.ok(Number.isFinite(Date.parse(env.device.getRobotDataUpdatedAt())));
  assert.ok(Number.isFinite(Date.parse(env.device.getInfoUpdatedAt())));
  data.model = 'Caller changed copy';
  assert.equal(env.device.getRobotData().model, 'VR300');
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('unknown additional values remain null and reject Flow checks before they can be inverted', async t => {
  const unknown = state({
    details: { charge: 12, isScheduleEnabled: 'false' },
    cleaning: { mode: 99, navigationMode: 99 },
    meta: { firmware: 'not-a-version', modelName: 'https://private.invalid' },
  });
  const env = await environment(t, [unknown]);
  const data = env.device.getRobotData();
  for (const key of ['cleaningMode', 'navigationMode', 'scheduleEnabled', 'firmware', 'model', 'chargeCount', 'area']) {
    assert.equal(data[key], null, `${key} must remain unknown`);
  }
  for (const capability of EXTRA_CAPABILITIES.filter(id => id !== 'kobold_warning')) {
    assert.equal(env.device.capabilities[capability], null, `${capability} must not invent a display value`);
  }
  assert.equal(data.warningKnown, false);
  assert.equal(data.warning, null);
  assert.equal(env.device.capabilities.kobold_warning, null);
  for (const id of ['is_eco_mode', 'is_robot_schedule_enabled', 'has_robot_warning']) {
    await assert.rejects(env.conditionCards.get(id).run({ device: env.device }), /errors.flow_value_unknown/);
  }
  await assert.rejects(env.conditionCards.get('navigation_is').run({ device: env.device, mode: 'normal' }), /errors.flow_value_unknown/);
  await assert.rejects(env.conditionCards.get('charge_count_above').run({ device: env.device, count: 0 }), /errors.flow_value_unknown/);
  assert.equal(env.device.capabilities.measure_battery, 12);
  assert.deepEqual(env.cloud.commands, []);
});

test('negated additional Flow conditions accept known false and zero but never turn unknown into true', async t => {
  const knownNegative = { ...EXTRA_STATE, alert: null,
    cleaning: { ...EXTRA_STATE.cleaning, mode: 2, navigationMode: 1 },
    details: { ...EXTRA_STATE.details, isScheduleEnabled: false } };
  const env = await environment(t, [knownNegative], { additional: { generalInfo: {
    data: { ...GENERAL_INFO.data, battery: { ...GENERAL_INFO.data.battery, totalCharges: 0 } },
  } } });
  const checks = [['is_eco_mode', {}], ['is_robot_schedule_enabled', {}], ['has_robot_warning', {}],
    ['navigation_is', { mode: 'extra_care' }], ['charge_count_above', { count: 0 }]];
  const inverted = async (id, args) => !await env.conditionCards.get(id).run({ device: env.device, ...args });
  for (const [id, args] of checks) {
    assert.equal(await env.conditionCards.get(id).run({ device: env.device, ...args }), false);
    assert.equal(await inverted(id, args), true);
  }
  env.cloud.generalInfo = { data: {} };
  env.enqueue(state({ cleaning: { mode: 99, navigationMode: 99 } }));
  await env.device.refreshRobotData();
  for (const [id, args] of checks) {
    await assert.rejects(inverted(id, args), /errors.flow_value_unknown/,
      `Unknown ${id} must abort before a negated Flow can proceed`);
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('missing snapshots or unknown basic values reject both ordinary and negated Flow checks', async t => {
  const env = await environment(t, [DOCKED]);
  let snapshot = null;
  t.mock.method(env.device, 'getSnapshot', () => snapshot);
  for (const candidate of [null, {}, { state: 'unrecognized', docked: null, charging: null }]) {
    snapshot = candidate;
    for (const id of ['is_cleaning', 'is_docked', 'is_charging']) {
      await assert.rejects(env.conditionCards.get(id).run({ device: env.device }), /errors.flow_value_unknown/);
      await assert.rejects(async () => !await env.conditionCards.get(id).run({ device: env.device }), /errors.flow_value_unknown/);
    }
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('additional information refresh uses only reads and bypasses the normal short-term cache', async t => {
  const env = await environment(t, [EXTRA_STATE], { additional: { generalInfo: GENERAL_INFO } });
  assert.equal(env.cloud.generalInfoCalls.length, 1);
  assert.equal(env.cloud.scheduleEventCalls.length, 1);
  assert.equal(env.cloud.scheduleCalls.length, 0);
  assert.equal(env.cloud.stateCalls.length, 1);
  await env.device.refreshStatus();
  assert.equal(env.cloud.stateCalls.length, 2);
  assert.equal(env.cloud.generalInfoCalls.length, 1);
  env.cloud.generalInfo = { data: { ...GENERAL_INFO.data, firmware: '2.1.4' } };
  const refreshed = await env.device.refreshRobotData();
  assert.equal(env.cloud.stateCalls.length, 3);
  assert.equal(env.cloud.generalInfoCalls.length, 2);
  assert.equal(env.cloud.scheduleEventCalls.length, 2);
  assert.equal(refreshed.firmware, '2.1.4');
  assert.equal(env.device.capabilities.kobold_firmware, '2.1.4');
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.cloud.areaCalls, env.initialAreaCalls);
});

test('schedule information chooses the supported read endpoint and skips unknown services', async t => {
  for (const service of ['basic-1', 'basic-2', undefined]) {
    const env = await environment(t, [state({ availableServices: service ? { schedule: service } : {} })]);
    assert.equal(env.cloud.scheduleCalls.length, service === 'basic-1' ? 1 : 0);
    assert.equal(env.cloud.scheduleEventCalls.length, service === 'basic-2' ? 1 : 0);
    assert.deepEqual(env.cloud.commands, []);
  }
});

test('schedule getters and the settings API expose sanitized independent event copies', async t => {
  const scheduled = state({ availableServices: { schedule: 'basic-2' } });
  const schedule = { data: { enabled: false, secret: ROBOT.secret, events: [{
    day: 2, startTime: '08:30', mode: 1, mapId: 'private-scheduled-map',
    boundary: { id: 'private-scheduled-boundary', name: 'Flur' }, secret: ROBOT.secret,
  }] } };
  const env = await environment(t, [scheduled], { additional: { schedule } });
  const value = env.device.getRobotSchedule();
  assert.equal(value.available, true);
  assert.equal(value.enabled, false);
  assert.ok(Number.isFinite(Date.parse(value.updatedAt)));
  assert.deepEqual(value.events, [{ day: 2, time: '08:30', mode: 'eco', area: 'Flur' }]);
  assert.equal(env.device.getRobotData().scheduleEnabled, false);
  value.events[0].time = '12:00';
  value.events.push({ day: 3 });
  assert.deepEqual(env.device.getRobotSchedule().events, [{ day: 2, time: '08:30', mode: 'eco', area: 'Flur' }]);
  const [device] = await env.app.getAreaDevices();
  assert.deepEqual(device.robotSchedule.events, [{ day: 2, time: '08:30', mode: 'eco', area: 'Flur' }]);
  const serialized = JSON.stringify(device);
  for (const privateValue of [ROBOT.secret, ROBOT.serial, ROBOT.endpoint, 'private-scheduled-map', 'private-scheduled-boundary']) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('optional information failures preserve a fresh robot status and allow later recovery', async t => {
  for (const failingRead of ['generalInfoError', 'scheduleEventsError']) {
    const env = await environment(t, [EXTRA_STATE], { additional: { generalInfo: GENERAL_INFO } });
    env.cloud[failingRead] = new Error('private optional-response failure');
    env.enqueue(state({ ...CHARGING, details: { ...CHARGING.details, charge: 41 },
      availableServices: { schedule: 'basic-2' } }));
    await env.device.refreshRobotData();
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.capabilities.measure_battery, 41);
    assert.equal(env.device.capabilities.vacuumcleaner_state, 'charging');
    assert.equal(env.device.getInfoAvailable(), failingRead !== 'generalInfoError');
    assert.equal(env.device.getRobotSchedule().available, failingRead !== 'scheduleEventsError');
    assert.equal(env.device.getRobotData().chargeCount, 42);
    const checkCounter = () => env.conditionCards.get('charge_count_above').run({ device: env.device, count: 1 });
    if (failingRead === 'generalInfoError') await assert.rejects(checkCounter(), /errors.flow_value_unknown/);
    else assert.equal(await checkCounter(), true);
    assert.equal(JSON.stringify(env.settingsWrites).includes('private optional-response failure'), false);
    env.cloud[failingRead] = null;
    await env.device.refreshRobotData();
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.getInfoAvailable(), true);
    assert.equal(env.device.getRobotSchedule().available, true);
    assert.deepEqual(env.cloud.commands, []);
  }
});

test('expired optional information reads occur after control commands, never between command checks and motion', async t => {
  const clockNow = Date.now();
  for (const action of ['pause', 'area']) {
    const env = await environment(t, action === 'pause' ? [CLEANING, CLEANING, PAUSED]
      : [DOCKED, DOCKED, DOCKED, CLEANING]);
    env.cloud.areas = AREAS;
    const calls = [];
    const command = env.cloud.command.bind(env.cloud);
    const generalInfo = env.cloud.getGeneralInfo.bind(env.cloud);
    env.cloud.command = async (...args) => {
      calls.push(`command:${args[1]}`);
      return command(...args);
    };
    env.cloud.getGeneralInfo = async (...args) => {
      calls.push('info');
      return generalInfo(...args);
    };
    t.mock.method(Date, 'now', () => clockNow + 16 * 60 * 1000);
    if (action === 'area') await env.device.startArea(AREAS[0]);
    else await env.device.executeAction(action);
    assert.deepEqual(calls, [`command:${action === 'area' ? 'startCleaning' : 'pauseCleaning'}`, 'info']);
    assert.equal(env.cloud.commands.length, 1);
    t.mock.restoreAll();
  }
});

test('closing while optional information is pending prevents late data changes and Flow triggers', async t => {
  const env = await environment(t, [EXTRA_STATE]);
  const before = env.device.getRobotData();
  let completeInfo;
  let notifyInfoStarted;
  const infoStarted = new Promise(resolve => { notifyInfoStarted = resolve; });
  env.cloud.getGeneralInfo = () => {
    notifyInfoStarted();
    return new Promise(resolve => { completeInfo = resolve; });
  };
  env.enqueue({ ...EXTRA_STATE, alert: 'clean_incomplete_to_start',
    cleaning: { ...EXTRA_STATE.cleaning, mode: 2, navigationMode: 3 },
    details: { ...EXTRA_STATE.details, isScheduleEnabled: true } });
  const refresh = env.device.refreshRobotData();
  await infoStarted;
  await env.device.onUninit();
  completeInfo(GENERAL_INFO);
  await refresh;
  assert.deepEqual(env.device.getRobotData(), before);
  assert.deepEqual(env.events, []);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.cloud.commands, []);
});

test('additional Flow conditions use known values and reject invalid charge-count thresholds', async t => {
  const warned = { ...EXTRA_STATE, alert: 'clean_incomplete_to_start',
    details: { ...EXTRA_STATE.details, isScheduleEnabled: true } };
  const env = await environment(t, [warned], { additional: { generalInfo: GENERAL_INFO } });
  for (const id of ['is_eco_mode', 'is_robot_schedule_enabled', 'has_robot_warning']) {
    assert.equal(await env.conditionCards.get(id).run({ device: env.device }), true);
  }
  assert.equal(await env.conditionCards.get('navigation_is').run({ device: env.device, mode: 'extra_care' }), true);
  assert.equal(await env.conditionCards.get('navigation_is').run({ device: env.device, mode: 'normal' }), false);
  const count = env.conditionCards.get('charge_count_above');
  assert.equal(await count.run({ device: env.device, count: 41 }), true);
  assert.equal(await count.run({ device: env.device, count: 42 }), false);
  for (const invalid of [-1, 1.5, '1', NaN, Infinity, undefined]) {
    assert.equal(await count.run({ device: env.device, count: invalid }), false);
  }
  await env.device.setUnavailable('offline');
  for (const id of ['is_eco_mode', 'is_robot_schedule_enabled', 'has_robot_warning']) {
    await assert.rejects(env.conditionCards.get(id).run({ device: env.device }), /errors.robot_unavailable/);
  }
  await assert.rejects(count.run({ device: env.device, count: 1 }), /errors.robot_unavailable/);
  assert.deepEqual(env.cloud.commands, []);
});

test('additional triggers stay silent on first observation and fire once for real changes', async t => {
  const env = await environment(t, [EXTRA_STATE], { additional: { generalInfo: GENERAL_INFO } });
  assert.deepEqual(env.events, []);
  const changed = { ...EXTRA_STATE, alert: 'clean_incomplete_to_start',
    cleaning: { ...EXTRA_STATE.cleaning, mode: 2, navigationMode: 3 },
    details: { ...EXTRA_STATE.details, isScheduleEnabled: true } };
  env.enqueue(changed);
  await env.device.refreshStatus();
  assert.deepEqual(env.events.filter(({ id }) => id === 'cleaning_mode_changed').map(({ tokens }) => tokens),
    [{ mode: 'turbo', navigation: 'deep' }]);
  assert.deepEqual(env.events.filter(({ id }) => id === 'robot_schedule_changed').map(({ tokens }) => tokens),
    [{ enabled: true }]);
  assert.deepEqual(env.events.filter(({ id }) => id === 'robot_warning_changed').map(({ tokens }) => tokens),
    [{ code: 'clean_incomplete_to_start', message: env.device.getRobotData().warning }]);
  await env.device.refreshStatus();
  assert.equal(env.events.filter(({ id }) => id === 'cleaning_mode_changed').length, 1);
  assert.equal(env.events.filter(({ id }) => id === 'robot_schedule_changed').length, 1);
  assert.equal(env.events.filter(({ id }) => id === 'robot_warning_changed').length, 1);
  env.enqueue({ ...changed, alert: 'ui_alert_invalid' });
  await env.device.refreshStatus();
  assert.deepEqual(env.events.filter(({ id }) => id === 'robot_warning_changed').at(-1).tokens,
    { code: '', message: 'warnings.none' });
  assert.deepEqual(env.cloud.commands, []);
});

test('missing or malformed warning readings never emit a false clear or a change from unknown', async t => {
  const warning = { ...EXTRA_STATE, alert: 'clean_incomplete_to_start' };
  const env = await environment(t, [warning]);
  assert.equal(env.device.getRobotData().warningKnown, true);
  assert.equal(await env.conditionCards.get('has_robot_warning').run({ device: env.device }), true);
  const missing = { ...EXTRA_STATE };
  delete missing.alert;
  for (const unknown of [missing, { ...EXTRA_STATE, alert: { private: ROBOT.secret } },
    { ...EXTRA_STATE, alert: 'not a safe alert code' }]) {
    env.enqueue(unknown);
    await env.device.refreshStatus();
    assert.equal(env.device.getRobotData().warningKnown, false);
    assert.equal(env.device.getRobotData().warning, null);
    assert.equal(env.device.capabilities.kobold_warning, null);
    await assert.rejects(env.conditionCards.get('has_robot_warning').run({ device: env.device }), /errors.flow_value_unknown/);
    assert.equal(env.events.filter(({ id }) => id === 'robot_warning_changed').length, 0);
  }
  env.enqueue({ ...EXTRA_STATE, alert: null });
  await env.device.refreshStatus();
  assert.equal(env.device.getRobotData().warningKnown, true);
  assert.equal(env.device.getRobotData().warning, 'warnings.none');
  assert.equal(env.events.filter(({ id }) => id === 'robot_warning_changed').length, 0);
  env.enqueue(warning);
  await env.device.refreshStatus();
  assert.deepEqual(env.events.filter(({ id }) => id === 'robot_warning_changed').map(({ tokens }) => tokens),
    [{ code: 'clean_incomplete_to_start', message: 'warnings.clean_incomplete_to_start' }]);
  env.enqueue({ ...EXTRA_STATE, alert: null });
  await env.device.refreshStatus();
  assert.deepEqual(env.events.filter(({ id }) => id === 'robot_warning_changed').at(-1).tokens,
    { code: '', message: 'warnings.none' });
  assert.equal(env.events.filter(({ id }) => id === 'robot_warning_changed').length, 2);
  const initiallyUnknown = await environment(t, [missing]);
  initiallyUnknown.enqueue(warning);
  await initiallyUnknown.device.refreshStatus();
  assert.equal(initiallyUnknown.device.getRobotData().warningKnown, true);
  assert.equal(await initiallyUnknown.conditionCards.get('has_robot_warning').run({ device: initiallyUnknown.device }), true);
  assert.deepEqual(initiallyUnknown.events, []);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(initiallyUnknown.cloud.commands, []);
});

test('unknown cleaning settings becoming known do not invent mode or schedule changes', async t => {
  const env = await environment(t, [IDLE]);
  env.enqueue(state({ cleaning: { mode: 1, navigationMode: 2 },
    details: { ...IDLE.details, isScheduleEnabled: false } }));
  await env.device.refreshStatus();
  assert.deepEqual(env.events, []);
  assert.equal(env.device.getRobotData().cleaningMode, 'eco');
  assert.equal(env.device.getRobotData().scheduleEnabled, false);
  assert.deepEqual(env.cloud.commands, []);
});

test('concurrent account reads refresh a shared token family once and persist rotation before reading', async t => {
  const expired = accountSession({ expiresAt: Date.now() - 1 });
  const first = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: expired } });
  const second = await environment(t, [DOCKED], { robotData: { ...ROBOT, serial: 'VR300-SECOND', accountSession: expired } });
  const unrelated = await environment(t, [DOCKED], { robotData: { ...ROBOT,
    accountSession: accountSession({ familyId: 'a6aa759e-cad3-475a-82d1-0a25cebf0dbf' }) } });
  first.driver.getDevices = () => [first.device, second.device, unrelated.device];
  let finishRefresh;
  let notifyRefreshStarted;
  const refreshStarted = new Promise(resolve => { notifyRefreshStarted = resolve; });
  first.cloud.refreshAccountSession = async session => {
    first.cloud.accountRefreshCalls.push(structuredClone(session));
    notifyRefreshStarted();
    return new Promise(resolve => { finishRefresh = resolve; });
  };
  const work = async session => {
    assert.equal(first.device.getAccountSession().idToken, 'private-rotated-id-token');
    assert.equal(second.device.getAccountSession().idToken, 'private-rotated-id-token');
    return session.idToken;
  };
  const one = first.app.withAccountSession(first.device, work);
  await refreshStarted;
  const two = first.app.withAccountSession(second.device, work);
  await Promise.resolve();
  assert.equal(first.cloud.accountRefreshCalls.length, 1);
  finishRefresh(accountSession({ idToken: 'private-rotated-id-token', refreshToken: 'private-rotated-refresh-token' }));
  assert.deepEqual(await Promise.all([one, two]), ['private-rotated-id-token', 'private-rotated-id-token']);
  assert.equal(first.cloud.accountRefreshCalls.length, 1);
  assert.equal(first.cloud.accountRefreshCalls[0].refreshToken, expired.refreshToken);
  for (const device of [first.device, second.device]) {
    assert.equal(device.getAccountSession().familyId, ACCOUNT_FAMILY);
    assert.equal(device.getAccountSession().refreshToken, 'private-rotated-refresh-token');
  }
  assert.equal(unrelated.device.getAccountSession().idToken, 'private-account-id-token');
  const serialized = JSON.stringify(await first.app.getAreaDevices());
  for (const token of [expired.idToken, expired.refreshToken, 'private-rotated-id-token', 'private-rotated-refresh-token']) {
    assert.equal(serialized.includes(token), false);
  }
  assert.deepEqual(first.cloud.commands, []);
  assert.deepEqual(second.cloud.commands, []);
  assert.deepEqual(unrelated.cloud.commands, []);
});

test('account authentication failures retry only once and do not poison later account reads', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  const authFailure = () => Object.assign(new Error('private account rejection'), { code: 'ACCOUNT_AUTHENTICATION_FAILED' });
  let reads = 0;
  assert.equal(await env.app.withAccountSession(env.device, async session => {
    reads += 1;
    if (reads === 1) throw authFailure();
    return session.idToken;
  }), 'private-rotated-id-token');
  assert.equal(reads, 2);
  assert.equal(env.cloud.accountRefreshCalls.length, 1);
  let rejectedReads = 0;
  await assert.rejects(env.app.withAccountSession(env.device, async () => {
    rejectedReads += 1;
    throw authFailure();
  }), error => error.code === 'ACCOUNT_AUTHENTICATION_FAILED');
  assert.equal(rejectedReads, 2);
  assert.equal(env.cloud.accountRefreshCalls.length, 2);
  assert.equal(await env.app.withAccountSession(env.device, async () => 'recovered'), 'recovered');
  assert.equal(env.cloud.accountRefreshCalls.length, 2);
  assert.deepEqual(env.cloud.commands, []);
});

test('a failed rotated-token store write does not cause later account reads to reuse the old token', async t => {
  const expired = accountSession({ expiresAt: Date.now() - 1 });
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: expired } });
  env.device.updateAccountSession = async () => { throw new Error('private store failure'); };
  const read = async session => {
    if (session.idToken === expired.idToken) {
      throw Object.assign(new Error('old identity token rejected'), { code: 'ACCOUNT_AUTHENTICATION_FAILED' });
    }
    return session.idToken;
  };
  assert.deepEqual(await Promise.all([
    env.app.withAccountSession(env.device, read), env.app.withAccountSession(env.device, read),
  ]), ['private-rotated-id-token', 'private-rotated-id-token']);
  assert.equal(await env.app.withAccountSession(env.device, read), 'private-rotated-id-token');
  assert.equal(env.cloud.accountRefreshCalls.length, 1);
  assert.equal(env.device.getAccountSession().refreshToken, expired.refreshToken);
  assert.deepEqual(env.cloud.commands, []);
});

test('restart uses the persisted rotated account session and treats recovered history as a silent baseline', async t => {
  const expired = accountSession({ expiresAt: Date.now() - 1 });
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: expired } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  assert.equal(env.cloud.accountRefreshCalls.length, 1);
  assert.equal(env.device.getStoreValue('robot').accountSession.refreshToken, 'private-rotated-refresh-token');
  await env.device.onUninit();
  await env.app.onInit();
  env.app.kobold = env.cloud;
  await env.device.onInit();
  env.device._account = env.account;
  const newest = { ...HISTORY_ENTRY, id: 'd'.repeat(64), startedAt: '2026-10-18T10:00:00.000Z' };
  env.account.history = { entries: [newest, HISTORY_ENTRY] };
  await env.device.refreshHistory();
  assert.equal(env.cloud.accountRefreshCalls.length, 1);
  assert.equal(env.account.historyCalls.at(-1).session.idToken, 'private-rotated-id-token');
  assert.equal(env.device.getCleaningHistory().entries[0].id, newest.id);
  assert.equal(env.device.getCleaningHistory().available, true);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
  assert.equal(env.cloud.requestedEmail, undefined);
  assert.equal(env.cloud.verified, undefined);
});

test('account reads without a stored session require login without invoking account or robot commands', async t => {
  const env = await environment(t, [DOCKED]);
  let invoked = false;
  await assert.rejects(env.app.withAccountSession(env.device, async () => { invoked = true; }),
    error => error.code === 'ACCOUNT_LOGIN_REQUIRED');
  assert.equal(invoked, false);
  assert.deepEqual(env.cloud.accountRefreshCalls, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('history and persistent maps update their displays using read-only account requests', async t => {
  const session = accountSession();
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: session } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  const stateReads = env.cloud.stateCalls.length;
  const history = await env.device.refreshHistory();
  assert.equal(history.available, true);
  assert.equal(history.historyAvailable, true);
  assert.equal(history.mapsAvailable, true);
  assert.equal(history.needsLogin, false);
  assert.deepEqual(history.entries, [HISTORY_ENTRY]);
  assert.deepEqual(history.maps, [HISTORY_MAP]);
  assert.ok(Number.isFinite(Date.parse(history.updatedAt)));
  assert.equal(env.device.capabilities.kobold_last_cleaned_area, 9.5);
  assert.equal(env.device.capabilities.kobold_last_duration, 20);
  assert.equal(typeof env.device.capabilities.kobold_last_cleaning, 'string');
  assert.equal(env.account.historyCalls.length, 1);
  assert.equal(env.account.mapCalls.length, 1);
  assert.equal(env.account.historyCalls[0].serial, ROBOT.serial);
  assert.equal(env.account.historyCalls[0].session.idToken, session.idToken);
  assert.equal(env.cloud.stateCalls.length, stateReads);
  history.entries[0].areaSquareMetres = 999;
  history.maps[0].name = 'Changed caller copy';
  history.entries.length = 0;
  assert.deepEqual(env.device.getCleaningHistory().entries, [HISTORY_ENTRY]);
  assert.deepEqual(env.device.getCleaningHistory().maps, [HISTORY_MAP]);
  const [publicDevice] = await env.app.getAreaDevices();
  assert.deepEqual(publicDevice.cleaningHistory.entries, [HISTORY_ENTRY]);
  const serialized = JSON.stringify(publicDevice);
  for (const privateValue of [session.idToken, session.refreshToken, session.familyId, ROBOT.secret, ROBOT.serial, ROBOT.endpoint]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('history triggers only a newly observed latest entry and its Flow conditions use known metrics', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  await env.device.refreshHistory();
  assert.deepEqual(env.events, []);
  assert.equal(await env.conditionCards.get('last_cleaned_area_above').run({ device: env.device, area: 9 }), true);
  assert.equal(await env.conditionCards.get('last_cleaned_area_above').run({ device: env.device, area: 9.5 }), false);
  assert.equal(await env.conditionCards.get('last_duration_above').run({ device: env.device, minutes: 19 }), true);
  assert.equal(await env.conditionCards.get('last_duration_above').run({ device: env.device, minutes: 20 }), false);
  assert.equal(await env.conditionCards.get('last_cleaning_successful').run({ device: env.device }), true);
  for (const invalid of [-1, '1', NaN, Infinity, undefined]) {
    assert.equal(await env.conditionCards.get('last_cleaned_area_above').run({ device: env.device, area: invalid }), false);
    assert.equal(await env.conditionCards.get('last_duration_above').run({ device: env.device, minutes: invalid }), false);
  }
  const next = { ...HISTORY_ENTRY, id: 'c'.repeat(64), startedAt: '2026-10-18T09:00:00.000Z',
    areaSquareMetres: null, durationMinutes: null, endedAt: null, status: 'incomplete' };
  env.account.history = { entries: [next, HISTORY_ENTRY] };
  await env.device.refreshHistory();
  assert.deepEqual(env.events.filter(({ id }) => id === 'history_entry_added').map(({ tokens }) => tokens),
    [{ started_at: next.startedAt, status: 'incomplete', area: '', duration: '' }]);
  await assert.rejects(env.conditionCards.get('last_cleaned_area_above').run({ device: env.device, area: 0 }), /errors.flow_value_unknown/);
  await assert.rejects(env.conditionCards.get('last_duration_above').run({ device: env.device, minutes: 0 }), /errors.flow_value_unknown/);
  assert.equal(await env.conditionCards.get('last_cleaning_successful').run({ device: env.device }), false);
  await env.device.refreshHistory();
  assert.equal(env.events.filter(({ id }) => id === 'history_entry_added').length, 1);
  assert.deepEqual(env.cloud.commands, []);
});

test('history conditions preserve known zero and failure while rejecting unknown results and empty history', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  const checks = [['last_cleaned_area_above', { area: 0 }], ['last_duration_above', { minutes: 0 }],
    ['last_cleaning_successful', {}]];
  const inverted = async (id, args) => !await env.conditionCards.get(id).run({ device: env.device, ...args });
  env.account.history = { entries: [{ ...HISTORY_ENTRY,
    areaSquareMetres: 0, durationMinutes: 0, endedAt: null, status: 'failed' }] };
  await env.device.refreshHistory();
  for (const [id, args] of checks) {
    assert.equal(await env.conditionCards.get(id).run({ device: env.device, ...args }), false);
    assert.equal(await inverted(id, args), true);
  }
  env.account.history = { entries: [{ ...HISTORY_ENTRY,
    areaSquareMetres: null, durationMinutes: null, status: 'unknown' }] };
  await env.device.refreshHistory();
  for (const [id, args] of checks) await assert.rejects(inverted(id, args), /errors.flow_value_unknown/);
  env.account.history = { entries: [{ ...HISTORY_ENTRY, endedAt: null }] };
  await env.device.refreshHistory();
  await assert.rejects(inverted('last_cleaning_successful', {}), /errors.flow_value_unknown/);
  env.account.history = { entries: [{ ...HISTORY_ENTRY, status: 'unknown', error: 'ui_error_brush_stuck' }] };
  await env.device.refreshHistory();
  assert.equal(await env.conditionCards.get('last_cleaning_successful').run({ device: env.device }), false);
  env.account.history = { entries: [] };
  await env.device.refreshHistory();
  for (const [id, args] of checks) await assert.rejects(inverted(id, args), /errors.flow_value_unknown/);
  assert.deepEqual(env.cloud.commands, []);
});

test('history removal, older rediscovery and temporarily empty lists never replay old cleaning events', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  const entry = (id, hour) => ({ ...HISTORY_ENTRY, id: id.repeat(64),
    startedAt: `2026-10-18T${hour}:00:00.000Z`, endedAt: `2026-10-18T${hour}:20:00.000Z` });
  const latest = entry('a', '10');
  const older = entry('b', '08');
  const olderUnseen = entry('c', '09');
  const genuinelyNew = entry('d', '11');
  env.account.history = { entries: [latest, older] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  for (const entries of [[older], [olderUnseen], [], [latest, older], [older]]) {
    env.account.history = { entries };
    await env.device.refreshHistory();
    assert.equal(env.events.filter(({ id }) => id === 'history_entry_added').length, 0);
  }
  env.account.history = { entries: [genuinelyNew, latest, older] };
  await env.device.refreshHistory();
  assert.deepEqual(env.events.filter(({ id }) => id === 'history_entry_added').map(({ tokens }) => tokens),
    [{ started_at: genuinelyNew.startedAt, status: 'completed', area: '9.5', duration: '20' }]);
  for (const entries of [[genuinelyNew], [latest], [{ ...genuinelyNew, id: 'e'.repeat(64), startedAt: null, endedAt: null }]]) {
    env.account.history = { entries };
    await env.device.refreshHistory();
    assert.equal(env.events.filter(({ id }) => id === 'history_entry_added').length, 1);
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('history login and read failures preserve basic robot status and never start cleaning', async t => {
  const disconnected = await environment(t, [DOCKED]);
  assert.deepEqual(await disconnected.device.refreshHistory(), {
    entries: [], maps: [], updatedAt: null, available: false, historyAvailable: false, mapsAvailable: false, needsLogin: true,
  });
  await assert.rejects(disconnected.actionCards.get('refresh_history').run({ device: disconnected.device }), /errors.account_login_required/);
  assert.deepEqual(disconnected.account.historyCalls, []);
  assert.deepEqual(disconnected.account.mapCalls, []);
  assert.equal(disconnected.device.getAvailable(), true);
  for (const failedRead of ['historyError', 'mapError']) {
    const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
    env.account.history = { entries: [HISTORY_ENTRY] };
    env.account.maps = [HISTORY_MAP];
    await env.device.refreshHistory();
    env.account[failedRead] = Object.assign(new Error('private account response'), { code: 'NETWORK_ERROR' });
    const result = await env.device.refreshHistory();
    assert.equal(result.available, false);
    assert.equal(result.historyAvailable, failedRead !== 'historyError');
    assert.equal(result.mapsAvailable, failedRead !== 'mapError');
    assert.equal(result.needsLogin, false);
    assert.deepEqual(result.entries, [HISTORY_ENTRY]);
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.capabilities.measure_battery, 100);
    const checkSuccess = () => env.conditionCards.get('last_cleaning_successful').run({ device: env.device });
    if (failedRead === 'historyError') await assert.rejects(checkSuccess(), /errors.history_unavailable/);
    else assert.equal(await checkSuccess(), true);
    assert.equal(await env.actionCards.get('refresh_history').run({ device: env.device }), true);
    assert.equal(JSON.stringify(env.settingsWrites).includes('private account response'), false);
    assert.deepEqual(env.cloud.commands, []);
  }
  assert.deepEqual(disconnected.cloud.commands, []);
});

test('scheduled history rate limits and timeouts preserve status and recover without token refresh or duplicate events', async t => {
  for (const code of ['RATE_LIMITED', 'TIMEOUT']) {
    const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
    env.account.history = { entries: [HISTORY_ENTRY] };
    env.account.maps = [HISTORY_MAP];
    await env.device.refreshHistory();
    const failure = Object.assign(new Error(`private ${code} response`), { code });
    env.account.historyError = failure;
    env.account.mapError = failure;
    await env.fireTimer(1500);
    const failed = env.device.getCleaningHistory();
    assert.equal(failed.available, false);
    assert.equal(failed.historyAvailable, false);
    assert.equal(failed.mapsAvailable, false);
    assert.equal(failed.needsLogin, false);
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.capabilities.measure_battery, 100);
    assert.equal(env.device.capabilities.kobold_last_cleaned_area, HISTORY_ENTRY.areaSquareMetres);
    await assert.rejects(env.conditionCards.get('last_cleaning_successful').run({ device: env.device }), /errors.history_unavailable/);
    assert.equal(env.account.historyCalls.length, 2);
    assert.ok([...env.timers.values()].some(({ delay }) => delay === 15 * 60 * 1000));
    env.account.historyError = null;
    env.account.mapError = null;
    await env.fireTimer(15 * 60 * 1000);
    assert.equal(env.device.getCleaningHistory().available, true);
    assert.equal(env.account.historyCalls.length, 3);
    assert.deepEqual(env.cloud.accountRefreshCalls, []);
    assert.deepEqual(env.events, []);
    assert.deepEqual(env.cloud.commands, []);
  }
});

test('map images require a known opaque identifier and expired images refresh once without motion', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  for (const invalid of ['https://private.invalid/map.png?token=secret', 'unknown-map', 'f'.repeat(64)]) {
    await assert.rejects(env.device.getHistoryImage(invalid), /errors.image_unavailable/);
  }
  assert.deepEqual(env.account.imageCalls, []);
  const originalImage = env.account.getImage.bind(env.account);
  let attempts = 0;
  env.account.getImage = async id => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('private expired URL'), { code: 'IMAGE_EXPIRED' });
    return originalImage(id);
  };
  const [{ id }] = await env.app.getAreaDevices();
  assert.deepEqual(await env.app.getDeviceHistoryImage(id, HISTORY_MAP.id),
    { mimeType: 'image/png', data: Buffer.from('test image bytes').toString('base64') });
  assert.equal(attempts, 2);
  assert.equal(env.account.historyCalls.length, 2);
  assert.equal(env.account.mapCalls.length, 2);
  await assert.rejects(env.app.getDeviceHistoryImage('unknown-device', HISTORY_MAP.id), /errors.device_not_found/);
  assert.deepEqual(env.cloud.commands, []);
});

test('closing a device cancels history polling and clears private image references', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  assert.ok([...env.timers.values()].some(({ delay }) => delay === 1500));
  await env.device.onUninit();
  assert.equal(env.timers.size, 0);
  assert.equal(env.account.clearCalls, 1);
  await assert.rejects(env.device.refreshHistory(), /errors.device_closed/);
  assert.deepEqual(env.account.historyCalls, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('a history response from before repair cannot restore old data or change the new login state', async t => {
  for (const result of ['success', 'login_error']) {
    const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
    env.account.history = { entries: [HISTORY_ENTRY] };
    env.account.maps = [HISTORY_MAP];
    await env.device.refreshHistory();
    let finishHistory;
    let failHistory;
    let notifyHistoryStarted;
    const historyStarted = new Promise(resolve => { notifyHistoryStarted = resolve; });
    env.account.getHistory = () => {
      notifyHistoryStarted();
      return new Promise((resolve, reject) => { finishHistory = resolve; failHistory = reject; });
    };
    const pending = env.device.refreshHistory();
    await historyStarted;
    await env.device.replaceRobot({ ...ROBOT, secret: 'renewed-secret', accountSession: accountSession({
      familyId: 'f96c6771-79d9-4c93-b200-bf03c9919846', idToken: 'new-family-id-token', refreshToken: 'new-family-refresh-token',
    }) });
    const afterRepair = env.device.getCleaningHistory();
    assert.deepEqual(afterRepair.entries, []);
    assert.deepEqual(afterRepair.maps, []);
    assert.equal(afterRepair.needsLogin, false);
    for (const capability of HISTORY_CAPABILITIES) assert.equal(env.device.capabilities[capability], null);
    if (result === 'success') finishHistory({ entries: [HISTORY_ENTRY] });
    else failHistory(Object.assign(new Error('old account login failed'), { code: 'ACCOUNT_LOGIN_REQUIRED' }));
    await pending;
    assert.deepEqual(env.device.getCleaningHistory(), afterRepair);
    assert.deepEqual(env.events, []);
    assert.deepEqual(env.cloud.commands, []);
  }
});

test('an image fetched before repair is rejected instead of returning data from the old account', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  let finishImage;
  let notifyImageStarted;
  const imageStarted = new Promise(resolve => { notifyImageStarted = resolve; });
  env.account.getImage = () => {
    notifyImageStarted();
    return new Promise(resolve => { finishImage = resolve; });
  };
  const image = env.device.getHistoryImage(HISTORY_MAP.id);
  await imageStarted;
  await env.device.replaceRobot({ ...ROBOT, accountSession: accountSession({ familyId: '231395f9-725d-40d9-9f4b-ecfc29d362bd' }) });
  finishImage({ mimeType: 'image/png', buffer: Buffer.from('private old account image') });
  await assert.rejects(image, /errors.device_closed/);
  assert.deepEqual(env.device.getCleaningHistory().entries, []);
  assert.deepEqual(env.device.getCleaningHistory().maps, []);
  assert.equal(env.device.getCleaningHistory().needsLogin, false);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('repair invalidates old history and pending images even when the first renewed robot status read fails', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  assert.equal(env.device.capabilities.kobold_last_cleaned_area, HISTORY_ENTRY.areaSquareMetres);
  let finishImage;
  let notifyImageStarted;
  const imageStarted = new Promise(resolve => { notifyImageStarted = resolve; });
  env.account.getImage = () => {
    notifyImageStarted();
    return new Promise(resolve => { finishImage = resolve; });
  };
  const pendingImage = env.device.getHistoryImage(HISTORY_MAP.id);
  await imageStarted;
  const renewed = accountSession({ familyId: '25e25442-5415-4f89-8742-5645aee31bda',
    idToken: 'renewed-private-id-token', refreshToken: 'renewed-private-refresh-token' });
  env.enqueue(new Error('private renewed status response'));
  await assert.rejects(env.device.replaceRobot({ ...ROBOT, secret: 'renewed-secret', accountSession: renewed }),
    /errors.robot_unavailable/);
  assert.equal(env.device.getAccountSession().familyId, renewed.familyId);
  assert.equal(env.device.getStoreValue('robot').secret, 'renewed-secret');
  assert.equal(env.device.getAvailable(), false);
  assert.deepEqual(env.device.getCleaningHistory(), { entries: [], maps: [], updatedAt: null,
    available: false, historyAvailable: false, mapsAvailable: false, needsLogin: false });
  for (const capability of HISTORY_CAPABILITIES) assert.equal(env.device.capabilities[capability], null);
  assert.equal(env.account.clearCalls, 1);
  finishImage({ mimeType: 'image/png', buffer: Buffer.from('private old map image') });
  await assert.rejects(pendingImage, /errors.device_closed/);
  await assert.rejects(env.device.getHistoryImage(HISTORY_MAP.id), /errors.image_unavailable/);
  assert.deepEqual(env.device.getCleaningHistory().entries, []);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('repair clears the former account history and pending image even when hiding unsupported capabilities fails', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  await env.device.refreshHistory();
  let finishImage;
  let notifyImageStarted;
  const imageStarted = new Promise(resolve => { notifyImageStarted = resolve; });
  env.account.getImage = () => {
    notifyImageStarted();
    return new Promise(resolve => { finishImage = resolve; });
  };
  const pendingImage = env.device.getHistoryImage(HISTORY_MAP.id);
  await imageStarted;
  const generation = env.device._historyGeneration;
  const originalOptions = env.device.setCapabilityOptions.bind(env.device);
  env.device.setCapabilityOptions = async (id, options) => {
    if (options.uiComponent === null) throw new Error('Synthetic native component update failure');
    return originalOptions(id, options);
  };
  const renewed = accountSession({ familyId: '821335e7-5f22-43e6-aef7-d67017fba8c9',
    idToken: 'renewed-private-id-token', refreshToken: 'renewed-private-refresh-token' });
  await assert.rejects(env.device.replaceRobot({ ...ROBOT, model: 'VR200', secret: 'renewed-robot-secret', accountSession: renewed }),
    /Synthetic native component update failure/);
  assert.equal(env.device.getAccountSession().familyId, renewed.familyId);
  assert.equal(env.device.getStoreValue('robot').secret, 'renewed-robot-secret');
  assert.equal(env.device.getSupport().model, 'VR200');
  assert.ok(env.device._historyGeneration > generation);
  assert.equal(env.account.clearCalls, 1);
  assert.notEqual(env.device._account, env.account);
  assert.deepEqual(env.device.getCleaningHistory(), { entries: [], maps: [], updatedAt: null,
    available: false, historyAvailable: false, mapsAvailable: false, needsLogin: false });
  finishImage({ mimeType: 'image/png', buffer: Buffer.from('private previous-account image') });
  await assert.rejects(pendingImage, /errors.device_closed/);
  for (const capability of HISTORY_CAPABILITIES) assert.equal(env.device.capabilities[capability], null);
  await assert.rejects(env.device.getHistoryImage(HISTORY_MAP.id), /errors.feature_unsupported/);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('history polling starts again when a fresh service response changes support from unavailable to available', async t => {
  const env = await environment(t, [VR200_DOCKED], { robotData: { ...ROBOT, accountSession: accountSession() } });
  assert.equal(env.device.getSupport().history, false);
  assert.equal([...env.timers.values()].some(({ delay }) => delay === 1500), false);
  env.account.history = { entries: [HISTORY_ENTRY] };
  env.account.maps = [HISTORY_MAP];
  env.enqueue(state({ ...DOCKED, availableServices: { houseCleaning: 'basic-4' } }));
  await env.device.refreshStatus();
  assert.equal(env.device.getSupport().history, true);
  assert.equal([...env.timers.values()].filter(({ delay }) => delay === 1500).length, 1);
  await env.fireTimer(1500);
  assert.equal(env.account.historyCalls.length, 1);
  assert.equal(env.account.mapCalls.length, 1);
  assert.deepEqual(env.device.getCleaningHistory().entries, [HISTORY_ENTRY]);
  assert.ok([...env.timers.values()].some(({ delay }) => delay === 15 * 60 * 1000));
  assert.equal(env.events.filter(event => event.id === 'history_entry_added').length, 0);
  assert.deepEqual(env.cloud.commands, []);
});

test('start resumes a suspended run without sending start options', async t => {
  const env = await environment(t, [PAUSED, PAUSED, CLEANING]);
  assert.equal(await env.actionCards.get('start_cleaning').run({ device: env.device }), true);
  assert.equal(env.cloud.commands.length, 1);
  assert.deepEqual(env.cloud.commands[0], { robot: ROBOT, command: 'resumeCleaning', params: undefined });
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'cleaning');
  assert.equal(env.events.filter(event => event.id === 'cleaning_started').length, 0);
});

test('fresh command availability prevents a control request', async t => {
  const env = await environment(t, [IDLE, state({ state: 2, action: 7, availableCommands: {} })]);
  await assert.rejects(env.device.executeAction('start'), /errors.command_unavailable/);
  assert.equal(env.cloud.commands.length, 0);
  assert.equal(env.cloud.stateCalls.length, 2);
  assert.equal(env.device.getSnapshot().state, 'busy');
});

test('start preserves map/no-go category, navigation and Eco options', async t => {
  const mappedIdle = state({
    cleaning: { category: 4, mode: 1, navigationMode: 2, mapId: 'persistent-floor-map' },
  });
  const env = await environment(t, [IDLE, mappedIdle, CLEANING]);
  await env.device.executeAction('start');
  assert.deepEqual(env.cloud.commands.map(({ command, params }) => ({ command, params })), [{
    command: 'startCleaning',
    params: { category: 4, mode: 1, modifier: 1, navigationMode: 2, mapId: 'persistent-floor-map' },
  }]);
});

test('a rejected mapped start does not retry or weaken the cleaning category', async t => {
  const env = await environment(t);
  env.cloud.commandError = new Error('backend response containing secret');
  await assert.rejects(env.device.executeAction('start'), error => {
    assert.equal(error.message, 'errors.command_failed');
    return true;
  });
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.cloud.commands[0].params.category, 4);
});

test('area discovery is read-only, timestamped and exposes independent catalog copies', async t => {
  const env = await environment(t, [DOCKED]);
  assert.deepEqual(env.cloud.areaCalls, env.initialAreaCalls);
  assert.deepEqual(env.device.getAreas(), []);
  assert.ok(Number.isFinite(Date.parse(env.device.getAreasUpdatedAt())));
  env.cloud.areas = AREAS;
  const discovered = await env.device.refreshAreas();
  assert.deepEqual(discovered, AREAS);
  assert.deepEqual(env.device.getAreas(), AREAS);
  assert.ok(Number.isFinite(Date.parse(env.device.getAreasUpdatedAt())));
  assert.deepEqual(env.cloud.commands, []);
  discovered[0].name = 'Changed caller copy';
  const cached = env.device.getAreas();
  assert.equal(cached[0].name, 'Küche');
  cached.splice(0, cached.length);
  assert.equal(env.device.getAreas().length, AREAS.length);
});

test('native area controls initialize a read-only picker without choosing or starting a room', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  assert.ok(env.device.hasCapability('kobold_area'));
  assert.ok(env.device.hasCapability('kobold_start_area'));
  assert.equal(typeof env.device.listeners.kobold_area, 'function');
  assert.equal(typeof env.device.listeners.kobold_start_area, 'function');
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.equal(env.device.getSelectedArea(), null);
  const options = nativeAreaValues(env.device);
  assert.equal(options.length, AREAS.length + 1);
  assert.equal(options[0].id, 'none');
  assert.equal(new Set(options.map(value => value.id)).size, options.length);
  for (const option of options.slice(1)) {
    assert.match(option.id, /^[a-zA-Z0-9_-]+$/);
    assert.equal(AREAS.some(area => area.id === option.id || area.mapId === option.id), false);
  }
  assert.notEqual(nativeAreaOption(env.device, 'Küche'), nativeAreaOption(env.device, 'Schlafzimmer'),
    'A repeated room ID on different maps must remain distinct in the picker');
  assert.ok(env.cloud.areaCalls.length > 0, 'Initialization populates the picker with a read-only catalog query');
  assert.equal(env.cloud.stateCalls.length, 1);
  assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => key === 'kobold_start_area'), []);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('native room selection and clearing synchronize the stored and settings selections without motion', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  const upper = nativeAreaOption(env.device, 'Schlafzimmer');
  const beforeReads = env.cloud.areaCalls.length;
  await env.device.listeners.kobold_area(upper);
  assert.equal(env.cloud.areaCalls.length, beforeReads + 1, 'Selection validates a fresh catalog');
  assert.deepEqual(env.device.getSelectedArea(), AREAS[2]);
  assert.deepEqual(env.device.getStoreValue('selected_area'), AREAS[2]);
  assert.equal(env.device.getCapabilityValue('kobold_area'), upper);
  assert.deepEqual((await env.app.getAreaDevices())[0].selectedArea, AREAS[2]);
  await env.device.selectArea(AREAS[0]);
  assert.equal(env.device.getCapabilityValue('kobold_area'), nativeAreaOption(env.device, 'Küche'));
  await env.device.listeners.kobold_area('none');
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('the native selected-room button starts only the latest queued selection with its real map and boundary', async t => {
  const areasByMap = new Map([
    ['ground-floor', [{ id: 'shared-boundary', name: 'Küche' }]],
    ['upper-floor', [{ id: 'shared-boundary', name: 'Büro' }]],
  ]);
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT, additional: { areasByMap } });
  const kitchen = nativeAreaOption(env.device, 'Küche · Erdgeschoss');
  const office = nativeAreaOption(env.device, 'Büro · Obergeschoss');
  assert.notEqual(kitchen, office);
  await env.device.listeners.kobold_area(kitchen);
  await env.device.listeners.kobold_start_area(false);
  await env.device.listeners.kobold_start_area(undefined);
  assert.deepEqual(env.cloud.commands, []);
  const selection = env.device.listeners.kobold_area(office);
  const start = env.device.listeners.kobold_start_area(true);
  await Promise.all([selection, start]);
  assert.deepEqual(env.cloud.commands.map(({ command, params }) => ({ command, params })), [{
    command: 'startCleaning', params: { category: 4, mode: 2, modifier: 1, navigationMode: 1,
      boundaryId: 'shared-boundary', mapId: 'upper-floor' },
  }]);
  assert.equal(env.device.getSelectedArea().mapId, 'upper-floor');
  assert.equal(env.device.getCapabilityValue('kobold_area'), office);
  assert.equal(env.device.getCapabilityValue('kobold_start_area'), undefined);
  assert.deepEqual(env.device.capabilityWrites.filter(({ key }) => key === 'kobold_start_area'), []);
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'docked', 'An acknowledgement alone must not guess that cleaning started');
});

test('native area options refresh names, remove stale selections and reject forged picker values', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  const kitchen = nativeAreaOption(env.device, 'Küche');
  await env.device.listeners.kobold_area(kitchen);
  env.cloud.areas = [{ ...AREAS[0], name: 'Neue Küche' }, AREAS[2]];
  await env.device.refreshAreas();
  assert.equal(nativeAreaOption(env.device, 'Neue Küche'), kitchen, 'A room rename must preserve its safe identity');
  assert.equal(env.device.getCapabilityValue('kobold_area'), kitchen);
  assert.equal(nativeAreaValues(env.device).length, 3);
  env.cloud.areas = [AREAS[2]];
  await env.device.refreshAreas();
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.equal(nativeAreaValues(env.device).some(value => value.id === kitchen), false);
  for (const value of [kitchen, 'forged-room', ROBOT.secret, '', null]) {
    await assert.rejects(async () => env.device.listeners.kobold_area(value));
  }
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.deepEqual(env.cloud.commands, []);
});

test('missing or stale native room selections never fall back to a full-floor start', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  await assert.rejects(env.device.listeners.kobold_start_area(true), /errors.area_selection_required/);
  await env.device.listeners.kobold_area(nativeAreaOption(env.device, 'Küche'));
  env.cloud.areas = [AREAS[2]];
  await assert.rejects(env.device.listeners.kobold_start_area(true), /errors.area_not_found|errors.no_areas/);
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('area selection uses a fresh catalog and persists only the selected area identity', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  await env.device.selectArea({ ...AREAS[0], name: 'Old name', secret: 'untrusted value' });
  assert.deepEqual(env.device.getSelectedArea(), AREAS[0]);
  assert.deepEqual(env.device.getStoreValue('selected_area'), AREAS[0]);
  assert.equal(env.cloud.areaCalls.length, env.initialAreaCalls.length + 1);
  assert.deepEqual(env.cloud.commands, []);
  const selected = env.device.getSelectedArea();
  selected.name = 'Changed selected copy';
  assert.equal(env.device.getSelectedArea().name, 'Küche');
  await assert.rejects(env.device.selectArea({ id: 'missing-room', mapId: 'ground-floor' }));
  assert.deepEqual(env.device.getSelectedArea(), AREAS[0]);
  assert.deepEqual(env.cloud.commands, []);
});

test('stored area selection is restored in the native picker after a fresh read-only initialization', async t => {
  const env = await environment(t, [DOCKED], { selectedArea: AREAS[1], additional: { areas: AREAS } });
  assert.deepEqual(env.device.getSelectedArea(), AREAS[1]);
  assert.deepEqual(env.device.getStoreValue('selected_area'), AREAS[1]);
  assert.equal(env.device.getCapabilityValue('kobold_area'), nativeAreaOption(env.device, 'Wohnzimmer'));
  assert.ok(env.cloud.areaCalls.length > 0);
  assert.deepEqual(env.cloud.commands, []);
});

test('temporary area-read failures preserve a saved native selection and expose only its safe placeholder', async t => {
  const env = await environment(t, [DOCKED], { selectedArea: AREAS[1], additional: {
    areaError: new Error('Synthetic catalog unavailable'),
  } });
  assert.equal(env.device.getAvailable(), true);
  assert.deepEqual(env.device.getSelectedArea(), AREAS[1]);
  assert.deepEqual(env.device.getStoreValue('selected_area'), AREAS[1]);
  const savedOption = nativeAreaOption(env.device, 'Wohnzimmer');
  assert.notEqual(savedOption, 'none');
  assert.match(savedOption, /^[a-zA-Z0-9_-]+$/);
  assert.equal(savedOption.includes(AREAS[1].id), false);
  assert.equal(env.device.getCapabilityValue('kobold_area'), savedOption);
  assert.deepEqual(nativeAreaValues(env.device).map(value => value.id).sort(), ['none', savedOption].sort());
  env.cloud.areaError = null;
  env.cloud.areas = AREAS;
  await env.device.refreshAreas();
  assert.equal(nativeAreaValues(env.device).length, AREAS.length + 1);
  const previousOptions = nativeAreaValues(env.device);
  env.cloud.areaError = new Error('Synthetic later catalog outage');
  await assert.rejects(env.device.refreshAreas(), /errors.areas_unavailable/);
  assert.deepEqual(nativeAreaValues(env.device), previousOptions);
  assert.equal(env.device.getCapabilityValue('kobold_area'), savedOption);
  assert.deepEqual(env.device.getStoreValue('selected_area'), AREAS[1]);
  assert.deepEqual(env.cloud.commands, []);
});

test('a removed saved area is cleared after a successful fresh catalog read', async t => {
  const env = await environment(t, [DOCKED], { selectedArea: AREAS[0], additional: { areas: AREAS } });
  env.cloud.areas = [AREAS[1]];
  await env.device.refreshAreas();
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.deepEqual(env.cloud.commands, []);
});

test('malformed saved area data is ignored and extra saved fields stay private', async t => {
  for (const saved of [null, [], { id: '' }, { id: 'room-1', mapId: '\u0000invalid' }]) {
    const env = await environment(t, [DOCKED], { selectedArea: saved });
    assert.equal(env.device.getSelectedArea(), null);
  }
  const env = await environment(t, [DOCKED], { selectedArea: { ...AREAS[0], secret: ROBOT.secret }, additional: { areas: AREAS } });
  assert.deepEqual(env.device.getSelectedArea(), AREAS[0]);
  assert.equal(JSON.stringify(await env.app.getAreaDevices()).includes(ROBOT.secret), false);
});

test('imported maps are queried explicitly and duplicate boundary IDs stay distinct', async t => {
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT });
  env.cloud.areasByMap.set('ground-floor', [{ id: 'shared-boundary', name: 'Küche' }]);
  env.cloud.areasByMap.set('upper-floor', [{ id: 'shared-boundary', name: 'Büro' }]);
  env.enqueue(state({ ...DOCKED, cleaning: { mapId: 'ground-floor' } }));
  const areas = await env.device.refreshAreas();
  assert.deepEqual(env.cloud.areaCalls.slice(env.initialAreaCalls.length).map(({ options }) => options), [{ mapId: 'ground-floor' }, { mapId: 'upper-floor' }]);
  assert.equal(areas.length, 2);
  assert.notEqual(areas[0].id, areas[1].id);
  for (const area of areas) {
    assert.match(area.id, /^[a-f0-9]{64}$/);
    assert.equal(area.boundaryId, 'shared-boundary');
  }
  assert.deepEqual(areas.map(({ mapId, name }) => ({ mapId, name })), [
    { mapId: 'ground-floor', name: 'Küche · Erdgeschoss' },
    { mapId: 'upper-floor', name: 'Büro · Obergeschoss' },
  ]);
  const optionWrites = env.device.capabilityOptionsWrites.length;
  assert.deepEqual(await env.device.refreshAreas(), areas);
  assert.equal(env.device.capabilityOptionsWrites.length, optionWrites,
    'An unchanged catalog must not cause another expensive native options update');
  assert.deepEqual(env.cloud.commands, []);
});

test('an imported area start uses the fresh real boundary ID and ignores a forged caller boundary', async t => {
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT });
  env.cloud.areasByMap.set('ground-floor', [{ id: 'real-kitchen-boundary', name: 'Küche' }]);
  env.cloud.areasByMap.set('upper-floor', []);
  const [area] = await env.device.refreshAreas();
  env.cloud.areaCalls.length = 0;
  await env.device.startArea({ ...area, boundaryId: 'forged-other-room' });
  assert.deepEqual(env.cloud.areaCalls.map(({ options }) => options), [{ mapId: 'ground-floor' }]);
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.cloud.commands[0].command, 'startCleaning');
  assert.equal(env.cloud.commands[0].params.category, 4);
  assert.equal(env.cloud.commands[0].params.mapId, 'ground-floor');
  assert.equal(env.cloud.commands[0].params.boundaryId, 'real-kitchen-boundary');
  assert.notEqual(env.cloud.commands[0].params.boundaryId, area.id);
});

test('an area on a map outside the imported catalog is refused before any boundary query', async t => {
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT });
  const unknown = { id: 'room-id', name: 'Old room', mapId: 'removed-map' };
  await assert.rejects(env.device.selectArea(unknown), /errors.area_not_found/);
  await assert.rejects(env.device.startArea(unknown), /errors.area_not_found/);
  assert.deepEqual(env.cloud.areaCalls, env.initialAreaCalls);
  assert.deepEqual(env.cloud.commands, []);
});

test('validating one imported map preserves other maps and only clears removed selections on that map', async t => {
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT });
  env.cloud.areasByMap.set('ground-floor', [{ id: 'kitchen', name: 'Küche' }]);
  env.cloud.areasByMap.set('upper-floor', [{ id: 'office', name: 'Büro' }]);
  const areas = await env.device.refreshAreas();
  const upper = areas.find(({ mapId }) => mapId === 'upper-floor');
  const ground = areas.find(({ mapId }) => mapId === 'ground-floor');
  await env.device.selectArea(upper);
  env.cloud.areasByMap.set('ground-floor', []);
  env.cloud.areaCalls.length = 0;
  await assert.rejects(env.device.startArea(ground), /errors.area_not_found/);
  assert.deepEqual(env.cloud.areaCalls.map(({ options }) => options), [{ mapId: 'ground-floor' }]);
  assert.deepEqual(env.device.getAreas(), [upper]);
  assert.deepEqual(env.device.getSelectedArea(), upper);
  env.cloud.areasByMap.set('upper-floor', []);
  await assert.rejects(env.device.startArea(upper), /errors.no_areas/);
  assert.deepEqual(env.device.getAreas(), []);
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.deepEqual(env.cloud.commands, []);
});

test('an empty imported map catalog is a valid empty result with no boundary queries', async t => {
  const env = await environment(t, [DOCKED], { robotData: { ...ROBOT, maps: [] } });
  assert.deepEqual(await env.device.refreshAreas(), []);
  assert.deepEqual(env.device.getAreas(), []);
  assert.ok(Number.isFinite(Date.parse(env.device.getAreasUpdatedAt())));
  assert.deepEqual(env.cloud.areaCalls, []);
  assert.deepEqual(env.cloud.commands, []);
});

test('older devices receive a map-import prompt when a mapless boundary query is rejected', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areaError = Object.assign(new Error('private cloud message'), { code: 'COMMAND_REJECTED' });
  await assert.rejects(env.device.refreshAreas(), /errors.maps_import_required/);
  assert.equal(env.cloud.areaCalls.length, env.initialAreaCalls.length + 1);
  assert.deepEqual(env.cloud.areaCalls.at(-1).options, {});
  assert.deepEqual(env.cloud.commands, []);
});

test('replacing robot credentials invalidates the old area catalog without starting cleaning', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  await env.device.refreshAreas();
  assert.ok(env.device.getAreas().length);
  env.cloud.areas = [];
  await env.device.replaceRobot({ ...IMPORTED_ROBOT, secret: 'renewed-secret' });
  assert.deepEqual(env.device.getAreas(), []);
  assert.ok(Number.isFinite(Date.parse(env.device.getAreasUpdatedAt())));
  assert.equal(env.device.getStoreValue('robot').secret, 'renewed-secret');
  assert.deepEqual(env.cloud.commands, []);
});

test('successful repair refreshes the native area picker from the renewed catalog without starting or selecting a room', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  await env.device.listeners.kobold_area(nativeAreaOption(env.device, 'Küche'));
  const oldValue = env.device.getCapabilityValue('kobold_area');
  env.cloud.areasByMap.set('ground-floor', [{ id: 'renewed-boundary', name: 'Neuer Bereich' }]);
  env.cloud.areasByMap.set('upper-floor', []);
  await env.device.replaceRobot({ ...IMPORTED_ROBOT, secret: 'renewed-robot-secret' });
  assert.equal(env.device.getStoreValue('robot').secret, 'renewed-robot-secret');
  assert.equal(nativeAreaValues(env.device).length, 2);
  assert.notEqual(nativeAreaOption(env.device, 'Neuer Bereich · Erdgeschoss'), oldValue);
  assert.equal(nativeAreaValues(env.device).some(value => value.id === oldValue), false);
  assert.equal(env.device.getCapabilityValue('kobold_area'), 'none');
  assert.equal(env.device.getSelectedArea(), null);
  assert.equal(env.device.getStoreValue('selected_area'), null);
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(env.events, []);
});

test('replacing credentials clears cached optional data if the renewed account reads fail', async t => {
  const env = await environment(t, [EXTRA_STATE], { additional: { generalInfo: GENERAL_INFO } });
  assert.equal(env.device.getRobotData().chargeCount, 42);
  assert.equal(env.device.getInfoAvailable(), true);
  env.cloud.generalInfoError = new Error('renewed info unavailable');
  env.cloud.scheduleEventsError = new Error('renewed schedule unavailable');
  await env.device.replaceRobot({ ...ROBOT, secret: 'renewed-secret' });
  assert.equal(env.device.getInfoAvailable(), false);
  assert.equal(env.device.getInfoUpdatedAt(), null);
  assert.equal(env.device.getRobotData().chargeCount, null);
  assert.equal(env.device.getRobotData().firmware, null);
  assert.deepEqual(env.device.getRobotSchedule(), { enabled: false, events: null, available: false, updatedAt: null });
  assert.equal(env.cloud.generalInfoCalls.length, 2);
  assert.deepEqual(env.cloud.commands, []);
});

test('a selected area starts as a new mapped run while preserving cleaning options', async t => {
  const mappedDocked = state({
    details: { charge: 99, isDocked: true, isCharging: true },
    cleaning: { category: 2, mode: 1, navigationMode: 2, mapId: 'other-map' },
  });
  const env = await environment(t, [DOCKED, mappedDocked, mappedDocked, CLEANING]);
  env.cloud.areas = AREAS;
  assert.equal(await env.device.startArea(AREAS[1]), true);
  assert.equal(env.cloud.areaCalls.length, env.initialAreaCalls.length + 1);
  assert.deepEqual(env.cloud.commands.map(({ command, params }) => ({ command, params })), [{
    command: 'startCleaning',
    params: { category: 4, mode: 1, modifier: 1, navigationMode: 2,
      boundaryId: 'room-2', mapId: 'ground-floor' },
  }]);
  assert.equal(env.device.getSnapshot().state, 'cleaning');
});

test('area start never resumes or replaces an existing run and requires docking', async t => {
  for (const current of [IDLE, CLEANING, PAUSED, RETURNING,
    state({ ...DOCKED, availableCommands: { resume: true, stop: true } })]) {
    const env = await environment(t, [DOCKED, current]);
    env.cloud.areas = AREAS;
    await assert.rejects(env.device.startArea(AREAS[0]));
    assert.deepEqual(env.cloud.commands, []);
  }
});

test('an area start is canceled if another control starts a run during catalog lookup', async t => {
  const env = await environment(t, [DOCKED, DOCKED, CLEANING]);
  env.cloud.areas = AREAS;
  await assert.rejects(env.device.startArea(AREAS[0]), /errors.area_requires_dock/);
  assert.equal(env.cloud.areaCalls.length, env.initialAreaCalls.length + 1);
  assert.deepEqual(env.cloud.commands, []);
  assert.equal(env.device.getSnapshot().state, 'cleaning');
});

test('removed, missing or mismatched-map areas are rejected before any motion', async t => {
  const invalidSelections = [
    { id: 'room-deleted', name: 'Former room', mapId: 'ground-floor' },
    { id: 'room-2', name: 'Wohnzimmer', mapId: 'upper-floor' },
    { id: 'room-1', name: 'Ambiguous room' },
    null,
    {},
  ];
  for (const selection of invalidSelections) {
    const env = await environment(t, [DOCKED]);
    env.cloud.areas = AREAS;
    await assert.rejects(async () => env.device.startArea(selection));
    assert.deepEqual(env.cloud.commands, []);
  }
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  await env.device.refreshAreas();
  env.cloud.areas = [];
  await assert.rejects(env.device.startArea(AREAS[0]));
  assert.equal(env.cloud.areaCalls.length, env.initialAreaCalls.length + 2);
  assert.deepEqual(env.cloud.commands, []);
});

test('an area start rechecks feature support after catalog lookup before attempting any command', async t => {
  const mappedDocked = state({ ...DOCKED, availableServices: { houseCleaning: 'basic-3' } });
  const basicDocked = state({ ...DOCKED, availableServices: { houseCleaning: 'basic-1' } });
  const env = await environment(t, [mappedDocked, mappedDocked, basicDocked], {
    robotData: { ...ROBOT, model: 'VR300' }, additional: { areas: AREAS },
  });
  await assert.rejects(env.device.startArea(AREAS[0]), /errors.feature_unsupported/);
  assert.equal(env.device.getSupport().areas, false);
  assert.equal(env.device.getSnapshot().state, 'docked');
  assert.deepEqual(env.cloud.commands, []);
});

test('area lookup failure and rejected area commands do not fall back to full-floor cleaning', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  env.cloud.areaError = new Error('private backend failure');
  await assert.rejects(env.device.startArea(AREAS[0]), /errors.areas_unavailable/);
  assert.deepEqual(env.cloud.commands, []);
  env.cloud.areaError = null;
  env.cloud.commandError = new Error('ambiguous backend acknowledgement');
  await assert.rejects(env.device.startArea(AREAS[0]), /errors.command_failed/);
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.cloud.commands[0].command, 'startCleaning');
  assert.equal(env.cloud.commands[0].params.boundaryId, AREAS[0].id);
  assert.equal(env.cloud.commands[0].params.category, 4);
});

test('area failure diagnostics are opt-in and persist only allowed codes and response shape values', async t => {
  const privateMapId = 'private-area-map-id';
  const failure = Object.assign(new Error(`private response ${ROBOT.secret}`), {
    code: 'INVALID_RESPONSE', status: 422, result: 'bad_request',
    robot: ROBOT, response: { secret: ROBOT.secret },
    areaDiagnostic: {
      dataType: 'object', boundariesType: 'array', count: 3,
      boundaryTypes: ['polygon', ROBOT.secret, { secret: ROBOT.secret }, 'polyline', 'other'],
      idTypes: ['string', privateMapId, { serial: ROBOT.serial }, 'null'],
      nameTypes: ['string', ROBOT.secret, 'array', 'number'],
      secret: ROBOT.secret, mapId: privateMapId,
      boundaries: [{ id: privateMapId, name: ROBOT.serial }],
    },
  });
  for (const diagnosticsEnabled of [false, true]) {
    const env = await environment(t, [DOCKED], { diagnosticsEnabled });
    env.cloud.areaError = failure;
    await assert.rejects(env.device.refreshAreas(), /errors.areas_unavailable/);
    const diagnostic = env.homey.settings.get('last_area_diagnostic');
    const writes = env.settingsWrites.filter(({ key }) => key === 'last_area_diagnostic');
    assert.deepEqual(env.cloud.commands, []);
    if (!diagnosticsEnabled) {
      assert.equal(diagnostic, undefined);
      assert.deepEqual(writes, []);
      continue;
    }
    assert.equal(writes.length, 1);
    const { at, ...values } = diagnostic;
    assert.ok(Number.isFinite(Date.parse(at)));
    assert.deepEqual(values, {
      code: 'INVALID_RESPONSE', status: 422, result: 'bad_request',
      request: { mapIdPresent: false, mapsService: 'unknown', houseCleaningService: 'unknown' },
      shape: {
        dataType: 'object', boundariesType: 'array', count: 3,
        boundaryTypes: ['polygon', 'polyline', 'other'],
        idTypes: ['string', 'null'], nameTypes: ['string', 'array', 'number'],
      },
    });
    const serialized = JSON.stringify(diagnostic);
    for (const privateValue of [ROBOT.secret, ROBOT.serial, ROBOT.endpoint, privateMapId, failure.message]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }
});

test('live area diagnostics compare the requested target without persisting map or boundary identifiers', async t => {
  const target = AREAS[0];
  const cases = [
    {
      cleaning: { category: 4, mapId: target.mapId, boundary: { id: target.id, name: target.name } },
      alert: 'ui_alert_invalid',
      expected: { mappedCleaning: true, mapMatches: true, boundaryMatches: true, nameMatches: true,
        completionAlert: 'ui_alert_invalid' },
    },
    {
      cleaning: { category: 4, mapId: target.mapId, boundaryId: target.id },
      alert: 'clean_completed_to_start',
      expected: { mappedCleaning: true, mapMatches: true, boundaryMatches: true, nameMatches: null,
        completionAlert: 'clean_completed_to_start' },
    },
    {
      cleaning: { category: 4 },
      expected: { mappedCleaning: true, mapMatches: null, boundaryMatches: null, nameMatches: null,
        completionAlert: null },
    },
    {
      cleaning: { category: 2, mapId: 'private-other-map',
        boundary: { id: 'private-other-boundary', name: 'private-other-room' } },
      alert: ROBOT.secret,
      expected: { mappedCleaning: false, mapMatches: false, boundaryMatches: false, nameMatches: false,
        completionAlert: 'other' },
    },
  ];
  for (const item of cases) {
    const reported = { ...CLEANING, ...ROBOT, cleaning: item.cleaning,
      alert: item.alert, privateResponse: { secret: ROBOT.secret } };
    const env = await environment(t, [DOCKED, DOCKED, DOCKED, reported], { diagnosticsEnabled: true });
    env.cloud.areas = AREAS;
    await env.device.startArea(target);
    const diagnostic = env.homey.settings.get('last_robot_diagnostics');
    assert.deepEqual(diagnostic.area, { requestedName: target.name, ...item.expected });
    const serialized = JSON.stringify(diagnostic);
    for (const privateValue of [ROBOT.secret, ROBOT.serial, ROBOT.endpoint, target.id, target.mapId,
      'private-other-map', 'private-other-boundary', 'private-other-room']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }
});

test('closing during area validation prevents a physical area start', async t => {
  const env = await environment(t, [DOCKED]);
  let finishAreas;
  let notifyAreasStarted;
  const areasStarted = new Promise(resolve => { notifyAreasStarted = resolve; });
  env.cloud.getAreas = () => {
    notifyAreasStarted();
    return new Promise(resolve => { finishAreas = resolve; });
  };
  const action = env.device.startArea(AREAS[0]);
  await areasStarted;
  await env.device.onUninit();
  finishAreas(AREAS);
  await assert.rejects(action, /errors.device_closed/);
  assert.deepEqual(env.cloud.commands, []);
  assert.equal(env.timers.size, 0);
});

test('area validation and normal controls share one serialized command queue', async t => {
  const env = await environment(t, [DOCKED, DOCKED, DOCKED, CLEANING, CLEANING, PAUSED]);
  let finishAreas;
  let notifyAreasStarted;
  const areasStarted = new Promise(resolve => { notifyAreasStarted = resolve; });
  env.cloud.getAreas = () => {
    notifyAreasStarted();
    return new Promise(resolve => { finishAreas = resolve; });
  };
  const areaStart = env.device.startArea(AREAS[0]);
  await areasStarted;
  const pause = env.device.executeAction('pause');
  await Promise.resolve();
  assert.deepEqual(env.cloud.commands, []);
  finishAreas(AREAS);
  await Promise.all([areaStart, pause]);
  assert.deepEqual(env.cloud.commands.map(({ command }) => command), ['startCleaning', 'pauseCleaning']);
  assert.equal(env.device.getSnapshot().state, 'paused');
});

test('area Flow autocomplete caches briefly, refreshes expired names and never starts the robot', async t => {
  const env = await environment(t, [DOCKED], { additional: { areas: AREAS } });
  const autocomplete = env.actionCards.get('clean_area').autocomplete.area;
  const matches = await autocomplete('WOHN', { device: env.device });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'room-2');
  assert.equal(matches[0].mapId, 'ground-floor');
  assert.equal(matches[0].name, 'Wohnzimmer');
  const all = await autocomplete('', { device: env.device });
  assert.equal(all.length, AREAS.length);
  assert.equal(env.cloud.areaCalls.length, 1);
  env.device.getAreasUpdatedAt = () => '2000-01-01T00:00:00.000Z';
  env.cloud.areas = [{ ...AREAS[1], name: 'Esszimmer' }];
  const refreshed = await autocomplete('Ess', { device: env.device });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].name, 'Esszimmer');
  assert.equal(env.cloud.areaCalls.length, 2);
  assert.deepEqual(env.cloud.commands, []);
});

test('area settings API only exposes paired VR300 devices without robot credentials', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  const devices = await env.app.getAreaDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Demo robot');
  assert.equal(typeof devices[0].id, 'string');
  assert.notEqual(devices[0].id, ROBOT.serial);
  const emitted = JSON.stringify(devices);
  for (const credential of [ROBOT.serial, ROBOT.secret, ROBOT.endpoint]) {
    assert.equal(emitted.includes(credential), false);
  }
  assert.deepEqual(env.cloud.commands, []);
  await assert.rejects(env.app.refreshDeviceAreas('unpaired-device'), /errors.device_not_found/);
  await assert.rejects(env.app.selectDeviceArea('unpaired-device', AREAS[0]), /errors.device_not_found/);
  await assert.rejects(env.app.startDeviceArea('unpaired-device', AREAS[0]), /errors.device_not_found/);
  assert.deepEqual(env.cloud.areaCalls, env.initialAreaCalls);
  assert.deepEqual(env.cloud.commands, []);
});

test('area settings API forwards catalog, selection and start only to the chosen paired device', async t => {
  const env = await environment(t, [DOCKED]);
  env.cloud.areas = AREAS;
  const [{ id }] = await env.app.getAreaDevices();
  await env.app.refreshDeviceAreas(id);
  assert.deepEqual(env.device.getAreas(), AREAS);
  await env.app.selectDeviceArea(id, AREAS[1]);
  assert.deepEqual(env.device.getSelectedArea(), AREAS[1]);
  assert.deepEqual(env.cloud.commands, []);
  await env.app.startDeviceArea(id, AREAS[1]);
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.cloud.commands[0].params.boundaryId, 'room-2');
  assert.equal(env.cloud.commands[0].params.mapId, 'ground-floor');
});

test('settings overview distinguishes cached offline status from an unseen robot status', async t => {
  const env = await environment(t, [DOCKED, new Error('offline')]);
  let [device] = await env.app.getAreaDevices();
  assert.equal(device.robotStatus.available, true);
  assert.equal(device.robotStatus.state, 'docked');
  assert.equal(device.robotStatus.battery, 100);
  assert.equal(device.robotStatus.docked, true);
  const lastRead = device.robotStatus.updatedAt;
  await assert.rejects(env.device.refreshStatus());
  [device] = await env.app.getAreaDevices();
  assert.equal(device.robotStatus.available, false);
  assert.equal(device.robotStatus.state, 'docked');
  assert.equal(device.robotStatus.updatedAt, lastRead);
  const unknown = await environment(t, [new Error('offline')]);
  const [unseen] = await unknown.app.getAreaDevices();
  assert.deepEqual(unseen.robotStatus, { available: false, state: null, status: null,
    battery: null, charging: null, docked: null, updatedAt: null });
  assert.deepEqual(env.cloud.commands, []);
  assert.deepEqual(unknown.cloud.commands, []);
});

test('missing dock and charging flags remain unknown in displays and cannot satisfy inverted conditions', async t => {
  const env = await environment(t, [state({ details: { charge: 56 } })]);
  assert.equal(env.device.getSnapshot().charging, null);
  assert.equal(env.device.getSnapshot().docked, null);
  assert.equal(env.device.capabilities.kobold_charging, null);
  const [device] = await env.app.getAreaDevices();
  assert.equal(device.robotStatus.charging, null);
  assert.equal(device.robotStatus.docked, null);
  for (const id of ['is_docked', 'is_charging']) {
    await assert.rejects(env.conditionCards.get(id).run({ device: env.device }), /errors.flow_value_unknown/);
  }
  assert.deepEqual(env.cloud.commands, []);
});

test('failed post-acknowledgement reads never repeat the acknowledged command', async t => {
  const env = await environment(t, [IDLE, IDLE, new Error('offline')]);
  assert.equal(await env.device.executeAction('start'), true);
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.device.getAvailable(), false);
  assert.deepEqual(env.events, []);
  await env.fireTimer(5000);
  assert.equal(env.cloud.commands.length, 1);
  assert.equal(env.device.getAvailable(), false);
});

test('returning from an active run pauses once and waits for docking permission', async t => {
  const env = await environment(t, [CLEANING, CLEANING, CLEANING, PAUSED, RETURNING]);
  assert.equal(await env.device.executeAction('dock'), true);
  assert.deepEqual(env.cloud.commands.map(({ command, params }) => ({ command, params })), [
    { command: 'pauseCleaning', params: undefined },
    { command: 'sendToBase', params: undefined },
  ]);
  assert.equal(env.cloud.stateCalls.length, 5);
  assert.equal(env.device.getSnapshot().state, 'returning');
});

test('docking readiness timeout never retries pause or sends an unavailable dock command', async t => {
  const env = await environment(t, [CLEANING]);
  await assert.rejects(env.device.executeAction('dock'), /errors.dock_not_ready/);
  assert.deepEqual(env.cloud.commands.map(item => item.command), ['pauseCleaning']);
  assert.equal(env.cloud.stateCalls.length, 5);
});

test('a failed docking readiness read leaves the robot unavailable without repeating pause', async t => {
  const env = await environment(t, [CLEANING, CLEANING, new Error('offline')]);
  await assert.rejects(env.device.executeAction('dock'), /errors.robot_unavailable/);
  assert.deepEqual(env.cloud.commands.map(item => item.command), ['pauseCleaning']);
  assert.equal(env.device.getAvailable(), false);
});

test('already paused docking sends the base command without another pause', async t => {
  const env = await environment(t, [PAUSED, PAUSED, RETURNING]);
  await env.device.executeAction('dock');
  assert.deepEqual(env.cloud.commands.map(item => item.command), ['sendToBase']);
});

test('a robot that has not seen the base refuses docking without changing its run', async t => {
  for (const activity of [CLEANING, state({ state: 3, action: 1,
    availableCommands: { stop: true, resume: true, goToBase: false } })]) {
    const unseenBase = state({ ...activity,
      details: { ...activity.details, dockHasBeenSeen: false },
    });
    const env = await environment(t, [unseenBase]);
    await assert.rejects(env.device.executeAction('dock'), /errors.base_not_seen/);
    assert.deepEqual(env.cloud.commands, []);
    assert.equal(env.device.getAvailable(), true);
    assert.equal(env.device.getSnapshot().state, activity === CLEANING ? 'cleaning' : 'paused');
  }
});

test('diagnostics are opt-in and do not persist robot status when disabled', async t => {
  const env = await environment(t, [IDLE, CLEANING]);
  await env.device.refreshStatus();
  assert.deepEqual(env.settingsWrites, []);
  assert.equal(env.homey.settings.get('last_robot_diagnostics'), undefined);
});

test('enabled diagnostics contain status values without robot credentials or map identifiers', async t => {
  const mapId = 'private-floor-map-id';
  const detailed = state({
    ...ROBOT,
    state: 3, action: 1,
    details: { charge: 81, isDocked: false, isCharging: false, dockHasBeenSeen: true, secret: ROBOT.secret },
    availableCommands: { start: false, stop: true, pause: false, resume: true, goToBase: true, secret: ROBOT.secret },
    cleaning: { category: 4, mode: 1, navigationMode: 2, mapId, robot: ROBOT },
  });
  const env = await environment(t, [detailed], { diagnosticsEnabled: true });
  assert.equal(env.settingsWrites.length, 1);
  assert.equal(env.settingsWrites[0].key, 'last_robot_diagnostics');
  const diagnostic = env.homey.settings.get('last_robot_diagnostics');
  const { at, ...values } = diagnostic;
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(values, {
    state: 3, action: 1,
    commands: { start: false, stop: true, pause: false, resume: true, goToBase: true },
    details: { isDocked: false, isCharging: false, dockHasBeenSeen: true, charge: 81 },
    cleaning: { category: 4, mode: 1, navigationMode: 2 },
    error: null,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const privateValue of [ROBOT.secret, ROBOT.serial, ROBOT.endpoint, mapId]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('closing during a pre-command status read prevents the physical command', async t => {
  const env = await environment(t);
  let finishRead;
  let notifyReadStarted;
  const readStarted = new Promise(resolve => { notifyReadStarted = resolve; });
  env.cloud.getState = () => {
    notifyReadStarted();
    return new Promise(resolve => { finishRead = resolve; });
  };
  const action = env.device.executeAction('start');
  await readStarted;
  await env.device.onUninit();
  finishRead(IDLE);
  await assert.rejects(action, /errors.device_closed/);
  assert.equal(env.cloud.commands.length, 0);
  assert.equal(env.timers.size, 0);
});

test('live capabilities reflect battery, charging, errors and supported Homey states', async t => {
  const env = await environment(t, [CHARGING]);
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'charging');
  assert.equal(env.device.capabilities.measure_battery, 32);
  assert.equal(env.device.capabilities.kobold_charging, true);
  assert.equal(env.device.capabilities.kobold_status, 'status.charging');
  env.enqueue(state({ state: 2, action: 2, details: { charge: 44 } }));
  await env.device.refreshStatus();
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'cleaning');
  assert.equal(env.device.capabilities.measure_battery, 44);
  env.enqueue(state({ state: 4, error: 'ui_error_brush_stuck', details: { charge: 'unknown' } }));
  await env.device.refreshStatus();
  assert.equal(env.device.capabilities.vacuumcleaner_state, 'stopped');
  assert.equal(env.device.capabilities.measure_battery, null);
  assert.equal(env.device.capabilities.alarm_generic, true);
  assert.match(env.device.capabilities.kobold_status, /ui_error_brush_stuck/);
  assert.equal(env.events.filter(event => event.id === 'robot_error').length, 1);
});

test('observed cleaning, pause, return and dock trigger one run ending event', async t => {
  const env = await environment(t, [IDLE]);
  for (const snapshot of [CLEANING, PAUSED, CLEANING, RETURNING, DOCKED, CHARGING]) {
    env.enqueue(snapshot);
    await env.device.refreshStatus();
  }
  assert.equal(env.events.filter(event => event.id === 'cleaning_started').length, 1);
  assert.equal(env.events.filter(event => event.id === 'cleaning_finished').length, 1);
  // A manual return ending at the dock qualifies as the run ending. This event
  // does not certify that every room was cleaned successfully.
  assert.deepEqual(env.events.filter(event => event.id === 'state_changed').map(event => event.tokens.state),
    ['cleaning', 'paused', 'cleaning', 'returning', 'docked', 'charging']);
  assert.ok(env.events.every(event => event.device === env.device));
});

test('docking alone, a stopped run and an errored run do not imply cleaning finished', async t => {
  for (const sequence of [[IDLE, DOCKED], [CLEANING, IDLE, DOCKED], [CLEANING, ROBOT_ERROR, DOCKED]]) {
    const env = await environment(t, [sequence[0]]);
    for (const snapshot of sequence.slice(1)) {
      env.enqueue(snapshot);
      await env.device.refreshStatus();
    }
    assert.equal(env.events.filter(event => event.id === 'cleaning_finished').length, 0);
  }
});

test('an incomplete idle reading preserves the observed run until docking or a confirmed stop', async t => {
  const partialDetails = [{ charge: 70 }, { charge: 70, isCharging: false },
    { charge: 70, isDocked: false }, { charge: 70, isCharging: 'false', isDocked: 0 }];
  for (const details of partialDetails) {
    const unknownStation = state({ details });
    const env = await environment(t, [CLEANING]);
    env.enqueue(unknownStation);
    await env.device.refreshStatus();
    assert.equal(env.events.filter(event => event.id === 'cleaning_finished').length, 0);
    for (const snapshot of [DOCKED, CHARGING, DOCKED]) {
      env.enqueue(snapshot);
      await env.device.refreshStatus();
      assert.equal(env.events.filter(event => event.id === 'cleaning_finished').length, 1);
    }
    assert.deepEqual(env.cloud.commands, []);
    for (const confirmedEnd of [IDLE, ROBOT_ERROR]) {
      const stopped = await environment(t, [CLEANING]);
      for (const snapshot of [unknownStation, confirmedEnd, DOCKED]) {
        stopped.enqueue(snapshot);
        await stopped.device.refreshStatus();
      }
      assert.equal(stopped.events.filter(event => event.id === 'cleaning_finished').length, 0,
        'A confirmed undocked stop or error must still cancel the run after an unknown reading');
      assert.deepEqual(stopped.cloud.commands, []);
    }
  }
});

test('a baseline observed cleaning run can end at the charger', async t => {
  const env = await environment(t, [CLEANING, CHARGING]);
  await env.device.refreshStatus();
  assert.equal(env.events.filter(event => event.id === 'cleaning_started').length, 0);
  assert.equal(env.events.filter(event => event.id === 'cleaning_finished').length, 1);
});

test('offline or malformed status rejects Flow checks instead of creating true inverted conditions', async t => {
  const env = await environment(t, [CLEANING]);
  assert.equal(await env.conditionCards.get('is_cleaning').run({ device: env.device }), true);
  for (const bad of [new Error('private backend detail'), { result: 'ok' }]) {
    env.enqueue(bad);
    await assert.rejects(env.device.refreshStatus(), /errors.robot_unavailable/);
    assert.equal(env.device.getAvailable(), false);
    assert.equal(env.device.unavailableMessage, 'errors.robot_unavailable');
    for (const [id, condition] of env.conditionCards) {
      if (id === 'vacuumcleaner_state_is') {
        // The compatibility card retains Homey's original stored-value test.
        assert.equal(await condition.run({ device: env.device, state: 'cleaning' }), true);
        continue;
      }
      await assert.rejects(condition.run({ device: env.device }), id.startsWith('last_')
        ? /errors.account_login_required/ : /errors.robot_unavailable/);
    }
  }
  env.enqueue(CHARGING);
  await env.device.refreshStatus();
  assert.equal(env.device.getAvailable(), true);
  assert.equal(await env.conditionCards.get('is_charging').run({ device: env.device }), true);
  assert.equal(await env.conditionCards.get('is_docked').run({ device: env.device }), true);
});

test('pairing uses a stable serial identity and keeps credentials in the device store', async t => {
  const env = await environment(t);
  const pair = session();
  await env.driver.onPair(pair);
  await assert.rejects(pair.run('verify_code', { code: '123456' }), /errors.request_code_first/);
  await pair.run('request_code', { email: ' OWNER@EXAMPLE.COM ' });
  assert.equal(env.cloud.requestedEmail, 'owner@example.com');
  assert.deepEqual(await pair.run('verify_code', { code: ' 123456 ' }), { repaired: false });
  assert.deepEqual(env.cloud.verified, { email: 'owner@example.com', code: '123456', options: { includeMaps: true, includeAccount: true } });
  const devices = await pair.run('list_devices');
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].data, { id: ROBOT.serial });
  assert.deepEqual(devices[0].store, { robot: ROBOT });
  assert.equal(JSON.stringify(devices[0].data).includes(ROBOT.secret), false);
  assert.equal(JSON.stringify(devices).includes('123456'), false);
  assert.equal(JSON.stringify(devices).includes('owner@example.com'), false);
  await pair.run('disconnect');
  assert.deepEqual(await pair.run('list_devices'), []);
});

test('pairing a mixed account lists VR200 and VR300 with unchanged serial identities and private model credentials', async t => {
  const env = await environment(t);
  const vr300 = { ...ROBOT, model: 'VR300' };
  env.cloud.discoverRobots = async () => [structuredClone(VR200_ROBOT), structuredClone(vr300)];
  const pair = session();
  await env.driver.onPair(pair);
  await pair.run('request_code', { email: 'owner@example.com' });
  assert.deepEqual(await pair.run('verify_code', { code: '123456' }), { repaired: false });
  const devices = await pair.run('list_devices');
  assert.deepEqual(devices.map(device => ({ id: device.data.id, model: device.store.robot.model })), [
    { id: VR200_ROBOT.serial, model: 'VR200' }, { id: ROBOT.serial, model: 'VR300' },
  ]);
  assert.deepEqual(devices[0].data, { id: VR200_ROBOT.serial });
  assert.deepEqual(devices[1].data, { id: ROBOT.serial });
  assert.deepEqual(devices[0].capabilities.sort(), [...VR200_CAPABILITIES].sort());
  assert.equal(devices[1].capabilities, undefined, 'VR300 retains its existing manifest capability list');
  for (const device of devices) assert.equal(JSON.stringify(device.data).includes(ROBOT.secret), false);
  assert.deepEqual(env.cloud.commands, []);
});

test('re-pairing refuses another robot and accepts the same serial case-insensitively', async t => {
  const env = await environment(t);
  const replacements = [];
  const existing = { getData: () => ({ id: 'vr300-test' }), async replaceRobot(robot) { replacements.push(robot); } };
  const repair = session();
  await env.driver.onRepair(repair, existing);
  await repair.run('request_code', { email: 'owner@example.com' });
  env.cloud.discoverRobots = async () => [{ ...ROBOT, serial: 'VR300-OTHER' }];
  await assert.rejects(repair.run('verify_code', { code: '123456' }), /errors.robot_not_found/);
  assert.equal(replacements.length, 0);
  env.cloud.discoverRobots = async () => [{ ...ROBOT, secret: 'renewed-secret' }];
  assert.deepEqual(await repair.run('verify_code', { code: '123456' }), { repaired: true });
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].secret, 'renewed-secret');
});

test('a failed map import during repair preserves robot credentials and does not persist OTP data', async t => {
  const env = await environment(t, [DOCKED], { robotData: IMPORTED_ROBOT });
  const before = structuredClone(env.device.store);
  const repair = session();
  await env.driver.onRepair(repair, env.device);
  await repair.run('request_code', { email: 'private-owner@example.com' });
  env.cloud.discoverRobots = async (email, code, options) => {
    assert.equal(email, 'private-owner@example.com');
    assert.equal(code, '901234');
    assert.deepEqual(options, { includeMaps: true, includeAccount: true });
    throw Object.assign(new Error('private import response'), { code: 'MAP_DISCOVERY_FAILED' });
  };
  await assert.rejects(repair.run('verify_code', { code: '901234' }), error => {
    assert.equal(error.message, 'errors.map_discovery_failed');
    return true;
  });
  assert.deepEqual(env.device.store, before);
  assert.deepEqual(await repair.run('list_devices'), []);
  assert.deepEqual(env.cloud.commands, []);
  const persisted = JSON.stringify({ store: env.device.store, settings: env.settingsWrites });
  for (const privateValue of ['private-owner@example.com', '901234', 'private import response']) {
    assert.equal(persisted.includes(privateValue), false);
  }
});

test('the device also rejects replacing credentials with another serial', async t => {
  const env = await environment(t);
  await assert.rejects(env.device.replaceRobot({ ...ROBOT, serial: 'VR300-OTHER' }), /errors.robot_not_found/);
  assert.equal(env.device.getStoreValue('robot').serial, ROBOT.serial);
  assert.equal(env.cloud.stateCalls.length, 1);
});

test('rejected OTP receives the actionable invalid-code pairing error', async t => {
  const env = await environment(t);
  const pair = session();
  await env.driver.onPair(pair);
  await pair.run('request_code', { email: 'owner@example.com' });
  env.cloud.discoverRobots = async () => {
    const error = new Error('private authentication body');
    error.code = 'AUTHENTICATION_FAILED';
    throw error;
  };
  await assert.rejects(pair.run('verify_code', { code: '123456' }), error => {
    assert.equal(error.message, 'errors.invalid_code');
    return true;
  });
});
