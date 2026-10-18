'use strict';

const Homey = require('homey');
const { createHash } = require('node:crypto');
const { KoboldClient, KoboldError } = require('./lib/kobold-client');

class KoboldApp extends Homey.App {
  async onInit() {
    this.kobold = new KoboldClient();
    this._accountQueues = new Map();
    this._accountSessions = new Map();
    const actions = {
      start_cleaning: 'start',
      pause_cleaning: 'pause',
      resume_cleaning: 'resume',
      stop_cleaning: 'stop',
      return_to_base: 'dock',
      refresh_status: 'refresh',
      // Original system-card IDs stay valid after hiding its native picker.
      clean: 'start', dock: 'dock', stop: 'stop',
    };
    for (const [id, action] of Object.entries(actions)) {
      this.homey.flow.getActionCard(id).registerRunListener(async ({ device }) => {
        await device.executeAction(action);
        return true;
      });
    }
    this.homey.flow.getActionCard('spot_clean').registerRunListener(async () => {
      // The previous capability listener did not support spot_cleaning either.
      throw new Error(this.homey.__('errors.unsupported_action'));
    });
    const legacyStateMatches = ({ device, state }) => {
      const value = device.getCapabilityValue('vacuumcleaner_state');
      if (!['cleaning', 'spot_cleaning', 'docked', 'charging', 'stopped'].includes(value)) {
        throw new Error(this.homey.__('errors.flow_value_unknown'));
      }
      return value === state;
    };
    this.homey.flow.getConditionCard('vacuumcleaner_state_is').registerRunListener(legacyStateMatches);
    // Homey automatically triggers <custom_capability>_changed on updates.
    // Only its state filter is needed here; explicit triggering would duplicate it.
    this.homey.flow.getDeviceTriggerCard('vacuumcleaner_state_changed').registerRunListener(legacyStateMatches);
    this.homey.flow.getActionCard('refresh_areas').registerRunListener(async ({ device }) => {
      await device.refreshAreas();
      return true;
    });
    this.homey.flow.getActionCard('refresh_robot_data').registerRunListener(async ({ device }) => {
      await device.refreshRobotData();
      return true;
    });
    this.homey.flow.getActionCard('refresh_history').registerRunListener(async ({ device }) => {
      const history = await device.refreshHistory();
      if (!history.historyAvailable && !history.mapsAvailable) throw new Error(this.homey.__(history.needsLogin
        ? 'errors.account_login_required' : 'errors.history_unavailable'));
      return true;
    });
    const areaCard = this.homey.flow.getActionCard('clean_area');
    areaCard.registerRunListener(async ({ device, area }) => device.startArea(area));
    areaCard.registerArgumentAutocompleteListener('area', async (query, { device }) => {
      const updatedAt = Date.parse(device.getAreasUpdatedAt());
      const areas = Number.isFinite(updatedAt) && Date.now() - updatedAt < 30000
        ? device.getAreas() : await device.refreshAreas();
      if (!areas.length) throw new Error(this.homey.__('errors.no_areas'));
      const search = String(query || '').trim().toLocaleLowerCase();
      return areas.filter(area => area.name.toLocaleLowerCase().includes(search));
    });
    const unknownCondition = () => new Error(this.homey.__('errors.flow_value_unknown'));
    const conditions = {
      is_cleaning: (snapshot) => ['cleaning', 'paused', 'charging', 'docked', 'idle', 'error', 'returning', 'busy']
        .includes(snapshot.state) ? snapshot.state === 'cleaning' : null,
      is_docked: (snapshot) => snapshot.docked,
      is_charging: (snapshot) => snapshot.charging,
    };
    for (const [id, predicate] of Object.entries(conditions)) {
      this.homey.flow.getConditionCard(id).registerRunListener(async ({ device }) => {
        if (!device.getAvailable()) throw new Error(this.homey.__('errors.robot_unavailable'));
        const snapshot = device.getSnapshot();
        if (!snapshot) throw unknownCondition();
        const result = predicate(snapshot);
        if (typeof result !== 'boolean') throw unknownCondition();
        return result;
      });
    }
    const dataConditions = {
      is_eco_mode: {
        known: data => ['eco', 'turbo'].includes(data.cleaningMode),
        test: data => data.cleaningMode === 'eco',
      },
      is_robot_schedule_enabled: {
        known: data => typeof data.scheduleEnabled === 'boolean',
        test: data => data.scheduleEnabled,
      },
      has_robot_warning: {
        known: data => data.warningKnown === true,
        test: data => data.warningCode !== null,
      },
      navigation_is: {
        feature: 'navigation',
        known: data => ['normal', 'extra_care', 'deep'].includes(data.navigationMode),
        test: (data, args) => ['normal', 'extra_care', 'deep'].includes(args.mode)
          && data.navigationMode === args.mode,
      },
      charge_count_above: {
        feature: 'generalInfo',
        known: (data, device) => device.getInfoAvailable() && Number.isSafeInteger(data.chargeCount)
          && data.chargeCount >= 0 && data.chargeCount <= 1e9,
        test: (data, args) => Number.isSafeInteger(args.count) && args.count >= 0 && args.count <= 1e9
          && data.chargeCount > args.count,
      },
    };
    for (const [id, condition] of Object.entries(dataConditions)) {
      this.homey.flow.getConditionCard(id).registerRunListener(async (args) => {
        if (condition.feature && args.device.getSupport?.()[condition.feature] === false) {
          throw new Error(this.homey.__('errors.feature_unsupported'));
        }
        if (!args.device.getAvailable()) throw new Error(this.homey.__('errors.robot_unavailable'));
        const data = args.device.getRobotData();
        if (!data || !condition.known(data, args.device)) throw unknownCondition();
        return Boolean(condition.test(data, args));
      });
    }
    const successfulHistoryStatuses = new Set(['ok', 'complete', 'completed', 'done']);
    const unsuccessfulHistoryStatuses = new Set(['error', 'failed', 'incomplete', 'stopped', 'canceled', 'cancelled']);
    const historyConditions = {
      last_cleaned_area_above: {
        known: entry => Number.isFinite(entry.areaSquareMetres) && entry.areaSquareMetres >= 0,
        test: (entry, args) => typeof args.area === 'number' && Number.isFinite(args.area)
          && args.area >= 0 && entry.areaSquareMetres > args.area,
      },
      last_duration_above: {
        known: entry => Number.isFinite(entry.durationMinutes) && entry.durationMinutes >= 0,
        test: (entry, args) => typeof args.minutes === 'number' && Number.isFinite(args.minutes)
          && args.minutes >= 0 && entry.durationMinutes > args.minutes,
      },
      last_cleaning_successful: {
        known: entry => Boolean(entry.error || unsuccessfulHistoryStatuses.has(entry.status)
          || (successfulHistoryStatuses.has(entry.status) && entry.endedAt)),
        test: entry => Boolean(entry.endedAt && !entry.error && successfulHistoryStatuses.has(entry.status)),
      },
    };
    for (const [id, condition] of Object.entries(historyConditions)) {
      this.homey.flow.getConditionCard(id).registerRunListener(async ({ device, ...args }) => {
        if (device.getSupport?.().history === false) throw new Error(this.homey.__('errors.feature_unsupported'));
        const history = device.getCleaningHistory();
        if (history?.needsLogin) throw new Error(this.homey.__('errors.account_login_required'));
        if (!history?.historyAvailable) throw new Error(this.homey.__('errors.history_unavailable'));
        const entry = history.entries?.[0];
        if (!entry || !condition.known(entry)) throw unknownCondition();
        return Boolean(condition.test(entry, args));
      });
    }
    this._deviceTriggers = Object.fromEntries(
      ['cleaning_started', 'cleaning_finished', 'robot_error', 'state_changed',
        'cleaning_mode_changed', 'robot_schedule_changed', 'robot_warning_changed', 'history_entry_added']
        .map((id) => [id, this.homey.flow.getDeviceTriggerCard(id)]),
    );
  }

