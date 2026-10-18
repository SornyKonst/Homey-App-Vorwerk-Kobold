'use strict';

module.exports = {
  async refreshDeviceHistory({ homey, body }) {
    return homey.app.refreshDeviceHistory(body?.deviceId);
  },
  async getDeviceHistoryImage({ homey, query }) {
    return homey.app.getDeviceHistoryImage(query?.deviceId, query?.imageId);
  },
  async refreshDeviceRobotData({ homey, body }) {
    return homey.app.refreshDeviceRobotData(body?.deviceId);
  },
  async getAreaDevices({ homey }) {
    return homey.app.getAreaDevices();
  },

  async refreshDeviceAreas({ homey, body }) {
    return homey.app.refreshDeviceAreas(body?.deviceId);
  },

  async selectDeviceArea({ homey, body }) {
    return homey.app.selectDeviceArea(body?.deviceId, body?.area);
  },

  async startDeviceArea({ homey, body }) {
    return homey.app.startDeviceArea(body?.deviceId, body?.area);
  },
};
