'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moment = require('moment');
const { RequestClient, describeError } = require('./lib/request-client');
const stations = require('./test/fixtures/stations.json');
const source = fs.readFileSync(require('node:path').join(__dirname, 'main.js'), 'utf8');

function setup(responder = () => ({ body: [] }), fixtures = stations) {
    const requests = [],
        handles = [],
        logs = [],
        states = new Map(),
        objects = new Map();
    const transport = (options, callback) => {
        requests.push(options);
        const handle = {
            aborted: false,
            abort() {
                this.aborted = true;
            },
        };
        handles.push(handle);
        queueMicrotask(() => {
            if (handle.aborted) return;
            const result = responder(options);
            if (result === 'hang') return;
            if (result instanceof Error) return callback(result);
            callback(null, { statusCode: result.statusCode || 200 }, result);
        });
        return handle;
    };
    class Adapter {
        constructor() {
            this.namespace = 'netatmo-crawler.0';
            this.config = {
                stationUrls: fixtures.map(s => `https://weathermap.netatmo.com/?stationid=${s._id}`).join('\n'),
                stationNameType: 'counter',
            };
            this.log = Object.fromEntries(
                ['debug', 'info', 'warn', 'error'].map(level => [level, text => logs.push({ level, text })]),
            );
        }
        on() {}
        async subscribeForeignObjectsAsync() {}
        async getForeignObjectAsync() {
            return { common: { enabled: true } };
        }
        async getStateAsync() {
            return { val: 'Bearer old', ts: Date.now() };
        }
        async setObjectNotExistsAsync(id, obj) {
            objects.set(id, obj);
        }
        async setStateAsync(id, value) {
            assert.notEqual(value, undefined);
            if (objects.get(id)?.common.type === 'number') assert(Number.isFinite(value));
            states.set(id, value);
        }
        terminate(message, code) {
            this.exit = { message, code };
        }
    }
    const sandbox = {
        module: { parent: true, exports: {} },
        require(name) {
            if (name === '@iobroker/adapter-core') return { Adapter };
            if (name === 'moment') return () => moment.utc('2026-10-12T12:00:00Z');
            if (name === 'request') return transport;
            return require(name);
        },
    };
    vm.runInNewContext(source, sandbox, { filename: 'main.js' });
    return { adapter: sandbox.module.exports(), requests, handles, logs, states, objects };
}
function success(o) {
    return o.url.endsWith('getpublicmeasure')
        ? { body: [stations.find(s => s._id === o.json.device_id)] }
        : { body: [{ value: [[0]] }] };
}

