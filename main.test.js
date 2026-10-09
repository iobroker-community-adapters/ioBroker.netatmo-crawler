'use strict';

const { expect } = require('chai');
const { REQUEST_TIMEOUT_MS, isNetworkError } = require('./lib/netatmo-request');

describe('Netatmo request handling', () => {
    it('limits every request to 30 seconds', () => {
        expect(REQUEST_TIMEOUT_MS).to.equal(30_000);
    });

    for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ENETUNREACH', 'ENOTFOUND']) {
        it(`treats ${code} as an expected network problem`, () => {
            expect(isNetworkError(Object.assign(new Error('network unavailable'), { code }))).to.equal(true);
        });
    }

    it('does not downgrade programming errors to warnings', () => {
        expect(isNetworkError(new TypeError('unexpected response'))).to.equal(false);
    });
});
