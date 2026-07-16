// Shared API cache for the classic frontend. It stays below the existing
// fetch/authFetch call sites so views retain their current behavior.
(function installQuantoraApiCache() {
    const nativeFetch = window.fetch.bind(window);
    const CACHE_VERSION = 2;
    const STORAGE_PREFIX = `quantora.api-cache.v${CACHE_VERSION}.`;
    const CHANNEL_NAME = `quantora-api-cache-v${CACHE_VERSION}`;
    const MAX_PERSISTED_BODY_BYTES = 750000;
    const MAX_MEMORY_BODY_BYTES = 1000000;
    const LRU_PERSIST_INTERVAL = 60000;
    const DEFAULT_LIMITS = Object.freeze({
        market: 30, portfolio: 20, watchlist: 20, search: 30,
        stock: 20, news: 20, financials: 12,
    });
    const policies = Object.freeze({
        market: { ttl: 30000, staleFor: 120000 },
        portfolio: { ttl: 30000, staleFor: 120000 },
        watchlist: { ttl: 300000, staleFor: 900000 },
        search: { ttl: 600000, staleFor: 1800000 },
        stock: { ttl: 30000, staleFor: 120000 },
        news: { ttl: 300000, staleFor: 900000 },
        financials: { ttl: 86400000, staleFor: 604800000 },
    });
    const cacheLimits = { ...DEFAULT_LIMITS };
    const memory = new Map();
    const inFlight = new Map();
    const backgroundRefreshes = new Set();
    const hydratedScopes = new Set();
    const cacheGenerations = new Map();
    const pendingPersistence = new Map();
    const metrics = Object.fromEntries(Object.keys(policies).map(category => [category, {
        hits: 0, misses: 0, staleHits: 0, deduplicated: 0, backgroundRefreshes: 0,
        evictions: 0, expirations: 0, invalidations: 0, syncs: 0,
    }]));
    const totals = { persistenceFailures: 0, synchronizationFailures: 0 };
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let persistenceScheduled = false;
    let cleanupScheduled = false;
    let cleanupTimer = null;
    let syncChannel = null;

    function increment(category, name) {
        if (metrics[category]) metrics[category][name] += 1;
    }

    function queueIdle(task, timeout = 1000) {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(task, { timeout });
        } else {
            window.setTimeout(() => task({ timeRemaining: () => 0, didTimeout: true }), Math.min(timeout, 100));
        }
    }

    function stableHash(value) {
        let first = 0xdeadbeef;
        let second = 0x41c6ce57;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            first = Math.imul(first ^ code, 2654435761);
            second = Math.imul(second ^ code, 1597334677);
        }
        first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
        second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
        return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
    }

    function cacheScope() {
        // Keys are scoped before they reach memory or localStorage, keeping a
        // shared browser's authenticated data isolated by account.
        try {
            const user = typeof authState !== 'undefined' && authState.authenticated ? authState.user : null;
            const id = user && (user.id || user.email);
            return id ? `user:${String(id)}` : 'public';
        } catch (_) {
            return 'public';
        }
    }

    function currentScopeId() {
        return stableHash(cacheScope());
    }

    function categoryFor(pathname) {
        if (/^\/api\/news(?:\/|$)/.test(pathname)) return 'news';
        if (/^\/api\/company(?:\/|$)/.test(pathname)) return 'financials';
        if (/^\/api\/gauges(?:\/|$)/.test(pathname)) return 'stock';
        if (/^\/api\/(?:tickers|search|search-history|search-analytics)(?:\/|$)/.test(pathname)) return 'search';
        if (/^\/api\/(?:watchlist|watchlists|favorites|recent-viewed)(?:\/|$)/.test(pathname)) return 'watchlist';
        if (/^\/api\/(?:portfolio|portfolios|positions)(?:\/|$)/.test(pathname)) return 'portfolio';
        if (/^\/api\/(?:quote|stats|chart-data|indicators|categories|industry-trends|ai-recommendation)(?:\/|$)/.test(pathname)) return 'market';
        return null;
    }

    function mutationCategories(pathname) {
        if (/^\/api\/auth(?:\/|$)/.test(pathname) || /^\/api\/me(?:\/|$)/.test(pathname)) return Object.keys(policies);
        const category = categoryFor(pathname);
        return category ? [category] : Object.keys(policies);
    }

    function normalizedUrl(input) {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.origin);
        if (url.origin !== window.location.origin) return null;
        const ordered = Array.from(url.searchParams.entries()).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
        url.search = new URLSearchParams(ordered).toString();
        return url;
    }

    function cacheKey(url, scopeId = currentScopeId()) {
        return `${scopeId}:${url.pathname}${url.search}`;
    }

    function storageKey(category, scopeId = currentScopeId()) {
        return `${STORAGE_PREFIX}${category}.${scopeId}`;
    }

    function hydrationKey(category, scopeId) {
        return `${category}:${scopeId}`;
    }

    function cacheGeneration(category, scopeId) {
        return cacheGenerations.get(hydrationKey(category, scopeId)) || 0;
    }

    function bumpCacheGeneration(category, scopeId) {
        const key = hydrationKey(category, scopeId);
        cacheGenerations.set(key, cacheGeneration(category, scopeId) + 1);
    }

    function recordsFor(category, scopeId) {
        return Array.from(memory.values()).filter(record => record.category === category && record.scopeId === scopeId);
    }

    function isExpired(record, policy, now = Date.now()) {
        return now - Number(record.updatedAt || 0) > policy.staleFor;
    }

    function validRecord(record, category, scopeId, now = Date.now()) {
        const policy = policies[category];
        return Boolean(
            policy && record && record.schemaVersion === CACHE_VERSION && record.category === category &&
            record.scopeId === scopeId && typeof record.key === 'string' && typeof record.body === 'string' &&
            !isExpired(record, policy, now)
        );
    }

    function enforceLimit(category, scopeId) {
        const limit = cacheLimits[category];
        const candidates = recordsFor(category, scopeId).sort((a, b) => Number(a.lastAccessedAt || a.updatedAt) - Number(b.lastAccessedAt || b.updatedAt));
        while (candidates.length > limit) {
            const oldest = candidates.shift();
            memory.delete(oldest.key);
            increment(category, 'evictions');
        }
    }

    function hydrateCategory(category, scopeId = currentScopeId(), replace = false) {
        const key = hydrationKey(category, scopeId);
        if (hydratedScopes.has(key) && !replace) return;
        hydratedScopes.add(key);
        const now = Date.now();
        let entries = [];
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey(category, scopeId)) || '[]');
            entries = Array.isArray(saved) ? saved : [];
        } catch (_) {
            totals.persistenceFailures += 1;
        }
        if (replace) {
            recordsFor(category, scopeId).forEach(record => memory.delete(record.key));
        }
        let removedExpired = false;
        entries.forEach(record => {
            if (validRecord(record, category, scopeId, now)) memory.set(record.key, record);
            else if (record && record.schemaVersion === CACHE_VERSION) {
                removedExpired = true;
                increment(category, 'expirations');
            }
        });
        enforceLimit(category, scopeId);
        if (removedExpired) schedulePersist(category, scopeId);
    }

    function schedulePersist(category, scopeId = currentScopeId()) {
        pendingPersistence.set(hydrationKey(category, scopeId), { category, scopeId, generation: cacheGeneration(category, scopeId) });
        if (persistenceScheduled) return;
        persistenceScheduled = true;
        queueIdle(() => {
            persistenceScheduled = false;
            const pending = Array.from(pendingPersistence.values());
            pendingPersistence.clear();
            pending.forEach(({ category: pendingCategory, scopeId: pendingScopeId, generation }) => persistCategory(pendingCategory, pendingScopeId, generation));
        });
    }

    function broadcast(type, category, scopeId) {
        if (!syncChannel) return;
        try {
            syncChannel.postMessage({ schemaVersion: CACHE_VERSION, source: tabId, type, category, scopeId });
        } catch (_) {
            totals.synchronizationFailures += 1;
        }
    }

    function persistCategory(category, scopeId, generation = cacheGeneration(category, scopeId)) {
        if (generation !== cacheGeneration(category, scopeId)) return;
        const entries = recordsFor(category, scopeId)
            .filter(record => record.body.length <= MAX_PERSISTED_BODY_BYTES && !isExpired(record, policies[category]))
            .sort((a, b) => Number(b.lastAccessedAt || b.updatedAt) - Number(a.lastAccessedAt || a.updatedAt))
            .slice(0, cacheLimits[category]);
        try {
            localStorage.setItem(storageKey(category, scopeId), JSON.stringify(entries));
            broadcast('sync', category, scopeId);
        } catch (_) {
            totals.persistenceFailures += 1;
        }
    }

    function cleanupStorageCategory(category, scopeId = currentScopeId()) {
        const key = storageKey(category, scopeId);
        try {
            const entries = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(entries)) return;
            const expiredKeys = new Set();
            recordsFor(category, scopeId).forEach(record => {
                if (isExpired(record, policies[category])) {
                    memory.delete(record.key);
                    expiredKeys.add(record.key);
                }
            });
            const validEntries = entries.filter(record => {
                const valid = validRecord(record, category, scopeId);
                if (!valid && record && typeof record.key === 'string') expiredKeys.add(record.key);
                return valid;
            });
            const valid = validEntries
                .sort((a, b) => Number(b.lastAccessedAt || b.updatedAt) - Number(a.lastAccessedAt || a.updatedAt))
                .slice(0, cacheLimits[category]);
            if (valid.length !== entries.length) {
                localStorage.setItem(key, JSON.stringify(valid));
            }
            if (expiredKeys.size) metrics[category].expirations += expiredKeys.size;
            if (validEntries.length > valid.length) metrics[category].evictions += validEntries.length - valid.length;
        } catch (_) {
            totals.persistenceFailures += 1;
        }
    }

    function scheduleCleanup() {
        if (cleanupScheduled) return;
        cleanupScheduled = true;
        const categories = Object.keys(policies);
        let cursor = 0;
        const run = deadline => {
            const startedAt = Date.now();
            while (cursor < categories.length && (cursor === 0 || deadline.timeRemaining() > 4) && Date.now() - startedAt < 8) {
                cleanupStorageCategory(categories[cursor]);
                cursor += 1;
            }
            if (cursor < categories.length) queueIdle(run);
            else {
                cleanupScheduled = false;
                if (cleanupTimer === null) {
                    cleanupTimer = window.setTimeout(() => {
                        cleanupTimer = null;
                        scheduleCleanup();
                    }, 300000);
                }
            }
        };
        queueIdle(run, 2000);
    }

    function cleanupLegacyStorage() {
        queueIdle(() => {
            // Versioned keys make schema rollouts safe; remove the previous
            // known schema asynchronously so obsolete buckets do not consume
            // the browser's small localStorage quota indefinitely.
            Object.keys(policies).forEach(category => {
                try { localStorage.removeItem(`quantora.api-cache.v${CACHE_VERSION - 1}.${category}`); }
                catch (_) { totals.persistenceFailures += 1; }
            });
        }, 3000);
    }

    function touch(record) {
        record.lastAccessedAt = Date.now();
        if (record.lastAccessedAt - Number(record.persistedAccessAt || 0) >= LRU_PERSIST_INTERVAL) {
            record.persistedAccessAt = record.lastAccessedAt;
            schedulePersist(record.category, record.scopeId);
        }
    }

    function responseFrom(record) {
        return new Response(record.body, {
            status: record.status,
            statusText: record.statusText,
            headers: record.headers,
        });
    }

    function abortError() {
        return new DOMException('The operation was aborted.', 'AbortError');
    }

    function respectingAbort(promise, signal) {
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const abort = () => reject(abortError());
            signal.addEventListener('abort', abort, { once: true });
            promise.then(value => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            }, error => {
                signal.removeEventListener('abort', abort);
                reject(error);
            });
        });
    }

    async function fetchRecord(key, category, scopeId, url, input, init) {
        if (inFlight.has(key)) return inFlight.get(key);
        const generation = cacheGeneration(category, scopeId);
        const requestInit = { ...(init || {}) };
        // A caller changing views must not cancel a deduplicated request used
        // by another view or by the background refresh scheduler.
        delete requestInit.signal;
        const task = nativeFetch(input, requestInit).then(async response => {
            const contentType = response.headers.get('content-type') || '';
            const body = await response.clone().text();
            const record = {
                schemaVersion: CACHE_VERSION,
                key,
                category,
                scopeId,
                url: url.pathname + url.search,
                updatedAt: Date.now(),
                lastAccessedAt: Date.now(),
                persistedAccessAt: 0,
                status: response.status,
                statusText: response.statusText,
                headers: Array.from(response.headers.entries()),
                body,
            };
            if (generation === cacheGeneration(category, scopeId) && response.ok && body.length <= MAX_MEMORY_BODY_BYTES && /application\/json/i.test(contentType)) {
                memory.set(key, record);
                enforceLimit(category, scopeId);
                schedulePersist(category, scopeId);
            }
            return record;
        }).finally(() => inFlight.delete(key));
        inFlight.set(key, task);
        return task;
    }

    function canBackgroundRefresh() {
        return document.visibilityState === 'visible' && navigator.onLine;
    }

    function refresh(record) {
        if (!canBackgroundRefresh() || inFlight.has(record.key) || backgroundRefreshes.has(record.key)) return;
        backgroundRefreshes.add(record.key);
        increment(record.category, 'backgroundRefreshes');
        const url = new URL(record.url, window.location.origin);
        void fetchRecord(record.key, record.category, record.scopeId, url, url.pathname + url.search, { credentials: 'same-origin' })
            .catch(() => {})
            .finally(() => backgroundRefreshes.delete(record.key));
    }

    function invalidate(categories, scopeId = currentScopeId(), synchronize = true) {
        categories.forEach(category => {
            bumpCacheGeneration(category, scopeId);
            pendingPersistence.delete(hydrationKey(category, scopeId));
            recordsFor(category, scopeId).forEach(record => memory.delete(record.key));
            increment(category, 'invalidations');
            try { localStorage.removeItem(storageKey(category, scopeId)); }
            catch (_) { totals.persistenceFailures += 1; }
            if (synchronize) broadcast('invalidate', category, scopeId);
        });
    }

    function synchronizeCategory(category, scopeId = currentScopeId()) {
        hydrateCategory(category, scopeId, true);
        increment(category, 'syncs');
    }

    function configureLimits(overrides = {}) {
        Object.keys(policies).forEach(category => {
            const value = Number(overrides[category]);
            if (Number.isInteger(value) && value > 0 && value <= 200) {
                cacheLimits[category] = value;
                const scopeId = currentScopeId();
                const before = recordsFor(category, scopeId).length;
                enforceLimit(category, scopeId);
                if (recordsFor(category, scopeId).length !== before) schedulePersist(category, scopeId);
            }
        });
        return { ...cacheLimits };
    }

    function debugEnabled() {
        try { return new URLSearchParams(window.location.search).get('debug') === '1' || localStorage.getItem('quantora.debug') === '1'; }
        catch (_) { return false; }
    }

    function getMetrics() {
        if (!debugEnabled()) return null;
        const buckets = Object.fromEntries(Object.entries(metrics).map(([category, values]) => [category, {
            ...values,
            entries: recordsFor(category, currentScopeId()).length,
            limit: cacheLimits[category],
            ttl: policies[category].ttl,
        }]));
        return {
            cacheVersion: CACHE_VERSION,
            scope: currentScopeId(),
            ...totals,
            buckets,
        };
    }

    async function cachedFetch(input, init = {}) {
        const url = normalizedUrl(input);
        const method = String(init.method || (input instanceof Request && input.method) || 'GET').toUpperCase();
        if (!url || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);

        if (method !== 'GET' && method !== 'HEAD') {
            const response = await nativeFetch(input, init);
            if (response.ok) invalidate(mutationCategories(url.pathname));
            return response;
        }

        const category = categoryFor(url.pathname);
        if (!category || method === 'HEAD') return nativeFetch(input, init);
        // Existing callers use `cache: 'no-store'` to avoid the browser HTTP
        // cache. This application-level SWR cache intentionally owns caching
        // for these eligible API reads.
        const scopeId = currentScopeId();
        hydrateCategory(category, scopeId);
        const key = cacheKey(url, scopeId);
        const policy = policies[category];
        const record = memory.get(key);
        const age = record ? Date.now() - record.updatedAt : Infinity;
        if (record && age <= policy.ttl) {
            increment(category, 'hits');
            touch(record);
            return respectingAbort(Promise.resolve(responseFrom(record)), init.signal);
        }
        if (record && age <= policy.staleFor) {
            increment(category, 'hits');
            increment(category, 'staleHits');
            touch(record);
            refresh(record);
            return respectingAbort(Promise.resolve(responseFrom(record)), init.signal);
        }
        if (record) {
            memory.delete(key);
            increment(category, 'expirations');
            schedulePersist(category, scopeId);
        }
        if (inFlight.has(key)) {
            increment(category, 'deduplicated');
            return respectingAbort(inFlight.get(key).then(responseFrom), init.signal);
        }
        increment(category, 'misses');
        return respectingAbort(fetchRecord(key, category, scopeId, url, input, init).then(responseFrom), init.signal);
    }

    function refreshStaleEntries() {
        if (!canBackgroundRefresh()) return;
        const scopeId = currentScopeId();
        Object.keys(policies).forEach(category => hydrateCategory(category, scopeId));
        const now = Date.now();
        Array.from(memory.values())
            .filter(record => record.scopeId === scopeId)
            .forEach(record => {
                const policy = policies[record.category];
                if (now - record.updatedAt > policy.ttl && now - record.updatedAt <= policy.staleFor) refresh(record);
            });
    }

    try {
        if (typeof window.BroadcastChannel === 'function') {
            syncChannel = new window.BroadcastChannel(CHANNEL_NAME);
            syncChannel.onmessage = event => {
                const message = event.data || {};
                if (message.schemaVersion !== CACHE_VERSION || message.source === tabId || message.scopeId !== currentScopeId() || !policies[message.category]) return;
                if (message.type === 'invalidate') invalidate([message.category], message.scopeId, false);
                if (message.type === 'sync') synchronizeCategory(message.category, message.scopeId);
            };
        }
    } catch (_) {
        totals.synchronizationFailures += 1;
        syncChannel = null;
    }

    if (!syncChannel) {
        window.addEventListener('storage', event => {
            const scopeId = currentScopeId();
            Object.keys(policies).forEach(category => {
                if (event.key === storageKey(category, scopeId)) synchronizeCategory(category, scopeId);
            });
        });
    }

    configureLimits(window.QUANTORA_CACHE_LIMITS || {});
    window.fetch = cachedFetch;
    window.quantoraApiCache = Object.freeze({
        invalidate: category => invalidate(category ? [category] : Object.keys(policies)),
        clear: () => invalidate(Object.keys(policies)),
        refresh: refreshStaleEntries,
        configureLimits,
        ...(debugEnabled() ? { getMetrics } : {}),
        cacheVersion: CACHE_VERSION,
    });
    window.addEventListener('online', refreshStaleEntries);
    window.addEventListener('focus', refreshStaleEntries);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshStaleEntries();
    });
    scheduleCleanup();
    cleanupLegacyStorage();
}());