describe('Netatmo regression tests', () => {
    for (const code of [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ESOCKETTIMEDOUT',
        'ETIMEDOUT',
    ]) {
        it(`warns and exits normally for ${code} during token retrieval`, async () => {
            const t = setup(() => Object.assign(new Error('network failure'), { code }));
            t.adapter.getStateAsync = async () => null;
            await t.adapter.onReady();
            assert.equal(t.adapter.exit.code, 0);
            assert(t.logs.some(l => l.level === 'warn' && l.text.includes(code)));
            assert(!t.logs.some(l => l.level === 'error'));
            assert.equal(t.requests.length, 1);
        });
    }
    it('treats its own token request deadline as an expected network failure', async () => {
        const t = setup(() => 'hang');
        t.adapter.getStateAsync = async () => null;
        t.adapter.client.timeout = 10;
        await t.adapter.onReady();
        assert.equal(t.adapter.exit.code, 0);
        assert(t.handles[0].aborted);
        assert(t.logs.some(l => l.level === 'warn' && l.text.includes('ETIMEDOUT')));
        assert(!t.logs.some(l => l.level === 'error'));
    });
    it('handles aggregated connection failures without hiding mixed programming errors', async () => {
        const network = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
        for (const [error, exitCode] of [
            [new AggregateError([network]), 0],
            [new AggregateError([network, new TypeError('bug')]), 15],
            [new AggregateError([]), 15],
            [new TypeError('unexpected response'), 15],
            [Object.assign(new Error('unknown'), { code: 'UNKNOWN' }), 15],
        ]) {
            const t = setup(() => error);
            t.adapter.getStateAsync = async () => null;
            await t.adapter.onReady();
            assert.equal(t.adapter.exit.code, exitCode);
            assert.equal(
                t.logs.some(l => l.level === 'error'),
                exitCode !== 0,
            );
        }
    });
    it('cancels an in-flight scheduled run when the instance is disabled', async () => {
        const t = setup(() => 'hang');
        const run = t.adapter.onReady();
        while (!t.handles.length) await new Promise(resolve => setImmediate(resolve));
        t.adapter.onInstanceChange('system.adapter.other.0', { common: { enabled: false } });
        assert.equal(t.adapter.client.stopped, false);
        t.adapter.onInstanceChange('system.adapter.netatmo-crawler.0', { common: { enabled: false } });
        await run;
        assert(t.handles[0].aborted);
        assert.equal(t.requests.length, 1);
        assert.equal(t.states.size, 0);
        assert.match(t.adapter.exit.message, /Instance disabled/);
    });
    it('does not request data if disabled during startup', async () => {
        const t = setup(success);
        t.adapter.getForeignObjectAsync = async () => ({ common: { enabled: false } });
        await t.adapter.onReady();
        assert.equal(t.requests.length, 0);
        assert.match(t.adapter.exit.message, /Instance disabled/);
    });
    it('saves all four supplied payload shapes without street, including zero rain and wind', async () => {
        const t = setup(success);
        await t.adapter.onReady();
        for (const [i, station] of stations.entries()) {
            for (const m of Object.values(station.measures))
                m.type.forEach((type, j) => {
                    if (!['windangle', 'gustangle'].includes(type))
                        assert.equal(t.states.get(`stationData.${i + 1}.${type}`), Object.values(m.res)[0][j]);
                });
            assert(!t.objects.has(`stationData.${i + 1}.info.street`));
        }
        assert.equal(t.states.get('stationData.3.windangle'), 'E');
        assert.equal(t.states.get('stationData.3.windstrength2'), 0.83);
        assert.equal(t.states.get('stationData.1.rain_today'), 0);
        assert.match(t.adapter.exit.message, /4 station\(s\) updated, 0 failed/);
    });
    it('tolerates missing place and retains existing optional metadata', async () => {
        const t = setup();
        await t.adapter.saveMeasure(1, 'info.street', 'Test street');
        await t.adapter.saveStationData(1, { _id: 'synthetic' });
        assert.equal(t.states.get('stationData.1.info.street'), 'Test street');
        assert.equal(t.states.size, 3);
    });
    it('skips malformed measurement arrays and their freshness timestamps', async () => {
        const t = setup(
            () => ({ body: [{ _id: 'synthetic', measures: { m: { type: ['temperature'], res: { 123: [] } } } }] }),
            [stations[0]],
        );
        await t.adapter.onReady();
        assert(!t.states.has('stationData.1.temperature'));
        assert(!t.states.has('stationData.1.lastUpdated.temperature'));
    });
    it('refreshes once and uses the fresh token for subsequent stations and rain', async () => {
        const t = setup(o =>
            o.url.endsWith('/token')
                ? { body: 'fresh' }
                : o.headers.Authorization === 'Bearer old'
                  ? { error: { code: 2 } }
                  : success(o),
        );
        await t.adapter.onReady();
        assert.equal(t.requests.filter(r => r.url.endsWith('/token')).length, 1);
        assert.equal(t.requests.filter(r => r.headers.Authorization === 'Bearer old').length, 1);
        assert.equal(t.states.get('common.authorisationToken'), 'Bearer fresh');
        assert.match(t.adapter.exit.message, /4 station\(s\) updated, 0 failed/);
        assert(!t.logs.some(l => l.text.includes('Bearer fresh')));
    });
    it('refreshes for HTTP 401 during rain history retrieval', async () => {
        const t = setup(
            o =>
                o.url.endsWith('/token')
                    ? { body: 'fresh' }
                    : o.url.endsWith('getmeasure') && o.headers.Authorization === 'Bearer old'
                      ? { statusCode: 401 }
                      : success(o),
            [stations[0]],
        );
        await t.adapter.onReady();
        assert.equal(t.requests.filter(r => r.url.endsWith('/token')).length, 1);
        assert.equal(t.states.get('stationData.1.rain_today'), 0);
    });
    it('bounds persistent invalid tokens to one refresh and stops reusing rejected tokens', async () => {
        const t = setup(o => (o.url.endsWith('/token') ? { body: 'fresh' } : { error: { code: 2 } }));
        await t.adapter.onReady();
        assert.equal(t.requests.length, 3);
        assert.equal(t.states.get('common.authorisationToken'), null);
        assert.match(t.adapter.exit.message, /0 station\(s\) updated, 4 failed/);
    });
    it('does not loop when token refresh fails', async () => {
        const t = setup(o => (o.url.endsWith('/token') ? { statusCode: 503 } : { error: { code: 2 } }));
        await t.adapter.onReady();
        assert.equal(t.requests.length, 2);
        assert.match(t.adapter.exit.message, /4 failed/);
    });
    it('propagates invalid token replies and cache read failures', async () => {
        const t = setup(() => ({ body: {} }));
        await assert.rejects(t.adapter.getAuthorizationToken(true), /No authorization token/);
        t.adapter.getStateAsync = async () => {
            throw Error('cache failure');
        };
        await assert.rejects(t.adapter.getAuthorizationToken(), /cache failure/);
    });
    it('parses string token endpoint responses', async () => {
        const t = setup(() => JSON.stringify({ body: 'new-token' }));
        assert.equal(await t.adapter.getAuthorizationToken(true), 'Bearer new-token');
    });
    it('distinguishes absent rain from real zero', async () => {
        for (const body of [[], [{}], [{ value: [] }], [{ value: [['']] }], [{ value: [[null]] }]]) {
            const t = setup(() => ({ body }));
            assert.equal(await t.adapter.getRainToday(stations[0].measures, 'test', 'token'), null);
        }
        const t = setup(() => ({ body: [{ value: [[0]] }] }));
        assert.equal(await t.adapter.getRainToday(stations[0].measures, 'test', 'token'), 0);
    });
    it('retries empty rain once and preserves previous values and timestamps', async () => {
        const t = setup(
            o => (o.url.endsWith('getpublicmeasure') ? { body: [stations[0]] } : { body: [] }),
            [stations[0]],
        );
        t.adapter.sleep = async () => {};
        t.states.set('stationData.1.rain_today', 12);
        t.states.set('stationData.1.lastUpdated.rain_today', 123);
        await t.adapter.onReady();
        assert.equal(t.requests.length, 7);
        assert.equal(t.states.get('stationData.1.rain_today'), 12);
        assert.equal(t.states.get('stationData.1.lastUpdated.rain_today'), 123);
    });
    it('reports nested errors, preserves current measurements and continues to the next station', async () => {
        const err = new AggregateError([
            Object.assign(Error('connect'), { code: 'ETIMEDOUT' }),
            Object.assign(Error('connect'), { code: 'ENETUNREACH' }),
        ]);
        const t = setup(o => (o.url.endsWith('getmeasure') ? err : success(o)), [stations[2], stations[1]]);
        await t.adapter.onReady();
        assert.equal(t.states.get('stationData.1.humidity'), 62);
        assert.equal(t.states.get('stationData.1.windstrength'), 3);
        assert.equal(t.states.get('stationData.2.temperature'), 13.7);
        assert(t.logs.some(l => l.text.includes('ETIMEDOUT') && l.text.includes('ENETUNREACH')));
        assert(!t.logs.some(l => l.text.includes('No body')));
        assert.match(t.adapter.exit.message, /1 station\(s\) updated, 1 failed/);
    });
    it('aborts hanging requests on unload without more stations or writes', async () => {
        const t = setup(() => 'hang');
        const run = t.adapter.onReady();
        await new Promise(resolve => setImmediate(resolve));
        let callbacks = 0;
        t.adapter.onUnload(() => callbacks++);
        await run;
        assert.equal(callbacks, 1);
        assert.equal(t.requests.length, 1);
        assert(t.handles[0].aborted);
        assert.equal(t.states.size, 0);
        assert.equal(t.adapter.client.pending.size, 0);
        assert.equal(t.adapter.exit, undefined);
    });
    it('cancels retry waits on unload', async () => {
        const t = setup();
        const run = t.adapter.onReady();
        await new Promise(resolve => setImmediate(resolve));
        t.adapter.onUnload(() => {});
        await run;
        assert.equal(t.requests.length, 1);
        assert.equal(t.adapter.client.pending.size, 0);
    });
    it('prevents writes if stopped during object creation', async () => {
        const t = setup();
        t.adapter.setObjectNotExistsAsync = async () => t.adapter.onUnload(() => {});
        await assert.rejects(t.adapter.saveMeasure(1, 'temperature', 12), /stopping/);
        assert.equal(t.states.size, 0);
    });
    it('ends a timed-out run and lets a subsequent adapter instance succeed', async () => {
        const t = setup(() => 'hang', [stations[0]]);
        t.adapter.client.timeout = 15;
        await t.adapter.onReady();
        assert(t.handles[0].aborted);
        assert.equal(t.adapter.client.pending.size, 0);
        assert.match(t.adapter.exit.message, /1 failed/);
        const next = setup(success, [stations[1]]);
        await next.adapter.onReady();
        assert.match(next.adapter.exit.message, /1 station\(s\) updated, 0 failed/);
    });
});

