"use strict";

var inherits = require("util").inherits;
var Service, Characteristic, HomebridgeAPI;

// OccupancyTriggerSwitch is 100% based on https://github.com/nfarina/homebridge-dummy

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;

  /**
   * Characteristic "Time Remaining"
   */
  Characteristic.TimeRemaining = function () {
    Characteristic.call(
      this,
      "Time Remaining",
      "2000006D-0000-1000-8000-0026BB765291"
    );
    this.setProps({
      format: Characteristic.Formats.UINT64,
      unit: Characteristic.Units.SECONDS,
      maxValue: 3600,
      minValue: 0,
      minStep: 1,
      perms: [
        Characteristic.Perms.READ,
        Characteristic.Perms.WRITE,
        Characteristic.Perms.NOTIFY,
      ],
    });
    this.value = this.getDefaultValue();
  };
  inherits(Characteristic.TimeRemaining, Characteristic);
  Characteristic.TimeRemaining.UUID = "2000006D-0000-1000-8000-0026BB765291";

  /**
   * Characteristic "Timeout Delay"
   */
  Characteristic.TimeoutDelay = function () {
    Characteristic.call(
      this,
      "Post-Activity Timeout Delay",
      "94a765c6-e114-11eb-ba80-0242ac130004"
    );
    this.setProps({
      format: Characteristic.Formats.UINT64,
      unit: Characteristic.Units.SECONDS,
      maxValue: 3600,
      minValue: 0,
      minStep: 1,
      perms: [
        Characteristic.Perms.READ,
        Characteristic.Perms.WRITE,
        Characteristic.Perms.NOTIFY,
      ],
    });
    this.value = this.getDefaultValue();
  };
  inherits(Characteristic.TimeoutDelay, Characteristic);
  Characteristic.TimeoutDelay.UUID = "94a765c6-e114-11eb-ba80-0242ac130004";

    /**
   * Characteristic "Keeping Occupancy Triggered"
   */
  Characteristic.KeepingOccupancyTriggered = function () {
    Characteristic.call(
      this,
      "Keeping Occupancy Triggered",
      "25eb64e4-e104-11eb-ba80-0242ac130004"
    );
    this.setProps({
      format: Characteristic.Formats.BOOL,
      perms: [
        Characteristic.Perms.READ,
        Characteristic.Perms.WRITE,
        Characteristic.Perms.NOTIFY,
      ],
    });
    this.value = this.getDefaultValue();
  };
  inherits(Characteristic.KeepingOccupancyTriggered, Characteristic);
  Characteristic.KeepingOccupancyTriggered.UUID = "25eb64e4-e104-11eb-ba80-0242ac130004";

  // Register
  homebridge.registerAccessory(
    "homebridge-magic-occupancy",
    "MagicOccupancy",
    MagicOccupancy
  );
};

class MagicOccupancy {
  constructor(log, config) {
    this.log = log;
    this.name = config.name.trim() || "MagicOccupancy";
    this.lightSwitchesNames = (config.lightSwitchesNames || "").split(",");
    this.statefulSwitchesNames = (config.statefulSwitchesNames || "").split(",");
    this.triggerSwitchesNames = (config.triggerSwitchesNames || "").split(",");
    this.motionSwitchesNames = (config.motionSwitchesNames || "").split(",");
    this.statefulStayOnSwitchesNames = (config.statefulStayOnSwitchesNames || "").split(",");
    this.triggerStayOnSwitchesNames = (config.triggerStayOnSwitchesNames || "").split(",");
    this.motionStayOnSwitchesNames = (config.motionStayOnSwitchesNames || "").split(",");
    this.stayOccupiedDelay = Math.min(3600, Math.max(0, parseInt(config.stayOccupiedDelay || 0, 10) || 0));
    this.maxOccupationTimeout = Math.max(0, parseInt(config.maxOccupationTimeout || 0, 10) || 0)
    this.persistBetweenReboots = config.persistBetweenReboots != false;
    this.startOnReboot = config.startOnReboot || false;
    this.triggerSwitchToggleTimeout = 1000;
    this.initializationCompleted = false;
    this.locksCounter = 0;
    this.isPendingCheckOccupancy = false;

    this._max_occupation_timer = null;

    this.cacheDirectory = HomebridgeAPI.user.persistPath();
    this.storage = require("node-persist");
    this.storage.initSync({
      dir: this.cacheDirectory,
      forgiveParseErrors: true,
    });

    const savedState = this.getCachedState("_MAIN", {
      '_last_occupied_state': false,
      'TimeRemaining' : 0,
    })

    this._timer = null;
    this._timer_started = null;
    this._timer_delay = 0;
    this._interval = null;
    this._interval_last_value = 0;

    this.switchServices = [];
    this.occupancyService = new Service.OccupancySensor(this.name);
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "https://github.com/Jason-Morcos/homebridge-magic-occupancy")
      .setCharacteristic(Characteristic.Model, "2")
      .setCharacteristic(Characteristic.SerialNumber, "JmoMagicOccupancySwitch");

