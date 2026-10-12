'use strict';

function stoppedError() {
    return new Error('Adapter is stopping');
}

/**
 * Render nested connection failures without dumping request headers.
 *
 * @param {any} error Transport or API error.
 * @returns {string} Readable error details.
 */
function describeError(error) {
    const detail = error?.code || error?.message || String(error);
    const children = Array.isArray(error?.errors) ? error.errors.map(describeError).join('; ') : '';
    return children ? `${detail}: ${children}` : detail;
}

/** Owns HTTP requests and retry delays for one adapter run. */
class RequestClient {
    /**
     * @param {Function} request Callback-based HTTP transport.
     * @param {number} timeout Maximum duration of one request in milliseconds.
     */
    constructor(request, timeout = 30000) {
        this.request = request;
        this.timeout = timeout;
        this.pending = new Set();
        this.stopped = false;
    }

    /** Reject new work after shutdown has started. */
    checkRunning() {
        if (this.stopped) {
            throw stoppedError();
        }
    }

    /**
     * Send a bounded, cancellable HTTP request.
     *
     * @param {object} options Transport options.
     * @param {boolean} allowHttpErrors Let the caller handle HTTP status, e.g. token expiry.
     * @returns {Promise<{body: any, statusCode: number}>} Response body and status.
     */
    send(options, allowHttpErrors = false) {
        this.checkRunning();
        return new Promise((resolve, reject) => {
            let handle;
            let settled = false;
            const finish = (error, result) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                this.pending.delete(cancel);
                error ? reject(error) : resolve(result);
            };
            const cancel = error => {
                finish(error);
                try {
                    handle?.abort();
                } catch {
                    // The promise is already rejected and its deadline cleared.
                }
            };
            // Wall-clock deadline also bounds responses that keep trickling data.
            const timer = setTimeout(
                () => cancel(new Error(`Netatmo request timed out after ${this.timeout} ms`)),
                this.timeout,
            );
            this.pending.add(cancel);
            try {
                handle = this.request({ ...options, timeout: this.timeout }, (error, response, body) => {
                    if (error) {
                        finish(error);
                        return;
                    }
                    const statusCode = response?.statusCode || 0;
                    if (!allowHttpErrors && (statusCode < 200 || statusCode >= 300)) {
                        finish(new Error(`Netatmo HTTP ${statusCode}`));
                        return;
                    }
                    finish(null, { body, statusCode });
                });
            } catch (error) {
                finish(error);
            }
        });
    }

    /**
     * Wait between retries, rejecting immediately on shutdown.
     *
     * @param {number} ms Delay in milliseconds.
     * @returns {Promise<void>} Completion or cancellation.
     */
    sleep(ms) {
        this.checkRunning();
        return new Promise((resolve, reject) => {
            const cancel = error => {
                clearTimeout(timer);
                this.pending.delete(cancel);
                reject(error);
            };
            const timer = setTimeout(() => {
                this.pending.delete(cancel);
                resolve();
            }, ms);
            this.pending.add(cancel);
        });
    }

    /** Cancel every outstanding operation before the unload callback returns. */
    stop() {
        this.stopped = true;
        for (const cancel of [...this.pending]) {
            try {
                cancel(stoppedError());
            } catch {
                // Continue cancelling the other operations if a transport abort throws.
            }
        }
    }
}

module.exports = { RequestClient, describeError };