  async triggerDevice(id, device, tokens = {}) {
    await this._deviceTriggers[id].trigger(device, tokens);
  }

  async withAccountSession(device, work) {
    const initial = device.getAccountSession();
    if (!initial?.idToken || !initial.familyId) {
      throw new KoboldError('ACCOUNT_LOGIN_REQUIRED', 'Connect the MyKobold account again.');
    }
    const familyId = initial.familyId;
    const pending = this._accountQueues.get(familyId) || Promise.resolve();
    const task = pending.then(async () => {
      const stored = device.getAccountSession();
      if (!stored?.idToken || stored.familyId !== familyId) {
        throw new KoboldError('ACCOUNT_LOGIN_REQUIRED', 'Connect the MyKobold account again.');
      }
      let session = this._accountSessions.get(familyId) || stored;
      this._accountSessions.set(familyId, session);
      let refreshed = false;
      const refresh = async () => {
        const latest = await this.kobold.refreshAccountSession(session);
        this._accountSessions.set(familyId, latest);
        const siblings = this._areaDevices().filter(candidate => !candidate._closed
          && candidate.getAccountSession()?.familyId === familyId);
        // A rotated refresh token is saved before another queued account read.
        await Promise.allSettled(siblings.map(sibling => sibling.updateAccountSession(latest, familyId)));
        session = latest;
        refreshed = true;
      };
      if (Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now() + 30000) await refresh();
      try {
        return await work(session);
      } catch (error) {
        if (error?.code !== 'ACCOUNT_AUTHENTICATION_FAILED' || refreshed) throw error;
        await refresh();
        return work(session);
      }
    });
    const tail = task.catch(() => {});
    this._accountQueues.set(familyId, tail);
    try { return await task; }
    finally { if (this._accountQueues.get(familyId) === tail) this._accountQueues.delete(familyId); }
  }

