'use strict';

/*
 * Created with @iobroker/create-adapter v1.26.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const url = require('node:url');
const moment = require('moment');
const request = require('request');
const { RequestClient, describeError, isNetworkError } = require('./lib/request-client');
// const { Adapter } = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require('node:fs');

class NetatmoCrawler extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] Adapter startup options.
     */
    constructor(options) {
        super({
            ...options,
            name: 'netatmo-crawler',
        });
        this.client = new RequestClient(request);
        this.token = null;
        this.tokenRefreshAttempted = false;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('objectChange', this.onInstanceChange.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // The adapters config (in the instance object everything under the attribute 'native') is accessible via
        // this.config:
        this.log.debug(`config stationUrls: ${this.config.stationUrls}`);
        this.log.debug(`Going to save station information with: ${this.config.stationNameType}`);
        const regex = /(https:\/\/weathermap\.netatmo\.com\/{1,}[-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
        const stationUrls = this.config.stationUrls.match(regex) || [];

        if (!stationUrls.length) {
            this.log.warn(`no valid station urls detected at ${this.config.stationUrls}`);
        }

        let succeeded = 0;
        let failed = 0;
        try {
            const instanceId = `system.adapter.${this.namespace}`;
            await this.subscribeForeignObjectsAsync(instanceId);
            // Scheduled instances are not signalled by the controller when disabled.
            // Subscribe before reading to cover disabling during startup as well.
            this.onInstanceChange(instanceId, await this.getForeignObjectAsync(instanceId));
            this.client.checkRunning();
            const token = stationUrls.length ? await this.getAuthorizationToken() : null;
            for (const [counter, stationUrl] of stationUrls.entries()) {
                this.client.checkRunning();
                try {
                    await this.getStationData(counter + 1, stationUrl, token, this.config.stationNameType);
                    succeeded++;
                } catch (error) {
                    this.client.checkRunning();
                    failed++;
                    this.log.warn(`Could not work with station ${counter + 1}: ${describeError(error)}`);
                }
            }
            this.client.checkRunning();
            const summary = `Run finished: ${succeeded} station(s) updated, ${failed} failed. Waiting for next schedule.`;
            if (failed) {
                this.log.warn(summary);
            }
            this.terminate ? this.terminate(summary, 0) : process.exit(0);
        } catch (error) {
            if (this.client.stopped) {
                return;
            }
            const networkError = isNetworkError(error);
            if (networkError) {
                this.log.warn(`Could not retrieve new Netatmo data due to a network problem: ${describeError(error)}`);
            } else {
                this.log.error(`Netatmo run failed: ${describeError(error)}`);
            }
            const exitCode = networkError ? 0 : 15;
            this.terminate
                ? this.terminate('Netatmo run failed; no complete update', exitCode)
                : process.exit(exitCode);
        }
    }

    /**
     * Stop a scheduled run when its instance is disabled or deleted.
     *
     * @param {string} id Changed object ID.
     * @param {ioBroker.Object | null | undefined} obj Changed instance configuration.
     */
    onInstanceChange(id, obj) {
        if (id === `system.adapter.${this.namespace}` && (!obj || obj.common.enabled === false)) {
            if (this.client.stopped) {
                return;
            }
            this.client.stop();
            this.terminate('Instance disabled; pending requests cancelled', 0);
        }
    }

    /**
     * Cancel requests and retry delays when ioBroker stops the instance.
     *
     * @param {() => void} callback ioBroker shutdown completion callback.
     */
    onUnload(callback) {
        try {
            this.client.stop();
        } finally {
            callback();
        }
    }

    async getStationData(id, url, token, stationNameType) {
        this.log.debug(`Going to get information for station: ${id}`);
        let stationid = this.getStationId(url);
        let stationData = await this.getPublicData(stationid, token);
        if (!stationData) {
            this.log.info('Got no station data. Trying again');
            await this.sleep(1000);
            stationData = await this.getPublicData(stationid, token);
        }
        if (stationData && stationData.measures) {
            this.log.debug(`Saving station data for station: ${id}`);
            if (stationNameType === 'id') {
                id = stationid;
            }
            await this.saveStationData(id, stationData);

            const measureTypes = [
                'temperature',
                'rain',
                'pressure',
                'humidity',
                'windangle',
                'guststrength',
                'windstrength',
            ];

            let savedMeasurements = 0;
            for (const measure of measureTypes) {
                if (this.hasMeasure(stationData.measures, measure)) {
                    if (this.getMeasureValue(stationData.measures, measure) === null) {
                        continue;
                    }
                    this.log.debug(`Saving data for station: ${id} and measure: ${measure}`);
                    let measureLastUpdated = this.getMeasureTimestamp(stationData.measures, measure);
                    if (measureLastUpdated) {
                        await this.saveTimestamp(id, measure, measureLastUpdated);
                    }
                    if (measure === 'windangle') {
                        await this.saveMeasure(
                            id,
                            measure,
                            this.getWindrichtungsName(this.getMeasureValue(stationData.measures, measure)),
                        );
                    } else if (measure === 'guststrength' || measure === 'windstrength') {
                        await this.saveMeasure(id, measure, this.getMeasureValue(stationData.measures, measure));
                        await this.saveMeasure(id, `${measure}2`, this.getMeasureValue(stationData.measures, measure));
                    } else {
                        await this.saveMeasure(id, measure, this.getMeasureValue(stationData.measures, measure));
                    }
                    savedMeasurements++;
                }
            }
            if (!savedMeasurements) {
                throw new Error(`No valid measurements for station ${stationid}`);
            }
            if (this.hasMeasure(stationData.measures, 'rain')) {
                let startOfDay = moment().startOf('day');
                if (startOfDay.add(15, 'minutes').isBefore(moment())) {
                    let rainToday = await this.getRainToday(stationData.measures, stationid, token);
                    if (rainToday == null) {
                        await this.sleep(1000);
                        rainToday = await this.getRainToday(stationData.measures, stationid, token);
                    }
                    if (rainToday != null) {
                        await this.saveMeasure(id, 'rain_today', rainToday);
                        this.log.debug(`Saved rain_today for station: ${id}`);
                        await this.saveMeasure(id, 'lastUpdated.rain_today', moment().valueOf());
                    }
                } else {
                    this.log.debug('Not getting rain today, because it is start of a new day');
                }
                let rainYesterday = await this.getRainYesterday(stationData.measures, stationid, token);
                if (rainYesterday == null) {
                    await this.sleep(1000);
                    rainYesterday = await this.getRainYesterday(stationData.measures, stationid, token);
                }
                if (rainYesterday != null) {
                    await this.saveMeasure(id, 'rain_yesterday', rainYesterday);
                    this.log.debug(`Saved rain_yesterday for station: ${id}`);
                    await this.saveMeasure(id, 'lastUpdated.rain_yesterday', moment().valueOf());
                }
                let rainLastHour = await this.getRainLastHour(stationData.measures, stationid, token);
                if (rainLastHour == null) {
                    await this.sleep(1000);
                    rainLastHour = await this.getRainLastHour(stationData.measures, stationid, token);
                }
                if (rainLastHour != null) {
                    await this.saveMeasure(id, 'rain_lastHour', rainLastHour);
                    this.log.debug(`Saved rain_lastHour for station: ${id}`);
                    await this.saveMeasure(id, 'lastUpdated.rain_lastHour', moment().valueOf());
                }
            }
        } else {
            throw `Did not get any values for station ${stationid}`;
        }
    }

    async saveStationData(id, stationData) {
        await this.saveMeasure(id, 'info.stationId', stationData['_id']);
        await this.saveMeasure(id, 'info.city', stationData.place?.city);
        await this.saveMeasure(id, 'info.country', stationData.place?.country);
        await this.saveMeasure(id, 'info.street', stationData.place?.street);
        await this.saveMeasure(id, 'info.lastInfoRetrieved', moment().valueOf());
    }

    async saveMeasure(id, measureName, measureValue) {
        this.client.checkRunning();
        if (measureValue !== null && measureValue !== undefined) {
            const stateName = `stationData.${id}.${measureName}`;
            let roundValue = false;
            switch (measureName) {
                case 'rain':
                    await this.createOwnState(stateName, 'mm', 'number', 'value.rain.hour');
                    roundValue = true;
                    break;
                case 'rain_today':
                    await this.createOwnState(stateName, 'mm', 'number', 'value.rain.today');
                    roundValue = true;
                    break;
                case 'rain_yesterday':
                    await this.createOwnState(stateName, 'mm', 'number', 'value');
                    roundValue = true;
                    break;
                case 'rain_lastHour':
                    await this.createOwnState(stateName, 'mm', 'number', 'value.rain.hour');
                    roundValue = true;
                    break;
                case 'pressure':
                    await this.createOwnState(stateName, 'mBar', 'number', 'value.pressure');
                    roundValue = true;
                    break;
                case 'temperature':
                    await this.createOwnState(stateName, '°C', 'number', 'value.temperature');
                    roundValue = true;
                    break;
                case 'humidity':
                    await this.createOwnState(stateName, '%', 'number', 'value.humidity');
                    roundValue = true;
                    break;
                case 'windangle':
                    await this.createOwnState(stateName, null, 'string', 'weather.direction.wind ');
                    break;
                case 'windstrength':
                    await this.createOwnState(stateName, 'km/h', 'number', 'value.speed.wind');
                    roundValue = true;
                    break;
                case 'windstrength2':
                    await this.createOwnState(stateName, 'm/s', 'number', 'value.speed.wind');
                    measureValue = (measureValue * 1000) / 3600;
                    roundValue = true;
                    break;
                case 'guststrength':
                    await this.createOwnState(stateName, 'km/h', 'number', 'value.speed.wind.gust');
                    roundValue = true;
                    break;
                case 'guststrength2':
                    await this.createOwnState(stateName, 'm/s', 'number', 'value.speed.wind.gust');
                    measureValue = (measureValue * 1000) / 3600;
                    roundValue = true;
                    break;
                case 'info.lastInfoRetrieved':
                    await this.createOwnState(stateName, null, 'number', 'date');
                    break;
                default:
                    if (measureName.startsWith('lastUpdated')) {
                        await this.createOwnState(stateName, null, 'number', 'date');
                    } else {
                        await this.createOwnState(stateName, null, 'string', 'text');
                    }
                    break;
            }
            if (roundValue) {
                measureValue = this.roundValue(measureValue);
            }
            this.client.checkRunning();
            await this.setStateAsync(stateName, measureValue, true);
        }
    }

    async saveTimestamp(id, measureName, timestamp) {
        if (timestamp != null && Number.isFinite(Number(timestamp))) {
            const stateName = `stationData.${id}.lastUpdated.${measureName}`;
            await this.createOwnState(stateName, null, 'number', 'date');
            timestamp = Number.parseInt(timestamp) * 1000;
            this.client.checkRunning();
            await this.setStateAsync(stateName, timestamp, true);
        }
    }

    async createOwnState(stateName, unit, type, role) {
        this.client.checkRunning();
        await this.setObjectNotExistsAsync(stateName, {
            type: 'state',
            common: {
                name: stateName,
                type: type,
                role: role,
                read: true,
                write: false,
                unit: unit,
            },
            native: {},
        });
    }

    getStationId(u) {
        const queryParams = url.parse(u, true).query;
        const stationId = queryParams['stationid'];
        return stationId;
    }

    async saveState(name, value) {
        await this.createOwnState(name, null, 'string', 'text');
        this.client.checkRunning();
        await this.setStateAsync(name, value, true);
    }

    async getAuthorizationToken(force = false) {
        this.client.checkRunning();
        const tokenState = 'common.authorisationToken';
        if (!force) {
            const cached = await this.getStateAsync(tokenState);
            if (typeof cached?.val === 'string' && cached.val && Date.now() < cached.ts + 86400000) {
                this.token = cached.val;
                return this.token;
            }
        }
        const { body } = await this.client.send({
            url: 'https://auth.netatmo.com/weathermap/token',
            headers: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8,en-US;q=0.7', 'User-Agent': 'Mozilla/5.0' },
        });
        const data = typeof body === 'string' ? JSON.parse(body) : body;
        if (typeof data?.body !== 'string' || !data.body) {
            throw new Error('No authorization token found');
        }
        this.token = `Bearer ${data.body}`;
        await this.saveState(tokenState, this.token);
        return this.token;
    }

    async apiRequest(endpoint, payload, token) {
        for (;;) {
            this.client.checkRunning();
            if (this.tokenRefreshAttempted && !this.token) {
                throw new Error('No valid access token after refresh attempt');
            }
            const { body, statusCode } = await this.client.send(
                {
                    method: 'POST',
                    url: `https://app.netatmo.net/api/${endpoint}`,
                    headers: { Authorization: this.token || token },
                    json: payload,
                },
                true,
            );
            if (statusCode === 401 || body?.error?.code === 2) {
                this.token = null;
                await this.saveState('common.authorisationToken', null);
                if (this.tokenRefreshAttempted) {
                    throw new Error('Invalid access token after refresh attempt');
                }
                this.tokenRefreshAttempted = true;
                this.log.info('Access token invalid; refreshing once for this run');
                await this.getAuthorizationToken(true);
                continue;
            }
            if (statusCode < 200 || statusCode >= 300) {
                throw new Error(`Netatmo HTTP ${statusCode}`);
            }
            if (body?.error) {
                throw new Error(`Netatmo API error ${body.error.code}`);
            }
            return body?.body;
        }
    }

    async getPublicData(stationId, token) {
        this.log.info(`Getting data for stationid:${stationId}`);
        const body = await this.apiRequest('getpublicmeasure', { device_id: stationId }, token);
        this.log.debug(`Body:${JSON.stringify(body)}`);
        return Array.isArray(body) ? body[0] : null;
    }

    hasMeasure(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return Array.isArray(measures[key]?.type) && measures[key].type.includes(measureName);
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            return true;
        }
        return false;
    }

    getMeasureValue(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return Array.isArray(measures[key]?.type) && measures[key].type.includes(measureName);
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            let measureIndex = measures[measureKey[0]].type.indexOf(measureName);
            const results = measures[measureKey[0]].res || {};
            const measureValues = results[Object.keys(results)[0]];
            const measureValue = measureValues?.[measureIndex];
            return typeof measureValue === 'number' && Number.isFinite(measureValue) ? measureValue : null;
        }
        return null;
    }

    getMeasureTimestamp(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return Array.isArray(measures[key]?.type) && measures[key].type.includes(measureName);
        });

        if (Array.isArray(measureKey) && measureKey.length > 0) {
            let res = measures[measureKey[0]].res || {};
            let timeStamp = Object.keys(res)[0];
            return timeStamp;
        }
        return null;
    }

    async getRainValue(measures, stationId, token, scale, start, end) {
        const moduleId = Object.keys(measures).find(key => measures[key]?.type?.includes('rain'));
        if (!moduleId) {
            return null;
        }
        const payload = {
            device_id: stationId,
            module_id: moduleId,
            scale,
            type: 'sum_rain',
            real_time: true,
            date_begin: start.toString(),
            ...(end === undefined ? {} : { date_end: end.toString() }),
        };
        const body = await this.apiRequest('getmeasure', payload, token);
        const value = body?.[0]?.value?.[0]?.[0];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    getRainToday(measures, stationId, token) {
        return this.getRainValue(measures, stationId, token, '1day', moment().startOf('day').unix());
    }

    getRainYesterday(measures, stationId, token) {
        return this.getRainValue(
            measures,
            stationId,
            token,
            '1day',
            moment().subtract(1, 'days').startOf('day').unix(),
            moment().subtract(1, 'days').endOf('day').unix(),
        );
    }

    getRainLastHour(measures, stationId, token) {
        return this.getRainValue(
            measures,
            stationId,
            token,
            '1hour',
            moment().subtract(1, 'hour').unix(),
            moment().unix(),
        );
    }

    getWindrichtungsName(value) {
        if (value === -1) {
            return 'calm';
        }
        if (value < 22.5 || value >= 337.5) {
            return 'N';
        }
        if (value < 67.5 && value >= 22.5) {
            return 'NE';
        }
        if (value < 125.5 && value >= 67.5) {
            return 'E';
        }
        if (value < 157.5 && value >= 125.5) {
            return 'SE';
        }
        if (value < 202.5 && value >= 157.5) {
            return 'S';
        }
        if (value < 247.5 && value >= 202.5) {
            return 'SW';
        }
        if (value < 292.5 && value >= 247.5) {
            return 'W';
        }
        if (value < 337.5 && value >= 292.5) {
            return 'NW';
        }
        return 'unknown';
    }

    sleep(ms) {
        return this.client.sleep(ms);
    }

    roundValue(val) {
        const roundedVal = Math.round(val * 100) / 100;
        this.log.debug(`Rounded value ${val} to ${roundedVal}`);
        return roundedVal;
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] Adapter startup options.
     */
    module.exports = options => new NetatmoCrawler(options);
} else {
    // otherwise start the instance directly
    new NetatmoCrawler();
}
