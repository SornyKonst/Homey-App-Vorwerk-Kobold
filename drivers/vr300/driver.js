'use strict';

const Homey = require('homey');
const { getRobotSupport } = require('../../lib/robot-support');
const VR200_CAPABILITIES = ['kobold_start', 'kobold_pause', 'kobold_resume', 'kobold_stop', 'kobold_dock',
  'vacuumcleaner_state', 'measure_battery', 'kobold_status', 'kobold_charging', 'alarm_generic',
  'kobold_cleaning_mode', 'kobold_schedule_enabled', 'kobold_firmware', 'kobold_model', 'kobold_warning'];

class Vr300Driver extends Homey.Driver {
  async onPair(session) {
    this._configureSession(session);
  }

  async onRepair(session, device) {
    this._configureSession(session, device);
  }

  _configureSession(session, device = null) {
    let email = null;
    let robots = [];
    let lastRequestAt = 0;
    let busy = false;

    session.setHandler('request_code', async (data = {}) => {
      if (busy || Date.now() - lastRequestAt < 30000) {
        throw new Error(this.homey.__('errors.wait_before_retry'));
      }
      const requestedEmail = String(data.email || '').trim().toLowerCase();
      busy = true;
      try {
        await this.homey.app.kobold.requestCode(requestedEmail);
        email = requestedEmail;
        robots = [];
        lastRequestAt = Date.now();
        return true;
      } catch (error) {
        throw this._loginError(error);
      } finally {
        busy = false;
      }
    });

    session.setHandler('verify_code', async (data = {}) => {
      if (!email) throw new Error(this.homey.__('errors.request_code_first'));
      if (busy) throw new Error(this.homey.__('errors.wait_before_retry'));
      busy = true;
      try {
        robots = await this.homey.app.kobold.discoverRobots(email, String(data.code || '').trim(),
          { includeMaps: true, includeAccount: true });
        if (!robots.length) throw new Error('NO_ROBOTS');
        if (device) {
          const serial = String(device.getData().id).toLowerCase();
          const robot = robots.find((item) => item.serial.toLowerCase() === serial);
          if (!robot) throw new Error('ROBOT_NOT_FOUND');
          await device.replaceRobot(robot);
          return { repaired: true };
        }
        return { repaired: false };
      } catch (error) {
        robots = [];
        throw this._loginError(error);
      } finally {
        busy = false;
      }
    });

    session.setHandler('list_devices', async () => robots.map((robot) => ({
      name: robot.name || (getRobotSupport(robot).model === 'VR200' ? 'Kobold VR200' : 'Kobold VR300'),
      data: { id: robot.serial },
      store: { robot },
      ...(getRobotSupport(robot).model === 'VR200' ? { capabilities: [...VR200_CAPABILITIES] } : {}),
    })));

    session.setHandler('disconnect', async () => {
      email = null;
      robots = [];
    });
  }

  _loginError(error) {
    const code = error && (error.code || error.message);
    const keys = {
      NO_ROBOTS: 'no_robots',
      ROBOT_NOT_FOUND: 'robot_not_found',
      INVALID_EMAIL: 'invalid_email',
      INVALID_CODE: 'invalid_code',
      AUTH_FAILED: 'invalid_code',
      AUTHENTICATION_FAILED: 'invalid_code',
      TIMEOUT: 'timeout',
      RATE_LIMITED: 'wait_before_retry',
      MAP_DISCOVERY_FAILED: 'map_discovery_failed',
    };
    return new Error(this.homey.__(`errors.${keys[code] || 'login_failed'}`));
  }
}

module.exports = Vr300Driver;
