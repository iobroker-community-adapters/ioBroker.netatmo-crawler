'use strict';

const REQUEST_TIMEOUT_MS = 30_000;
const NETWORK_ERROR_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ESOCKETTIMEDOUT',
    'ETIMEDOUT',
]);

/**
 * @param {unknown} error
 * @returns {error is Error & { code: string }}
 */
function isNetworkError(error) {
    return error instanceof Error && 'code' in error && NETWORK_ERROR_CODES.has(String(error.code));
}

module.exports = { REQUEST_TIMEOUT_MS, isNetworkError };
