'use strict';

const { inherits } = require('util');
let Service, Characteristic, HomebridgeAPI;

const TIME_REMAINING_CHARACTERISTIC_NAME = 'Time Remaining';
const TIME_REMAINING_CHARACTERISTIC_UUID = '2000006D-0000-1000-8000-0026BB765291';

const TIMEOUT_DELAY_CHARACTERISTIC_NAME = 'Post-Activity Timeout Delay';
const TIMEOUT_DELAY_CHARACTERISTIC_UUID = '94a765c6-e114-11eb-ba80-0242ac130004';

const MAX_TIME_REMAINING = 2147483647;

// OccupancyTriggerSwitch is 100% based on https://github.com/nfarina/homebridge-dummy

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;

    // Register
    homebridge.registerAccessory(
        'homebridge-magic-occupancy',
        'MagicOccupancy',
        MagicOccupancy
    );
};

class MagicOccupancy {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.occupancyLogging = config.occupancyLogging ?? true;
        // Trim name if provided, otherwise default to 'MagicOccupancy'
        this.name = config.name ? config.name.trim() : 'MagicOccupancy';
        this.lightSwitchesNames = (config.lightSwitchesNames ?? '').split(',');
        this.statefulSwitchesNames = (config.statefulSwitchesNames ?? '').split(',');
        this.triggerSwitchesNames = (config.triggerSwitchesNames ?? '').split(',');
        this.statefulStayOnSwitchesNames = (config.statefulStayOnSwitchesNames ?? '').split(',');
        this.triggerStayOnSwitchesNames = (config.triggerStayOnSwitchesNames ?? '').split(',');
        // Use parseInt with fallback to zero for non-numeric values
        this.stayOccupiedDelay = Math.max(0, parseInt(config.stayOccupiedDelay, 10) || 0);
        this.maxOccupationTimeout = Math.max(0, parseInt(config.maxOccupationTimeout, 10) || 0);
        this.serial = config.serial ? config.serial.trim() : 'JmoMagicOccupancySwitch';
        this.persistBetweenReboots = config.persistBetweenReboots != false;
        this.startOnReboot = config.startOnReboot || false;
        this.triggerSwitchToggleTimeout = 1000;
        this.initializationCompleted = false;
        this.locksCounter = 0;
        this.isPendingCheckOccupancy = false;
        this.isClearingOccupancy = false;

        this._max_occupation_timer = null;
        this.modeState = 'Unoccupied';

        // Initialize storage
        this.cacheDirectory = HomebridgeAPI.user.persistPath();
        this.storage = require('node-persist');
        this.storage.initSync({
            dir: this.cacheDirectory,
            forgiveParseErrors: true
        });

        const savedState = this._getInitialMainCacheState();

        this._timer = null;
        this._timer_started = null;
        this._timer_delay = 0;
        this._interval = null;
        this._interval_last_value = 0;

        this.switches = [];
        // Create Occupancy Sensor Service
        this.occupancyService = new Service.OccupancySensor(this.name);
        // Create Information Service
        this.informationService = new Service.AccessoryInformation()
            .setCharacteristic(
                Characteristic.Manufacturer,
                'https://github.com/Jason-Morcos/homebridge-magic-occupancy'
            )
            .setCharacteristic(Characteristic.Model, '2')
            .setCharacteristic(Characteristic.SerialNumber, this.serial);

        // Fix names getting messed up by iOS 16
        this.occupancyService.addOptionalCharacteristic(Characteristic.ConfiguredName);
        this.occupancyService.setCharacteristic(Characteristic.ConfiguredName, this.name);

        // Add Post-Activity Timeout Delay characteristic
        this.occupancyService.addCharacteristic(new Characteristic(
            TIMEOUT_DELAY_CHARACTERISTIC_NAME,
            TIMEOUT_DELAY_CHARACTERISTIC_UUID,
            {
                format: this.api.hap.Formats.UINT32,
                unit: this.api.hap.Units.SECONDS,
                maxValue: MAX_TIME_REMAINING,
                minValue: 0,
                minStep: 1,
                perms: [
                    this.api.hap.Perms.READ,
                    this.api.hap.Perms.NOTIFY
                ]
            }
        ));
        this.occupancyService.setCharacteristic(
            TIMEOUT_DELAY_CHARACTERISTIC_NAME,
            Math.min(MAX_TIME_REMAINING, this.stayOccupiedDelay)
        );
        this.occupancyService
            .getCharacteristic(TIMEOUT_DELAY_CHARACTERISTIC_NAME)
            .on('change', event => {
                this.log.debug('Setting stay occupied delay to:', event.newValue);
                this.stayOccupiedDelay = event.newValue;
            });

