// Quantora application-shell module: router
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        const searchInput = document.getElementById('search-input');
        const autocompleteList = document.getElementById('autocomplete-list');

        const APP_ROUTES = Object.freeze({
            home: 'home-section', watchlist: 'watchlist-row', search: 'search-input',
            analysis: 'tvchart', tools: 'tools-section', portfolio: 'portfolio-section', profile: 'profile-sheet',
        });
        const ROUTE_MODULE_IMPORTERS = Object.freeze({
            home: () => import('/assets/routes/home.js'),
            watchlist: () => import('/assets/routes/watchlist.js'),
            search: () => import('/assets/routes/search.js'),
            analysis: () => import('/assets/routes/analysis.js'),
            tools: () => import('/assets/routes/tools.js'),
            portfolio: () => import('/assets/routes/portfolio.js'),
        });
        const routeResourceLoads = new Map();
        const routeModuleLoads = new Map();
        const prefetchedRouteModules = new Set();

        function activateTerminalRoute(target) {
            if (routeResourceLoads.has(target)) return routeResourceLoads.get(target);
            const tasks = {
                home: () => Promise.all([fetchDashboardData(), renderTrendingIndustries(), loadCategoryRail(), loadHomeAiRecommendation()]),
                watchlist: () => fetchWatchlist(),
                analysis: () => fetchDashboardData(),
                tools: () => { renderToolsCalculatorFields(); addScenarioCard(); },
                portfolio: () => loadPortfolioModuleData(),
                search: () => undefined,
            };
            const run = tasks[target];
            if (!run) return Promise.resolve();
            const load = Promise.resolve().then(run).catch(error => {
                routeResourceLoads.delete(target);
                throw error;
            });
            routeResourceLoads.set(target, load);
            return load;
        }

        // Route chunks stay separate from the application shell. Their only
        // responsibility is deciding when an existing engine becomes active.
        window.__quantoraRouteApi = Object.freeze({ activate: activateTerminalRoute });

        function loadRouteModule(target) {
            const importer = ROUTE_MODULE_IMPORTERS[target];
            if (!importer) return Promise.resolve();
            if (routeModuleLoads.has(target)) return routeModuleLoads.get(target);
            const load = importer()
                .then(module => typeof module.default === 'function' ? module.default() : undefined)
                .catch(error => {
                    routeModuleLoads.delete(target);
                    throw error;
                });
            routeModuleLoads.set(target, load);
            return load;
        }

        function prefetchRouteModule(target) {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (!ROUTE_MODULE_IMPORTERS[target] || prefetchedRouteModules.has(target) || connection?.saveData || /2g/.test(connection?.effectiveType || '')) return;
            prefetchedRouteModules.add(target);
            const schedule = window.requestIdleCallback || (callback => window.setTimeout(callback, 250));
            schedule(() => { void ROUTE_MODULE_IMPORTERS[target]().catch(() => prefetchedRouteModules.delete(target)); });
        }

        document.querySelectorAll('.pt-nav-item[data-nav]').forEach(item => {
            const target = item.dataset.nav;
            item.addEventListener('pointerenter', () => prefetchRouteModule(target), { passive: true });
            item.addEventListener('focusin', () => prefetchRouteModule(target));
        });

        function setNetworkStatus(isOnline) {
            isNetworkOnline = Boolean(isOnline);
            const banner = document.getElementById('network-banner');
            if (banner) banner.classList.toggle('is-visible', !isNetworkOnline);
            if (isNetworkOnline && typeof flushSafeTerminalActions === 'function') void flushSafeTerminalActions();
        }

        function setCloudSyncWarning(visible) {
            const banner = document.getElementById('cloud-sync-warning');
            if (!banner) return;
            banner.classList.toggle('is-visible', Boolean(visible));
            banner.setAttribute('aria-hidden', String(!visible));
        }

        function currentTerminalRoute() {
            const requested = decodeURIComponent((window.location.hash || '#/home').replace(/^#\/?/, '')).toLowerCase();
            if (requested.startsWith('portfolio/')) return 'portfolio';
            return requested === 'watchlists' ? 'watchlist' : requested;
        }

        function setInitialSkeletonLoading(loading) {
            document.querySelectorAll('.pt-stat-value, .pt-industry-performance, #home-live-price').forEach(element => {
                element.classList.toggle('pt-skeleton', loading);
                element.setAttribute('aria-busy', String(loading));
            });
        }

        function setAuthGate(visible) {
            const gate = document.getElementById('auth-gate');
            if (!gate) return;
            gate.classList.toggle('is-visible', Boolean(visible));
            gate.setAttribute('aria-hidden', String(!visible));
        }

        function showSystemScreen(title, copy, actionLabel = 'Try again', action = () => window.location.reload(), mark = '!') {
            const screen = document.getElementById('system-screen');
            if (!screen) return;
            document.getElementById('system-screen-mark').textContent = mark;
            document.getElementById('system-screen-title').textContent = title;
            document.getElementById('system-screen-copy').textContent = copy;
            const button = document.getElementById('system-screen-action');
            button.textContent = actionLabel;
            button.onclick = action;
            screen.classList.add('is-visible');
            screen.setAttribute('aria-hidden', 'false');
        }

        function clearSystemScreen() {
            const screen = document.getElementById('system-screen');
            if (!screen) return;
            screen.classList.remove('is-visible');
            screen.setAttribute('aria-hidden', 'true');
        }

        function applyRouteFromLocation() {
            const requested = decodeURIComponent((window.location.hash || '#/home').replace(/^#\/?/, '')).toLowerCase();
            if (requested.startsWith('portfolio/')) {
                const view = requested.slice('portfolio/'.length);
                if (!['overview', 'stocks', 'options'].includes(view)) {
                    showSystemScreen('Page not found', 'This portfolio destination does not exist or may have moved.', 'Open portfolio', () => { window.location.hash = '#/portfolio/overview'; }, '404');
                    return;
                }
                clearSystemScreen();
                navigateTerminal('portfolio', null, true);
                // The portfolio controller is lazy-loaded. On a fresh deep
                // link it does not exist until the route module finishes, so
                // wait for that shared route load before selecting a subview.
                void loadRouteModule('portfolio')
                    .then(() => selectPortfolioModuleView(view, null, true))
                    .catch(error => reportQuantoraError(error, { area: 'route:portfolio' }));
                return;
            }
            const target = requested === 'watchlists' ? 'watchlist' : requested;
            if (!Object.prototype.hasOwnProperty.call(APP_ROUTES, target)) {
                showSystemScreen('Page not found', 'This Quantora AI destination does not exist or may have moved.', 'Go to Home', () => {
                    window.location.hash = '#/home';
                }, '404');
                return;
            }
            clearSystemScreen();
            navigateTerminal(target, null, true);
        }

        window.addEventListener('hashchange', applyRouteFromLocation);
        window.addEventListener('online', () => setNetworkStatus(true));
        window.addEventListener('offline', () => setNetworkStatus(false));