    this.occupancyService.addCharacteristic(Characteristic.TimeoutDelay);
    this.occupancyService.setCharacteristic(
      Characteristic.TimeoutDelay,
      this.stayOccupiedDelay
    );
    this.occupancyService
      .getCharacteristic(Characteristic.TimeoutDelay)
      .on("change", (event) => {
        this.log("Setting stay occupied delay to:", event.newValue);
        this.stayOccupiedDelay = event.newValue;
      });

    this.occupancyService.addCharacteristic(Characteristic.TimeRemaining);
    if(this.stayOccupiedDelay) {
      this.occupancyService.setCharacteristic(Characteristic.TimeRemaining, savedState.TimeRemaining);
    }

    //Restore past state
    this._setOccupancyState(savedState._last_occupied_state)

    this.occupancyService
      .getCharacteristic(Characteristic.TimeRemaining)
      .on("change", (event) => {
        if (event.newValue === 0 && event.oldValue > 0) {
          this.log('Cancel timer and set occupancy to "NotDetected"');
          this.setOccupancyNotDetected();
        }
      });

    /* Make the lightSwitches */
    if(this.lightSwitchesNames.length > 0) {
      this.log.debug("Making " + this.lightSwitchesNames.length + " Light Switch switchServices");
      this.lightSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new LightSwitchMirrorSwitch(this, {
            name: switchName,
            stayOnOnly: false,
        }))._service);
      }.bind(this));
    }
    /* Make the statefulSwitches */
    if(this.statefulSwitchesNames.length > 0) {
      this.log.debug("Making " + this.statefulSwitchesNames.length + " Stateful trigger switchServices");
      this.statefulSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new StatefulSwitch(this, {
            name: switchName,
            stayOnOnly: false,
        }))._service);
      }.bind(this));
    }
    /* Make the triggerSwitches */
    if(this.triggerSwitchesNames.length > 0) {
      this.log.debug("Making " + this.triggerSwitchesNames.length + " Trigger trigger switchServices");
      this.triggerSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new TriggerSwitch(this, {
            name: switchName,
            stayOnOnly: false,
        }))._service);
      }.bind(this));
    }
    /* Make the motionSwitches */
    if(this.motionSwitchesNames.length > 0) {
      this.log.debug("Making " + this.motionSwitchesNames.length + " Motion trigger switchServices");
      this.motionSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new MotionSensorSwitch(this, {
            name: switchName,
            stayOnOnly: false,
        }))._service);
      }.bind(this));
    }

    /* Make the statefulStayOnSwitches */
    if(this.statefulStayOnSwitchesNames.length > 0) {
      this.log.debug("Making " + this.statefulStayOnSwitchesNames.length + " StayOn Stateful trigger switchServices");
      this.statefulStayOnSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new StatefulSwitch(this, {
            name: switchName,
            stayOnOnly: true,
        }))._service);
      }.bind(this));
    }
    /* Make the triggerStayOnSwitches */
    if(this.triggerStayOnSwitchesNames.length > 0) {
      this.log.debug("Making " + this.triggerStayOnSwitchesNames.length + " StayOn Trigger trigger switchServices");
      this.triggerStayOnSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new TriggerSwitch(this, {
            name: switchName,
            stayOnOnly: true,
        }))._service);
      }.bind(this));
    }
    /* Make the motionStayOnSwitches */
    if(this.motionStayOnSwitchesNames.length > 0) {
      this.log.debug("Making " + this.motionStayOnSwitchesNames.length + " StayOn Motion trigger switchServices");
      this.motionStayOnSwitchesNames.forEach(function(switchName) {
        if(switchName.length == 0) {
          return true; //continue
        }
        this.switchServices.push((new MotionSensorSwitch(this, {
            name: switchName,
            stayOnOnly: true,
        }))._service);
      }.bind(this));
    }

    //Create master shutoff
    if(config.createMasterShutoff == true) {
      this.switchServices.push((new MasterShutoffSwitch(this, {
            name: "Master Shutoff",
        }))._service);
    }

    //Mark that we're done initializing here, final setup below
    this.initializationCompleted = true;

    //Handle start on reboot
    if(this.startOnReboot) {
      this.log(
        `startOnReboot==true - setting to active`
      );
      //Run the set after homebridge should have booted to ensure events fire
      setTimeout(function() {
        this.setOccupancyDetected();
        this.checkOccupancy(10);
      }.bind(this), 10000);
    }
    //Handle restoring state - gotta restart the decaying timer if we rebooted
    else if (this.persistBetweenReboots && this._last_occupied_state == true) {
      this.startUnoccupiedDelay(this.stayOccupiedDelay ? savedState.TimeRemaining : 0);
    }

    //Do an initial occupancy check
    this.checkOccupancy(10);
  }

  /**
   * startUnoccupiedDelays the countdown timer.
   */
  startUnoccupiedDelay(overrideTimeRemaining = null) {
    if(this._last_occupied_state === false || (this.stayOccupiedDelay || 0) == 0) {
      this.setOccupancyNotDetected();
      return;
    }

    this.locksCounter += 1;

    this.stop();

    this._timer_started = new Date().getTime();
    this.log("Timer startUnoccupiedDelayed:", this.stayOccupiedDelay);

    this._timer = setTimeout(
      this.setOccupancyNotDetected.bind(this),
      Math.round(this.stayOccupiedDelay * 1000)
    );
    this._timer_delay = overrideTimeRemaining || this.stayOccupiedDelay;
    this._interval = setInterval(() => {
      var elapsed = (new Date().getTime() - this._timer_started) / 1000,
        newValue = Math.round(this._timer_delay - elapsed);

      if (newValue !== this._interval_last_value) {
        this.occupancyService.setCharacteristic(
          Characteristic.TimeRemaining,
          newValue
        );
        this._interval_last_value = newValue;

        this.saveCachedState("_MAIN", {
          '_last_occupied_state': this._last_occupied_state,
          'TimeRemaining' : newValue,
        });
      }
    }, 250);

    this.saveCachedState("_MAIN", {
      '_last_occupied_state': this._last_occupied_state,
      'TimeRemaining' : this.stayOccupiedDelay,
    });

    this.locksCounter -= 1;
  }

  /**
   * Stops the countdown timer
   */
  stop() {
    if (this._timer) {
      this.log("Delay timer stopped");
      clearTimeout(this._timer);
      clearInterval(this._interval);
      this._timer = null;
      this._timer_started = null;
      this._timer_delay = null;
      this._interval = null;
    }
  }

  //Helper to get a cached state value
  getCachedState(key, defaultValue) {
    if(!this.persistBetweenReboots) {
      return defaultValue;
    }
    this.log.debug(`Loading cached value for ${key}`);

    const cachedValue = this.storage.getItemSync(this.name + '-HMO-' + key);

    if(cachedValue == undefined || cachedValue == null) {
      return defaultValue;
    }

    return cachedValue;
  }
  //Helper to set/save a cached state value
  saveCachedState(key, value) {
    if(!this.persistBetweenReboots) {
      return;
    }

    setTimeout(function() {
      this.storage.setItemSync(this.name + '-HMO-' + key, value);
    }.bind(this), 10);
  }

  setOccupancyDetected() {
    this.locksCounter += 1;
    this.stop();

    this._setOccupancyState(true);

    if (this.stayOccupiedDelay) {
      this.occupancyService.setCharacteristic(
        Characteristic.TimeRemaining,
        this.stayOccupiedDelay
      );
    }

    if(this.maxOccupationTimeout > 0 && this._max_occupation_timer == null) {
      this._max_occupation_timer = setTimeout(
        this.setOccupancyNotDetected.bind(this),
        Math.round(this.maxOccupationTimeout * 1000)
      );
    }

    //Save state
    this.saveCachedState("_MAIN", {
      '_last_occupied_state': this._last_occupied_state,
      'TimeRemaining' : this.stayOccupiedDelay || 0,
    });

    this.locksCounter -= 1;
  }

  _setOccupancyState(newVal) {
    this._last_occupied_state = newVal;
    this.occupancyService.setCharacteristic(
      Characteristic.OccupancyDetected,
      newVal ? Characteristic.OccupationDetected.OCCUPANCY_DETECTED : Characteristic.OccupationDetected.OCCUPANCY_NOT_DETECTED
    );
  }

  setOccupancyNotDetected() {
    this.locksCounter += 1;
    this.stop();

    this._setOccupancyState(false);

    if (this.stayOccupiedDelay) {
      this.occupancyService.setCharacteristic(Characteristic.TimeRemaining, 0);
    }

    if(this.maxOccupationTimeout > 0 && this._max_occupation_timer == null) {
      this._max_occupation_timer = setTimeout(
        this.setOccupancyNotDetected.bind(this),
        Math.round(this.maxOccupationTimeout * 1000)
      );
    }

    //Clear max timeout
    if (this._max_occupation_timer != null) {
      this.log("Max occupation timer stopped");
      clearTimeout(this._max_occupation_timer);
      this._max_occupation_timer = null;
    }

    //Turn all switches off
    var shutoff_switch = (aSwitch) => {
      aSwitch
        .getCharacteristic(Characteristic.On)
        .getValue(function(err, value) {
          if (!err && value) {
            aSwitch.setCharacteristic(Characteristic.On, false);
          }
        });
    }
    for (let i = 0; i < this.switchServices.length; i += 1) {
      shutoff_switch(this.switchServices[i]);
    }

    //Save state
    this.saveCachedState("_MAIN", {
      '_last_occupied_state': this._last_occupied_state,
      'TimeRemaining' : 0,
    });

    this.locksCounter -= 1;
  }

  /**
   * Checks all the trigger switchServices to see if any of them are on. If so this
   * Occupancy Sensor will remain "Occupied". This is used as a callback when
   * the "On" state changes on any of the trigger switchServices.
   */
  checkOccupancy(timeoutUntilCheck = 0) {
    if(this.locksCounter > 0) {
      this.log(`checking occupancy waiting for ${this.locksCounter} to clear; waiting for at least 100ms`);
      timeoutUntilCheck = Math.max(100, timeoutUntilCheck);
    }

    if(timeoutUntilCheck > 0) {
      if(!this.isPendingCheckOccupancy) {
        this.isPendingCheckOccupancy = true;
        setTimeout(function() {
          this.isPendingCheckOccupancy = false;
          this.checkOccupancy();
        }.bind(this), timeoutUntilCheck);
      }
      return;
    }

    this.locksCounter += 1;

    const switchesToCheck = this.switchServices;
    const previousOccupiedState = this._last_occupied_state;
    this.log.debug(`checking occupancy. Total: ${switchesToCheck.length} switches`);

    /* callback for when all the switchServices values have been returned */
    var result = {'already_acted': false, 'remainingCount': switchesToCheck.length};

    var handleResponse = function(value) {
      result.remainingCount -= 1;

      if(result.already_acted) {
        return;
      }

      if(value == true) {
        result.already_acted = true;

        if(this._last_occupied_state == false) {
          this.setOccupancyDetected();
        }

        this.log(
          `checkOccupancy result: true. Previous occupied state: ${previousOccupiedState}, current state: ${this._last_occupied_state}`
        );
      }

      if(value == false && result.remainingCount == 0) {
        result.already_acted = true;

        this.startUnoccupiedDelay();

        this.log(
          `checkOccupancy result: false. Previous occupied state: ${previousOccupiedState}, current state: ${this._last_occupied_state}`
        );
      }
    }.bind(this);

    /* look at all the trigger switchServices "KeepingOccupancyTriggered" characteristic and return to callback */
    for (let i = 0; i < switchesToCheck.length; i += 1) {
      if(result.already_acted) {
        break;
      }

      switchesToCheck[i]
        .getCharacteristic(Characteristic.KeepingOccupancyTriggered)
        .getValue(function(err, value) {
          if (err) {
            this.log(
              `ERROR GETTING VALUE Characteristic.KeepingOccupancyTriggered ${err}`
            );
            value = false;
          }

          handleResponse(value);
      });
    }

    if(switchesToCheck.length == 0 && this._last_occupied_state == true) {
      this.startUnoccupiedDelay();

      this.log(
        `checkOccupancy result: false (0 switches). Previous occupied state: ${previousOccupiedState}, current state: ${this._last_occupied_state}`
      );
    }

    this.locksCounter -= 1;
  }

  /**
   * Homebridge function to return all the Services associated with this
   * Accessory.
   *
   * @returns {*[]}
   */
  getServices() {
    var services = [this.occupancyService, this.informationService];

    return services.concat([...this.switchServices]);
  }
}