describe('Request lifecycle', () => {
    it('sets 30 seconds and clears deadlines on success', async () => {
        let options;
        const c = new RequestClient((o, cb) => {
            options = o;
            cb(null, { statusCode: 200 }, 'ok');
            return { abort() {} };
        });
        assert.equal((await c.send({})).body, 'ok');
        assert.equal(options.timeout, 30000);
        assert.equal(c.pending.size, 0);
    });
    it('ignores late callbacks after a deadline', async () => {
        let cb,
            aborted = false;
        const c = new RequestClient((o, callback) => {
            cb = callback;
            return {
                abort() {
                    aborted = true;
                },
            };
        }, 10);
        await assert.rejects(c.send({}), /timed out/);
        cb(null, { statusCode: 200 }, 'late');
        assert(aborted);
        assert.equal(c.pending.size, 0);
    });
    it('cleans up synchronous failures and keeps cancelling when abort throws', async () => {
        const broken = new RequestClient(() => {
            throw Error('transport');
        });
        await assert.rejects(broken.send({}), /transport/);
        assert.equal(broken.pending.size, 0);
        const c = new RequestClient(() => ({
            abort() {
                throw Error('abort');
            },
        }));
        const requests = [assert.rejects(c.send({}), /stopping/), assert.rejects(c.sleep(1000), /stopping/)];
        c.stop();
        await Promise.all(requests);
        assert.equal(c.pending.size, 0);
        assert.throws(() => c.send({}), /stopping/);
    });
    it('includes nested network codes', () =>
        assert.match(
            describeError(new AggregateError([Object.assign(Error('connect'), { code: 'ECONNREFUSED' })])),
            /ECONNREFUSED/,
        ));
});