        // Add Time Remaining characteristic
        this.occupancyService.addCharacteristic(new Characteristic(
            TIME_REMAINING_CHARACTERISTIC_NAME,
            TIME_REMAINING_CHARACTERISTIC_UUID,
            {
                format: this.api.hap.Formats.UINT32,
                unit: this.api.hap.Units.SECONDS,
                maxValue: MAX_TIME_REMAINING,
                minValue: 0,
                minStep: 1,
                perms: [
                    this.api.hap.Perms.READ,
                    this.api.hap.Perms.NOTIFY
                ]
            }
        ));
        
        this.occupancyService.setCharacteristic(
            TIME_REMAINING_CHARACTERISTIC_NAME,
            this.stayOccupiedDelay ? Math.min(MAX_TIME_REMAINING, savedState.TimeRemaining ?? 0) : 0
        );

        // Restore past state
        this._setOccupancyState(savedState.ModeState);

        // Listen for changes on the Time Remaining characteristic
        this.occupancyService
            .getCharacteristic(TIME_REMAINING_CHARACTERISTIC_NAME)
            .on('change', event => {
                if (event.newValue === 0 && event.oldValue > 0) {
                    this.log.debug('Cancel timer and set occupancy to "NotDetected"');
                    this.setOccupancyNotDetected();
                }
            });

        /* Make the lightSwitches */
        if (this.lightSwitchesNames.length > 0) {
            this.log.debug(
                'Making ' + this.lightSwitchesNames.length + ' Light Switches'
            );
            this.lightSwitchesNames.forEach(function (switchName) {
                if (switchName.length == 0) {
                    return true; // continue
                }
                this.switches.push(
                    new LightSwitchMirrorSwitch(this, {
                        name: switchName,
                        stayOnOnly: false
                    })
                );
            }.bind(this));
        }
        /* Make the statefulSwitches */
        if (this.statefulSwitchesNames.length > 0) {
            this.log.debug(
                'Making ' + this.statefulSwitchesNames.length + ' Stateful trigger switches'
            );
            this.statefulSwitchesNames.forEach(function (switchName) {
                if (switchName.length == 0) {
                    return true; // continue
                }
                this.switches.push(
                    new StatefulSwitch(this, {
                        name: switchName,
                        stayOnOnly: false
                    })
                );
            }.bind(this));
        }
        /* Make the triggerSwitches */
        if (this.triggerSwitchesNames.length > 0) {
            this.log.debug(
                'Making ' + this.triggerSwitchesNames.length + ' Trigger trigger switches'
            );
            this.triggerSwitchesNames.forEach(function (switchName) {
                if (switchName.length == 0) {
                    return true; // continue
                }
                this.switches.push(
                    new TriggerSwitch(this, {
                        name: switchName,
                        stayOnOnly: false
                    })
                );
            }.bind(this));
        }
        /* Make the statefulStayOnSwitches */
        if (this.statefulStayOnSwitchesNames.length > 0) {
            this.log.debug(
                'Making ' + this.statefulStayOnSwitchesNames.length + ' StayOn Stateful trigger switches'
            );
            this.statefulStayOnSwitchesNames.forEach(function (switchName) {
                if (switchName.length == 0) {
                    return true; // continue
                }
                this.switches.push(
                    new StatefulSwitch(this, {
                        name: switchName,
                        stayOnOnly: true
                    })
                );
            }.bind(this));
        }
        /* Make the triggerStayOnSwitches */
        if (this.triggerStayOnSwitchesNames.length > 0) {
            this.log.debug(
                'Making ' + this.triggerStayOnSwitchesNames.length + ' StayOn Trigger trigger switches'
            );
            this.triggerStayOnSwitchesNames.forEach(function (switchName) {
                if (switchName.length == 0) {
                    return true; // continue
                }
                this.switches.push(
                    new TriggerSwitch(this, {
                        name: switchName,
                        stayOnOnly: true
                    })
                );
            }.bind(this));
        }