class BaseHelperSwitch {
  constructor(occupancySensor, config) {
    this.log = occupancySensor.log;
    this.occupancySensor = occupancySensor;
    this.name = occupancySensor.name.trim() + " " + config.name.trim();
    this._service = new Service.Switch(this.name.trim(), this.name.trim());

    this._offDelayTimer = null;


    this._service.setCharacteristic(Characteristic.On, this.occupancySensor.getCachedState('PMS-' + this.name, false));

    this._service.addCharacteristic(Characteristic.KeepingOccupancyTriggered);
    this.keepingOccupancyTriggered = this.occupancySensor.getCachedState('PMS-KOT-' + this.name, false);
    this._service.setCharacteristic(
      Characteristic.KeepingOccupancyTriggered,
      this.keepingOccupancyTriggered
    );

    //Attach to changes
    this._service.getCharacteristic(Characteristic.On)
      .on('set', this._internalStateChangeTrigger.bind(this));

  }

  _killOccupancy() {
    this.occupancySensor.locksCounter += 1;
    this.occupancySensor.setOccupancyNotDetected();
    setTimeout(function() {
      this.occupancySensor.checkOccupancy();
      this.occupancySensor.locksCounter -= 1;
    }.bind(this), 10);
  }

  _setOccupancyOn() {
    this.occupancySensor.locksCounter += 1;
    this.occupancySensor.setOccupancyDetected();
    setTimeout(function() {
      this.occupancySensor.checkOccupancy();
      this.occupancySensor.locksCounter -= 1;
    }.bind(this), 10);
  }

