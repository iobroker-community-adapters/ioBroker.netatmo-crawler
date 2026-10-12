'use strict';

/**
 * Send an HTTP request using Node's native fetch implementation.
 *
 * @param {{url: string, method?: string, headers?: Record<string, string>, json?: object}} options Request options.
 * @param {(error: unknown, response?: {statusCode: number}, body?: unknown) => void} callback Completion callback.
 * @returns {{abort: () => void}} Cancellation handle.
 */
function httpTransport(options, callback) {
    const controller = new AbortController();
    const headers = { ...options.headers };
    if (options.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers.Accept = 'application/json';
    }
    const operation = async () => {
        const response = await fetch(options.url, {
            method: options.method,
            headers,
            body: options.json === undefined ? undefined : JSON.stringify(options.json),
            signal: controller.signal,
        });
        const text = await response.text();
        // Keep HTTP error responses available to the token refresh handler.
        let body = text;
        if (options.json !== undefined && text) {
            try {
                body = JSON.parse(text);
            } catch {
                // Non-JSON HTTP errors are handled by their status code.
                if (response.ok) {
                    throw new Error('Invalid JSON in Netatmo response');
                }
            }
        }
        return { body, statusCode: response.status };
    };
    operation().then(
        result => callback(null, { statusCode: result.statusCode }, result.body),
        error => callback(error),
    );
    return { abort: () => controller.abort() };
}

module.exports = httpTransport;