        // Create master shutoff
        if (config.createMasterShutoff == true) {
            this.switches.push(
                new MasterShutoffSwitch(this, {
                    name: 'Master Shutoff'
                })
            );
        }

        // Mark that we're done initializing here, final setup below
        this.initializationCompleted = true;

        // Handle start on reboot
        if (this.startOnReboot) {
            this.log.debug(`startOnReboot==true - setting to active`);
            // Run the set after homebridge should have booted to ensure events fire
            setTimeout(function () {
                this.setOccupancyDetected();
                this.checkOccupancy(10);
            }.bind(this), 10000);
        }
        // Handle restoring state - gotta restart the decaying timer if we rebooted
        else if (this.persistBetweenReboots && savedState.ModeState == 'UnoccupiedDelay') {
            this.startUnoccupiedDelay(this.stayOccupiedDelay ? savedState.TimeRemaining : 0);
        }
        // Handle restoring state - gotta restart the max runtime timer if we rebooted
        else if (this.persistBetweenReboots && savedState.ModeState == 'Occupied') {
            this.setOccupancyDetected();
        }
        // Handle restoring state - gotta make sure all the timers are stopped
        else if (this.persistBetweenReboots && savedState.ModeState == 'Unoccupied') {
            this.setOccupancyNotDetected();
        }

