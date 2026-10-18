'use strict';

const Homey = require('homey');
const { createHash } = require('node:crypto');
const { normalizeRobotState } = require('../../lib/robot-state');
const { normalizeRobotData } = require('../../lib/robot-data');
const { normalizeRobotSchedule } = require('../../lib/robot-schedule');
const { KoboldAccount } = require('../../lib/kobold-account');
const { getRobotSupport, getHouseCleaningService } = require('../../lib/robot-support');

const HISTORY_CAPABILITIES = ['kobold_last_cleaned_area', 'kobold_last_duration', 'kobold_last_cleaning'];
const IMAGE_HOSTS = ['beehive.ksecosys.com'];
const CONTROL_CAPABILITIES = {
  kobold_start: 'start', kobold_pause: 'pause', kobold_resume: 'resume',
  kobold_stop: 'stop', kobold_dock: 'dock',
};
const AREA_CAPABILITIES = ['kobold_area', 'kobold_start_area'];
const AREA_NONE = 'none';
const OPTIONAL_CAPABILITIES = {
  kobold_area: 'areas', kobold_start_area: 'areas', kobold_current_area: 'areas',
  kobold_navigation_mode: 'navigation', kobold_charge_count: 'generalInfo',
  kobold_last_cleaned_area: 'history', kobold_last_duration: 'history', kobold_last_cleaning: 'history',
};

const DATA_CAPABILITIES = {
  kobold_cleaning_mode: 'cleaningMode', kobold_navigation_mode: 'navigationMode',
  kobold_schedule_enabled: 'scheduleEnabled', kobold_firmware: 'firmware',
  kobold_model: 'model', kobold_charge_count: 'chargeCount',
  kobold_warning: 'warning', kobold_current_area: 'area',
};

class Vr300Device extends Homey.Device {
  async onInit() {
    this._closed = false;
    this._queue = Promise.resolve();
    this._snapshot = null;
    this._lastRaw = null;
    this._support = getRobotSupport(this._robot());
    this._runActive = false;
    this._failures = 0;
    this._pollTimer = null;
    this._followupTimer = null;
    this._areas = [];
    this._areasUpdatedAt = null;
    this._areaTarget = null;
    this._selectedArea = this._parseArea(this.getStoreValue('selected_area'), false);
    this._areaPickerSignature = null;
    this._robotData = null;
    this._robotDataUpdatedAt = null;
    this._generalInfo = {};
    this._infoUpdatedAt = null;
    this._infoAvailable = false;
    this._infoAttemptAt = null;
    this._robotSchedule = { enabled: null, events: null };
    this._scheduleUpdatedAt = null;
    this._scheduleAvailable = false;
    this._historyQueue = Promise.resolve();
    this._historyTimer = null;
    this._historyObserved = false;
    this._historyIds = new Set();
    this._historyLatestAt = null;
    this._historyGeneration = 0;
    this._account = new KoboldAccount({ imageHosts: IMAGE_HOSTS });
    this._cleaningHistory = { entries: [], maps: [], updatedAt: null, available: false,
      historyAvailable: false, mapsAvailable: false,
      needsLogin: this._support.history && !this.getAccountSession() };
    for (const capability of [...Object.keys(DATA_CAPABILITIES), ...HISTORY_CAPABILITIES,
      ...Object.keys(CONTROL_CAPABILITIES), ...AREA_CAPABILITIES]) {
      if (this._supportsCapability(capability) && !this.hasCapability(capability)) await this.addCapability(capability);
    }
    for (const [capability, action] of Object.entries(CONTROL_CAPABILITIES)) {
      // Stateless buttons describe an action, never an optimistic robot state.
      this.registerCapabilityListener(capability, async () => this.executeAction(action));
    }
    if (this.hasCapability('kobold_area')) this.registerCapabilityListener('kobold_area', value => this.selectArea(value, { fromPicker: true }));
    if (this.hasCapability('kobold_start_area')) this.registerCapabilityListener('kobold_start_area', async value => {
      if (value !== true) return false;
      return this.startArea(undefined, { useStoredSelection: true });
    });
    this.registerCapabilityListener('vacuumcleaner_state', async (value) => {
      const actions = { cleaning: 'start', stopped: 'stop', docked: 'dock', charging: 'dock' };
      if (!actions[value]) throw new Error(this.homey.__('errors.unsupported_action'));
      await this.executeAction(actions[value]);
    });
    await this._syncSupportCapabilities();
    await this._syncAreaPicker().catch(() => {});
    const initialStatus = await this.refreshStatus().catch(() => null);
    if (initialStatus && this._support.areas) {
      // Reuse the initial status for this read-only catalog import. No extra
      // status request or command is needed to populate the native picker.
      const mapId = !Array.isArray(this._robot().maps) && typeof initialStatus.cleaning?.mapId === 'string'
        && initialStatus.cleaning.mapId ? initialStatus.cleaning.mapId : undefined;
      await this._enqueue(() => this._loadAreas(mapId)).catch(() => {});
    }
    this._schedulePoll();
    this._scheduleHistory(1500);
  }

  getSnapshot() {
    return this._snapshot;
  }

  getSupport() { return { ...this._support }; }

  _supportsCapability(capability) {
    const feature = OPTIONAL_CAPABILITIES[capability];
    return !feature || this._support[feature] !== false;
  }

  _requireFeature(feature) {
    if (this._support[feature] === false) throw new Error(this.homey.__('errors.feature_unsupported'));
  }