  _internalStateChangeTrigger(on, callback) {
    //Make sure we're actually full initialized
    if(!this.occupancySensor.initializationCompleted) {
      this.log.debug("Setting " + this.name + " initial state and bypassing all events");
      callback();
      return;
    }

    //Handle off switch canceling timer
    if(!on && this._offDelayTimer) {
      clearTimeout(this._offDelayTimer);
      this._offDelayTimer = null;
    }

    //Cache our previous state for restoration
    this.occupancySensor.saveCachedState('PMS-' + this.name, on);

    this._handleNewState(on);

    callback();
  }

  _setKeepingOccupancyTriggered(newVal) {
    this.keepingOccupancyTriggered = newVal;
    this._service.setCharacteristic(Characteristic.KeepingOccupancyTriggered, newVal);
    this.occupancySensor.saveCachedState('PMS-KOT-' + this.name, newVal);
  }

  _handleNewState(on) {
    //Overwritten in child classes
  }
}

class StatefulSwitch extends BaseHelperSwitch {
  constructor(occupancySensor, config) {
    super(occupancySensor, config);
    this.stayOnOnly = config.stayOnOnly || false;
  }

  _handleNewState(on) {
    if(!on && !this.keepingOccupancyTriggered) {
      return;
    }

    const isValidOn = on && (!this.stayOnOnly || this.occupancySensor._last_occupied_state == true);

    this._setKeepingOccupancyTriggered(isValidOn);

    if(isValidOn) {
      this._setOccupancyOn();
    }

    if(!on && this.occupancySensor._last_occupied_state == true) {
      this.occupancySensor.checkOccupancy(10);
    }
  }
}