        // Do an initial occupancy check
        this.checkOccupancy(10);
    }

    // Helper to get a cached state value
    _getInitialMainCacheState() {
        const defaultState = {
            TimeRemaining: 0,
            ModeState: 'Unoccupied'
        };
        
        try {
            var state = this.getCachedState('_MAIN', defaultState);

            // Handle migrating a v1 cache
            if (!('ModeState' in state)) {
                state.ModeState = 'UnoccupiedDelay';
            }

            return state;
        } catch (error) {
            this.log.debug(`Error initializing past state, falling back on default - ${error}`);
            return defaultState;
        }
    }

    /**
     * startUnoccupiedDelay the countdown timer.
     */
    startUnoccupiedDelay(overrideTimeRemaining = null) {
        var timeRemaining = this.stayOccupiedDelay;
        if (overrideTimeRemaining != null && overrideTimeRemaining < timeRemaining) {
            timeRemaining = overrideTimeRemaining;
        }

        if (timeRemaining <= 0) {
            this.setOccupancyNotDetected();
            return;
        }

        // Set state
        this._setOccupancyState('UnoccupiedDelay');

        this.locksCounter += 1;

        this.stop();

        this._timer_started = new Date().getTime();
        this.log.debug('Timer startUnoccupiedDelayed:', timeRemaining);

        this._timer = setTimeout(this.setOccupancyNotDetected.bind(this), Math.round(timeRemaining * 1000));
        this._timer_delay = timeRemaining;
        this._interval = setInterval(() => {
            var elapsed = (new Date().getTime() - this._timer_started) / 1000;
            var newValue = Math.round(this._timer_delay - elapsed);

            if (newValue !== this._interval_last_value) {
                this.occupancyService.setCharacteristic(
                    TIME_REMAINING_CHARACTERISTIC_NAME,
                    Math.min(MAX_TIME_REMAINING, newValue)
                );
                this._interval_last_value = newValue;

                this.saveCachedState('_MAIN', {
                    TimeRemaining: newValue,
                    ModeState: 'UnoccupiedDelay'
                });
            }
        }, 250);

        this.saveCachedState('_MAIN', {
            TimeRemaining: timeRemaining,
            ModeState: 'UnoccupiedDelay'
        });

        this.locksCounter -= 1;
    }

    /**
     * Stops the countdown timer
     */
    stop() {
        if (this._timer) {
            this.log.debug('Delay timer stopped');
            clearTimeout(this._timer);
            clearInterval(this._interval);
            this._timer = null;
            this._timer_started = null;
            this._timer_delay = null;
            this._interval = null;
        }
    }

    // Helper to get a cached state value
    getCachedState(key, defaultValue) {
        if (!this.persistBetweenReboots && !this.initializationCompleted) {
            this.log.debug(`Persistence disabled - ignoring cached value for ${key}`);
            return defaultValue;
        }
        this.log.debug(`Loading cached value for ${key}`);

        const cachedValue = this.storage.getItemSync(this.name + '-HMO-' + key);

        if (cachedValue == undefined || cachedValue == null) {
            return defaultValue;
        }

        return cachedValue;
    }

    // Helper to set/save a cached state value
    saveCachedState(key, value) {
        setTimeout(function () {
            this.storage.setItemSync(this.name + '-HMO-' + key, value);
        }.bind(this), 10);
    }

    setOccupancyDetected() {
        this.locksCounter += 1;
        this.stop();

        this._setOccupancyState('Occupied');

        if (this.stayOccupiedDelay) {
            this.occupancyService.setCharacteristic(
                TIME_REMAINING_CHARACTERISTIC_NAME,
                this.stayOccupiedDelay
            );
        }

        if (this.maxOccupationTimeout > 0 && this._max_occupation_timer == null) {
            this._max_occupation_timer = setTimeout(
                this.setOccupancyNotDetected.bind(this),
                Math.round(this.maxOccupationTimeout * 1000)
            );
        }

        // Save state
        this.saveCachedState('_MAIN', {
            TimeRemaining: this.stayOccupiedDelay,
            ModeState: 'Occupied'
        });

        this.locksCounter -= 1;
    }

    _setOccupancyState(newVal) {
        // Capture the previous state and determine if the state change should be logged
        this.previousModeState = this.modeState;
        const occupancyLoggingCondition = ((newVal == 'Occupied' && this.previousModeState == 'Unoccupied') || newVal == 'Unoccupied');
        if (this.occupancyLogging && occupancyLoggingCondition) {
            this.log(`Setting state to ${newVal}`);
        }

        // Set the new state
        this.modeState = newVal;
        this.log.debug(`Previous state was ${this.previousModeState} and is now ${this.modeState}`);

        this.occupancyService.setCharacteristic(
            Characteristic.OccupancyDetected,
            newVal != 'Unoccupied'
                ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
                : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
        );
    }

    setOccupancyNotDetected() {
        this.locksCounter += 1;
        this.stop();

        this._setOccupancyState('Unoccupied');

        if (this.stayOccupiedDelay) {
            this.occupancyService.setCharacteristic(TIME_REMAINING_CHARACTERISTIC_NAME, 0);
        }

        // Clear max occupation timer if it exists
        if (this._max_occupation_timer != null) {
            this.log.debug('Max occupation timer stopped');
            clearTimeout(this._max_occupation_timer);
            this._max_occupation_timer = null;
        }

        // Turn all switches off
        var shutoff_switch = aSwitch => {
            let theValue = aSwitch.getCharacteristic(Characteristic.On).value;
            // Still on, turn it off
            if (theValue) {
                this.isClearingOccupancy = true;
                aSwitch.setCharacteristic(Characteristic.On, false);
                this.isClearingOccupancy = false;
            }
        };
        for (let i = 0; i < this.switches.length; i += 1) {
            shutoff_switch(this.switches[i]._service);
        }

        // Save state
        this.saveCachedState('_MAIN', {
            TimeRemaining: 0,
            ModeState: 'Unoccupied'
        });

        this.locksCounter -= 1;
    }

    /**
     * Checks all the trigger switches to see if any of them are on. If so this
     * Occupancy Sensor will remain "Occupied". This is used as a callback when
     * the "On" state changes on any of the trigger switches.
     */
    checkOccupancy(timeoutUntilCheck = 0) {
        if (this.locksCounter > 0) {
            this.log.debug(`checking occupancy waiting for ${this.locksCounter} to clear; waiting for at least 100ms`);
            timeoutUntilCheck = Math.max(100, timeoutUntilCheck);
        }

        if (timeoutUntilCheck > 0) {
            if (!this.isPendingCheckOccupancy) {
                this.isPendingCheckOccupancy = true;
                setTimeout(function () {
                    this.isPendingCheckOccupancy = false;
                    this.checkOccupancy();
                }.bind(this), timeoutUntilCheck);
            }
            return;
        }

        this.locksCounter += 1;

        const switchesToCheck = this.switches;
        // Interpolate string to copy
        const previousModeState = `${this.modeState}`;
        this.log.debug(`checking occupancy. Total: ${switchesToCheck.length} switches`);

        var result = {
            already_acted: false,
            remainingCount: switchesToCheck.length
        };

        var handleResponse = function (value) {
            result.remainingCount -= 1;

            if (result.already_acted) {
                return;
            }

            if (value == true) {
                result.already_acted = true;

                if (this.modeState != 'Occupied') {
                    this.setOccupancyDetected();
                }

                this.log.debug(`checkOccupancy result: true. Previous state: ${previousModeState}, current state: ${this.modeState}`);
            }

            if (value == false && result.remainingCount == 0) {
                result.already_acted = true;

                if (previousModeState == 'Occupied') {
                    this.startUnoccupiedDelay();
                }

                this.log.debug(`checkOccupancy result: false. Previous state: ${previousModeState}, current state: ${this.modeState}`);
            }
        }.bind(this);

        /* look at all the trigger switches "KeepingOccupancyTriggered" characteristic */
        for (let i = 0; i < switchesToCheck.length; i += 1) {
            if (result.already_acted) {
                break;
            }
            handleResponse(switchesToCheck[i]._getIsKeepingOccupancyTriggered());
        }

        if (switchesToCheck.length == 0 && this.modeState == 'Occupied' && result.already_acted == false) {
            this.startUnoccupiedDelay();

            this.log.debug(`checkOccupancy result: false (0 switches). Previous occupied state: ${previousModeState}, current state: ${this.modeState}`);
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
        return services.concat(this.switches.map(switchItem => switchItem._service));
    }
}

