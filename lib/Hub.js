'use strict';

const dgram           = require('dgram');
const util            = require('util');
const EventEmitter    = require('events').EventEmitter;
const crypto          = require('crypto');
const Devices         = require('./devices');

function Hub(options) {
    if (!(this instanceof Hub)) return new Hub(options);

    options = options || {};
    options.port = parseInt(options.port, 10) || 9898;
    
    this.sensors = {};

    this.key     = options.key;
    this.keys    = {};
    this.token   = {};
    this.iv      = Buffer.from([0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28, 0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58, 0x56, 0x2e]);

    if (options.keys) {
        for (let i = 0; i < options.keys.length; i++) {
            this.keys[options.keys[i].ip] = options.keys[i].key;
        }
    }

    /* this.clickTypes = {
        click:              'click',
        double_click:       'double_click',
        long_click_press:   'long_click_press',
        long_click_release: 'long_click_release'
    }; */

    this.listen = function () {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', this.onMessage.bind(this));
        this.socket.on('error', this.onError.bind(this));
        this.socket.on('listening', this.onListening.bind(this));
        this.socket.bind(options.port);
    };

    this.stop = function (cb) {
        if (this._state === 'CLOSED') return false;
        this._state = 'CLOSED';

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.close(cb);
                this.socket = null;
            } catch (e) {
                cb && cb();
            }
        } else {
            cb && cb();
        }
    };

    this.onListening = function () {
        this._state = 'CONNECTED';
        this.socket.setBroadcast(true);
        this.socket.setMulticastTTL(128);
        if (options.bind && options.bind !== '0.0.0.0') {
            this.socket.addMembership('224.0.0.50', options.bind);
        } else {
            this.socket.addMembership('224.0.0.50');
        }
        const whoIsCommand = '{"cmd": "whois"}';
        this.socket.send(whoIsCommand, 0, whoIsCommand.length, 4321, '224.0.0.50');
    };

    this.onError = function (err) {
        if (this._state === 'CLOSED') return false;
        this.emit('error', err);
    };

    this.onMessage = function (msgBuffer, rinfo) {
        if (this._state === 'CLOSED') return false;
        let msg;
        try {
            msg = JSON.parse(msgBuffer.toString());
        }
        catch (e) {
            return;
        }

        let sensor = this.getSensor(msg.sid);
        if (!sensor) {
            // {"model":"lumi.lock.v1","did":"lumi.1xxxxxxxxxxxxx8","name":"Front door lock"}
            if (!msg.model) {
                return;
            }
            try {
                if (options.browse) {
                    if (msg.model === 'gateway') {
                        this.emit('browse', {ip: rinfo.address});
                    }
                    return;
                } else {
                    sensor = this.sensorFactory(msg.sid, msg.model, rinfo.address, msg.name);
                }
            }
            catch (e) {
                this.emit('warning', 'Could not add new sensor: ' + e.message);
                return;
            }
        }
        
        if (sensor) {
            if (msg.data && typeof msg.data === 'string') {
                try {
                    msg.data = JSON.parse(msg.data);
                } catch (e) {
                    this.emit('warning', 'Could not parse: ' + msg.data);
                    msg.data = null;
                }
            }
            if (msg.token) {
                this.token[rinfo.address] = msg.token;
            }

            if (msg.cmd === 'heartbeat') {
                sensor.heartBeat(msg.token, msg.data);
            } else {
                sensor.heartBeat();
            }

            if (msg.data && (msg.cmd === 'report' || msg.cmd.indexOf('_ack') !== -1)) {
                sensor.onMessage(msg);
            }
        }
        
        this.emit('message', msg);
    };

    this.getKey = function (ip) {
        if (!this.token[ip]) return null;
        const key = this.keys[ip] || this.key;
        const cipher = crypto.createCipheriv('aes-128-cbc', key, this.iv);
        const crypted = cipher.update(this.token[ip], 'ascii', 'hex');
        cipher.final('hex'); // Useless data, don't know why yet.
        return crypted;
    };

    this.sendMessage = function (message, ip) {
        if (this._state === 'CLOSED') return false;
        const json = JSON.stringify(message);
        this.socket.send(json, 0, json.length, options.port, ip || '224.0.0.50');
    };

    this.sensorFactory = function (sid, model, ip, name) {
        if (this._state === 'CLOSED') return false;
        let sensor = null;
        const dev = Object.keys(Devices).find(id => Devices[id].type === model);

        if (Devices[dev] && Devices[dev].ClassName) {
            sensor = new Devices[dev].ClassName(sid, ip, this, model, options);
        } else {
            throw new Error('Type "' + model + '" is not valid, use one of  Hub::sensorTypes');
        }
        this.registerSensor(sensor, name);
        return sensor;
    };
    this.getSensor = function (sid) {
        return this.sensors[sid] || null;
    };
    this.registerSensor = function (sensor, name) {
        if (this._state === 'CLOSED') return false;
        this.emit('device', sensor, name);
        this.sensors[sensor.sid] = sensor;
    };
    
    return this;
}

// extend the EventEmitter class using our Radio class
util.inherits(Hub, EventEmitter);

module.exports = {
    Hub,
    Devices
};