class TriggerSwitch extends BaseHelperSwitch {
  constructor(occupancySensor, config) {
    super(occupancySensor, config);
    this.stayOnOnly = config.stayOnOnly || false;
    this._setKeepingOccupancyTriggered(false);
  }

  _handleNewState(on) {
    if(!on && !this.keepingOccupancyTriggered) {
      return;
    }

    if(on && (!this.stayOnOnly || this.occupancySensor._last_occupied_state == true)) {
      this._setOccupancyOn();
    }

    if(on) {
      this._offDelayTimer = setTimeout(function() {
        this._service.setCharacteristic(Characteristic.On, false);
      }.bind(this), this.occupancySensor.triggerSwitchToggleTimeout);
    }
  }
}


class MotionSensorSwitch extends BaseHelperSwitch {
  constructor(occupancySensor, config) {
    super(occupancySensor, config);
    this.stayOnOnly = config.stayOnOnly || false;
  }

  _handleNewState(on) {
    if(!on && !this.keepingOccupancyTriggered) {
      return;
    }

    const isValidOn = on && (!this.stayOnOnly || this.occupancySensor._last_occupied_state == true);

    this._setKeepingOccupancyTriggered(isValidOn);

    if(isValidOn) {
      this._setOccupancyOn();
    }

    if(!on && this.occupancySensor._last_occupied_state == true) {
      this.occupancySensor.checkOccupancy(10);
    }
  }
}