class BaseHelperSwitch {
    constructor(occupancySensor, config, isStateful) {
        this.log = occupancySensor.log;
        this.config = occupancySensor.config;
        this.api = occupancySensor.api;
        this.occupancySensor = occupancySensor;
        this.name = occupancySensor.name.trim() + ' ' + config.name.trim();
        this._service = new Service.Switch(this.name.trim(), this.name.trim());
        
        this.isStateful = isStateful;
        this._offDelayTimer = null;

        this._is_on = this.isStateful ? this.occupancySensor.getCachedState('PMS-' + this.name, false) : false;
        this._service.setCharacteristic(Characteristic.On, this._is_on);

        // Fix names getting messed up by iOS 16
        this._service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        this._service.setCharacteristic(Characteristic.ConfiguredName, this.name.trim());

        // Attach to changes
        this._service
            .getCharacteristic(Characteristic.On)
            .on('set', this._internalStateChangeTrigger.bind(this));
    }

    _getIsKeepingOccupancyTriggered() {
        // Overwritten in child classes
        return this._is_on;
    }

    _killOccupancy() {
        this.occupancySensor.locksCounter += 1;
        this.occupancySensor.setOccupancyNotDetected();
        setTimeout(function () {
            this.occupancySensor.checkOccupancy();
            this.occupancySensor.locksCounter -= 1;
        }.bind(this), 10);
    }

    _setOccupancyOn() {
        this.occupancySensor.locksCounter += 1;
        this.occupancySensor.setOccupancyDetected();
        setTimeout(function () {
            this.occupancySensor.checkOccupancy();
            this.occupancySensor.locksCounter -= 1;
        }.bind(this), 10);
    }

    _internalStateChangeTrigger(on, callback) {
        // execute callback
        try {
            callback();
        } catch (error) {
            this.log.debug(`Callback error: BaseHelperSwitch._internalStateChangeTrigger - ${error}`);
        }

        // Determine if the state is different
        const previousOn = this._is_on;

        // Store new state
        if (on != previousOn) {
            this._is_on = on;
        }

        // Handle off switch canceling timer
        this._handleOffDelayTimer(on);

        // Make sure we're actually fully initialized
        if (!this.occupancySensor.initializationCompleted) {
            this.log.debug('Setting ' + this.name + ' initial state and bypassing all events');
            return;
        }

        // Figure out if events should be suppressed
        const suppressEvents = this.occupancySensor.isClearingOccupancy && on == false;

        // Handle specific events
        if (!suppressEvents) {
            this._handleNewState(on, previousOn);
        }

        // Cache our previous state for restoration
        if (on != previousOn && this.isStateful) {
            this.occupancySensor.saveCachedState('PMS-' + this.name, on);
        }
    }