  async _syncSupportCapabilities() {
    for (const capability of Object.keys(OPTIONAL_CAPABILITIES)) {
      const supported = this._supportsCapability(capability);
      if (!this.hasCapability(capability)) {
        if (supported) await this.addCapability(capability);
        else continue;
      }
      let options;
      try { options = this.getCapabilityOptions(capability) || {}; }
      catch (error) {
        // Homey can lack a readable options record for an existing write-only
        // button. This does not make the action itself an invalid capability.
        if (capability !== 'kobold_start_area'
          || error?.message !== `Invalid Capability: ${capability}`) throw error;
        options = {};
      }
      // Never remove a capability: saved Flows and their tags keep their IDs.
      if (!supported && options.uiComponent !== null) {
        await this.setCapabilityOptions(capability, { ...options, uiComponent: null });
      } else if (supported && options.uiComponent === null) {
        const component = capability === 'kobold_area' ? 'picker'
          : capability === 'kobold_start_area' ? 'button' : 'sensor';
        await this.setCapabilityOptions(capability, { ...options, uiComponent: component });
      }
    }
  }

  getAccountSession() {
    const session = this.getStoreValue('robot')?.accountSession;
    return session && typeof session === 'object' ? { ...session } : null;
  }

  async updateAccountSession(session, familyId) {
    if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
    const robot = this._robot();
    if (robot.accountSession?.familyId !== familyId || session.familyId !== familyId) {
      throw new Error(this.homey.__('errors.account_login_required'));
    }
    await this.setStoreValue('robot', { ...robot, accountSession: { ...session } });
  }

  getCleaningHistory() {
    return { ...this._cleaningHistory,
      entries: this._cleaningHistory.entries.map(entry => ({ ...entry })),
      maps: this._cleaningHistory.maps.map(map => ({ ...map })) };
  }

  _enqueueHistory(work) {
    const task = this._historyQueue.then(() => {
      if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
      return work();
    });
    this._historyQueue = task.catch(() => {});
    return task;
  }

  refreshHistory() {
    return this._enqueueHistory(() => this._refreshHistory());
  }

  async _refreshHistory() {
    this._requireFeature('history');
    const robot = this._robot();
    const familyId = robot.accountSession?.familyId;
    const generation = this._historyGeneration;
    const account = this._account;
    if (!this.getAccountSession()) {
      this._cleaningHistory.available = false;
      this._cleaningHistory.historyAvailable = false;
      this._cleaningHistory.mapsAvailable = false;
      this._cleaningHistory.needsLogin = true;
      return this.getCleaningHistory();
    }
    try {
      const results = await this.homey.app.withAccountSession(this, async session => {
        const values = await Promise.allSettled([
          account.getHistory(robot.serial, session),
          account.getPersistentMaps(robot.serial, session),
        ]);
        const authentication = values.find(value => value.status === 'rejected'
          && value.reason?.code === 'ACCOUNT_AUTHENTICATION_FAILED');
        if (authentication) throw authentication.reason;
        return values;
      });
      if (this._closed || this._historyGeneration !== generation
        || this.getAccountSession()?.familyId !== familyId) return this.getCleaningHistory();
      const historyOk = results[0].status === 'fulfilled';
      const mapsOk = results[1].status === 'fulfilled';
      if (historyOk) this._cleaningHistory.entries = results[0].value.entries;
      if (mapsOk) this._cleaningHistory.maps = results[1].value;
      this._cleaningHistory.available = historyOk && mapsOk;
      this._cleaningHistory.historyAvailable = historyOk;
      this._cleaningHistory.mapsAvailable = mapsOk;
      this._cleaningHistory.needsLogin = false;
      if (historyOk) {
        this._cleaningHistory.updatedAt = new Date().toISOString();
        const latest = this._cleaningHistory.entries[0];
        const startedAt = Date.parse(latest?.startedAt);
        const newEntry = this._historyObserved && latest && !this._historyIds.has(latest.id)
          && Number.isFinite(startedAt)
          && (this._historyLatestAt === null || startedAt >= this._historyLatestAt);
        // Removing a newer cloud record or restoring an older snapshot must not
        // replay a historical cleaning as a new Flow event.
        for (const entry of this._cleaningHistory.entries) {
          this._historyIds.add(entry.id);
          const at = Date.parse(entry.startedAt);
          if (Number.isFinite(at) && (this._historyLatestAt === null || at > this._historyLatestAt)) {
            this._historyLatestAt = at;
          }
        }
        while (this._historyIds.size > 500) this._historyIds.delete(this._historyIds.values().next().value);
        await Promise.all([
          this.setCapabilityValue('kobold_last_cleaned_area', latest?.areaSquareMetres ?? null),
          this.setCapabilityValue('kobold_last_duration', latest?.durationMinutes ?? null),
          this.setCapabilityValue('kobold_last_cleaning', this._historyDate(latest?.startedAt)),
        ]);
        if (newEntry) {
          await this._trigger('history_entry_added', {
            started_at: latest.startedAt || '', status: latest.status || 'unknown',
            area: latest.areaSquareMetres === null ? '' : String(latest.areaSquareMetres),
            duration: latest.durationMinutes === null ? '' : String(latest.durationMinutes),
          });
        }
        this._historyObserved = true;
      }
      if (this.homey.settings?.get('diagnostics_enabled') === true) {
        this.homey.settings.set('last_history_diagnostics', {
          at: new Date().toISOString(), historyOk, mapsOk,
          entryCount: this._cleaningHistory.entries.length, mapCount: this._cleaningHistory.maps.length,
          imageOrigins: account.getImageOrigins(),
        });
      }
    } catch (error) {
      if (!this._closed && this._historyGeneration === generation
        && this.getAccountSession()?.familyId === familyId) {
        this._cleaningHistory.available = false;
        this._cleaningHistory.historyAvailable = false;
        this._cleaningHistory.mapsAvailable = false;
        this._cleaningHistory.needsLogin = ['ACCOUNT_LOGIN_REQUIRED', 'ACCOUNT_AUTHENTICATION_FAILED'].includes(error?.code);
      }
    }
    return this.getCleaningHistory();
  }

