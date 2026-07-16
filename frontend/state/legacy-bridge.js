// Compatibility bridge for classic scripts and inline controls. It exposes
// existing globals as views of domain stores; no domain data is copied here.
(function (global, state) {
    const bind = (name, store, key) => Object.defineProperty(global, name, {
        configurable: true, get: () => store.getState()[key],
        set: value => store.patch({ [key]: value }, { type: `legacy/${name}` }),
    });
    const updateAtPath = (value, path, nextValue) => {
        if (!path.length) return nextValue;
        const [key, ...rest] = path;
        const source = value == null ? (Number.isInteger(Number(key)) ? [] : {}) : value;
        const copy = Array.isArray(source) ? source.slice() : { ...source };
        copy[key] = updateAtPath(source[key], rest, nextValue);
        return copy;
    };
    const isProxyable = value => value && typeof value === 'object' && (
        Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    );
    const bindObject = (name, store) => {
        const proxies = new Map();
        const proxyFor = path => {
            const cacheKey = path.join('.');
            if (proxies.has(cacheKey)) return proxies.get(cacheKey);
            const initialValue = path.reduce((current, segment) => current == null ? undefined : current[segment], store.getState());
            const proxy = new Proxy(Array.isArray(initialValue) ? [] : {}, {
                get(_, key) {
                    const value = path.reduce((current, segment) => current == null ? undefined : current[segment], store.getState());
                    const next = value == null ? undefined : value[key];
                    return isProxyable(next) ? proxyFor([...path, key]) : next;
                },
                has(_, key) {
                    const value = path.reduce((current, segment) => current == null ? undefined : current[segment], store.getState());
                    return value != null && key in value;
                },
                set(_, key, value) {
                    store.update(current => updateAtPath(current, [...path, key], value), { type: `legacy/${name}/${String(key)}` });
                    return true;
                },
                deleteProperty(_, key) {
                    store.update(current => {
                        const parent = path.reduce((value, segment) => value == null ? undefined : value[segment], current);
                        const copy = Array.isArray(parent) ? parent.slice() : { ...(parent || {}) };
                        if (Array.isArray(copy)) copy.splice(Number(key), 1); else delete copy[key];
                        return updateAtPath(current, path, copy);
                    }, { type: `legacy/${name}/delete` });
                    return true;
                },
                ownKeys() { const value = path.reduce((current, segment) => current == null ? undefined : current[segment], store.getState()); return Reflect.ownKeys(value || {}); },
                getOwnPropertyDescriptor(target, key) {
                    if (Array.isArray(target) && key === 'length') return { enumerable: false, configurable: false, writable: true, value: proxy[key] };
                    return { enumerable: true, configurable: true, value: proxy[key] };
                },
            });
            proxies.set(cacheKey, proxy);
            return proxy;
        };
        Object.defineProperty(global, name, { configurable: true, get: () => proxyFor([]), set: value => store.setState(value, { type: `legacy/${name}` }) });
    };

    bind('currentTicker', state.market, 'ticker'); bind('currentTimeframe', state.market, 'timeframe');
    bind('currentMarketSession', state.market, 'session'); bind('globalChartData', state.market, 'chartData');
    bind('currentLivePrice', state.market, 'livePrice'); bind('currentPrevClose', state.market, 'previousClose'); bind('currentClosePrice', state.market, 'closePrice');
    bind('isSRVisible', state.analysis, 'srVisible'); bind('srLines', state.analysis, 'srLines'); bind('srData', state.analysis, 'srData');
    bind('categoryRailCategories', state.analysis, 'categoryRail'); bind('selectedCategoryRail', state.analysis, 'selectedCategory');
    bind('activePositions', state.portfolio, 'positions'); bind('localPositions', state.portfolio, 'localPositions');
    Object.defineProperty(global, 'watchlist', {
        configurable: true,
        get: () => {
            const workspace = state.app.getState().workspace;
            const selected = state.watchlist.selectSelected(state.watchlist.getState());
            if (workspace.loaded && selected && Array.isArray(selected.items)) {
                return selected.items.map(item => String(item && item.ticker || '').toUpperCase().trim()).filter(Boolean);
            }
            return state.watchlist.getState().items;
        },
        set: value => state.watchlist.patch({ items: Array.isArray(value) ? value : [] }, { type: 'legacy/watchlist' }),
    });
    Object.defineProperty(global, 'favoriteTickers', {
        configurable: true,
        get: () => {
            const values = () => state.watchlist.getState().favorites;
            return {
                has: value => values().includes(String(value).toUpperCase()),
                add(value) { state.watchlist.patch({ favorites: [...new Set([...values(), String(value).toUpperCase()])] }, { type: 'favorites/add' }); return this; },
                delete(value) { const next = values().filter(item => item !== String(value).toUpperCase()); const changed = next.length !== values().length; if (changed) state.watchlist.patch({ favorites: next }, { type: 'favorites/delete' }); return changed; },
                clear: () => state.watchlist.patch({ favorites: [] }, { type: 'favorites/clear' }),
                values: () => values().values(), keys: () => values().values(), entries: () => values().map(value => [value, value]).values(),
                forEach: callback => values().forEach(value => callback(value, value)), get size() { return values().length; },
                [Symbol.iterator]: () => values()[Symbol.iterator](),
            };
        },
        set: value => state.watchlist.patch({ favorites: [...new Set(value ? Array.from(value, item => String(item).toUpperCase()) : [])] }, { type: 'legacy/favoriteTickers' }),
    });
    bind('sessionRecentViewed', state.session, 'recentViewed'); bindObject('authState', state.auth);
    bind('authFormMode', state.session, 'formMode'); bind('authSessionEpoch', state.session, 'authEpoch'); bind('authVerificationEmail', state.session, 'verificationEmail');
    bindObject('userPreferences', state.preferences); bindObject('alertCenter', state.notifications);
    bind('isNetworkOnline', state.app, 'networkOnline'); bind('isPageVisible', state.app, 'pageVisible');

    // Kept for legacy consumers, but derived from normalized watchlist and
    // portfolio entities instead of owning a second workspace data graph.
    const workspace = new Proxy({}, {
        get(_, key) {
            const app = state.app.getState(); const watchlists = state.watchlist.getState(); const portfolios = state.portfolio.getState();
            if (key === 'watchlists') return state.watchlist.selectAll(watchlists);
            if (key === 'portfolios') return state.portfolio.selectAll(portfolios);
            if (key === 'selectedWatchlistId') return watchlists.selectedId;
            if (key === 'selectedPortfolioId') return portfolios.selectedId;
            return app.workspace[key];
        },
        set(_, key, value) {
            if (key === 'watchlists') state.watchlist.replaceCloud(value);
            else if (key === 'portfolios') state.portfolio.replaceCloud(value);
            else if (key === 'selectedWatchlistId') state.watchlist.patch({ selectedId: value == null ? null : String(value) }, { type: 'watchlist/select' });
            else if (key === 'selectedPortfolioId') state.portfolio.patch({ selectedId: value == null ? null : String(value) }, { type: 'portfolio/select' });
            else state.app.update(current => ({ ...current, workspace: { ...current.workspace, [key]: value } }), { type: `workspace/${String(key)}` });
            return true;
        },
    });
    Object.defineProperty(global, 'cloudWorkspace', { configurable: true, get: () => workspace, set: value => {
        if (!value || typeof value !== 'object') return;
        Object.entries(value).forEach(([key, item]) => { workspace[key] = item; });
    }});

    global.quantoraSelectors = Object.freeze({
        selectedCloudWatchlist: () => state.watchlist.selectSelected(state.watchlist.getState()),
        selectedCloudPortfolio: () => state.portfolio.selectSelected(state.portfolio.getState()),
        unreadNotifications: () => state.notifications.getState().unreadCount,
    });
    let bindingsInstalled = false;
    global.installQuantoraStateBindings = () => {
        if (bindingsInstalled) return;
        bindingsInstalled = true;
        state.app.subscribe(online => {
            const banner = document.getElementById('network-banner');
            if (banner) banner.classList.toggle('is-visible', !online);
        }, value => value.networkOnline);
        state.market.subscribe(() => {
            if (typeof global.updateFavoriteButton === 'function') global.updateFavoriteButton();
            if (typeof global.renderWatchlist === 'function') global.renderWatchlist();
        }, value => value.ticker);
        state.notifications.subscribe(() => {
            if (typeof global.updateAlertNotificationBadges === 'function') global.updateAlertNotificationBadges();
            if (typeof global.renderAlertCenter === 'function') global.renderAlertCenter();
        }, value => ({ unread: value.unreadCount, loading: value.loading, error: value.error, alerts: value.alerts, notifications: value.notifications }), state.shallowEqual);
    };
}(window, window.quantoraState));