    _handleOffDelayTimer(on) {
        // Cancel if the timer exists first, always
        if (this._offDelayTimer) {
            clearTimeout(this._offDelayTimer);
            this._offDelayTimer = null;
        }
        // Turn on the off delay timer if the switch is on
        if (on && !this.isStateful) {
            this._offDelayTimer = setTimeout(function () {
                this._service.setCharacteristic(Characteristic.On, false);
            }.bind(this), this.occupancySensor.triggerSwitchToggleTimeout);
        }
    }

    _handleNewState(on, previousOn) {
        // Overwritten in child classes
    }
}

class StatefulSwitch extends BaseHelperSwitch {
    constructor(occupancySensor, config) {
        super(occupancySensor, config, true);
        this.stayOnOnly = config.stayOnOnly || false;
    }

    _handleNewState(on, previousOn) {
        const isValidOn = on && (!this.stayOnOnly || this.occupancySensor.modeState != 'Unoccupied');
        if (isValidOn) {
            this._setOccupancyOn();
        }
        if (!on && this.occupancySensor.modeState != 'Unoccupied') {
            this.occupancySensor.checkOccupancy(10);
        }
    }

    _getIsKeepingOccupancyTriggered() {
        return this._is_on && (!this.stayOnOnly || this.occupancySensor.modeState != 'Unoccupied');
    }
}

class TriggerSwitch extends BaseHelperSwitch {
    constructor(occupancySensor, config) {
        super(occupancySensor, config, false);
        this.stayOnOnly = config.stayOnOnly || false;
    }

    _handleNewState(on, previousOn) {
        if (on && (!this.stayOnOnly || this.occupancySensor.modeState != 'Unoccupied')) {
            this._setOccupancyOn();
        }
    }

    _getIsKeepingOccupancyTriggered() {
        return false;
    }
}

class LightSwitchMirrorSwitch extends BaseHelperSwitch {
    constructor(occupancySensor, config) {
        super(occupancySensor, config, true);
        this.wasTheInitialTriggerSwitch = this.occupancySensor.getCachedState('PMS-wasInit-' + this.name, false);

        // Make this switch match the big boi
        this.occupancySensor.occupancyService
            .getCharacteristic(Characteristic.OccupancyDetected)
            .on('set', function (occVal, callback) {
                // execute callback
                try {
                    callback();
                } catch (error) {
                    this.log.debug(`Callback error: LightSwitchMirrorSwitch.constructor - ${error}`);
                }
                const properSwitchState = this.occupancySensor.modeState != 'Unoccupied';
                if (this._is_on != properSwitchState) {
                    this._service.setCharacteristic(Characteristic.On, properSwitchState);
                }
            }.bind(this));
    }

    _handleNewState(on, previousOn) {
        // Figure out if this switch is the reason we're occupied and save that
        if (this.occupancySensor.initializationCompleted && (!on || !previousOn)) {
            this.wasTheInitialTriggerSwitch = on && this.occupancySensor.modeState == 'Unoccupied';
        }
        // Normal on behavior
        if (on && this.occupancySensor.modeState != 'Occupied') {
            this._setOccupancyOn();
        }
        // Handle turning off the whole system with this switch
        if (!on) {
            this._killOccupancy();
        }
        // Save cached state
        this.occupancySensor.saveCachedState('PMS-wasInit-' + this.name, this.wasTheInitialTriggerSwitch);
    }

    _getIsKeepingOccupancyTriggered() {
        return this._is_on && this.wasTheInitialTriggerSwitch;
    }
}

class MasterShutoffSwitch extends BaseHelperSwitch {
    constructor(occupancySensor, config) {
        super(occupancySensor, config, false);
    }

    _handleNewState(on, previousOn) {
        if (on) {
            this._killOccupancy();
        }
    }

    _getIsKeepingOccupancyTriggered() {
        return false;
    }
}