  _historyDate(value) {
    if (!value) return null;
    try {
      return new Intl.DateTimeFormat(this.homey.i18n?.getLanguage?.() || 'en',
        { dateStyle: 'medium', timeStyle: 'short', timeZone: this.homey.clock?.getTimezone?.() || 'UTC' })
        .format(new Date(value));
    } catch { return value; }
  }

  getHistoryImage(id) {
    return this._enqueueHistory(async () => {
      this._requireFeature('maps');
      const account = this._account;
      const generation = this._historyGeneration;
      const familyId = this.getAccountSession()?.familyId;
      const known = () => [...this._cleaningHistory.entries, ...this._cleaningHistory.maps]
        .some(entry => entry.id === id && entry.hasImage);
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !known()) {
        throw new Error(this.homey.__('errors.image_unavailable'));
      }
      let result;
      try { result = await account.getImage(id); }
      catch (error) {
        if (['IMAGE_UNAVAILABLE', 'IMAGE_EXPIRED', 'IMAGE_NOT_FOUND'].includes(error?.code) || [403, 404].includes(error?.status)) {
          await this._refreshHistory();
          if (this._cleaningHistory.needsLogin) throw new Error(this.homey.__('errors.account_login_required'));
          if (!known()) throw new Error(this.homey.__('errors.image_unavailable'));
          try { result = await account.getImage(id); }
          catch { throw new Error(this.homey.__('errors.image_unavailable')); }
        } else throw new Error(this.homey.__('errors.image_unavailable'));
      }
      if (this._closed || this._historyGeneration !== generation
        || this.getAccountSession()?.familyId !== familyId) throw new Error(this.homey.__('errors.device_closed'));
      return { mimeType: result.mimeType, data: result.buffer.toString('base64') };
    });
  }

  _scheduleHistory(delay = 15 * 60 * 1000) {
    if (this._closed || this._support.history === false || !this.getAccountSession() || this._cleaningHistory.needsLogin) return;
    if (this._historyTimer) this.homey.clearTimeout(this._historyTimer);
    this._historyTimer = this.homey.setTimeout(async () => {
      this._historyTimer = null;
      await this.refreshHistory().catch(() => {});
      this._scheduleHistory();
    }, delay);
  }

  getRobotData() {
    return this._robotData ? { ...this._robotData } : null;
  }

  getRobotDataUpdatedAt() { return this._robotDataUpdatedAt; }
  getInfoUpdatedAt() { return this._infoUpdatedAt; }
  getInfoAvailable() { return this._infoAvailable; }
  getRobotSchedule() {
    return { enabled: this._robotData?.scheduleEnabled ?? this._robotSchedule.enabled,
      events: this._robotSchedule.events?.map(event => ({ ...event })) ?? null,
      available: this._scheduleAvailable, updatedAt: this._scheduleUpdatedAt };
  }

  getAreas() {
    return this._areas.map(area => ({ ...area }));
  }

  getSelectedArea() {
    return this._selectedArea ? { ...this._selectedArea } : null;
  }

  getAreasUpdatedAt() {
    return this._areasUpdatedAt;
  }

  _parseArea(value, required = true) {
    const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(id);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)
      || (value.mapId !== undefined && !validId(value.mapId))) {
      if (!required) return null;
      throw new Error(this.homey.__('errors.invalid_area'));
    }
    return { id: value.id,
      ...(typeof value.name === 'string' ? { name: value.name.slice(0, 256) } : {}),
      ...(value.mapId !== undefined ? { mapId: value.mapId } : {}) };
  }

  _matchingArea(selection, areas) {
    return areas.find(area => area.id === selection.id
      && (area.mapId || null) === (selection.mapId || null));
  }

  _areaPickerId(area) {
    // Imported catalogs already use sha256([mapId, boundaryId]) identities.
    // Older robot-only catalogs need the same opaque, map-qualified encoding.
    const imported = typeof area.boundaryId === 'string'
      || (Array.isArray(this._robot().maps) && /^[a-f0-9]{64}$/.test(area.id));
    const identity = imported ? area.id
      : createHash('sha256').update(JSON.stringify([area.mapId || null, area.id])).digest('hex');
    return `area_${identity}`;
  }

  async _syncAreaPicker() {
    if (this._closed || this._support.areas === false || !this.hasCapability('kobold_area')) return;
    const currentOptions = this.getCapabilityOptions('kobold_area') || {};
    const manifestNone = this.homey.app.manifest?.capabilities?.kobold_area?.values
      ?.find(value => value.id === AREA_NONE)?.title;
    const noneTitle = manifestNone && typeof manifestNone === 'object'
      ? { ...manifestNone }
      : { en: this.homey.__('controls.area_none'), de: this.homey.__('controls.area_none') };
    const values = [{ id: AREA_NONE, title: noneTitle }];
    const areas = this.getAreas();
    // A failed initial/repair read must not discard a saved selection. Keep a
    // valid placeholder until its map can be checked against a fresh catalog.
    if (this._selectedArea && !this._matchingArea(this._selectedArea, areas)) areas.push(this._selectedArea);
    const identities = new Map();
    for (const area of areas) {
      const id = this._areaPickerId(area);
      const identity = JSON.stringify([area.mapId || null, area.id]);
      if (identities.has(id)) {
        if (identities.get(id) !== identity) throw new Error(this.homey.__('errors.areas_unavailable'));
        continue;
      }
      identities.set(id, identity);
      const name = typeof area.name === 'string' && area.name.trim()
        && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(area.name)
        ? area.name.slice(0, 512) : this.homey.__('settings.area');
      values.push({ id, title: { en: name, de: name } });
    }
    const selected = this._selectedArea ? this._matchingArea(this._selectedArea, areas) : null;
    const nextValue = selected ? this._areaPickerId(selected) : AREA_NONE;
    const signature = JSON.stringify(values);
    try {
      // Clear a removed value while 'none' is still valid in the old options,
      // then add new options before assigning a newly selected identity.
      const currentValue = this.getCapabilityValue('kobold_area');
      if (currentValue !== AREA_NONE && !values.some(value => value.id === currentValue)) {
        await this.setCapabilityValue('kobold_area', AREA_NONE);
      }
      if (this._closed) return;
      if (signature !== this._areaPickerSignature) {
        await this.setCapabilityOptions('kobold_area', { ...currentOptions, values });
        this._areaPickerSignature = signature;
      }
      if (this._closed) return;
      if (this.getCapabilityValue('kobold_area') !== nextValue) {
        await this.setCapabilityValue('kobold_area', nextValue);
      }
    } catch (error) {
      throw new Error(this.homey.__('errors.areas_unavailable'));
    }
  }

  async _loadAreas(mapId) {
    this._requireFeature('areas');
    let areas;
    const robot = this._robot();
    try {
      const maps = Array.isArray(robot.maps) ? robot.maps : null;
      if (maps) {
        const selectedMaps = mapId ? maps.filter(map => map.id === mapId) : maps;
        if (mapId && !selectedMaps.length) throw new Error(this.homey.__('errors.area_not_found'));
        areas = [];
        for (const map of selectedMaps) {
          if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
          const mapAreas = await this.homey.app.kobold.getAreas(robot, { mapId: map.id });
          areas.push(...mapAreas.map(area => ({
            id: createHash('sha256').update(JSON.stringify([map.id, area.id])).digest('hex'),
            boundaryId: area.id,
            mapId: map.id,
            name: maps.length > 1 ? `${area.name} · ${map.name}` : area.name,
          })));
        }
      } else {
        areas = await this.homey.app.kobold.getAreas(robot, mapId ? { mapId } : {});
      }
    } catch (error) {
      if (this.homey.settings?.get('diagnostics_enabled') === true) {
        const codes = new Set(['INVALID_RESPONSE', 'COMMAND_REJECTED', 'TIMEOUT', 'HTTP_ERROR',
          'ROBOT_AUTHENTICATION_FAILED', 'RATE_LIMITED', 'NETWORK_ERROR', 'INVALID_ROBOT',
          'UNSUPPORTED_ENDPOINT', 'INVALID_PARAMS']);
        const diagnostic = { at: new Date().toISOString(),
          code: codes.has(error?.code) ? error.code : 'UNKNOWN' };
        if (this._areaReadHints) diagnostic.request = { ...this._areaReadHints };
        if (Number.isInteger(error?.status)) diagnostic.status = error.status;
        if (['invalid_json', 'bad_request', 'command_not_found', 'command_rejected', 'ko',
          'not_on_charge_base'].includes(error?.result)) diagnostic.result = error.result;
        const shape = error?.areaDiagnostic;
        if (shape) {
          const types = new Set(['object', 'array', 'null', 'undefined', 'string', 'number', 'boolean', 'other']);
          diagnostic.shape = {};
          for (const key of ['dataType', 'boundariesType', 'mapIdType']) {
            if (types.has(shape[key])) diagnostic.shape[key] = shape[key];
          }
          for (const key of ['messageAccepted', 'mapIdMatches']) {
            if (typeof shape[key] === 'boolean') diagnostic.shape[key] = shape[key];
          }
          if (Number.isInteger(shape.count) && shape.count >= 0 && shape.count <= 1001) {
            diagnostic.shape.count = shape.count;
          }
          for (const key of ['idTypes', 'nameTypes']) {
            if (Array.isArray(shape[key])) diagnostic.shape[key] = shape[key].filter(type => types.has(type)).slice(0, 8);
          }
          if (Array.isArray(shape.boundaryTypes)) diagnostic.shape.boundaryTypes = shape.boundaryTypes
            .filter(type => ['polygon', 'polyline', 'other'].includes(type)).slice(0, 3);
          for (const key of ['recordTypes', 'idTypes', 'nameTypes', 'boundaryTypes']) {
            if (shape[key] && typeof shape[key] === 'object' && !Array.isArray(shape[key])) {
              const labels = key === 'boundaryTypes' ? ['polygon', 'polyline', 'other'] : [...types];
              diagnostic.shape[key] = Object.fromEntries(labels
                .filter(label => Number.isInteger(shape[key][label]) && shape[key][label] >= 0 && shape[key][label] <= 1000)
                .map(label => [label, shape[key][label]]));
            }
          }
        }
        this.homey.settings.set('last_area_diagnostic', diagnostic);
      }
      if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
      if (Array.isArray(robot.maps) && mapId && !robot.maps.some(map => map.id === mapId)) {
        throw new Error(this.homey.__('errors.area_not_found'));
      }
      if (!mapId && !Array.isArray(robot.maps) && error?.code === 'COMMAND_REJECTED') {
        throw new Error(this.homey.__('errors.maps_import_required'));
      }
      throw new Error(this.homey.__('errors.areas_unavailable'));
    }
    if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
    this._areas = (mapId && Array.isArray(robot.maps)
      ? [...this._areas.filter(area => area.mapId !== mapId), ...areas]
      : areas).map(area => ({ ...area }));
    this._areasUpdatedAt = new Date().toISOString();
    if (this._selectedArea && (!mapId || this._selectedArea.mapId === mapId)) {
      const selected = this._matchingArea(this._selectedArea, this._areas);
      if (!selected) {
        await this.setStoreValue('selected_area', null);
        this._selectedArea = null;
      } else if (this._selectedArea.name !== selected.name
        || this._selectedArea.boundaryId !== selected.boundaryId) {
        await this.setStoreValue('selected_area', selected);
        this._selectedArea = { ...selected };
      }
    }
    await this._syncAreaPicker();
    return this.getAreas();
  }

  refreshAreas() {
    return this._enqueue(async () => {
      this._requireFeature('areas');
      const raw = await this._fetchAndUpdate();
      if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
      const mapId = typeof raw.cleaning?.mapId === 'string' && raw.cleaning.mapId ? raw.cleaning.mapId : undefined;
      const versions = ['basic-1', 'basic-2', 'basic-3', 'basic-4', 'minimal-2'];
      this._areaReadHints = { mapIdPresent: Boolean(mapId),
        mapsService: versions.includes(raw.availableServices?.maps) ? raw.availableServices.maps : 'unknown',
        houseCleaningService: versions.includes(raw.availableServices?.houseCleaning) ? raw.availableServices.houseCleaning : 'unknown' };
      return this._loadAreas(Array.isArray(this._robot().maps) ? undefined : mapId);
    });
  }

  selectArea(value, { fromPicker = false } = {}) {
    this._requireFeature('areas');
    const selection = fromPicker ? null : this._parseArea(value);
    if (fromPicker && value !== AREA_NONE && (typeof value !== 'string' || !/^area_[a-f0-9]{64}$/.test(value))) {
      throw new Error(this.homey.__('errors.area_not_found'));
    }
    return this._enqueue(async () => {
      if (fromPicker && value === AREA_NONE) {
        await this.setStoreValue('selected_area', null);
        this._selectedArea = null;
        await this._syncAreaPicker();
        return null;
      }
      const areas = await this._loadAreas(fromPicker ? undefined : selection.mapId);
      if (!areas.length) throw new Error(this.homey.__('errors.no_areas'));
      const area = fromPicker ? areas.find(candidate => this._areaPickerId(candidate) === value)
        : this._matchingArea(selection, areas);
      if (!area) throw new Error(this.homey.__('errors.area_not_found'));
      await this.setStoreValue('selected_area', area);
      this._selectedArea = { ...area };
      await this._syncAreaPicker();
      return this.getSelectedArea();
    });
  }

  _requireAreaStart() {
    this._requireFeature('areas');
    if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
    if (!this._snapshot?.docked || !this._snapshot.availableCommands.start
      || this._snapshot.availableCommands.resume) {
      throw new Error(this.homey.__('errors.area_requires_dock'));
    }
  }

  startArea(value, { useStoredSelection = false } = {}) {
    this._requireFeature('areas');
    const requestedSelection = useStoredSelection ? null : this._parseArea(value);
    return this._enqueue(async () => {
      this._requireFeature('areas');
      const selection = useStoredSelection ? this._parseArea(this._selectedArea, false) : requestedSelection;
      if (!selection || (useStoredSelection
        && this.getCapabilityValue('kobold_area') !== this._areaPickerId(selection))) {
        throw new Error(this.homey.__('errors.area_selection_required'));
      }
      await this._fetchAndUpdate({ skipAdditional: true });
      this._requireAreaStart();
      const areas = await this._loadAreas(selection.mapId);
      if (!areas.length) throw new Error(this.homey.__('errors.no_areas'));
      const area = this._matchingArea(selection, areas);
      if (!area) throw new Error(this.homey.__('errors.area_not_found'));
      // A map lookup can take time. Recheck the robot immediately before motion.
      const raw = await this._fetchAndUpdate({ skipAdditional: true });
      this._requireAreaStart();
      const cleaning = raw.cleaning || {};
      this._areaTarget = {
        name: area.name,
        mapId: area.mapId,
        boundaryId: area.boundaryId || area.id,
        mapName: this._robot().maps?.find(map => map.id === area.mapId)?.name,
      };
      await this._sendCommand('startCleaning', {
        category: 4,
        mode: [1, 2].includes(cleaning.mode) ? cleaning.mode : 2,
        modifier: 1,
        navigationMode: [1, 2, 3].includes(cleaning.navigationMode) ? cleaning.navigationMode : 1,
        boundaryId: area.boundaryId || area.id,
        ...(area.mapId ? { mapId: area.mapId } : {}),
      });
      await this._fetchAndUpdate().catch(() => {});
      this._scheduleFollowup();
      return true;
    });
  }

  _enqueue(work) {
    const result = this._queue.then(() => {
      if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
      return work();
    });
    this._queue = result.catch(() => {});
    return result;
  }

  async replaceRobot(robot) {
    if (robot.serial.toLowerCase() !== String(this.getData().id).toLowerCase()) {
      throw new Error(this.homey.__('errors.robot_not_found'));
    }
    await this._enqueue(async () => {
      await this.setStoreValue('robot', robot);
      this._lastRaw = null;
      this._support = getRobotSupport(robot);
      // Invalidate the old account immediately after replacing credentials.
      // A failing robot-status read must not leave the previous account's
      // history or private image URLs accessible under the renewed session.
      if (this._historyTimer) this.homey.clearTimeout(this._historyTimer);
      this._historyTimer = null;
      this._historyGeneration += 1;
      this._account.clear();
      this._account = new KoboldAccount({ imageHosts: IMAGE_HOSTS });
      this._cleaningHistory = { entries: [], maps: [], updatedAt: null, available: false,
        historyAvailable: false, mapsAvailable: false,
        needsLogin: this._support.history && !this.getAccountSession() };
      this._historyObserved = false;
      this._historyIds = new Set();
      this._historyLatestAt = null;
      this._areas = [];
      this._areasUpdatedAt = null;
      if (this._selectedArea && Array.isArray(robot.maps)
        && (!robot.maps.length || (this._selectedArea.mapId
          && !robot.maps.some(map => map.id === this._selectedArea.mapId)))) {
        await this.setStoreValue('selected_area', null);
        this._selectedArea = null;
      }
      this._infoAttemptAt = null;
      this._generalInfo = {};
      this._infoAvailable = false;
      this._infoUpdatedAt = null;
      this._scheduleAvailable = false;
      this._scheduleUpdatedAt = null;
      this._robotSchedule = { enabled: null, events: null };
      try {
        await Promise.all(HISTORY_CAPABILITIES.filter(capability => this.hasCapability(capability))
          .map(capability => this.setCapabilityValue(capability, null)));
        await this._syncSupportCapabilities();
        await this._syncAreaPicker().catch(() => {});
        const raw = await this._fetchAndUpdate();
        const mapId = !Array.isArray(robot.maps) && typeof raw.cleaning?.mapId === 'string'
          && raw.cleaning.mapId ? raw.cleaning.mapId : undefined;
        if (this._support.areas) await this._loadAreas(mapId).catch(() => {});
      } finally {
        this._scheduleHistory(1500);
      }
    });
  }

  refreshStatus() {
    return this._enqueue(() => this._fetchAndUpdate());
  }

  refreshRobotData() {
    return this._enqueue(async () => {
      await this._fetchAndUpdate({ forceAdditional: true });
      return this.getRobotData();
    });
  }

  executeAction(action) {
    if (action === 'refresh') return this.refreshStatus();
    return this._enqueue(async () => {
      // Fetch current command availability before acting on a robot that may have
      // changed state through MyKobold or its physical buttons.
      const raw = await this._fetchAndUpdate({ skipAdditional: true });
      if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
      let available = this._snapshot.availableCommands;
      if (action === 'dock' && !available.goToBase && raw.details.dockHasBeenSeen === false) {
        throw new Error(this.homey.__('errors.base_not_seen'));
      }
      if (action === 'dock' && !available.goToBase && available.pause) {
        await this._sendCommand('pauseCleaning');
        // Some firmware permits docking only after the paused state appears.
        // Retry status reads, never the physical pause command.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await new Promise((resolve) => this.homey.setTimeout(resolve, 1000));
          if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
          await this._fetchAndUpdate({ skipAdditional: true });
          available = this._snapshot.availableCommands;
          if (available.goToBase) break;
        }
        if (!available.goToBase) throw new Error(this.homey.__('errors.dock_not_ready'));
      }
      let command;
      if (action === 'start') {
        command = available.resume ? 'resumeCleaning' : 'startCleaning';
        this._requireCommand(available.resume ? 'resume' : 'start');
      } else {
        const commands = {
          pause: ['pause', 'pauseCleaning'],
          resume: ['resume', 'resumeCleaning'],
          stop: ['stop', 'stopCleaning'],
          dock: ['goToBase', 'sendToBase'],
        };
        if (!commands[action]) throw new Error(this.homey.__('errors.unsupported_action'));
        this._requireCommand(commands[action][0]);
        command = commands[action][1];
      }
      const cleaning = raw.cleaning || {};
      const legacyCleaning = getHouseCleaningService(this._robot(), raw) === 'basic-1' || this._support.model === 'VR200';
      const params = command === 'startCleaning' ? legacyCleaning ? {
        category: 2,
        mode: [1, 2].includes(cleaning.mode) ? cleaning.mode : 2,
        modifier: 1,
      } : {
        category: [2, 4].includes(cleaning.category) ? cleaning.category : 4,
        mode: [1, 2].includes(cleaning.mode) ? cleaning.mode : 2,
        modifier: 1,
        navigationMode: [1, 2, 3].includes(cleaning.navigationMode) ? cleaning.navigationMode : 1,
        ...(typeof cleaning.mapId === 'string' && cleaning.mapId ? { mapId: cleaning.mapId } : {}),
      } : undefined;
      if (command === 'startCleaning') this._areaTarget = null;
      await this._sendCommand(command, params);
      // Acknowledgement is not a confirmed state transition. Only real status
      // responses update Homey and fire triggers.
      await this._fetchAndUpdate().catch(() => {});
      this._scheduleFollowup();
      return true;
    });
  }

  async _sendCommand(command, params) {
    if (this._closed) throw new Error(this.homey.__('errors.device_closed'));
    try {
      await this.homey.app.kobold.command({ ...this._robot(),
        ...(this._lastRaw?.availableServices ? { availableServices: this._lastRaw.availableServices } : {}) }, command, params);
    } catch (error) {
      throw new Error(this.homey.__('errors.command_failed'));
    }
  }

  _requireCommand(name) {
    if (!this._snapshot.availableCommands[name]) {
      throw new Error(this.homey.__('errors.command_unavailable'));
    }
  }

  _robot() {
    const robot = this.getStoreValue('robot');
    if (!robot || !robot.secret || !robot.endpoint || !robot.serial) {
      throw new Error(this.homey.__('errors.repair_required'));
    }
    return robot;
  }

  _areaDiagnostic(raw) {
    if (!this._areaTarget) return undefined;
    const target = this._areaTarget;
    const cleaning = raw.cleaning || {};
    const ids = [cleaning.boundaryId, cleaning.boundary?.id]
      .filter(value => typeof value === 'string' && value.length > 0);
    const boundaryName = typeof cleaning.boundary?.name === 'string'
      ? cleaning.boundary.name.trim() : '';
    const alerts = ['clean_completed_to_start', 'clean_incomplete_to_start',
      'nav_floorplan_load_fail', 'nav_floorplan_localization_fail',
      'nav_floorplan_not_created', 'ui_alert_invalid'];
    return {
      requestedName: target.name,
      mappedCleaning: cleaning.category === 4,
      mapMatches: typeof cleaning.mapId === 'string' && cleaning.mapId
        ? cleaning.mapId === target.mapId : null,
      boundaryMatches: ids.length ? ids.every(id => id === target.boundaryId) : null,
      nameMatches: boundaryName ? (boundaryName === target.name
        || (target.mapName && `${boundaryName} · ${target.mapName}` === target.name)) === true : null,
      completionAlert: typeof raw.alert === 'string' && raw.alert
        ? (alerts.includes(raw.alert) ? raw.alert : 'other') : null,
    };
  }

  async _fetchAdditionalInfo(raw) {
    this._infoAttemptAt = Date.now();
    if (this._support.generalInfo) try {
      const result = await this.homey.app.kobold.getGeneralInfo(this._robot());
      if (this._closed) return;
      const data = normalizeRobotData({}, result.data);
      this._generalInfo = { firmware: data.firmware, model: data.model, productNumber: data.productNumber,
        battery: { totalCharges: data.chargeCount, vendor: data.batteryVendor,
          manufacturingDate: data.batteryManufacturingDate } };
      this._infoAvailable = true;
      this._infoUpdatedAt = new Date().toISOString();
    } catch {
      this._infoAvailable = false;
    }
    if (this._closed) return;
    try {
      const service = raw.availableServices?.schedule;
      const result = service === 'basic-2'
        ? await this.homey.app.kobold.getScheduleEvents(this._robot())
        : service === 'basic-1' || service === 'minimal-1'
          ? await this.homey.app.kobold.getSchedule(this._robot()) : null;
      if (this._closed) return;
      this._robotSchedule = normalizeRobotSchedule(result?.data);
      this._scheduleAvailable = result !== null;
      if (result) this._scheduleUpdatedAt = new Date().toISOString();
    } catch {
      this._scheduleAvailable = false;
    }
  }

  async _updateRobotData(raw, forceAdditional, skipAdditional) {
    if (!skipAdditional && (forceAdditional || this._infoAttemptAt === null || Date.now() - this._infoAttemptAt >= 15 * 60 * 1000)) {
      await this._fetchAdditionalInfo(raw);
    }
    if (this._closed) return;
    const previous = this._robotData;
    const next = normalizeRobotData(raw, this._generalInfo);
    if (!this._support.generalInfo) {
      next.chargeCount = null;
      next.batteryVendor = null;
      next.batteryManufacturingDate = null;
      next.productNumber = null;
    }
    if (!this._support.navigation) next.navigationMode = null;
    if (!this._support.areas) next.area = null;
    if (next.scheduleEnabled === null && this._scheduleAvailable) next.scheduleEnabled = this._robotSchedule.enabled;
    const knownWarnings = new Set(['ui_alert_dust_bin_full', 'dustbin_full', 'maint_brush_change',
      'maint_filter_change', 'clean_completed_to_start', 'clean_incomplete_to_start',
      'nav_floorplan_load_fail', 'nav_floorplan_localization_fail', 'nav_floorplan_not_created',
      'ui_alert_battery_chargebasecommerr', 'ui_alert_swupdate_fail', 'ui_alert_busy_charging']);
    next.warningKnown = raw.alert === null || (typeof raw.alert === 'string'
      && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw.alert)
      && (raw.alert.trim() === '' || raw.alert.trim() === 'ui_alert_invalid' || next.warningCode !== null));
    next.warning = !next.warningKnown ? null : next.warningCode
      ? (knownWarnings.has(next.warningCode) ? this.homey.__(`warnings.${next.warningCode}`)
        : `${this.homey.__('warnings.other')} (${next.warningCode})`)
      : this.homey.__('warnings.none');
    await Promise.all(Object.entries(DATA_CAPABILITIES).filter(([capability]) => this.hasCapability(capability))
      .map(([capability, key]) => this.setCapabilityValue(capability, next[key])));
    this._robotData = next;
    this._robotDataUpdatedAt = new Date().toISOString();
    if (!previous) return;
    if ((previous.cleaningMode !== null && next.cleaningMode !== null && previous.cleaningMode !== next.cleaningMode)
      || (previous.navigationMode !== null && next.navigationMode !== null && previous.navigationMode !== next.navigationMode)) {
      await this._trigger('cleaning_mode_changed', { mode: next.cleaningMode || '', navigation: next.navigationMode || '' });
    }
    if (typeof previous.scheduleEnabled === 'boolean' && typeof next.scheduleEnabled === 'boolean'
      && previous.scheduleEnabled !== next.scheduleEnabled) {
      await this._trigger('robot_schedule_changed', { enabled: next.scheduleEnabled });
    }
    if (previous.warningKnown && next.warningKnown && previous.warningCode !== next.warningCode) {
      await this._trigger('robot_warning_changed', { code: next.warningCode || '', message: next.warning });
    }
  }

  async _fetchAndUpdate({ forceAdditional = false, skipAdditional = false } = {}) {
    let raw;
    let next;
    try {
      raw = await this.homey.app.kobold.getState(this._robot());
      next = normalizeRobotState(raw);
    } catch (error) {
      this._failures += 1;
      if (!this._closed) await this.setUnavailable(this.homey.__('errors.robot_unavailable'));
      throw new Error(this.homey.__('errors.robot_unavailable'));
    }
    if (this._closed) return raw;
    this._lastRaw = raw;
    let support = getRobotSupport(this._robot(), raw);
    // Model identity is stable even when optional metadata is omitted from a
    // subsequent status response. Fresh explicit model data still wins.
    if (!support.model && this._support.model) {
      support = getRobotSupport({ ...this._robot(), model: this._support.model }, raw);
    }
    if (JSON.stringify(support) !== JSON.stringify(this._support)) {
      const historyWasSupported = this._support.history;
      if (support.generalInfo !== this._support.generalInfo) this._infoAttemptAt = null;
      this._support = support;
      if (!support.generalInfo) {
        this._generalInfo = {};
        this._infoAvailable = false;
        this._infoUpdatedAt = null;
      }
      await this._syncSupportCapabilities();
      if (!support.history) {
        if (this._historyTimer) this.homey.clearTimeout(this._historyTimer);
        this._historyTimer = null;
        this._historyGeneration += 1;
        this._account.clear();
        this._cleaningHistory = { entries: [], maps: [], available: false, historyAvailable: false,
          mapsAvailable: false, needsLogin: false, updatedAt: null };
      } else if (!historyWasSupported) {
        this._scheduleHistory(1500);
      }
    }
    if (this.homey.settings?.get('diagnostics_enabled') === true) {
      // Opt-in support data only: never persist the robot secret, serial,
      // endpoint, map identifiers or account response.
      this.homey.settings.set('last_robot_diagnostics', {
        at: new Date().toISOString(),
        state: raw.state,
        action: raw.action,
        commands: Object.fromEntries(Object.entries(raw.availableCommands)
          .filter(([, value]) => typeof value === 'boolean')),
        details: {
          isDocked: next.docked,
          isCharging: typeof raw.details.isCharging === 'boolean' ? raw.details.isCharging : null,
          dockHasBeenSeen: raw.details.dockHasBeenSeen === true,
          charge: next.battery,
        },
        cleaning: {
          category: raw.cleaning?.category,
          mode: raw.cleaning?.mode,
          navigationMode: raw.cleaning?.navigationMode,
        },
        error: next.errorCode,
        ...(this._areaTarget ? { area: this._areaDiagnostic(raw) } : {}),
      });
    }
    this._failures = 0;
    const previous = this._snapshot;
    const status = this.homey.__(`status.${next.statusKey}`)
      + (next.errorCode ? ` (${next.errorCode})` : '');
    await Promise.all([
      this.setCapabilityValue('vacuumcleaner_state', next.vacuumState === 'spot_cleaning' ? 'cleaning' : next.vacuumState),
      this.setCapabilityValue('measure_battery', next.battery),
      this.setCapabilityValue('alarm_generic', next.state === 'error'),
      this.setCapabilityValue('kobold_status', status),
      this.setCapabilityValue('kobold_charging', next.charging),
    ]);
    this._snapshot = next;
    await this.setAvailable();
    await this._updateRobotData(raw, forceAdditional, skipAdditional);
    if (this._closed) return raw;
    // First observation after pairing/restart supplies the baseline, not events.
    if (!previous) {
      this._runActive = next.state === 'cleaning';
      return raw;
    }
    if (previous.state !== next.state || previous.errorCode !== next.errorCode) {
      await this._trigger('state_changed', { state: next.state, status });
    }
    if (next.state === 'cleaning') {
      this._runActive = true;
      if (previous.state !== 'cleaning' && previous.state !== 'paused') {
        await this._trigger('cleaning_started');
      }
    }
    if (next.state === 'error' && (previous.state !== 'error' || previous.errorCode !== next.errorCode)) {
      await this._trigger('robot_error', { message: status });
    }
    if (this._runActive && ['docked', 'charging'].includes(next.state)) {
      this._runActive = false;
      await this._trigger('cleaning_finished');
      this._scheduleHistory(30000);
    }
    // An idle response with missing dock/charge fields cannot distinguish a
    // stopped job from a completed return. Keep the observed run until the
    // station state is known, rather than losing its eventual docking event.
    if (next.state === 'error'
      || (next.state === 'idle' && next.docked === false && next.charging === false)) {
      this._runActive = false;
    }
    return raw;
  }

  async _trigger(id, tokens) {
    try {
      await this.homey.app.triggerDevice(id, this, tokens);
    } catch (error) {
      this.error(`Flow trigger failed: ${id}`);
    }
  }

  _schedulePoll() {
    if (this._closed) return;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    const seconds = Number(this.getSetting('poll_interval')) || 60;
    const interval = Math.max(60, Math.min(600, seconds));
    const delay = Math.min(600, interval * (2 ** Math.min(this._failures, 3)));
    this._pollTimer = this.homey.setTimeout(async () => {
      this._pollTimer = null;
      await this.refreshStatus().catch(() => {});
      this._schedulePoll();
    }, delay * 1000);
  }

  _scheduleFollowup() {
    if (this._closed) return;
    if (this._followupTimer) this.homey.clearTimeout(this._followupTimer);
    this._followupTimer = this.homey.setTimeout(async () => {
      this._followupTimer = null;
      await this.refreshStatus().catch(() => {});
    }, 5000);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      // Homey commits newSettings after this hook resolves.
      this.homey.setTimeout(() => this._schedulePoll(), 0);
    }
  }

  async onUninit() {
    this._closed = true;
    this._historyGeneration += 1;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    if (this._followupTimer) this.homey.clearTimeout(this._followupTimer);
    if (this._historyTimer) this.homey.clearTimeout(this._historyTimer);
    this._account.clear();
  }

  async onDeleted() {
    await this.onUninit();
  }
}

module.exports = Vr300Device;
