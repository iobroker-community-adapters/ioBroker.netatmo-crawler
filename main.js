'use strict';

/*
 * Created with @iobroker/create-adapter v1.26.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const url = require('url');
const moment = require('moment');
const request = require('request');
// const { Adapter } = require('@iobroker/adapter-core');

let logger;
let myAdapter;

// Load your modules here, e.g.:
// const fs = require('fs');

class NetatmoCrawler extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'netatmo-crawler',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        logger = this.log;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        myAdapter = this;

        // The adapters config (in the instance object everything under the attribute 'native') is accessible via
        // this.config:
        this.log.debug(`config stationUrls: ${this.config.stationUrls}`);
        this.log.debug(`Going to save station information with: ${this.config.stationNameType}`);
        const regex = /(https:\/\/weathermap\.netatmo\.com\/{1,}[-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
        const stationUrls = this.config.stationUrls.match(regex) || [];

        if (!stationUrls.length) {
            this.log.warn(`no valid station urls detected at ${this.config.stationUrls}`);
        }

        try {
            let token = await this.getAuthorizationToken(this);
            for (const [counter, stationUrl] of stationUrls.entries()) {
                this.log.debug(`Working with stationUrl: ${stationUrl}`);
                if (stationUrl) {
                    try {
                        await this.getStationData(counter + 1, stationUrl, token, this.config.stationNameType);
                    } catch (e) {
                        this.log.warn(`Could not work with station ${counter + 1} - Message: ${e}`);
                    }
                }
            }
            this.log.debug('all done, exiting');
            this.terminate
                ? this.terminate('Everything done. Going to terminate till next schedule', 0)
                : process.exit(0);
        } catch (e) {
            // if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
            //     const sentryInstance = this.getPluginInstance('sentry');
            //     if (sentryInstance) {
            //         sentryInstance.getSentryObject().captureException(e);
            //     }
            // }
            this.log.error(`Error while running Netatmo Crawler. Error Message:${e}`);
            this.log.debug('all done, exiting');
            this.terminate ? this.terminate(15) : process.exit(15);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

            callback();
        } catch {
            callback();
        }
    }

    async getStationData(id, url, token, stationNameType) {
        logger.debug(`Going to get information for station: ${id}`);
        let stationid = this.getStationId(url);
        let stationData = await this.getPublicData(stationid, token);
        if (!stationData) {
            logger.info('Got no station data. Trying again');
            await this.sleep(1000);
            stationData = await this.getPublicData(stationid, token);
        }
        if (stationData && stationData.measures) {
            logger.debug(`Saving station data for station: ${id}`);
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

            for (const measure of measureTypes) {
                if (this.hasMeasure(stationData.measures, measure)) {
                    logger.debug(`Saving data for station: ${id} and measure: ${measure}`);
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

                    if (measure === 'rain') {
                        let startOfDay = moment().startOf('day');
                        if (startOfDay.add(15, 'minutes').isBefore(moment())) {
                            let rainToday = await this.getRainToday(stationData.measures, stationid, token);
                            if (rainToday == null) {
                                await this.sleep(1000);
                                rainToday = await this.getRainToday(stationData.measures, stationid, token);
                            }
                            if (rainToday != null) {
                                await this.saveMeasure(id, 'rain_today', rainToday);
                                logger.debug(`Saved rain_today for station: ${id}`);
                                await this.saveMeasure(id, 'lastUpdated.rain_today', moment().valueOf());
                            }
                        } else {
                            logger.debug('Not getting rain today, because it is start of a new day');
                        }
                        let rainYesterday = await this.getRainYesterday(stationData.measures, stationid, token);
                        if (rainYesterday == null) {
                            await this.sleep(1000);
                            rainYesterday = await this.getRainYesterday(stationData.measures, stationid, token);
                        }
                        if (rainYesterday != null) {
                            await this.saveMeasure(id, 'rain_yesterday', rainYesterday);
                            logger.debug(`Saved rain_yesterday for station: ${id}`);
                            await this.saveMeasure(id, 'lastUpdated.rain_yesterday', moment().valueOf());
                        }
                        let rainLastHour = await this.getRainLastHour(stationData.measures, stationid, token);
                        if (rainLastHour == null) {
                            await this.sleep(1000);
                            rainLastHour = await this.getRainLastHour(stationData.measures, stationid, token);
                        }
                        if (rainLastHour != null) {
                            await this.saveMeasure(id, 'rain_lastHour', rainLastHour);
                            logger.debug(`Saved rain_lastHour for station: ${id}`);
                            await this.saveMeasure(id, 'lastUpdated.rain_lastHour', moment().valueOf());
                        }
                    }
                }
            }
        } else {
            throw `Did not get any values for station ${stationid}`;
        }
    }

    async saveStationData(id, stationData) {
        await this.saveMeasure(id, 'info.stationId', stationData['_id']);
        await this.saveMeasure(id, 'info.city', stationData['place']['city']);
        await this.saveMeasure(id, 'info.country', stationData['place']['country']);
        await this.saveMeasure(id, 'info.street', stationData['place']['street']);
        await this.saveMeasure(id, 'info.lastInfoRetrieved', moment().valueOf());
    }

    async saveMeasure(id, measureName, measureValue) {
        if (measureValue !== null) {
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
            await this.setStateAsync(stateName, measureValue, true);
        }
    }

    async saveTimestamp(id, measureName, timestamp) {
        if (timestamp !== null) {
            const stateName = `stationData.${id}.lastUpdated.${measureName}`;
            await this.createOwnState(stateName, null, 'number', 'date');
            timestamp = Number.parseInt(timestamp) * 1000;
            await this.setStateAsync(stateName, timestamp, true);
        }
    }

    async createOwnState(stateName, unit, type, role) {
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
        await this.setStateAsync(name, value, true);
    }

    getAuthorizationToken(adapter) {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (res, rej) => {
            const tokenState = 'common.authorisationToken';
            logger.debug('Trying to get token from state');
            let token = await adapter.getStateAsync(tokenState);
            let foundToken = false;
            if (token && null !== token.val) {
                const now = new Date().getTime();
                if (now < token.ts + 86400 * 1000) {
                    //logger.debug('Token is fresh, using it. Now:' + now + ' Token Timestamp: ' + token.ts + ' Token calculated: ' + (token.ts + 86400 * 1000));
                    foundToken = true;
                    res(token.val);
                }
            }
            if (!foundToken) {
                logger.debug('Found no token in state, going to get it from website');
                request(
                    {
                        url: 'https://auth.netatmo.com/weathermap/token',
                        headers: {
                            'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8,en-US;q=0.7',
                            'User-Agent': 'Mozilla/5.0',
                        },
                        rejectUnauthorized: false,
                    },

                    async function (error, response, body) {
                        if (error) {
                            rej(error);
                        }
                        //logger.debug('Body:' + body);

                        if (!body) {
                            await adapter.saveState(tokenState, null);
                            rej('No body for authorization token found.');
                        }
                        try {
                            logger.debug(`Body:${body}`);
                            const innerBody = JSON.parse(body);
                            if (innerBody && innerBody.body) {
                                const token = `Bearer ${innerBody.body}`;
                                logger.debug(`Token:${token}`);
                                await adapter.saveState(tokenState, token);
                                res(token);
                            } else {
                                rej('No authorization token found');
                            }
                        } catch (e) {
                            rej(`Could not load page to get authorization token: ${e}`);
                        }
                    },
                );
            }
        });
    }

    getPublicData(stationId, token) {
        return new Promise((res, rej) => {
            logger.info(`Getting data for stationid:${stationId}`);
            request.post(
                {
                    url: 'https://app.netatmo.net/api/getpublicmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: {
                        device_id: stationId,
                    },
                },
                async function (error, response, body) {
                    if (error) {
                        rej(error);
                    }
                    if (body && body.body) {
                        logger.debug(`Body:${JSON.stringify(body.body)}`);

                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        try {
                            res(body.body[0]);
                        } catch (e) {
                            logger.warn(`Could not get Data for station ${stationId}: ${e}`);
                            res('');
                        }
                        //res(body)
                    } else {
                        logger.info(`No body:${JSON.stringify(body)}`);
                        if (body && body.error && body.error.code === 2) {
                            logger.debug('Accesstoken is invalid. Going to reset state');
                            await myAdapter.saveState('common.authorisationToken', null);
                        }
                        res('');
                    }
                },
            );
        });
    }

    hasMeasure(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return measures[key].type.indexOf(measureName) !== -1;
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            return true;
        }
        return false;
    }

    getMeasureValue(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return measures[key].type.indexOf(measureName) !== -1;
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            let measureIndex = measures[measureKey[0]].type.indexOf(measureName);
            const measureValues = measures[measureKey[0]].res[Object.keys(measures[measureKey[0]].res)[0]];
            const measureValue = measureValues[measureIndex];
            return measureValue;
        }
        return null;
    }

    getMeasureTimestamp(measures, measureName) {
        let measureKey = Object.keys(measures).filter(key => {
            return measures[key].type.indexOf(measureName) !== -1;
        });

        if (Array.isArray(measureKey) && measureKey.length > 0) {
            let res = measures[measureKey[0]].res;
            let timeStamp = Object.keys(res)[0];
            return timeStamp;
        }
        return null;
    }

    getRainToday(measures, stationId, token) {
        return new Promise((res, rej) => {
            //console.log('Getting data for stationid:' + stationId);
            var start = moment().startOf('day').unix();
            const moduleId = Object.keys(measures).filter(key => {
                return measures[key].type.indexOf('rain') !== -1;
            })[0];
            const inputObj = {
                device_id: stationId,
                module_id: moduleId,
                scale: '1day',
                type: 'sum_rain',
                real_time: true,
                date_begin: start.toString(),
            };
            //console.log('InputObj:' + JSON.stringify(inputObj));
            request.post(
                {
                    url: 'https://app.netatmo.net/api/getmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: inputObj,
                },
                async function (error, response, body) {
                    if (error) {
                        rej(error);
                    }
                    logger.debug(`Body Rain_Today:${JSON.stringify(body)}`);
                    if (body && body.body) {
                        if (!body.body[0] || !body.body[0].value) {
                            logger.debug(`No rain today value for Station ${stationId}`);
                            res('');
                        }
                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        try {
                            const rainToday = body.body[0].value[0][0];
                            logger.debug(`Rain Today for Station ${stationId} is: ${rainToday}`);
                            res(rainToday);
                        } catch (e) {
                            logger.info(`Could not get Rain Today for station ${stationId}: ${e}`);
                            res('');
                        }
                        //res(body)
                    } else {
                        logger.info(`No body in Rain_Today:${JSON.stringify(body)}`);
                        res('');
                    }
                },
            );
        });
    }

    getRainYesterday(measures, stationId, token) {
        return new Promise((res, rej) => {
            //console.log('Getting data for stationid:' + stationId);
            var start = moment().subtract(1, 'days').startOf('day').unix();
            var end = moment().subtract(1, 'days').endOf('day').unix();
            const moduleId = Object.keys(measures).filter(key => {
                return measures[key].type.indexOf('rain') !== -1;
            })[0];
            const inputObj = {
                device_id: stationId,
                module_id: moduleId,
                scale: '1day',
                type: 'sum_rain',
                real_time: true,
                date_begin: start.toString(),
                date_end: end.toString(),
            };
            //console.log('InputObj:' + JSON.stringify(inputObj));
            request.post(
                {
                    url: 'https://app.netatmo.net/api/getmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: inputObj,
                },
                async function (error, response, body) {
                    if (error) {
                        rej(error);
                    }
                    if (body && body.body) {
                        logger.debug(`Body Rain_Yesterday:${JSON.stringify(body.body)}`);

                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        try {
                            const rainYesterday = body.body[0].value[0][0];
                            logger.debug(`Rain Yesterday for Station ${stationId} is: ${rainYesterday}`);
                            res(rainYesterday);
                        } catch (e) {
                            logger.info(`Could not get Rain Yesterday for station ${stationId}: ${e}`);
                            res('');
                        }
                        //res(body)
                    } else {
                        logger.info(`No body in Rain_Yesterday:${JSON.stringify(body)}`);
                        res('');
                    }
                },
            );
        });
    }

    getRainLastHour(measures, stationId, token) {
        return new Promise((res, rej) => {
            //console.log('Getting data for stationid:' + stationId);
            var start = moment().subtract(1, 'hour').unix();
            var end = moment().unix();
            const moduleId = Object.keys(measures).filter(key => {
                return measures[key].type.indexOf('rain') !== -1;
            })[0];
            const inputObj = {
                device_id: stationId,
                module_id: moduleId,
                scale: '1hour',
                type: 'sum_rain',
                real_time: true,
                date_begin: start.toString(),
                date_end: end.toString(),
            };
            //console.log('InputObj:' + JSON.stringify(inputObj));
            request.post(
                {
                    url: 'https://app.netatmo.net/api/getmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: inputObj,
                },
                async function (error, response, body) {
                    if (error) {
                        rej(error);
                    }
                    if (body && body.body) {
                        logger.debug(`Body Rain_LastHour:${JSON.stringify(body.body)}`);

                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        try {
                            const rainLastHour = body.body[0].value[0][0];
                            logger.debug(`Rain Last Hour for Station ${stationId} is: ${rainLastHour}`);
                            res(rainLastHour);
                        } catch (e) {
                            logger.info(`Could not get Rain LastHour for station ${stationId}: ${e}`);
                            res('');
                        }
                        //res(body)
                    } else {
                        logger.info(`No body in Rain_LastHour:${JSON.stringify(body)}`);
                        res('');
                    }
                },
            );
        });
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
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    roundValue(val) {
        const roundedVal = Math.round(val * 100) / 100;
        logger.debug(`Rounded value ${val} to ${roundedVal}`);
        return roundedVal;
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new NetatmoCrawler(options);
} else {
    // otherwise start the instance directly
    new NetatmoCrawler();
}
