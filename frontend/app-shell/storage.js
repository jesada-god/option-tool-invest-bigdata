// Quantora application-shell module: storage
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        // --- โ๏ธ State Management & Data Fetching ---
        // Domain values are owned by frontend/state/*.js.  The names below
        // remain available through the legacy bridge for inline controls.
        let isChangingData = false;
        const LOCAL_WATCHLIST_STORAGE_KEY = 'quantora.session-watchlist.v1';
        let ws = null;
        let wsReconnectTimer = null;
        let wsReconnectAttempts = 0;
        let wsConnectionEpoch = 0;
        let wsLastMessageAt = 0;
        let wsLastSequence = 0;
        let wsWatchdogTimer = null;
        let searchDebounce = null;
        let tickerSearchAbortController = null;
        let searchActivityAbortController = null;
        let categoryRailAbortController = null;
        let categoryRailRequestVersion = 0;
        const TRENDING_INDUSTRIES = Object.freeze([
            { name: 'AI', symbol: 'PLTR', count: 6 },
            { name: 'Semiconductor', symbol: 'NVDA', count: 18 },
            { name: 'Technology', symbol: 'AAPL', count: 8 },
            { name: 'Healthcare', symbol: 'UNH', count: 7 },
            { name: 'Banking', category: 'Bank', symbol: 'JPM', count: 8 },
            { name: 'Energy', symbol: 'XOM', count: 8 },
            { name: 'Crypto', symbol: 'COIN', count: 7 },
            { name: 'Defense', symbol: 'LMT', count: 7 },
        ]);
        const industrySnapshots = new Map();
        let dashboardAbortController = null;
        let chartRefreshAbortController = null;
        let gaugesAbortController = null;
        let viewEpoch = 0;
        let terminalResyncTimer = null;
        let portfolioRefreshTimer = null;
        let portfolioRefreshInFlight = false;
        let preferenceSyncTimer = null;
        let profileSheetReturnFocus = null;
        let pendingProfileAvatarUrl = null;
        const UI_TRANSLATIONS = Object.freeze({
            th: {
                home_kicker: 'เธจเธนเธเธขเนเธฃเธงเธกเน€เธเธฃเธทเนเธญเธเธกเธทเธญเธเธฒเธฃเธฅเธเธ—เธธเธเธเธญเธเธเธธเธ“',
                trending_industries: '8 เธเธฅเธธเนเธกเธญเธธเธ•เธชเธฒเธซเธเธฃเธฃเธกเธ—เธตเนเธเนเธฒเธชเธเนเธ',
                live_proxies: 'เธญเนเธฒเธเธญเธดเธเธเนเธญเธกเธนเธฅเธ•เธฅเธฒเธ”เธฅเนเธฒเธชเธธเธ”', market_activity: 'เน€เธฃเธตเธขเธเธ•เธฒเธกเธเธงเธฒเธกเธชเธเนเธเธเธญเธเธ•เธฅเธฒเธ”',
                market_categories: 'เธชเธณเธฃเธงเธเธซเธกเธงเธ”เธซเธธเนเธ',
                category_description: 'เธฃเธฒเธเธฒเนเธฅเธฐเนเธเธงเธฃเธฑเธเนเธเธงเธ•เนเธฒเธเธฃเธฒเธขเธชเธฑเธเธ”เธฒเธซเนเธ—เธตเนเนเธเธฅเนเธ—เธตเนเธชเธธเธ”',
                recently_viewed: 'เธ”เธนเธฅเนเธฒเธชเธธเธ”', cloud_synced: 'เธเธดเธเธเนเธเธเธเธฅเธฒเธงเธ”เน',
                industry_movers: 'เธเธฅเธธเนเธกเธ—เธตเนเธฃเธฒเธเธฒเธเธขเธฑเธเน€เธ”เนเธ', category_performance: 'เธเธฅเธ•เธญเธเนเธ—เธเธ•เธฒเธกเธซเธกเธงเธ”',
                overview: 'เธ เธฒเธเธฃเธงเธก', company: 'เธเธฃเธดเธฉเธฑเธ—', financial: 'เธเธฒเธฃเน€เธเธดเธ', news: 'เธเนเธฒเธง', forecast: 'เนเธเธงเนเธเนเธก',
                home: 'เธซเธเนเธฒเธซเธฅเธฑเธ', watchlist: 'เธฃเธฒเธขเธเธฒเธฃเธ•เธดเธ”เธ•เธฒเธก', search: 'เธเนเธเธซเธฒ', tools: 'เน€เธเธฃเธทเนเธญเธเธกเธทเธญ', portfolio: 'เธเธญเธฃเนเธ•', profile: 'เนเธเธฃเนเธเธฅเน',
                favorite: 'เธฃเธฒเธขเธเธฒเธฃเนเธเธฃเธ”', favorited: 'เธเธฑเธเธ—เธถเธเน€เธเนเธเธฃเธฒเธขเธเธฒเธฃเนเธเธฃเธ”เนเธฅเนเธง',
                workspace_settings: 'เธ•เธฑเนเธเธเนเธฒเธเธฒเธฃเนเธเนเธเธฒเธ', theme: 'เธเธตเธก', language: 'เธ เธฒเธฉเธฒ', currency: 'เธชเธเธธเธฅเน€เธเธดเธ', timeframe: 'เธเนเธงเธเน€เธงเธฅเธฒเน€เธฃเธดเนเธกเธ•เนเธ',
                auto_save: 'เธเธฑเธเธ—เธถเธเธเธฒเธฃเน€เธเธฅเธตเนเธขเธเนเธเธฅเธเนเธซเนเนเธ”เธขเธญเธฑเธ•เนเธเธกเธฑเธ•เธดเธเธเธเธฅเธฒเธงเธ”เน',
                settings_session_only: 'เธเธฒเธฃเธ•เธฑเนเธเธเนเธฒเธเธตเนเนเธเนเนเธ”เนเธ—เธฑเธเธ—เธตเนเธเธซเธเนเธฒเธเธตเน เนเธฅเธฐเธเธฐเธเธดเธเธเนเน€เธกเธทเนเธญเน€เธเธดเธ”เนเธเนเธเธฑเธเธเธตเธเธฅเธฒเธงเธ”เน',
            },
        });
        let cloudWorkspaceAbortController = null;

        // Cloud alert rules and the inbox are deliberately bounded client
        // state. Server data remains the source of truth; no alert or event is
        // written to browser storage.
        const ALERT_CENTER_POLL_MS = 20_000;
        // A Profile open/visibility transition may happen while a previous
        // poll request is still resolving.  The generation invalidates that
        // request's finally-handler so it cannot resurrect a second timer.
        let alertCenterPollGeneration = 0;
        let alertCenterLoadPromise = null;

        function isAbortError(error) {
            return error && error.name === 'AbortError';
        }

        function isCurrentView(context) {
            return Boolean(context) &&
                context.epoch === viewEpoch &&
                context.ticker === currentTicker &&
                context.timeframe === currentTimeframe &&
                (!context.signal || !context.signal.aborted);
        }

        function invalidateViewRequests() {
            viewEpoch += 1;
            [dashboardAbortController, chartRefreshAbortController, gaugesAbortController].forEach(controller => {
                if (controller && !controller.signal.aborted) controller.abort();
            });
            dashboardAbortController = null;
            chartRefreshAbortController = null;
            gaugesAbortController = null;
            return viewEpoch;
        }

        function makeDashboardContext() {
            if (dashboardAbortController && !dashboardAbortController.signal.aborted) {
                dashboardAbortController.abort();
            }
            const controller = new AbortController();
            dashboardAbortController = controller;
            return {
                epoch: ++viewEpoch,
                ticker: currentTicker,
                timeframe: currentTimeframe,
                signal: controller.signal,
            };
        }

        function currentViewContext() {
            return { epoch: viewEpoch, ticker: currentTicker, timeframe: currentTimeframe };
        }

        function getSRRightOffset() {
            const offset = Math.max(80, Math.min(120, Math.floor(window.innerWidth * 0.12)));
            return offset;
        }