class LightSwitchMirrorSwitch extends BaseHelperSwitch {
  constructor(occupancySensor, config) {
    super(occupancySensor, config);

    //Make this switch match the big boi
    this.occupancySensor.occupancyService.getCharacteristic(Characteristic.OccupancyDetected)
      .on('set', function(occVal, callback) {
        this._service
          .getCharacteristic(Characteristic.On)
          .getValue(function(err, value) {
            if (err) {
              this.log(
                `ERROR GETTING VALUE Characteristic.On ${err}`
              );
              return;
            }

            if(value != this.occupancySensor._last_occupied_state) {
              this._service.setCharacteristic(Characteristic.On, this.occupancySensor._last_occupied_state);
            }
          }.bind(this));
      }.bind(this))
  }

  _handleNewState(on) {
    if(on && this.occupancySensor._last_occupied_state == false) {
      this._setKeepingOccupancyTriggered(true);

      this._setOccupancyOn();
    }

    //Handle turning off the whole system with this switch
    if(!on) {
      this._setKeepingOccupancyTriggered(false);
      this._killOccupancy();
    }
  }
}


class MasterShutoffSwitch extends BaseHelperSwitch {
  constructor(occupancySensor, config) {
    super(occupancySensor, config);
    this._setKeepingOccupancyTriggered(false);
  }

  _handleNewState(on) {
    if(on) {
      this._killOccupancy();
      this._offDelayTimer = setTimeout(function() {
        this._service.setCharacteristic(Characteristic.On, false);
      }.bind(this), this.occupancySensor.triggerSwitchToggleTimeout);
    }
  }
}
