// Quantora application-shell module: storage
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        // --- ⚙️ State Management & Data Fetching ---
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
                home_kicker: 'ศูนย์รวมเครื่องมือการลงทุนของคุณ',
                trending_industries: '8 กลุ่มอุตสาหกรรมที่น่าสนใจ',
                live_proxies: 'อ้างอิงข้อมูลตลาดล่าสุด', market_activity: 'เรียงตามความสนใจของตลาด',
                market_categories: 'สำรวจหมวดหุ้น',
                category_description: 'ราคาและแนวรับแนวต้านรายสัปดาห์ที่ใกล้ที่สุด',
                recently_viewed: 'ดูล่าสุด', cloud_synced: 'ซิงก์บนคลาวด์',
                industry_movers: 'กลุ่มที่ราคาขยับเด่น', category_performance: 'ผลตอบแทนตามหมวด',
                overview: 'ภาพรวม', company: 'บริษัท', financial: 'การเงิน', news: 'ข่าว', forecast: 'แนวโน้ม',
                home: 'หน้าหลัก', watchlist: 'รายการติดตาม', search: 'ค้นหา', tools: 'เครื่องมือ', portfolio: 'พอร์ต', profile: 'โปรไฟล์',
                favorite: 'รายการโปรด', favorited: 'บันทึกเป็นรายการโปรดแล้ว',
                workspace_settings: 'ตั้งค่าการใช้งาน', theme: 'ธีม', language: 'ภาษา', currency: 'สกุลเงิน', timeframe: 'ช่วงเวลาเริ่มต้น',
                auto_save: 'บันทึกการเปลี่ยนแปลงให้โดยอัตโนมัติบนคลาวด์',
                settings_session_only: 'การตั้งค่านี้ใช้ได้ทันทีในหน้านี้ และจะซิงก์เมื่อเปิดใช้บัญชีคลาวด์',
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

