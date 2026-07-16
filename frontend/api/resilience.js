// Cross-cutting production hardening for the classic frontend. This module is
// loaded before the cache and installed after it so every API request uses the
// same cancellation, timeout, retry, and diagnostic policy.
(function installQuantoraResilience(global) {
    const debugEnabled = (() => {
        try {
            const query = new URLSearchParams(global.location.search);
            return query.get('debug') === '1' || global.localStorage.getItem('quantora.debug') === '1';
        } catch (_) { return false; }
    })();
    const metrics = {
        requests: 0, failedRequests: 0, slowRequests: 0, retries: 0,
        deduplicated: 0, duplicateMutationsPrevented: 0, renderSamples: 0,
        firstPaintMs: null, firstContentfulPaintMs: null, largestContentfulPaintMs: null, websocketReconnects: 0,
    };
    const inFlightReads = new Map();
    const inFlightMutations = new Set();
    const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
    const SAFE_METHODS = new Set(['GET', 'HEAD']);
    const DEFAULT_TIMEOUT_MS = 15_000;
    const SLOW_REQUEST_MS = 2_000;

    function requestId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
        return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function isApiRequest(input) {
        try {
            const value = input instanceof Request ? input.url : input;
            const url = new URL(value, global.location.origin);
            return url.origin === global.location.origin && url.pathname.startsWith('/api/');
        } catch (_) { return false; }
    }

    function methodFor(input, init) {
        return String(init.method || (input instanceof Request && input.method) || 'GET').toUpperCase();
    }

    function requestKey(input, method) {
        const value = input instanceof Request ? input.url : input;
        const url = new URL(value, global.location.origin);
        const entries = Array.from(url.searchParams.entries()).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
        url.search = new URLSearchParams(entries).toString();
        return `${method}:${url.pathname}${url.search}`;
    }

    function mutationKey(input, init, method) {
        const body = typeof init.body === 'string' ? init.body : '';
        return `${requestKey(input, method)}:${body}`;
    }

    function safeError(error, context = {}) {
        const abort = error && error.name === 'AbortError';
        if (abort) return;
        const entry = {
            at: new Date().toISOString(),
            name: String(error && error.name || 'Error').slice(0, 80),
            message: String(error && error.message || 'Unexpected client failure').slice(0, 240),
            context: { area: String(context.area || 'client').slice(0, 80), requestId: context.requestId || undefined },
        };
        if (debugEnabled) {
            global.__quantoraDiagnostics.errors.push(entry);
            global.console.warn('[Quantora]', entry);
        }
        // Deliberately do not transmit browser errors automatically. Requests
        // can carry sensitive account or market context and server logging is
        // the authoritative production telemetry channel.
    }

    function exposeDiagnostics() {
        if (!debugEnabled) return;
        global.__quantoraDebugEnabled = true;
        global.__quantoraDiagnostics = {
            errors: [],
            getMetrics: () => ({ ...metrics, cache: global.quantoraApiCache?.getMetrics?.() || null }),
        };
    }

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            const timer = global.setTimeout(resolve, ms);
            if (!signal) return;
            if (signal.aborted) { global.clearTimeout(timer); reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
            signal.addEventListener('abort', () => { global.clearTimeout(timer); reject(new DOMException('The operation was aborted.', 'AbortError')); }, { once: true });
        });
    }

    function respectAbort(promise, signal) {
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
        return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
            promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        });
    }

    function abortableInit(input, init, requestIdValue) {
        const controller = new AbortController();
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        headers.set('X-Request-ID', requestIdValue);
        const upstream = init.signal;
        const abortUpstream = () => controller.abort(upstream.reason);
        if (upstream) {
            if (upstream.aborted) abortUpstream();
            else upstream.addEventListener('abort', abortUpstream, { once: true });
        }
        return { init: { ...init, headers, signal: controller.signal }, controller, cleanup: () => upstream?.removeEventListener('abort', abortUpstream) };
    }

    function timeoutFor(init) {
        const configured = Number(init.timeoutMs);
        return Number.isFinite(configured) && configured >= 1_000 && configured <= 60_000 ? configured : DEFAULT_TIMEOUT_MS;
    }

    async function execute(baseFetch, input, init, method, id) {
        const timeout = timeoutFor(init);
        const maxAttempts = SAFE_METHODS.has(method) ? 3 : 1;
        let lastError;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            if (!navigator.onLine && !SAFE_METHODS.has(method)) {
                const offline = new Error('This action needs an internet connection. Please try again when you are online.');
                offline.name = 'OfflineError';
                throw offline;
            }
            const prepared = abortableInit(input, init, id);
            let timedOut = false;
            const timeoutId = global.setTimeout(() => { timedOut = true; prepared.controller.abort(); }, timeout);
            const started = performance.now();
            try {
                const response = await baseFetch(input, prepared.init);
                const duration = performance.now() - started;
                metrics.requests += 1;
                if (duration >= SLOW_REQUEST_MS) metrics.slowRequests += 1;
                if (!SAFE_METHODS.has(method) || !RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts - 1) {
                    return response;
                }
                metrics.retries += 1;
                try { await response.body?.cancel(); } catch (_) { /* Response cleanup is best-effort. */ }
                await delay(Math.min(2_000, 250 * (2 ** attempt)) + Math.round(Math.random() * 125), init.signal);
            } catch (error) {
                if (init.signal?.aborted) throw error;
                if (timedOut) {
                    const timeoutError = new Error('The request took too long. Please try again.');
                    timeoutError.name = 'TimeoutError';
                    lastError = timeoutError;
                } else {
                    lastError = error;
                }
                if (!SAFE_METHODS.has(method) || attempt === maxAttempts - 1) throw lastError;
                metrics.retries += 1;
                await delay(Math.min(2_000, 250 * (2 ** attempt)) + Math.round(Math.random() * 125), init.signal);
            } finally {
                global.clearTimeout(timeoutId);
                prepared.cleanup();
            }
        }
        throw lastError || new Error('Request failed.');
    }

    function installFetch() {
        if (global.__quantoraFetchHardened) return;
        global.__quantoraFetchHardened = true;
        const baseFetch = global.fetch.bind(global);
        global.fetch = function resilientFetch(input, init = {}) {
            if (!isApiRequest(input)) return baseFetch(input, init);
            const method = methodFor(input, init);
            const id = requestId();
            const run = () => execute(baseFetch, input, init, method, id)
                .then(response => {
                    if (!response.ok) metrics.failedRequests += 1;
                    return response;
                })
                .catch(error => { metrics.failedRequests += 1; safeError(error, { area: 'network', requestId: id }); throw error; });
            if (!SAFE_METHODS.has(method)) {
                const key = mutationKey(input, init, method);
                if (inFlightMutations.has(key)) {
                    metrics.duplicateMutationsPrevented += 1;
                    const error = new Error('This action is already being processed.');
                    error.name = 'DuplicateRequestError';
                    return Promise.reject(error);
                }
                inFlightMutations.add(key);
                return run().finally(() => inFlightMutations.delete(key));
            }
            const key = requestKey(input, method);
            if (inFlightReads.has(key)) {
                metrics.deduplicated += 1;
                return respectAbort(inFlightReads.get(key).then(response => response.clone()), init.signal);
            }
            const sharedInit = { ...init };
            delete sharedInit.signal;
            const task = execute(baseFetch, input, sharedInit, method, id)
                .then(response => {
                    if (!response.ok) metrics.failedRequests += 1;
                    return response;
                })
                .catch(error => { metrics.failedRequests += 1; safeError(error, { area: 'network', requestId: id }); throw error; })
                .finally(() => inFlightReads.delete(key));
            inFlightReads.set(key, task);
            return respectAbort(task.then(response => response.clone()), init.signal);
        };
    }

    function observeRenderTiming() {
        if (!('PerformanceObserver' in global)) return;
        try {
            const observer = new PerformanceObserver(entries => {
                entries.getEntries().forEach(entry => {
                    metrics.renderSamples += 1;
                    if (entry.name === 'first-paint') metrics.firstPaintMs = Math.round(entry.startTime);
                    if (entry.name === 'first-contentful-paint') metrics.firstContentfulPaintMs = Math.round(entry.startTime);
                });
            });
            observer.observe({ type: 'paint', buffered: true });
            global.addEventListener('pagehide', () => observer.disconnect(), { once: true });
            const lcpObserver = new PerformanceObserver(entries => {
                const samples = entries.getEntries();
                const latest = samples[samples.length - 1];
                if (latest) metrics.largestContentfulPaintMs = Math.round(latest.startTime);
            });
            lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
            global.addEventListener('pagehide', () => lcpObserver.disconnect(), { once: true });
        } catch (_) { /* Paint timing is optional browser telemetry. */ }
    }

    exposeDiagnostics();
    observeRenderTiming();
    global.reportQuantoraError = safeError;
    global.incrementQuantoraMetric = name => { if (Object.prototype.hasOwnProperty.call(metrics, name)) metrics[name] += 1; };
    global.installQuantoraFetchHardening = installFetch;
    global.addEventListener('error', event => {
        safeError(event.error || new Error(event.message || 'Client error'), { area: 'window' });
    });
    global.addEventListener('unhandledrejection', event => {
        safeError(event.reason, { area: 'promise' });
    });
}(window));
