// Quantora state core. This file intentionally has no application imports so
// domain stores can be loaded in any order without circular dependencies.
(function initializeQuantoraStateCore(global) {
    const stores = new Map();
    const events = new Map();
    const requests = new Map();

    const shallowEqual = (left, right) => {
        if (Object.is(left, right)) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        const leftKeys = Object.keys(left);
        return leftKeys.length === Object.keys(right).length && leftKeys.every(key => Object.is(left[key], right[key]));
    };

    function createStore(name, initialState, options = {}) {
        let state = options.restore ? options.restore(initialState) : initialState;
        const listeners = new Set();
        const notify = (next, previous, meta) => {
            listeners.forEach(listener => listener(next, previous, meta));
            (events.get(name) || new Set()).forEach(listener => listener({ name, next, previous, meta }));
        };
        const persist = next => {
            if (!options.persistKey) return;
            try { localStorage.setItem(options.persistKey, JSON.stringify(options.serialize ? options.serialize(next) : next)); } catch (_) { /* Persistence is optional. */ }
        };
        const api = {
            name,
            getState: () => state,
            setState(next, meta = {}) {
                if (Object.is(next, state) || (options.shallow !== false && shallowEqual(next, state))) return state;
                const previous = state;
                state = next;
                persist(next);
                notify(next, previous, meta);
                return state;
            },
            patch(partial, meta = {}) { return api.setState({ ...state, ...partial }, meta); },
            update(updater, meta = {}) { return api.setState(updater(state), meta); },
            subscribe(listener, selector = value => value, equality = Object.is) {
                let selected = selector(state);
                const wrapped = (next, previous, meta) => {
                    const nextSelected = selector(next);
                    if (equality(selected, nextSelected)) return;
                    const previousSelected = selected;
                    selected = nextSelected;
                    listener(nextSelected, previousSelected, meta);
                };
                listeners.add(wrapped);
                return () => listeners.delete(wrapped);
            },
            // Only the newest response for a key can update a store. Callers
            // can use this around fetches without keeping request epochs in UI modules.
            async runLatest(key, task) {
                const version = (requests.get(`${name}:${key}`) || 0) + 1;
                requests.set(`${name}:${key}`, version);
                const result = await task();
                return requests.get(`${name}:${key}`) === version ? { current: true, result } : { current: false, result };
            },
        };
        stores.set(name, api);
        return api;
    }

    function on(eventName, listener) {
        const listeners = events.get(eventName) || new Set();
        listeners.add(listener);
        events.set(eventName, listeners);
        return () => listeners.delete(listener);
    }

    // Domain modules register themselves on this namespace during bootstrap.
    // The store APIs remain stable; the namespace cannot be frozen until then.
    global.quantoraState = {
        createStore, on, get: name => stores.get(name), stores, shallowEqual,
    };
}(window));