  _areaDeviceId(device) {
    return createHash('sha256').update(String(device.getData().id)).digest('hex').slice(0, 24);
  }

  _areaDevices() {
    return this.homey.drivers.getDriver('vr300').getDevices();
  }

  _areaDeviceInfo(device) {
    const snapshot = device.getSnapshot();
    return { id: this._areaDeviceId(device), name: device.getName(), support: device.getSupport(), areas: device.getAreas(),
      robotStatus: { available: device.getAvailable(), state: snapshot?.state ?? null,
        status: snapshot ? this.homey.__(`status.${snapshot.statusKey}`) : null,
        battery: snapshot?.battery ?? null, charging: snapshot?.charging ?? null,
        docked: snapshot?.docked ?? null, updatedAt: device.getRobotDataUpdatedAt() },
      selectedArea: device.getSelectedArea(), areasUpdatedAt: device.getAreasUpdatedAt(),
      robotData: device.getRobotData(), robotDataUpdatedAt: device.getRobotDataUpdatedAt(),
      infoUpdatedAt: device.getInfoUpdatedAt(), infoAvailable: device.getInfoAvailable(),
      robotSchedule: device.getRobotSchedule(), cleaningHistory: device.getCleaningHistory() };
  }

  async getAreaDevices() {
    const devices = this._areaDevices();
    await Promise.all(devices.map(device => device.ready()));
    return devices.map(device => this._areaDeviceInfo(device));
  }

  async _getAreaDevice(id) {
    const device = typeof id === 'string'
      ? this._areaDevices().find(candidate => this._areaDeviceId(candidate) === id) : null;
    if (!device) throw new Error(this.homey.__('errors.device_not_found'));
    await device.ready();
    return device;
  }

  async refreshDeviceAreas(id) {
    const device = await this._getAreaDevice(id);
    await device.refreshAreas();
    return this._areaDeviceInfo(device);
  }

  async selectDeviceArea(id, area) {
    const device = await this._getAreaDevice(id);
    await device.selectArea(area);
    return this._areaDeviceInfo(device);
  }

  async startDeviceArea(id, area) {
    const device = await this._getAreaDevice(id);
    return device.startArea(area);
  }

  async refreshDeviceRobotData(id) {
    const device = await this._getAreaDevice(id);
    await device.refreshRobotData();
    return this._areaDeviceInfo(device);
  }

  async refreshDeviceHistory(id) {
    const device = await this._getAreaDevice(id);
    await device.refreshHistory();
    return this._areaDeviceInfo(device);
  }

  async getDeviceHistoryImage(id, imageId) {
    return (await this._getAreaDevice(id)).getHistoryImage(imageId);
  }
}

module.exports = KoboldApp;