describe('Real HTTP transport on localhost', () => {
    async function serve(handler, work) {
        const server = require('node:http').createServer(handler);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            await work(`http://127.0.0.1:${server.address().port}`);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }

    it('sends authenticated POST JSON and parses a real response', async () => {
        let received;
        await serve(
            (req, res) => {
                let data = '';
                req.on('data', chunk => {
                    data += chunk;
                });
                req.on('end', () => {
                    received = { method: req.method, auth: req.headers.authorization, body: JSON.parse(data) };
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ body: [{ value: [[0]] }] }));
                });
            },
            async url => {
                const client = new RequestClient(require('request'));
                const response = await client.send({
                    url,
                    method: 'POST',
                    headers: { Authorization: 'Bearer synthetic' },
                    json: { device_id: 'synthetic' },
                });
                assert.equal(response.body.body[0].value[0][0], 0);
                assert.deepEqual(received, {
                    method: 'POST',
                    auth: 'Bearer synthetic',
                    body: { device_id: 'synthetic' },
                });
                assert.equal(client.pending.size, 0);
            },
        );
    });

    it('bounds a real server which never responds', async () => {
        await serve(
            () => {},
            async url => {
                const client = new RequestClient(require('request'), 40);
                await assert.rejects(client.send({ url }), /timed out|ETIMEDOUT|ESOCKETTIMEDOUT/);
                assert.equal(client.pending.size, 0);
            },
        );
    });

    it('aborts a real in-flight socket when stopped', async () => {
        let arrived;
        const arrival = new Promise(resolve => {
            arrived = resolve;
        });
        await serve(
            () => arrived(),
            async url => {
                const client = new RequestClient(require('request'));
                const pending = assert.rejects(client.send({ url }), /stopping/);
                await arrival;
                client.stop();
                await pending;
                assert.equal(client.pending.size, 0);
            },
        );
    });
});
