// --- ⚙️ State Management & Data Fetching ---
        let currentTicker = "NVDA";
        let currentTimeframe = "1d";
        let currentMarketSession = "CLOSED";
        let globalChartData = [];
        let isSRVisible = false;
        let srLines = [];
        let srData = null;
        let activePositions = [];
        let isChangingData = false;
        let currentLivePrice = null;
        let currentPrevClose = 0;
        let currentClosePrice = 0;
        let watchlist = [];
        let ws = null;
        let wsReconnectTimer = null;
        let wsReconnectAttempts = 0;
        let wsConnectionEpoch = 0;
        let wsLastMessageAt = 0;
        let wsLastSequence = 0;
        let wsWatchdogTimer = null;
        let searchDebounce = null;
        let tickerSearchAbortController = null;
        let categoryRailAbortController = null;
        let categoryRailRequestVersion = 0;
        let categoryRailCategories = [];
        let selectedCategoryRail = '';
        let dashboardAbortController = null;
        let chartRefreshAbortController = null;
        let gaugesAbortController = null;
        let viewEpoch = 0;
        let isPageVisible = document.visibilityState === 'visible';
        let isNetworkOnline = navigator.onLine;
        let terminalResyncTimer = null;
        let preferenceSyncTimer = null;
        let authFormMode = 'sign-in';
        let authSessionEpoch = 0;
        let authState = { configured: null, authenticated: false, user: null, googleEnabled: false, cloudSyncEnabled: false, csrfToken: null, recoveryMode: false };
        let cloudWorkspace = {
            watchlists: [],
            portfolios: [],
            selectedWatchlistId: null,
            selectedPortfolioId: null,
            loaded: false,
            loading: false,
            error: '',
            statusMessage: '',
            statusTone: '',
            requestVersion: 0,
        };
        let cloudWorkspaceAbortController = null;

        // Cloud alert rules and the inbox are deliberately bounded client
        // state. Server data remains the source of truth; no alert or event is
        // written to browser storage.
        const ALERT_CENTER_POLL_MS = 20_000;
        let alertCenterLoadPromise = null;
        let alertCenter = {
            alerts: [],
            notifications: [],
            unreadCount: 0,
            loading: false,
            error: '',
            statusMessage: '',
            statusTone: '',
            requestVersion: 0,
            abortController: null,
            pollTimer: null,
            draft: null,
        };

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

        const searchInput = document.getElementById('search-input');
        const autocompleteList = document.getElementById('autocomplete-list');

        // --- ✨ V2 application shell: navigation only, existing engines stay in place ---
        function setActiveNavigation(target) {
            document.querySelectorAll('.pt-nav-item').forEach(item => {
                item.classList.toggle('is-active', item.dataset.nav === target);
            });
        }

        function navigateTerminal(target, source) {
            if (target === 'profile') {
                setActiveNavigation('profile');
                openProfileSheet();
                return;
            }

            const targets = {
                home: 'home-section',
                watchlist: 'watchlist-row',
                search: 'search-input',
                analysis: 'tvchart',
                tools: 'tools-section',
                portfolio: 'portfolio-section',
            };
            const targetEl = document.getElementById(targets[target]);
            if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

            if (target === 'search') {
                setActiveNavigation('search');
                window.setTimeout(() => searchInput.focus({ preventScroll: true }), 220);
            } else if (target !== 'analysis') {
                setActiveNavigation(target);
            }

            if (source) setActiveNavigation(source.dataset.nav || target);
        }

        function openProfileSheet() {
            const sheet = document.getElementById('profile-sheet');
            renderProfileAuthContent();
            sheet.classList.add('is-open');
            sheet.setAttribute('aria-hidden', 'false');
            if (cloudWorkspaceEnabled()) {
                void loadCloudWorkspace();
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        }

        function closeProfileSheet() {
            const sheet = document.getElementById('profile-sheet');
            sheet.classList.remove('is-open');
            sheet.setAttribute('aria-hidden', 'true');
        }

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));
        }

        function profileInitials(user) {
            const source = user && (user.username || user.email || user.display_name);
            if (!source) return 'PT';
            return String(source).trim().slice(0, 2).toUpperCase() || 'PT';
        }

        function authHeaders(includeJson = false) {
            const headers = {};
            if (includeJson) headers['Content-Type'] = 'application/json';
            if (authState.csrfToken) headers['X-CSRF-Token'] = authState.csrfToken;
            return headers;
        }

        async function authFetch(input, init = {}) {
            const response = await fetch(input, { ...init, credentials: 'same-origin' });
            const refreshedCsrf = response.headers.get('X-CSRF-Token');
            if (refreshedCsrf) authState.csrfToken = refreshedCsrf;
            return response;
        }

        // --- Authenticated alert rules and notification inbox -------------
        // Only Price and Support/Resistance rules are surfaced as actionable
        // here. They are explicitly in-app notifications; push/email settings
        // are intentionally not implied by this UI.
        const ALERT_CENTER_TYPES = Object.freeze({
            price: 'Price',
            support_resistance: 'S/R',
        });
        const ALERT_CENTER_CONDITIONS = Object.freeze({
            price: Object.freeze([
                Object.freeze({ value: 'above', label: 'Price moves above' }),
                Object.freeze({ value: 'below', label: 'Price moves below' }),
                Object.freeze({ value: 'crosses_above', label: 'Crosses above' }),
                Object.freeze({ value: 'crosses_below', label: 'Crosses below' }),
            ]),
            support_resistance: Object.freeze([
                Object.freeze({ value: 'breakout', label: 'Resistance breakout' }),
                Object.freeze({ value: 'breakdown', label: 'Support breakdown' }),
                Object.freeze({ value: 'bounce', label: 'Support / resistance bounce' }),
            ]),
        });

        function alertCenterEnabled() {
            return Boolean(authState.authenticated && authState.cloudSyncEnabled);
        }

        function alertCenterTicker(value = currentTicker) {
            const ticker = String(value || '').trim().toUpperCase();
            return /^[A-Z0-9.-]{1,12}$/.test(ticker) ? ticker : '';
        }

        function alertCenterDefaultDraft() {
            return {
                ticker: alertCenterTicker(),
                alert_type: 'price',
                condition: 'above',
                target_value: '',
                cooldown_seconds: '300',
            };
        }

        function alertCenterDraft() {
            if (!alertCenter.draft || typeof alertCenter.draft !== 'object') {
                alertCenter.draft = alertCenterDefaultDraft();
            }
            const draft = alertCenter.draft;
            if (!ALERT_CENTER_TYPES[draft.alert_type]) draft.alert_type = 'price';
            const validConditions = ALERT_CENTER_CONDITIONS[draft.alert_type];
            if (!validConditions.some(item => item.value === draft.condition)) {
                draft.condition = validConditions[0].value;
            }
            if (!draft.ticker) draft.ticker = alertCenterTicker();
            return draft;
        }

        function alertCenterId(value) {
            const id = Number(value);
            return Number.isSafeInteger(id) && id > 0 ? id : null;
        }

        function isAlertCenterActionable(alert) {
            return Boolean(alert && ALERT_CENTER_TYPES[String(alert.alert_type || '')]);
        }

        function alertCenterTypeLabel(type) {
            return ALERT_CENTER_TYPES[String(type || '')] || 'Unavailable rule';
        }

        function alertCenterConditionLabel(type, condition) {
            const conditions = ALERT_CENTER_CONDITIONS[String(type || '')] || [];
            const matching = conditions.find(item => item.value === String(condition || ''));
            return matching ? matching.label : 'Unavailable condition';
        }

        function alertCenterNotificationTypeLabel(type) {
            if (type === 'price') return 'Price';
            if (type === 'support_resistance') return 'S/R';
            return 'Notification';
        }

        function alertCenterFormatTarget(value) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric < 0) return 'Target unavailable';
            return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
        }

        function alertCenterFormatCooldown(value) {
            const seconds = Number(value);
            if (!Number.isFinite(seconds) || seconds < 0) return 'cooldown unavailable';
            if (seconds === 0) return 'no cooldown';
            if (seconds % 3600 === 0) return `${seconds / 3600}h cooldown`;
            if (seconds % 60 === 0) return `${seconds / 60}m cooldown`;
            return `${seconds}s cooldown`;
        }

        function alertCenterFormatTime(value) {
            const timestamp = Date.parse(value || '');
            if (!Number.isFinite(timestamp)) return 'just now';
            try {
                return new Intl.DateTimeFormat(undefined, {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                }).format(new Date(timestamp));
            } catch (_) {
                return new Date(timestamp).toLocaleString();
            }
        }

        function alertCenterElement(tag, className = '', text = '') {
            const element = document.createElement(tag);
            if (className) element.className = className;
            if (text !== '') element.textContent = text;
            return element;
        }

        function alertCenterButton(label, handler, variant = '') {
            const button = alertCenterElement('button', `pt-alert-button${variant ? ` ${variant}` : ''}`, label);
            button.type = 'button';
            button.addEventListener('click', handler);
            return button;
        }

        function alertCenterInput(id, type, placeholder, value) {
            const input = document.createElement('input');
            input.id = id;
            input.type = type;
            input.placeholder = placeholder;
            input.autocomplete = 'off';
            input.value = value == null ? '' : String(value);
            return input;
        }

        function updateAlertNotificationBadges() {
            const rawCount = Number(alertCenter.unreadCount);
            const unreadCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
            const text = unreadCount > 99 ? '99+' : String(unreadCount);
            const topBadge = document.getElementById('notification-top-badge');
            const navBadge = document.getElementById('notification-nav-badge');
            const notificationButton = document.getElementById('notification-center-button');
            [topBadge, navBadge].forEach(badge => {
                if (!badge) return;
                badge.hidden = unreadCount === 0;
                badge.textContent = text;
                badge.setAttribute('aria-label', unreadCount === 1 ? '1 unread notification' : `${unreadCount} unread notifications`);
            });
            if (notificationButton) {
                notificationButton.setAttribute('aria-label', unreadCount === 1 ? '1 unread notification' : unreadCount ? `${unreadCount} unread notifications` : 'Notifications');
                notificationButton.title = unreadCount === 1 ? '1 unread notification' : unreadCount ? `${unreadCount} unread notifications` : 'Notifications';
            }
        }

        function setAlertCenterStatus(message = '', tone = '') {
            alertCenter.statusMessage = message;
            alertCenter.statusTone = tone;
            const status = document.getElementById('alert-center-status');
            if (!status) return;
            status.textContent = message;
            status.className = `pt-alert-status${tone ? ` ${tone}` : ''}`;
        }

        function resetAlertCenter() {
            if (alertCenter.abortController && !alertCenter.abortController.signal.aborted) {
                alertCenter.abortController.abort();
            }
            if (alertCenter.pollTimer) window.clearTimeout(alertCenter.pollTimer);
            const requestVersion = alertCenter.requestVersion + 1;
            alertCenterLoadPromise = null;
            alertCenter = {
                alerts: [], notifications: [], unreadCount: 0, loading: false, error: '',
                statusMessage: '', statusTone: '', requestVersion, abortController: null,
                pollTimer: null, draft: null,
            };
            updateAlertNotificationBadges();
        }

        function stopAlertCenterPolling() {
            if (alertCenter.pollTimer) window.clearTimeout(alertCenter.pollTimer);
            alertCenter.pollTimer = null;
        }

        function startAlertCenterPolling() {
            stopAlertCenterPolling();
            if (!alertCenterEnabled() || !isPageVisible || !isNetworkOnline) return;
            const poll = () => {
                if (!alertCenterEnabled() || !isPageVisible || !isNetworkOnline) {
                    alertCenter.pollTimer = null;
                    return;
                }
                void refreshAlertCenter({ quiet: true }).finally(() => {
                    if (alertCenterEnabled() && isPageVisible && isNetworkOnline) {
                        alertCenter.pollTimer = window.setTimeout(poll, ALERT_CENTER_POLL_MS);
                    }
                });
            };
            alertCenter.pollTimer = window.setTimeout(poll, ALERT_CENTER_POLL_MS);
        }

        async function alertCenterResponse(response, fallback) {
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(cloudWorkspaceErrorMessage(data, fallback));
            return data || {};
        }

        function renderAlertCreatePanel() {
            const panel = alertCenterElement('section', 'pt-alert-panel');
            panel.append(
                alertCenterElement('h4', '', 'Create a live rule'),
                alertCenterElement('p', 'pt-alert-empty', 'Price and S/R only. Events are delivered to this in-app inbox.'),
            );
            const draft = alertCenterDraft();
            const form = document.createElement('form');
            form.className = 'pt-alert-fields';
            form.noValidate = true;
            form.addEventListener('submit', event => {
                event.preventDefault();
                void createAlertCenterRule();
            });

            const ticker = alertCenterInput('alert-center-ticker', 'text', 'Ticker, e.g. NVDA', draft.ticker);
            ticker.maxLength = 12;
            ticker.setAttribute('aria-label', 'Alert ticker');
            ticker.addEventListener('input', () => { alertCenter.draft.ticker = ticker.value; });

            const type = document.createElement('select');
            type.id = 'alert-center-type';
            type.setAttribute('aria-label', 'Alert type');
            Object.entries(ALERT_CENTER_TYPES).forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = `${label} (in-app)`;
                option.selected = value === draft.alert_type;
                type.appendChild(option);
            });
            type.addEventListener('change', () => {
                alertCenter.draft.alert_type = type.value;
                alertCenter.draft.condition = ALERT_CENTER_CONDITIONS[type.value][0].value;
                renderAlertCenter();
            });

            const condition = document.createElement('select');
            condition.id = 'alert-center-condition';
            condition.setAttribute('aria-label', 'Alert condition');
            ALERT_CENTER_CONDITIONS[draft.alert_type].forEach(item => {
                const option = document.createElement('option');
                option.value = item.value;
                option.textContent = item.label;
                option.selected = item.value === draft.condition;
                condition.appendChild(option);
            });
            condition.addEventListener('change', () => { alertCenter.draft.condition = condition.value; });

            const target = alertCenterInput('alert-center-target', 'number', 'Target price / S&R level', draft.target_value);
            target.min = '0';
            target.step = 'any';
            target.inputMode = 'decimal';
            target.setAttribute('aria-label', 'Target price or support resistance level');
            target.addEventListener('input', () => { alertCenter.draft.target_value = target.value; });

            const cooldown = alertCenterInput('alert-center-cooldown', 'number', 'Cooldown seconds', draft.cooldown_seconds);
            cooldown.min = '0';
            cooldown.max = '604800';
            cooldown.step = '1';
            cooldown.inputMode = 'numeric';
            cooldown.setAttribute('aria-label', 'Cooldown seconds');
            cooldown.addEventListener('input', () => { alertCenter.draft.cooldown_seconds = cooldown.value; });

            const split = alertCenterElement('div', 'pt-alert-split');
            split.append(type, condition);
            const numericSplit = alertCenterElement('div', 'pt-alert-split');
            numericSplit.append(target, cooldown);
            const submit = alertCenterButton('Create in-app rule', () => {}, '');
            submit.type = 'submit';
            form.append(ticker, split, numericSplit, submit);
            panel.appendChild(form);
            return panel;
        }

        function renderAlertRulesPanel() {
            const panel = alertCenterElement('section', 'pt-alert-panel');
            panel.append(
                alertCenterElement('h4', '', 'Your live rules'),
                alertCenterElement('p', 'pt-alert-empty', 'Enable, pause, or remove rules tied to your account.'),
            );
            const list = alertCenterElement('div', 'pt-alert-list');
            const alerts = Array.isArray(alertCenter.alerts) ? alertCenter.alerts : [];
            if (!alerts.length) {
                list.appendChild(alertCenterElement('p', 'pt-alert-empty', 'No cloud alert rules yet.'));
            } else {
                alerts.forEach(alert => {
                    const id = alertCenterId(alert && alert.id);
                    if (!id) return;
                    const row = alertCenterElement('article', 'pt-alert-row');
                    const content = document.createElement('div');
                    const type = String(alert.alert_type || '');
                    const ticker = alertCenterTicker(alert.ticker) || 'Market';
                    const name = typeof alert.name === 'string' && alert.name.trim()
                        ? alert.name.trim()
                        : `${ticker} ${alertCenterTypeLabel(type)}`;
                    const title = alertCenterElement('strong', '', name);
                    const target = alertCenterFormatTarget(alert.target_value);
                    const condition = alertCenterConditionLabel(type, alert.condition);
                    const state = alert.is_enabled ? 'active' : 'paused';
                    const detail = alertCenterElement(
                        'span', '', `${ticker} · ${alertCenterTypeLabel(type)} · ${condition} ${target} · ${state} · ${alertCenterFormatCooldown(alert.cooldown_seconds)}`,
                    );
                    content.append(title, detail);

                    const actions = alertCenterElement('div', 'pt-alert-actions');
                    if (isAlertCenterActionable(alert)) {
                        actions.appendChild(alertCenterButton(
                            alert.is_enabled ? 'Pause' : 'Enable',
                            () => void toggleAlertCenterRule(id, Boolean(alert.is_enabled)),
                            'ghost',
                        ));
                    } else {
                        const unsupported = alertCenterButton('Not live here', () => {}, 'ghost');
                        unsupported.disabled = true;
                        unsupported.title = 'Only Price and S/R rules are actionable in this in-app surface.';
                        actions.appendChild(unsupported);
                    }
                    actions.appendChild(alertCenterButton('Delete', () => void deleteAlertCenterRule(id), 'danger'));
                    row.append(content, actions);
                    list.appendChild(row);
                });
            }
            panel.appendChild(list);
            return panel;
        }

        function renderAlertNotificationPanel() {
            const panel = alertCenterElement('section', 'pt-alert-panel pt-alert-inbox-panel');
            const heading = alertCenterElement('div', 'pt-alert-head');
            const copy = document.createElement('div');
            copy.append(
                alertCenterElement('h4', '', 'In-app notification inbox'),
                alertCenterElement('p', '', 'Recent Price and S/R events from your cloud rules.'),
            );
            const unread = alertCenterElement('span', 'pt-alert-unread', String(Math.max(0, Number(alertCenter.unreadCount) || 0)));
            unread.setAttribute('aria-label', 'Unread notifications');
            heading.append(copy, unread);
            panel.appendChild(heading);

            const actionRow = alertCenterElement('div', 'pt-alert-actions');
            const readAll = alertCenterButton('Mark all read', () => void markAllAlertNotificationsRead(), 'ghost');
            readAll.disabled = !(Number(alertCenter.unreadCount) > 0);
            actionRow.appendChild(readAll);
            panel.appendChild(actionRow);

            const list = alertCenterElement('div', 'pt-alert-list');
            const notifications = Array.isArray(alertCenter.notifications) ? alertCenter.notifications : [];
            if (!notifications.length) {
                list.appendChild(alertCenterElement('p', 'pt-alert-empty', 'No in-app notifications yet.'));
            } else {
                notifications.forEach(notification => {
                    const id = alertCenterId(notification && notification.id);
                    if (!id) return;
                    const severity = String(notification.severity || 'info');
                    const row = alertCenterElement(
                        'article', `pt-alert-row${notification.read_at ? ' is-read' : ''}${severity === 'critical' ? ' is-critical' : ''}`,
                    );
                    const content = document.createElement('div');
                    const title = alertCenterElement(
                        'strong', '', typeof notification.title === 'string' && notification.title.trim()
                            ? notification.title.trim()
                            : `${alertCenterNotificationTypeLabel(notification.notification_type)} alert`,
                    );
                    const ticker = alertCenterTicker(notification.ticker);
                    const bodyText = typeof notification.body === 'string' ? notification.body.trim() : '';
                    const description = [
                        alertCenterNotificationTypeLabel(notification.notification_type),
                        ticker || null,
                        bodyText || null,
                        alertCenterFormatTime(notification.created_at),
                    ].filter(Boolean).join(' · ');
                    content.append(title, alertCenterElement('span', '', description));

                    const actions = alertCenterElement('div', 'pt-alert-actions');
                    if (!notification.read_at) {
                        actions.appendChild(alertCenterButton('Read', () => void markAlertNotificationRead(id), 'ghost'));
                    }
                    actions.appendChild(alertCenterButton('Delete', () => void deleteAlertNotification(id), 'danger'));
                    row.append(content, actions);
                    list.appendChild(row);
                });
            }
            panel.appendChild(list);
            return panel;
        }

        function renderAlertCenter() {
            updateAlertNotificationBadges();
            const host = document.getElementById('alert-center-content');
            if (!host || !alertCenterEnabled()) return;
            host.replaceChildren();

            const head = alertCenterElement('div', 'pt-alert-head');
            const heading = document.createElement('div');
            heading.append(
                alertCenterElement('h3', '', 'Alerts & notification inbox'),
                alertCenterElement('p', '', 'Live in-app only: Price and Support/Resistance. Your account controls every rule.'),
            );
            const unread = alertCenterElement('span', 'pt-alert-unread', String(Math.max(0, Number(alertCenter.unreadCount) || 0)));
            unread.setAttribute('aria-label', 'Unread notifications');
            head.append(heading, unread);
            host.appendChild(head);

            if (alertCenter.loading && !alertCenter.alerts.length && !alertCenter.notifications.length) {
                host.appendChild(alertCenterElement('p', 'pt-alert-status', 'Loading your alert rules and inbox…'));
                return;
            }
            if (alertCenter.error && !alertCenter.alerts.length && !alertCenter.notifications.length) {
                host.appendChild(alertCenterElement('p', 'pt-alert-status error', alertCenter.error));
                return;
            }

            const grid = alertCenterElement('div', 'pt-alert-grid');
            grid.append(renderAlertCreatePanel(), renderAlertRulesPanel(), renderAlertNotificationPanel());
            host.appendChild(grid);
            const status = alertCenterElement(
                'p', `pt-alert-status${alertCenter.statusTone ? ` ${alertCenter.statusTone}` : ''}`,
                alertCenter.statusMessage || alertCenter.error,
            );
            status.id = 'alert-center-status';
            host.appendChild(status);
        }

        async function refreshAlertCenter({ quiet = false, force = false } = {}) {
            if (!alertCenterEnabled()) {
                resetAlertCenter();
                return false;
            }
            if (!isNetworkOnline) return false;
            if (alertCenterLoadPromise) {
                if (!force) return alertCenterLoadPromise;
                if (alertCenter.abortController && !alertCenter.abortController.signal.aborted) {
                    alertCenter.abortController.abort();
                }
                alertCenterLoadPromise = null;
            }

            const requestVersion = ++alertCenter.requestVersion;
            const controller = new AbortController();
            alertCenter.abortController = controller;
            alertCenter.loading = true;
            alertCenter.error = '';
            if (!quiet) renderAlertCenter();

            const task = (async () => {
                try {
                    const [alertsResponse, notificationsResponse] = await Promise.all([
                        authFetch('/api/alerts', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                        authFetch('/api/notifications?limit=20', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                    ]);
                    const [alertsData, notificationsData] = await Promise.all([
                        alertCenterResponse(alertsResponse, 'Unable to load alert rules.'),
                        alertCenterResponse(notificationsResponse, 'Unable to load notifications.'),
                    ]);
                    if (requestVersion !== alertCenter.requestVersion || !alertCenterEnabled()) return false;
                    alertCenter.alerts = Array.isArray(alertsData.items) ? alertsData.items : [];
                    alertCenter.notifications = Array.isArray(notificationsData.items) ? notificationsData.items : [];
                    const unreadCount = Number(notificationsData.unread_count);
                    alertCenter.unreadCount = Number.isFinite(unreadCount) && unreadCount >= 0 ? Math.floor(unreadCount) : 0;
                    alertCenter.error = '';
                    renderAlertCenter();
                    return true;
                } catch (error) {
                    if (error && error.name === 'AbortError') return false;
                    if (requestVersion === alertCenter.requestVersion && alertCenterEnabled()) {
                        alertCenter.error = error && error.message ? error.message : 'Unable to load your alert center.';
                        renderAlertCenter();
                    }
                    return false;
                } finally {
                    if (requestVersion === alertCenter.requestVersion) {
                        alertCenter.loading = false;
                        if (alertCenterEnabled()) renderAlertCenter();
                    }
                    if (alertCenter.abortController === controller) alertCenter.abortController = null;
                }
            })();
            alertCenterLoadPromise = task;
            try {
                return await task;
            } finally {
                if (alertCenterLoadPromise === task) alertCenterLoadPromise = null;
            }
        }

        async function mutateAlertCenter(url, init, successMessage) {
            if (!alertCenterEnabled()) {
                setAlertCenterStatus('Sign in with cloud sync enabled to manage alerts.', 'error');
                return false;
            }
            setAlertCenterStatus('Saving alert change…');
            try {
                const response = await authFetch(url, init);
                await alertCenterResponse(response, 'Alert change was not accepted.');
                await refreshAlertCenter({ quiet: true, force: true });
                setAlertCenterStatus(successMessage, 'success');
                startAlertCenterPolling();
                return true;
            } catch (error) {
                setAlertCenterStatus(error && error.message ? error.message : 'Unable to save alert change.', 'error');
                return false;
            }
        }

        async function createAlertCenterRule() {
            if (!alertCenterEnabled()) return;
            const draft = alertCenterDraft();
            const ticker = alertCenterTicker(draft.ticker);
            const target = String(draft.target_value || '').trim();
            const targetNumber = Number(target);
            const cooldownNumber = Number(draft.cooldown_seconds);
            if (!ticker) {
                setAlertCenterStatus('Enter a valid ticker, for example NVDA.', 'error');
                return;
            }
            if (!target || !Number.isFinite(targetNumber) || targetNumber < 0) {
                setAlertCenterStatus('Enter a valid non-negative target price or S/R level.', 'error');
                return;
            }
            if (!Number.isInteger(cooldownNumber) || cooldownNumber < 0 || cooldownNumber > 604800) {
                setAlertCenterStatus('Cooldown must be a whole number of seconds (0–604800).', 'error');
                return;
            }
            const payload = {
                alert_type: draft.alert_type,
                condition: draft.condition,
                ticker,
                target_value: target,
                cooldown_seconds: cooldownNumber,
                delivery_channels: ['in_app'],
                is_enabled: true,
            };
            const created = await mutateAlertCenter('/api/alerts', {
                method: 'POST', headers: authHeaders(true), body: JSON.stringify(payload),
            }, `${ticker} ${alertCenterTypeLabel(draft.alert_type)} rule created.`);
            if (created) {
                alertCenter.draft = { ...alertCenterDefaultDraft(), ticker, alert_type: draft.alert_type };
                alertCenter.draft.condition = ALERT_CENTER_CONDITIONS[draft.alert_type][0].value;
                renderAlertCenter();
            }
        }

        async function toggleAlertCenterRule(id, isEnabled) {
            if (!alertCenterId(id)) return;
            await mutateAlertCenter(`/api/alerts/${id}`, {
                method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ is_enabled: !isEnabled }),
            }, isEnabled ? 'Alert paused.' : 'Alert enabled.');
        }

        async function deleteAlertCenterRule(id) {
            if (!alertCenterId(id)) return;
            if (!window.confirm('Delete this alert rule? Past inbox events will remain.')) return;
            await mutateAlertCenter(`/api/alerts/${id}`, {
                method: 'DELETE', headers: authHeaders(),
            }, 'Alert deleted.');
        }

        async function markAlertNotificationRead(id) {
            if (!alertCenterId(id)) return;
            await mutateAlertCenter(`/api/notifications/${id}/read`, {
                method: 'PATCH', headers: authHeaders(),
            }, 'Notification marked as read.');
        }

        async function markAllAlertNotificationsRead() {
            if (!(Number(alertCenter.unreadCount) > 0)) return;
            await mutateAlertCenter('/api/notifications/read-all', {
                method: 'POST', headers: authHeaders(),
            }, 'All notifications marked as read.');
        }

        async function deleteAlertNotification(id) {
            if (!alertCenterId(id)) return;
            await mutateAlertCenter(`/api/notifications/${id}`, {
                method: 'DELETE', headers: authHeaders(),
            }, 'Notification deleted.');
        }

        function openNotificationInbox() {
            openProfileSheet();
            window.requestAnimationFrame(() => {
                const manager = document.getElementById('alert-center-manager');
                if (manager) manager.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
        }

        // --- Authenticated cloud workspace ---------------------------------
        // Selection is deliberately in-memory only. The API remains the source
        // of truth and legacy users keep the existing /api/watchlist workflow.
        let cloudWorkspaceLoadPromise = null;

        function cloudWorkspaceEnabled() {
            return Boolean(authState.authenticated && authState.cloudSyncEnabled);
        }

        function cloudWorkspaceId(value) {
            const id = Number(value);
            return Number.isSafeInteger(id) && id > 0 ? id : null;
        }

        function resetCloudWorkspace() {
            if (cloudWorkspaceAbortController && !cloudWorkspaceAbortController.signal.aborted) {
                cloudWorkspaceAbortController.abort();
            }
            cloudWorkspaceAbortController = null;
            cloudWorkspaceLoadPromise = null;
            cloudWorkspace = {
                watchlists: [], portfolios: [], selectedWatchlistId: null, selectedPortfolioId: null,
                loaded: false, loading: false, error: '', statusMessage: '', statusTone: '',
                requestVersion: cloudWorkspace.requestVersion + 1,
            };
            updatePositionPortfolioSelector();
        }

        function cloudWorkspaceErrorMessage(data, fallback) {
            if (data && typeof data.detail === 'string') return data.detail;
            if (data && typeof data.message === 'string') return data.message;
            if (data && Array.isArray(data.detail)) {
                const messages = data.detail.map(item => item && (item.msg || item.message)).filter(Boolean);
                if (messages.length) return messages.join(' ');
            }
            return fallback;
        }

        async function cloudWorkspaceResponse(response, fallback) {
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(cloudWorkspaceErrorMessage(data, fallback));
            return data || {};
        }

        function selectedCloudWatchlist() {
            const id = cloudWorkspaceId(cloudWorkspace.selectedWatchlistId);
            return cloudWorkspace.watchlists.find(item => cloudWorkspaceId(item && item.id) === id) || null;
        }

        function selectedCloudPortfolio() {
            const id = cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
            return cloudWorkspace.portfolios.find(item => cloudWorkspaceId(item && item.id) === id) || null;
        }

        function selectWorkspaceDefaults() {
            const watchlists = Array.isArray(cloudWorkspace.watchlists) ? cloudWorkspace.watchlists : [];
            const portfolios = Array.isArray(cloudWorkspace.portfolios) ? cloudWorkspace.portfolios : [];
            if (!watchlists.some(item => cloudWorkspaceId(item && item.id) === cloudWorkspaceId(cloudWorkspace.selectedWatchlistId))) {
                const fallbackWatchlist = watchlists.find(item => item && item.is_default) || watchlists[0] || null;
                cloudWorkspace.selectedWatchlistId = fallbackWatchlist ? cloudWorkspaceId(fallbackWatchlist.id) : null;
            }
            if (!portfolios.some(item => cloudWorkspaceId(item && item.id) === cloudWorkspaceId(cloudWorkspace.selectedPortfolioId))) {
                const fallbackPortfolio = portfolios.find(item => item && item.is_default) || portfolios[0] || null;
                cloudWorkspace.selectedPortfolioId = fallbackPortfolio ? cloudWorkspaceId(fallbackPortfolio.id) : null;
            }
        }

        function cloudWatchlistTickers(watchlistItem) {
            if (!watchlistItem || !Array.isArray(watchlistItem.items)) return [];
            return watchlistItem.items
                .map(item => String(item && item.ticker || '').toUpperCase().trim())
                .filter(ticker => /^[A-Z0-9.-]{1,12}$/.test(ticker));
        }

        function syncSelectedCloudWatchlist() {
            if (!cloudWorkspaceEnabled() || !cloudWorkspace.loaded) return;
            watchlist = cloudWatchlistTickers(selectedCloudWatchlist());
            renderWatchlist();
            updateHomeWatchlistSurface();
        }

        function updatePositionPortfolioSelector() {
            const selector = document.getElementById('form-portfolio-id');
            if (!selector) return;
            const portfolios = Array.isArray(cloudWorkspace.portfolios)
                ? cloudWorkspace.portfolios.filter(item => item && !item.archived_at)
                : [];
            const cloudEnabled = cloudWorkspaceEnabled() && portfolios.length > 0;
            selector.hidden = !cloudEnabled;
            selector.disabled = !cloudEnabled;
            selector.replaceChildren();
            if (!cloudEnabled) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'Default portfolio';
                selector.appendChild(option);
                return;
            }

            const selectedId = cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
            portfolios.forEach(portfolio => {
                const option = document.createElement('option');
                option.value = String(portfolio.id);
                option.textContent = `${portfolio.name}${portfolio.is_default ? ' · Default' : ''}`;
                option.selected = cloudWorkspaceId(portfolio.id) === selectedId;
                selector.appendChild(option);
            });
            if (!selector.value && selector.options.length) selector.selectedIndex = 0;
        }

        function setCloudWorkspaceStatus(message = '', tone = '') {
            cloudWorkspace.statusMessage = message;
            cloudWorkspace.statusTone = tone;
            const status = document.getElementById('cloud-workspace-status');
            if (!status) return;
            status.textContent = message;
            status.className = `pt-workspace-status${tone ? ` ${tone}` : ''}`;
        }

        function cloudWorkspaceElement(tag, className = '', text = '') {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text) node.textContent = text;
            return node;
        }

        function cloudWorkspaceButton(label, handler, variant = '') {
            const button = cloudWorkspaceElement('button', `pt-workspace-button${variant ? ` ${variant}` : ''}`, label);
            button.type = 'button';
            button.addEventListener('click', handler);
            return button;
        }

        function cloudWorkspaceInput(id, placeholder, value = '') {
            const input = document.createElement('input');
            input.id = id;
            input.type = 'text';
            input.autocomplete = 'off';
            input.maxLength = 80;
            input.placeholder = placeholder;
            input.value = value || '';
            return input;
        }

        function cloudWorkspacePanel(title, copy) {
            const panel = cloudWorkspaceElement('section', 'pt-workspace-panel');
            panel.append(cloudWorkspaceElement('h4', '', title), cloudWorkspaceElement('p', '', copy));
            return panel;
        }

        function renderCloudWatchlistPanel() {
            const panel = cloudWorkspacePanel('Named watchlists', 'Select a list to drive the watchlist rail and add symbols to it.');
            const watchlists = Array.isArray(cloudWorkspace.watchlists) ? cloudWorkspace.watchlists : [];
            const selected = selectedCloudWatchlist();
            const fields = cloudWorkspaceElement('div', 'pt-workspace-fields');
            const selector = document.createElement('select');
            selector.id = 'cloud-watchlist-select';
            selector.disabled = !watchlists.length;
            watchlists.forEach(item => {
                const option = document.createElement('option');
                option.value = String(item.id);
                option.textContent = `${item.name}${item.is_default ? ' · Default' : ''}${item.is_pinned ? ' · Pinned' : ''}`;
                option.selected = cloudWorkspaceId(item.id) === cloudWorkspaceId(cloudWorkspace.selectedWatchlistId);
                selector.appendChild(option);
            });
            selector.addEventListener('change', event => selectCloudWatchlist(event.target.value));
            fields.appendChild(selector);

            const renameRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            const renameInput = cloudWorkspaceInput('cloud-watchlist-name', 'Watchlist name', selected && selected.name);
            renameInput.disabled = !selected;
            renameRow.append(renameInput, cloudWorkspaceButton('Save', renameCloudWatchlist, 'ghost'));
            fields.appendChild(renameRow);

            const createRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            createRow.append(cloudWorkspaceInput('cloud-watchlist-create', 'New watchlist'), cloudWorkspaceButton('Create', createCloudWatchlist));
            fields.appendChild(createRow);

            const tickerRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            const tickerInput = cloudWorkspaceInput('cloud-watchlist-ticker', 'Ticker e.g. NVDA');
            tickerInput.maxLength = 12;
            tickerRow.append(tickerInput, cloudWorkspaceButton('Add', addTickerToSelectedCloudWatchlist));
            fields.appendChild(tickerRow);

            const currentButton = cloudWorkspaceButton(`Add ${currentTicker}`, () => addTickerToSelectedCloudWatchlist(currentTicker), 'ghost');
            currentButton.disabled = !selected;
            fields.appendChild(currentButton);

            const tickerList = cloudWorkspaceElement('div', 'pt-workspace-ticker-list');
            const items = selected && Array.isArray(selected.items) ? selected.items : [];
            if (!items.length) {
                tickerList.appendChild(cloudWorkspaceElement('p', 'pt-workspace-empty', 'No symbols in this watchlist yet.'));
            } else {
                items.forEach(item => {
                    const ticker = String(item && item.ticker || '').toUpperCase();
                    if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return;
                    const pill = cloudWorkspaceElement('span', 'pt-workspace-ticker', ticker);
                    const remove = cloudWorkspaceButton('×', () => removeTickerFromSelectedCloudWatchlist(ticker));
                    remove.className = '';
                    remove.setAttribute('aria-label', `Remove ${ticker}`);
                    pill.appendChild(remove);
                    tickerList.appendChild(pill);
                });
            }
            fields.appendChild(tickerList);

            const deleteButton = cloudWorkspaceButton('Delete selected', deleteCloudWatchlist, 'danger');
            deleteButton.disabled = !selected;
            fields.appendChild(deleteButton);
            panel.appendChild(fields);
            return panel;
        }

        function renderCloudPortfolioPanel() {
            const panel = cloudWorkspacePanel('Portfolios', 'The selected portfolio is attached to the next option position you open.');
            const portfolios = Array.isArray(cloudWorkspace.portfolios) ? cloudWorkspace.portfolios.filter(item => item && !item.archived_at) : [];
            const selected = selectedCloudPortfolio();
            const fields = cloudWorkspaceElement('div', 'pt-workspace-fields');
            const selector = document.createElement('select');
            selector.id = 'cloud-portfolio-select';
            selector.disabled = !portfolios.length;
            portfolios.forEach(item => {
                const option = document.createElement('option');
                option.value = String(item.id);
                option.textContent = `${item.name}${item.is_default ? ' · Default' : ''} · ${item.currency || 'USD'}`;
                option.selected = cloudWorkspaceId(item.id) === cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
                selector.appendChild(option);
            });
            selector.addEventListener('change', event => selectCloudPortfolio(event.target.value));
            fields.appendChild(selector);

            const renameRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            const renameInput = cloudWorkspaceInput('cloud-portfolio-name', 'Portfolio name', selected && selected.name);
            renameInput.disabled = !selected;
            renameRow.append(renameInput, cloudWorkspaceButton('Save', renameCloudPortfolio, 'ghost'));
            fields.appendChild(renameRow);

            const createRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            createRow.append(cloudWorkspaceInput('cloud-portfolio-create', 'New portfolio'), cloudWorkspaceButton('Create', createCloudPortfolio));
            fields.appendChild(createRow);

            const archiveButton = cloudWorkspaceButton('Archive selected', archiveCloudPortfolio, 'danger');
            archiveButton.disabled = !selected;
            fields.appendChild(archiveButton);
            panel.appendChild(fields);
            return panel;
        }

        function renderCloudWorkspaceManager() {
            const host = document.getElementById('cloud-workspace-content');
            if (!host || !cloudWorkspaceEnabled()) return;
            host.replaceChildren();

            const head = cloudWorkspaceElement('div', 'pt-workspace-head');
            const heading = document.createElement('div');
            heading.append(
                cloudWorkspaceElement('p', 'pt-workspace-kicker', 'Cloud workspace'),
                cloudWorkspaceElement('h3', 'pt-workspace-title', 'Watchlists & portfolios'),
                cloudWorkspaceElement('p', 'pt-workspace-copy', 'Changes are saved to your signed-in account.'),
            );
            const headActions = cloudWorkspaceElement('div', 'pt-workspace-head-actions');
            const refreshButton = cloudWorkspaceButton('Refresh', () => void loadCloudWorkspace(), 'ghost');
            refreshButton.setAttribute('aria-label', 'Refresh cloud workspace');
            headActions.append(cloudWorkspaceElement('span', 'pt-workspace-live-badge', 'SYNCED'), refreshButton);
            head.append(heading, headActions);
            host.appendChild(head);

            if (cloudWorkspace.loading && !cloudWorkspace.loaded) {
                host.appendChild(cloudWorkspaceElement('p', 'pt-workspace-status', 'Loading your workspace…'));
                return;
            }
            if (cloudWorkspace.error && !cloudWorkspace.loaded) {
                host.appendChild(cloudWorkspaceElement('p', 'pt-workspace-status error', cloudWorkspace.error));
                return;
            }

            const grid = cloudWorkspaceElement('div', 'pt-workspace-grid');
            grid.append(renderCloudWatchlistPanel(), renderCloudPortfolioPanel());
            host.appendChild(grid);
            const status = cloudWorkspaceElement('p', `pt-workspace-status${cloudWorkspace.statusTone ? ` ${cloudWorkspace.statusTone}` : ''}`, cloudWorkspace.statusMessage);
            status.id = 'cloud-workspace-status';
            host.appendChild(status);
        }

        async function loadCloudWorkspace() {
            if (!cloudWorkspaceEnabled()) {
                resetCloudWorkspace();
                return false;
            }
            if (cloudWorkspaceLoadPromise) return cloudWorkspaceLoadPromise;

            const requestVersion = ++cloudWorkspace.requestVersion;
            const controller = new AbortController();
            cloudWorkspaceAbortController = controller;
            cloudWorkspace.loading = true;
            cloudWorkspace.error = '';
            renderCloudWorkspaceManager();

            const task = (async () => {
                try {
                    const [watchlistResponse, portfolioResponse] = await Promise.all([
                        authFetch('/api/watchlists', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                        authFetch('/api/portfolios', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                    ]);
                    const [watchlistData, portfolioData] = await Promise.all([
                        cloudWorkspaceResponse(watchlistResponse, 'Unable to load watchlists.'),
                        cloudWorkspaceResponse(portfolioResponse, 'Unable to load portfolios.'),
                    ]);
                    if (requestVersion !== cloudWorkspace.requestVersion || !cloudWorkspaceEnabled()) return false;
                    cloudWorkspace.watchlists = Array.isArray(watchlistData.items) ? watchlistData.items : [];
                    cloudWorkspace.portfolios = Array.isArray(portfolioData.items) ? portfolioData.items : [];
                    cloudWorkspace.loaded = true;
                    cloudWorkspace.error = '';
                    selectWorkspaceDefaults();
                    syncSelectedCloudWatchlist();
                    updatePositionPortfolioSelector();
                    renderCloudWorkspaceManager();
                    return true;
                } catch (error) {
                    if (error && error.name === 'AbortError') return false;
                    if (requestVersion === cloudWorkspace.requestVersion) {
                        cloudWorkspace.loaded = false;
                        cloudWorkspace.error = error.message || 'Unable to load your cloud workspace.';
                        updatePositionPortfolioSelector();
                        renderCloudWorkspaceManager();
                    }
                    return false;
                } finally {
                    if (requestVersion === cloudWorkspace.requestVersion) {
                        cloudWorkspace.loading = false;
                        renderCloudWorkspaceManager();
                    }
                    if (cloudWorkspaceAbortController === controller) cloudWorkspaceAbortController = null;
                }
            })();
            cloudWorkspaceLoadPromise = task;
            try {
                return await task;
            } finally {
                if (cloudWorkspaceLoadPromise === task) cloudWorkspaceLoadPromise = null;
            }
        }

        async function mutateCloudWorkspace(url, init, successMessage, selectFromResponse) {
            if (!cloudWorkspaceEnabled()) {
                setCloudWorkspaceStatus('Sign in with cloud sync enabled to manage this workspace.', 'error');
                return null;
            }
            setCloudWorkspaceStatus('Saving workspace change…');
            try {
                const response = await authFetch(url, init);
                const data = await cloudWorkspaceResponse(response, 'Workspace change was not accepted.');
                if (typeof selectFromResponse === 'function') selectFromResponse(data);
                const loaded = await loadCloudWorkspace();
                if (!loaded) throw new Error('Workspace changed, but the latest data could not be loaded.');
                setCloudWorkspaceStatus(successMessage, 'success');
                return data;
            } catch (error) {
                setCloudWorkspaceStatus(error.message || 'Unable to save workspace change.', 'error');
                return null;
            }
        }

        function selectCloudWatchlist(value) {
            const id = cloudWorkspaceId(value);
            if (!cloudWorkspace.watchlists.some(item => cloudWorkspaceId(item && item.id) === id)) return;
            cloudWorkspace.selectedWatchlistId = id;
            syncSelectedCloudWatchlist();
            renderCloudWorkspaceManager();
        }

        function selectCloudPortfolio(value) {
            const id = cloudWorkspaceId(value);
            if (!cloudWorkspace.portfolios.some(item => cloudWorkspaceId(item && item.id) === id && !item.archived_at)) return;
            cloudWorkspace.selectedPortfolioId = id;
            updatePositionPortfolioSelector();
            renderCloudWorkspaceManager();
        }

        async function createCloudWatchlist() {
            const input = document.getElementById('cloud-watchlist-create');
            const name = input && input.value.trim();
            if (!name) { setCloudWorkspaceStatus('Enter a watchlist name first.', 'error'); return; }
            await mutateCloudWorkspace('/api/watchlists', {
                method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name }),
            }, 'Watchlist created.', data => {
                cloudWorkspace.selectedWatchlistId = cloudWorkspaceId(data.watchlist && data.watchlist.id);
            });
        }

        async function renameCloudWatchlist() {
            const selected = selectedCloudWatchlist();
            const input = document.getElementById('cloud-watchlist-name');
            const name = input && input.value.trim();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            if (!name) { setCloudWorkspaceStatus('Enter a watchlist name first.', 'error'); return; }
            await mutateCloudWorkspace(`/api/watchlists/${selected.id}`, {
                method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ name }),
            }, 'Watchlist renamed.');
        }

        async function deleteCloudWatchlist() {
            const selected = selectedCloudWatchlist();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            if (!window.confirm(`Delete watchlist “${selected.name}”? This cannot be undone.`)) return;
            await mutateCloudWorkspace(`/api/watchlists/${selected.id}`, {
                method: 'DELETE', headers: authHeaders(),
            }, 'Watchlist deleted.');
        }

        async function addTickerToSelectedCloudWatchlist(tickerOverride) {
            const selected = selectedCloudWatchlist();
            const input = document.getElementById('cloud-watchlist-ticker');
            const rawTicker = tickerOverride || (input && input.value) || '';
            const ticker = String(rawTicker).toUpperCase().trim();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
                setCloudWorkspaceStatus('Enter a valid ticker, for example NVDA.', 'error');
                return;
            }
            await mutateCloudWorkspace(`/api/watchlists/${selected.id}/items`, {
                method: 'POST', headers: authHeaders(true), body: JSON.stringify({ ticker }),
            }, `${ticker} added to ${selected.name}.`);
        }

        async function removeTickerFromSelectedCloudWatchlist(ticker) {
            const selected = selectedCloudWatchlist();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            const normalizedTicker = String(ticker || '').toUpperCase().trim();
            return await mutateCloudWorkspace(`/api/watchlists/${selected.id}/items?ticker=${encodeURIComponent(normalizedTicker)}`, {
                method: 'DELETE', headers: authHeaders(),
            }, `${normalizedTicker} removed from ${selected.name}.`);
        }

        async function createCloudPortfolio() {
            const input = document.getElementById('cloud-portfolio-create');
            const name = input && input.value.trim();
            if (!name) { setCloudWorkspaceStatus('Enter a portfolio name first.', 'error'); return; }
            await mutateCloudWorkspace('/api/portfolios', {
                method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name, currency: 'USD' }),
            }, 'Portfolio created.', data => {
                cloudWorkspace.selectedPortfolioId = cloudWorkspaceId(data.portfolio && data.portfolio.id);
            });
        }

        async function renameCloudPortfolio() {
            const selected = selectedCloudPortfolio();
            const input = document.getElementById('cloud-portfolio-name');
            const name = input && input.value.trim();
            if (!selected) { setCloudWorkspaceStatus('Select a portfolio first.', 'error'); return; }
            if (!name) { setCloudWorkspaceStatus('Enter a portfolio name first.', 'error'); return; }
            await mutateCloudWorkspace(`/api/portfolios/${selected.id}`, {
                method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ name }),
            }, 'Portfolio renamed.');
        }

        async function archiveCloudPortfolio() {
            const selected = selectedCloudPortfolio();
            if (!selected) { setCloudWorkspaceStatus('Select a portfolio first.', 'error'); return; }
            if (!window.confirm(`Archive portfolio “${selected.name}”? Existing history is retained.`)) return;
            await mutateCloudWorkspace(`/api/portfolios/${selected.id}`, {
                method: 'DELETE', headers: authHeaders(),
            }, 'Portfolio archived.');
        }

        function setProfileSummary() {
            const user = authState.user;
            const initials = profileInitials(user);
            const avatarButton = document.getElementById('profile-avatar-button');
            const avatar = document.getElementById('profile-sheet-avatar');
            const name = document.getElementById('profile-sheet-name');
            const email = document.getElementById('profile-sheet-email');
            if (avatarButton) avatarButton.textContent = initials;
            if (avatar) avatar.textContent = initials;
            if (!authState.authenticated || !user) {
                if (name) name.textContent = authState.configured === false ? 'Portfolio Terminal' : 'Portfolio Terminal User';
                if (email) email.textContent = authState.configured === false ? 'Cloud authentication is not configured' : 'Secure session required';
                return;
            }
            if (name) name.textContent = user.username || user.display_name || 'Welcome to Portfolio Terminal';
            if (email) email.textContent = user.email || 'Signed in securely';
        }

        function setAuthStatus(message, tone = '') {
            const el = document.getElementById('profile-auth-status');
            if (!el) return;
            el.textContent = message || '';
            el.className = `pt-auth-status${tone ? ` ${tone}` : ''}`;
        }

        function renderProfileAuthContent() {
            setProfileSummary();
            const host = document.getElementById('profile-auth-content');
            if (!host) return;

            if (authState.configured === null) {
                host.innerHTML = '<div class="pt-sync-note">Checking the secure account service…</div>';
                return;
            }
            if (authState.configured === false) {
                host.innerHTML = '<div class="pt-sync-note">Cloud sign-in is not configured on this deployment yet. The terminal remains in legacy local-session mode until Supabase credentials are added.</div>';
                return;
            }
            if (authState.recoveryMode) {
                host.innerHTML = `
                    <div class="pt-auth-stack">
                        <p class="pt-sync-note" style="margin:0;">Choose a new password for your account.</p>
                        <input id="auth-new-password" type="password" minlength="8" autocomplete="new-password" placeholder="New password (8+ characters)">
                        <button type="button" class="pt-auth-action" onclick="submitPasswordRecovery()">Update password</button>
                        <div id="profile-auth-status" class="pt-auth-status"></div>
                    </div>`;
                return;
            }
            if (authState.authenticated && authState.user) {
                const user = authState.user;
                const needsOnboarding = Boolean(user.needs_onboarding || !user.username);
                if (needsOnboarding) {
                    host.innerHTML = `
                        <div class="pt-auth-stack">
                            <div class="pt-sync-note" style="margin:0;">Welcome to Portfolio Terminal AI. Choose the username that will appear across your synced workspace.</div>
                            <input id="onboarding-username" maxlength="32" autocomplete="username" placeholder="Username" value="${escapeHtml(user.is_provisional_username ? '' : (user.username || ''))}">
                            <button type="button" class="pt-auth-action" onclick="completeOnboarding()">Continue to dashboard</button>
                            <div id="profile-auth-status" class="pt-auth-status"></div>
                        </div>`;
                    return;
                }
                host.innerHTML = `
                    <div class="pt-auth-stack">
                        <div class="pt-sync-note" style="margin:0;">${authState.cloudSyncEnabled ? 'Cloud sync is active for watchlists, positions, and indicator preferences on this account.' : 'Your account is signed in, but cloud storage is not configured on this deployment yet.'}</div>
                        ${authState.cloudSyncEnabled ? '<section id="cloud-workspace-manager" class="pt-workspace-manager" aria-label="Cloud workspace manager"><div id="cloud-workspace-content"></div></section><section id="alert-center-manager" class="pt-alert-manager" aria-label="Cloud alert rules and in-app notification inbox"><div id="alert-center-content"></div></section>' : ''}
                        <button type="button" class="pt-auth-action secondary" onclick="signOut()">Sign out</button>
                        <div id="profile-auth-status" class="pt-auth-status"></div>
                    </div>`;
                if (authState.cloudSyncEnabled) {
                    renderCloudWorkspaceManager();
                    renderAlertCenter();
                }
                return;
            }

            const isSignUp = authFormMode === 'sign-up';
            host.innerHTML = `
                <form class="pt-auth-stack" onsubmit="submitAuth(event)">
                    <input id="auth-email" type="email" autocomplete="email" placeholder="Email" required>
                    <input id="auth-password" type="password" minlength="8" autocomplete="${isSignUp ? 'new-password' : 'current-password'}" placeholder="Password" required>
                    ${isSignUp ? '' : '<label style="display:flex; align-items:center; gap:8px; color:var(--text-muted); font-size:12px;"><input id="auth-remember" type="checkbox" checked style="width:auto; min-height:auto;">Remember this device</label>'}
                    <button type="submit" class="pt-auth-action">${isSignUp ? 'Create account' : 'Sign in'}</button>
                    ${authState.googleEnabled ? '<button type="button" class="pt-auth-action secondary" onclick="signInWithGoogle()">Continue with Google</button>' : ''}
                    <div class="pt-auth-links">
                        <button type="button" onclick="setAuthFormMode('${isSignUp ? 'sign-in' : 'sign-up'}')">${isSignUp ? 'Already have an account?' : 'Create account'}</button>
                        ${isSignUp ? '' : '<button type="button" onclick="sendPasswordReset()">Forgot password?</button>'}
                    </div>
                    <div id="profile-auth-status" class="pt-auth-status"></div>
                </form>`;
        }

        function setAuthFormMode(mode) {
            authFormMode = mode === 'sign-up' ? 'sign-up' : 'sign-in';
            renderProfileAuthContent();
        }

        async function loadAuthSession() {
            const sessionEpoch = ++authSessionEpoch;
            try {
                const res = await authFetch('/api/me', { cache: 'no-store' });
                if (sessionEpoch !== authSessionEpoch) return;
                if (res.status === 404) {
                    authState = { ...authState, configured: false, authenticated: false, user: null, cloudSyncEnabled: false, csrfToken: null };
                } else {
                    const data = await res.json();
                    if (sessionEpoch !== authSessionEpoch) return;
                    authState = {
                        ...authState,
                        configured: Boolean(data.auth_enabled ?? data.configured),
                        authenticated: Boolean(data.authenticated),
                        user: data.user || data.profile || null,
                        googleEnabled: Boolean(data.google_enabled),
                        cloudSyncEnabled: Boolean(data.cloud_sync_enabled),
                        csrfToken: data.csrf_token || null,
                    };
                }
            } catch (err) {
                if (sessionEpoch !== authSessionEpoch) return;
                console.warn('Unable to load account session:', err);
                authState = { ...authState, configured: false, authenticated: false, user: null, cloudSyncEnabled: false, csrfToken: null };
            }
            if (sessionEpoch !== authSessionEpoch) return;
            // A renewed session can belong to a different account. Clear the
            // previous account's inbox before any new profile UI is rendered.
            resetAlertCenter();
            renderProfileAuthContent();
            if (authState.authenticated && authState.cloudSyncEnabled) {
                await loadCloudPreferences();
                if (sessionEpoch !== authSessionEpoch) return;
                await loadCloudWorkspace();
                if (sessionEpoch !== authSessionEpoch) return;
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            } else {
                resetCloudWorkspace();
            }
            if (sessionEpoch !== authSessionEpoch) return;
            if (authState.authenticated && authState.user && (authState.user.needs_onboarding || !authState.user.username)) openProfileSheet();
        }

        async function submitAuth(event) {
            event.preventDefault();
            const email = document.getElementById('auth-email').value.trim();
            const password = document.getElementById('auth-password').value;
            const remember = Boolean(document.getElementById('auth-remember')?.checked);
            const endpoint = authFormMode === 'sign-up' ? '/api/auth/sign-up' : '/api/auth/sign-in';
            setAuthStatus('Working securely…');
            try {
                const res = await authFetch(endpoint, {
                    method: 'POST',
                    headers: authHeaders(true),
                    credentials: 'same-origin',
                    body: JSON.stringify({ email, password, remember_me: remember }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to complete authentication.');
                if (authFormMode === 'sign-up' && !data.authenticated) {
                    setAuthStatus(data.message || 'Check your email to confirm the account.', 'success');
                    return;
                }
                await loadAuthSession();
                renderProfileAuthContent();
            } catch (err) {
                setAuthStatus(err.message || 'Unable to complete authentication.', 'error');
            }
        }

        function signInWithGoogle() {
            window.location.assign('/api/auth/google/start');
        }

        async function sendPasswordReset() {
            const email = document.getElementById('auth-email')?.value.trim();
            if (!email) {
                setAuthStatus('Enter your email first, then request a reset link.', 'error');
                return;
            }
            setAuthStatus('Sending reset email…');
            try {
                const res = await authFetch('/api/auth/forgot-password', {
                    method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to send reset email.');
                setAuthStatus(data.message || 'If this address exists, a reset link is on its way.', 'success');
            } catch (err) {
                setAuthStatus(err.message || 'Unable to send reset email.', 'error');
            }
        }

        async function completeOnboarding() {
            const username = document.getElementById('onboarding-username')?.value.trim();
            if (!username) { setAuthStatus('Choose a username to continue.', 'error'); return; }
            setAuthStatus('Saving your profile…');
            try {
                const res = await authFetch('/api/me', {
                    method: 'PUT', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ username })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to save your profile.');
                authState.user = data.user || data.profile || { ...authState.user, username, needs_onboarding: false };
                authState.user.needs_onboarding = false;
                renderProfileAuthContent();
                closeProfileSheet();
            } catch (err) {
                setAuthStatus(err.message || 'Unable to save your profile.', 'error');
            }
        }

        async function signOut() {
            try {
                await authFetch('/api/auth/sign-out', { method: 'POST', headers: authHeaders(true) });
            } finally {
                authSessionEpoch += 1;
                authState = { configured: authState.configured, authenticated: false, user: null, googleEnabled: authState.googleEnabled, cloudSyncEnabled: false, csrfToken: null, recoveryMode: false };
                resetCloudWorkspace();
                resetAlertCenter();
                watchlist = [];
                activePositions = [];
                renderWatchlist();
                renderPortfolioTable();
                updateHomeWatchlistSurface();
                updateHomePortfolioSurface();
                emaSettings = loadEmaSettings();
                emaMasterEnabled = loadEmaMaster();
                renderIndicatorsPanel();
                updateEMASeries();
                renderProfileAuthContent();
            }
        }

        async function submitPasswordRecovery() {
            const password = document.getElementById('auth-new-password')?.value;
            if (!password || password.length < 8) { setAuthStatus('Use at least 8 characters.', 'error'); return; }
            try {
                const res = await authFetch('/api/auth/update-password', {
                    method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ password })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to update password.');
                authState.recoveryMode = false;
                await loadAuthSession();
                setAuthStatus('Password updated.', 'success');
            } catch (err) {
                setAuthStatus(err.message || 'Unable to update password.', 'error');
            }
        }

        async function consumeAuthHash() {
            const params = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '');
            const accessToken = params.get('access_token');
            const type = params.get('type');
            // Google uses the server-side PKCE callback. This legacy fragment
            // exchange remains only for Supabase email confirmation/recovery.
            if (!accessToken || !['recovery', 'signup'].includes(type || '')) return;
            const refreshToken = params.get('refresh_token');
            try {
                const res = await authFetch('/api/auth/session', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
                });
                if (!res.ok) throw new Error('Secure session exchange failed.');
                history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
                authState.recoveryMode = type === 'recovery';
            } catch (err) {
                console.warn('Auth callback could not create a secure session:', err);
            }
        }

        async function loadCloudPreferences() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return;
            try {
                const res = await authFetch('/api/preferences', { headers: authHeaders(), cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                const preference = data.preferences || data;
                const savedSettings = preference.ema_settings;
                if (savedSettings && typeof savedSettings === 'object') {
                    const merged = {};
                    EMA_PERIODS.forEach(period => { merged[period] = { ...EMA_DEFAULTS[period], ...(savedSettings[period] || {}) }; });
                    emaSettings = merged;
                }
                if (typeof preference.ema_master_enabled === 'boolean') emaMasterEnabled = preference.ema_master_enabled;
                renderIndicatorsPanel();
                updateEMASeries();
            } catch (err) {
                console.warn('Cloud preferences could not be loaded:', err);
            }
        }

        function queuePreferenceSync() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return;
            if (preferenceSyncTimer) clearTimeout(preferenceSyncTimer);
            preferenceSyncTimer = window.setTimeout(async () => {
                try {
                    await authFetch('/api/preferences', {
                        method: 'PUT', headers: authHeaders(true),
                        body: JSON.stringify({ ema_settings: emaSettings, ema_master_enabled: emaMasterEnabled }),
                    });
                } catch (err) {
                    console.warn('Cloud preferences could not be saved:', err);
                }
            }, 350);
        }

        function updateHomeWatchlistSurface() {
            const el = document.getElementById('home-watchlist-count');
            if (el) el.textContent = Array.isArray(watchlist) ? String(watchlist.length) : '0';
        }

        function updateHomePortfolioSurface() {
            const positions = Array.isArray(activePositions) ? activePositions : [];
            const pnl = positions.reduce((sum, position) => {
                const value = Number(position.pnl);
                return sum + (Number.isFinite(value) ? value : 0);
            }, 0);
            const pnlEl = document.getElementById('home-total-pnl');
            const noteEl = document.getElementById('home-total-pnl-note');
            const countEl = document.getElementById('home-position-count');
            if (pnlEl) {
                const sign = pnl > 0 ? '+' : '';
                pnlEl.textContent = `${sign}$${Math.abs(pnl).toFixed(2)}`;
                pnlEl.style.color = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--pt-white)';
            }
            if (noteEl) {
                noteEl.textContent = positions.length ? `${positions.length} open option position${positions.length === 1 ? '' : 's'}` : 'No open positions';
                noteEl.classList.toggle('positive', pnl > 0);
            }
            if (countEl) countEl.textContent = String(positions.length);
        }

        function updateHomeMarketSurface(stats = {}) {
            const hasStat = key => Object.prototype.hasOwnProperty.call(stats, key);
            const readNumber = (key, fallback) => {
                const value = hasStat(key) ? stats[key] : fallback;
                return value === null || value === undefined || value === '' ? Number.NaN : Number(value);
            };
            const price = readNumber('current_price', currentLivePrice);
            const previous = readNumber('prev_close', currentPrevClose);
            const session = (hasStat('market_session') ? stats.market_session : currentMarketSession) || 'CLOSED';
            const sessionNames = { REGULAR: 'Market open', PRE: 'Pre-market', POST: 'After-hours', CLOSED: 'Market closed', LOADING: 'Loading' };
            const shortSessionNames = { REGULAR: 'Open', PRE: 'Pre', POST: 'Post', CLOSED: 'Closed', LOADING: 'Loading' };
            const symbolEl = document.getElementById('home-live-symbol');
            const priceEl = document.getElementById('home-live-price');
            const changeEl = document.getElementById('home-live-change');
            const sessionEl = document.getElementById('home-market-session');
            const labelEl = document.getElementById('home-session-label');

            if (symbolEl) symbolEl.textContent = currentTicker || '—';
            if (priceEl) priceEl.textContent = Number.isFinite(price) ? `$${price.toFixed(2)}` : '—';
            if (sessionEl) sessionEl.textContent = sessionNames[session] || session;
            if (labelEl) labelEl.textContent = shortSessionNames[session] || session;

            if (changeEl) {
                if (Number.isFinite(price) && previous > 0) {
                    const change = ((price - previous) / previous) * 100;
                    changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}% vs previous close`;
                    changeEl.style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
                } else {
                    changeEl.textContent = 'Waiting for market data';
                    changeEl.style.color = 'var(--text-muted)';
                }
            }
        }

        // --- 🔎 ค้นหาหุ้นจากฐานข้อมูล Ticker ฝั่ง Backend ---
        // --- Reference category rail ---------------------------------------
        // The catalog is server-provided and intentionally carries no made-up
        // price data. Selecting a symbol simply opens the existing analysis UI.
        function renderCategoryRailChips() {
            const host = document.getElementById('category-rail-chips');
            if (!host) return;
            host.replaceChildren();
            categoryRailCategories.forEach(category => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `pt-category-chip${category === selectedCategoryRail ? ' is-active' : ''}`;
                button.textContent = category;
                button.setAttribute('aria-pressed', String(category === selectedCategoryRail));
                button.addEventListener('click', () => selectCategoryRail(category));
                host.appendChild(button);
            });
        }

        function setCategoryRailMessage(message, isError = false) {
            const host = document.getElementById('category-rail-instruments');
            if (!host) return;
            host.replaceChildren();
            const messageEl = document.createElement('p');
            messageEl.className = `pt-category-message${isError ? ' error' : ''}`;
            messageEl.textContent = message;
            host.appendChild(messageEl);
        }

        function renderCategoryRailInstruments(instruments) {
            const host = document.getElementById('category-rail-instruments');
            if (!host) return;
            host.replaceChildren();
            if (!Array.isArray(instruments) || !instruments.length) {
                setCategoryRailMessage('No catalog instruments are available for this category.');
                return;
            }
            instruments.forEach(instrument => {
                const symbol = String(instrument && instrument.symbol || '').toUpperCase().trim();
                if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'pt-category-instrument';
                button.title = `Open ${symbol} analysis`;
                const symbolEl = document.createElement('strong');
                symbolEl.textContent = symbol;
                const nameEl = document.createElement('span');
                nameEl.textContent = String(instrument.name || instrument.sector || 'Open analysis');
                button.append(symbolEl, nameEl);
                button.addEventListener('click', () => switchStock(symbol));
                host.appendChild(button);
            });
            if (!host.childElementCount) setCategoryRailMessage('No valid symbols are available for this category.');
        }

        async function selectCategoryRail(category) {
            const normalized = String(category || '').trim();
            if (!categoryRailCategories.includes(normalized)) return;
            selectedCategoryRail = normalized;
            renderCategoryRailChips();
            if (categoryRailAbortController && !categoryRailAbortController.signal.aborted) {
                categoryRailAbortController.abort();
            }
            const controller = new AbortController();
            categoryRailAbortController = controller;
            const requestVersion = ++categoryRailRequestVersion;
            setCategoryRailMessage(`Loading ${normalized} instruments…`);
            try {
                const response = await fetch(`/api/categories/${encodeURIComponent(normalized)}`, {
                    cache: 'no-store', signal: controller.signal,
                });
                if (!response.ok) throw new Error(`Category request failed (${response.status}).`);
                const data = await response.json();
                if (controller.signal.aborted || requestVersion !== categoryRailRequestVersion) return;
                renderCategoryRailInstruments(data && data.items);
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                if (requestVersion === categoryRailRequestVersion) {
                    setCategoryRailMessage(error.message || 'Unable to load this category right now.', true);
                }
            } finally {
                if (categoryRailAbortController === controller) categoryRailAbortController = null;
            }
        }

        async function loadCategoryRail() {
            setCategoryRailMessage('Loading categories…');
            try {
                const response = await fetch('/api/categories', { cache: 'no-store' });
                if (!response.ok) throw new Error(`Category catalog request failed (${response.status}).`);
                const data = await response.json();
                categoryRailCategories = Array.isArray(data && data.items)
                    ? data.items.map(item => String(item || '').trim()).filter(Boolean)
                    : [];
                if (!categoryRailCategories.length) {
                    setCategoryRailMessage('The category catalog is currently empty.');
                    return;
                }
                if (!categoryRailCategories.includes(selectedCategoryRail)) selectedCategoryRail = categoryRailCategories[0];
                renderCategoryRailChips();
                await selectCategoryRail(selectedCategoryRail);
            } catch (error) {
                setCategoryRailMessage(error.message || 'Unable to load market categories.', true);
            }
        }

        async function fetchTickerMatches(val, signal) {
            try {
                const res = await fetch(`/api/tickers?q=${encodeURIComponent(val)}`, { signal, cache: 'no-store' });
                if (!res.ok) return [];
                return await res.json();
            } catch (err) {
                if (!isAbortError(err)) console.warn('Ticker search failed:', err);
                return [];
            }
        }

        searchInput.addEventListener('input', function () {
            this.value = this.value.toUpperCase();
            const val = this.value;
            if (!val) { autocompleteList.innerHTML = ''; autocompleteList.style.display = 'none'; return; }

            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(async () => {
                if (tickerSearchAbortController && !tickerSearchAbortController.signal.aborted) {
                    tickerSearchAbortController.abort();
                }
                const controller = new AbortController();
                tickerSearchAbortController = controller;
                const matches = await fetchTickerMatches(val, controller.signal);
                if (controller.signal.aborted || searchInput.value !== val) return;
                autocompleteList.innerHTML = '';
                if (matches.length > 0) {
                    autocompleteList.style.display = 'block';
                    matches.forEach(m => {
                        const symbol = m.symbol;
                        const idx = symbol.indexOf(val);
                        const div = document.createElement('div');
                        if (idx === 0) {
                            div.innerHTML = `<strong>${symbol.substr(0, val.length)}</strong>${symbol.substr(val.length)} <span style="color:var(--text-muted); font-weight:normal;">${m.name || ''}</span>`;
                        } else {
                            div.innerHTML = `${symbol} <span style="color:var(--text-muted); font-weight:normal;">${m.name || ''}</span>`;
                        }
                        div.addEventListener('click', function () {
                            searchInput.value = symbol; autocompleteList.style.display = 'none'; searchStock();
                        });
                        autocompleteList.appendChild(div);
                    });
                } else { autocompleteList.style.display = 'none'; }
            }, 200);
        });

        searchInput.addEventListener('keypress', function (event) {
            if (event.key === 'Enter') { autocompleteList.style.display = 'none'; searchStock(); }
        });
        document.addEventListener('click', function (e) { if (e.target !== searchInput) { autocompleteList.style.display = 'none'; } });

        // --- 📈 ตั้งค่าชาร์ตหลักด้วย Lightweight Charts ---
        const chartContainer = document.getElementById('tvchart');
        const chart = LightweightCharts.createChart(chartContainer, {
            layout: { textColor: '#cbd5e1', background: { type: 'solid', color: '#141722' } },
            grid: { vertLines: { color: '#1e2232' }, horzLines: { color: '#1e2232' } },
            leftPriceScale: { visible: false },
            rightPriceScale: { visible: true, borderColor: '#242733', scaleMargins: { top: 0.12, bottom: 0.12 } },
            timeScale: {
                borderColor: '#242733',
                visible: false,
                rightOffset: getSRRightOffset(),
                barSpacing: 9,
                fixLeftEdge: false,
                fixRightEdge: false
            },
            handleScale: {
                axisPressedMouseMove: { time: true, price: false }
            }
        });
        const candleSeries = chart.addCandlestickSeries({ upColor: '#00c57f', downColor: '#ff3b30', borderVisible: false });

        // --- 📊 [แก้ไขโครงสร้าง] ปรับเปลี่ยนจากชาร์ต RSI เดิม ให้เป็น Volume Chart ---
        const volumeContainer = document.getElementById('volumechart');
        const volumeChart = LightweightCharts.createChart(volumeContainer, {
            layout: { textColor: '#cbd5e1', background: { type: 'solid', color: '#141722' } },
            grid: { vertLines: { color: '#1e2232' }, horzLines: { color: '#1e2232' } },
            leftPriceScale: { visible: false },
            rightPriceScale: { visible: true, borderColor: '#242733' },
            timeScale: {
                borderColor: '#242733',
                timeVisible: true,
                rightOffset: getSRRightOffset(),
                barSpacing: 9, // 🛠️ [แก้บั๊ก] ต้องเท่ากับกราฟหลักเป๊ะ ไม่งั้นแท่ง Volume จะกว้าง/แคบไม่ตรงกับแท่งเทียน
                fixLeftEdge: false,
                fixRightEdge: false
            },
            handleScale: {
                axisPressedMouseMove: { time: true, price: false }
            }
        });
        // กำหนดให้ Series เป็นแบบ Histogram (แท่งปริมาณซื้อขาย) แทน Line แบบเดิม
        const volumeSeries = volumeChart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'right',
        });

        // --- 🛠️ [แก้บั๊ก] แท่งเทียนกับแท่งวอลุ่มยืนไม่ตรงกัน ---
        // สาเหตุจริง: chart กับ volumeChart เป็นคนละ chart instance กัน แม้ time ของทุกแท่งจะตรงกัน 100%
        // (มาจาก chartData ชุดเดียวกัน) แต่ "ความกว้างของแกนราคาขวา" ของแต่ละกราฟคำนวณเองอิสระ
        // ตามความกว้างของตัวเลขที่แสดง (ราคาหุ้น เช่น "203.69" กับวอลุ่ม เช่น "95.35M" กว้างไม่เท่ากัน)
        // เมื่อแกนราคากว้างไม่เท่ากัน พื้นที่วาดกราฟ (plot area) ของสองกราฟจะกว้างไม่เท่ากันไปด้วย
        // ทำให้แท่งเทียนกับแท่งวอลุ่มเลื่อนหลุดแนวกันในแนวนอน ยิ่งเลื่อนกราฟไปทางซ้ายยิ่งเห็นชัด
        // วิธีแก้: บังคับให้ minimumWidth ของแกนราคาขวาทั้งสองกราฟเท่ากันเป๊ะเสมอ (ใช้ค่าที่กว้างที่สุด)
        function syncPriceScaleWidths() {
            const mainWidth = chart.priceScale('right').width();
            const volWidth = volumeChart.priceScale('right').width();
            const target = Math.max(mainWidth, volWidth, 56);
            if (target > 0) {
                chart.priceScale('right').applyOptions({ minimumWidth: target });
                volumeChart.priceScale('right').applyOptions({ minimumWidth: target });
            }
        }

        // --- 📈 EMA Indicator System (EMA 20 / 50 / 100 / 200) --------------
        const EMA_PERIODS = [20, 50, 100, 200];
        const EMA_DEFAULTS = {
            20: { enabled: false, color: '#f0b90b', width: 2, dashed: false }, // ทอง
            50: { enabled: false, color: '#2962ff', width: 2, dashed: false }, // น้ำเงิน
            100: { enabled: false, color: '#ba68c8', width: 2, dashed: false }, // ม่วง
            200: { enabled: false, color: '#ff3b30', width: 2, dashed: false }, // แดง
        };

        function loadEmaSettings() {
            return JSON.parse(JSON.stringify(EMA_DEFAULTS));
        }

        function saveEmaSettings() {
            queuePreferenceSync();
        }

        // ปุ่มหลัก "เปิดใช้งาน EMA" — กดครั้งแรกให้ขึ้นทุกเส้นทันที ไม่ต้องเลือกทีละเส้น
        // ผู้ใช้ค่อยไปติ๊กเอาเส้นที่ไม่ต้องการออกทีหลังได้จากรายการด้านล่าง
        function loadEmaMaster() {
            return false;
        }
        function saveEmaMaster() {
            queuePreferenceSync();
        }

        let emaSettings = loadEmaSettings();
        let emaMasterEnabled = loadEmaMaster();
        const emaSeriesMap = { 20: null, 50: null, 100: null, 200: null };
        const emaLastValue = { 20: null, 50: null, 100: null, 200: null }; // เก็บราคาล่าสุดของแต่ละเส้นไว้โชว์บน legend

        // คำนวณ EMA จากแท่งเทียน (seed ด้วยค่าเฉลี่ย SMA ของ N แท่งแรกเหมือน TradingView)
        function calculateEMA(candles, period) {
            if (!candles || candles.length < period) return [];
            const k = 2 / (period + 1);
            const result = [];
            let sum = 0;
            for (let i = 0; i < period; i++) sum += candles[i].close;
            let ema = sum / period;
            result.push({ time: candles[period - 1].time, value: ema });
            for (let i = period; i < candles.length; i++) {
                ema = candles[i].close * k + ema * (1 - k);
                result.push({ time: candles[i].time, value: ema });
            }
            return result;
        }

        // สร้าง/อัปเดต/ลบ เส้น EMA บนกราฟหลักตามค่า emaSettings ปัจจุบัน + อัปเดต legend ราคาล่าสุด
        function updateEMASeries() {
            EMA_PERIODS.forEach(period => {
                const cfg = emaSettings[period];
                if (cfg.enabled) {
                    if (!emaSeriesMap[period]) {
                        emaSeriesMap[period] = chart.addLineSeries({
                            color: cfg.color,
                            lineWidth: cfg.width,
                            lineStyle: cfg.dashed ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid,
                            priceLineVisible: false,
                            lastValueVisible: true, // โชว์ป้ายราคาล่าสุดของเส้นนี้ที่ขอบขวากราฟด้วย
                            crosshairMarkerVisible: false,
                            title: `EMA ${period}`,
                        });
                    } else {
                        emaSeriesMap[period].applyOptions({
                            color: cfg.color,
                            lineWidth: cfg.width,
                            lineStyle: cfg.dashed ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid,
                        });
                    }
                    const data = calculateEMA(globalChartData, period);
                    emaSeriesMap[period].setData(data);
                    emaLastValue[period] = data.length ? data[data.length - 1].value : null;
                } else if (emaSeriesMap[period]) {
                    chart.removeSeries(emaSeriesMap[period]);
                    emaSeriesMap[period] = null;
                    emaLastValue[period] = null;
                } else {
                    emaLastValue[period] = null;
                }
            });
            updateEmaLegend();
        }

        // แสดงกล่องเล็กๆ มุมซ้ายบนกราฟ บอกว่าแต่ละเส้น EMA ตอนนี้อยู่ที่ราคาเท่าไหร่ (อัปเดต real-time)
        function updateEmaLegend() {
            const legend = document.getElementById('ema-legend');
            if (!legend) return;
            const items = EMA_PERIODS
                .filter(p => emaSettings[p].enabled && emaLastValue[p] !== null)
                .map(p => `<div class="ema-legend-item">
                        <span class="ema-legend-dot" style="background:${emaSettings[p].color};"></span>
                        EMA${p}: $${emaLastValue[p].toFixed(2)}
                    </div>`)
                .join('');
            legend.innerHTML = items;
        }

        function toggleIndicatorsPanel() {
            const panel = document.getElementById('indicators-panel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }

        // ปิด panel เมื่อคลิกนอกพื้นที่
        document.addEventListener('click', function (e) {
            const panel = document.getElementById('indicators-panel');
            const btn = document.getElementById('indicators-btn');
            if (panel && panel.style.display === 'block' && !panel.contains(e.target) && e.target !== btn) {
                panel.style.display = 'none';
            }
        });

        function renderIndicatorsPanel() {
            const panel = document.getElementById('indicators-panel');
            panel.innerHTML = `
                <label class="ema-master-row">
                    <input type="checkbox" id="ema-master-toggle" ${emaMasterEnabled ? 'checked' : ''}
                        onchange="onEmaMasterToggle(this.checked)">
                    ✅ เปิดใช้งาน EMA (แสดงทุกเส้นทันที)
                </label>
                <div class="indicators-panel-title">📈 EMA (Exponential Moving Average)</div>` +
                EMA_PERIODS.map(period => {
                    const cfg = emaSettings[period];
                    return `
                    <div class="ema-row" data-period="${period}">
                        <label>
                            <input type="checkbox" class="ema-toggle" ${cfg.enabled ? 'checked' : ''}
                                onchange="onEmaChange(${period}, 'enabled', this.checked)">
                            EMA ${period}
                        </label>
                        <input type="color" value="${cfg.color}" title="เปลี่ยนสี"
                            onchange="onEmaChange(${period}, 'color', this.value)">
                        <select title="ความหนาเส้น" onchange="onEmaChange(${period}, 'width', parseInt(this.value))">
                            <option value="1" ${cfg.width === 1 ? 'selected' : ''}>บาง</option>
                            <option value="2" ${cfg.width === 2 ? 'selected' : ''}>ปกติ</option>
                            <option value="3" ${cfg.width === 3 ? 'selected' : ''}>หนา</option>
                            <option value="4" ${cfg.width === 4 ? 'selected' : ''}>หนามาก</option>
                        </select>
                        <label class="ema-dash-label" title="เส้นประ">
                            <input type="checkbox" class="ema-dash" ${cfg.dashed ? 'checked' : ''}
                                onchange="onEmaChange(${period}, 'dashed', this.checked)">
                            ประ
                        </label>
                    </div>`;
                }).join('') +
                `<div class="field-hint" style="margin-top:8px;">ติ๊กออกเฉพาะเส้นที่ไม่ต้องการได้เลย ไม่จำเป็นต้องปิดปุ่มด้านบน</div>`;
        }

        // ปุ่มหลัก: เปิด = ให้ครบทุกเส้นทันที / ปิด = ซ่อนทุกเส้นทันที
        function onEmaMasterToggle(checked) {
            emaMasterEnabled = checked;
            saveEmaMaster();
            EMA_PERIODS.forEach(p => { emaSettings[p].enabled = checked; });
            saveEmaSettings();
            renderIndicatorsPanel(); // รีเฟรช checkbox ย่อยให้ตรงกับสถานะใหม่
            updateEMASeries();
        }

        function onEmaChange(period, key, value) {
            emaSettings[period][key] = value;
            saveEmaSettings();
            updateEMASeries();
        }

        // --- 🔄 ระบบซิงค์กราฟหลักและกราฟ Volume ด้วย LogicalRange ---
        let isSyncing = false;

        chart.timeScale().subscribeVisibleLogicalRangeChange(logicalRange => {
            if (!isSyncing && !isChangingData && logicalRange !== null) {
                isSyncing = true;
                volumeChart.timeScale().setVisibleLogicalRange(logicalRange);
                isSyncing = false;
            }
        });

        volumeChart.timeScale().subscribeVisibleLogicalRangeChange(logicalRange => {
            if (!isSyncing && !isChangingData && logicalRange !== null) {
                isSyncing = true;
                chart.timeScale().setVisibleLogicalRange(logicalRange);
                isSyncing = false;
            }
        });

        new ResizeObserver(() => {
            chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
            volumeChart.applyOptions({ width: volumeContainer.clientWidth, height: volumeContainer.clientHeight });
            requestAnimationFrame(syncPriceScaleWidths);
        }).observe(chartContainer);

        function resetChartView() {
            if (globalChartData && globalChartData.length > 0) {
                chart.priceScale('right').applyOptions({ autoScale: true });
                chart.priceScale('left').applyOptions({ autoScale: true });
                volumeChart.priceScale('right').applyOptions({ autoScale: true });

                // 🛠️ [แก้บั๊ก] ห้ามสั่ง scrollToRealTime() แยกกันทั้ง 2 กราฟ เพราะแต่ละกราฟจะคำนวณ
                // ตำแหน่ง real-time ของตัวเองใหม่ (คนละค่ากัน) แล้วทำให้ Volume หลุด sync จากราคา
                // ให้เลื่อนกราฟราคาไป real-time ก่อน แล้ว "บังคับ" ให้กราฟ Volume ใช้ช่วงเดียวกันเป๊ะ
                isSyncing = true;
                chart.timeScale().scrollToRealTime();
                const realtimeRange = chart.timeScale().getVisibleLogicalRange();
                if (realtimeRange) {
                    volumeChart.timeScale().setVisibleLogicalRange(realtimeRange);
                }
                isSyncing = false;
            }
        }

        // --- 🌐 API Integration Data Fetching ---
        async function fetchWatchlist() {
            const sessionEpoch = authSessionEpoch;
            // On an auth-enabled deployment, a signed-out screen must not
            // repopulate a previous cloud account through a late refresh.
            // Auth-disabled deployments retain the legacy watchlist route.
            if (authState.configured === true && !authState.authenticated) {
                watchlist = [];
                renderWatchlist();
                updateHomeWatchlistSurface();
                return;
            }
            if (cloudWorkspaceEnabled()) {
                const loaded = cloudWorkspace.loaded || await loadCloudWorkspace();
                if (sessionEpoch !== authSessionEpoch) return;
                if (loaded) {
                    syncSelectedCloudWatchlist();
                } else {
                    watchlist = [];
                    renderWatchlist();
                    updateHomeWatchlistSurface();
                }
                return;
            }
            try {
                const res = await authFetch('/api/watchlist', { cache: 'no-store' });
                if (!res.ok) throw new Error(`Watchlist request failed: ${res.status}`);
                const items = await res.json();
                if (sessionEpoch !== authSessionEpoch) return;
                watchlist = Array.isArray(items) ? items : [];
                renderWatchlist();
                updateHomeWatchlistSurface();
            } catch (err) { console.error("Error fetching watchlist:", err); }
        }

        function renderWatchlist() {
            const container = document.getElementById('watchlist-row');
            container.innerHTML = watchlist.map(t => `
<div class="watchlist-tag ${t === currentTicker ? 'active' : ''}" onclick="switchStock('${t}')">
${t}
<span class="remove-btn" onclick="event.stopPropagation(); deleteWatchlist('${t}')">×</span>
</div>
`).join('');
        }

        function formatUsd(value) {
            return (typeof value === 'number' && Number.isFinite(value)) ? `$${value.toFixed(2)}` : '-';
        }

        function formatPct(value, digits = 2) {
            return (typeof value === 'number' && Number.isFinite(value)) ? `${value.toFixed(digits)}%` : '-';
        }

        function formatPrice(value) {
            return Number.isFinite(value) ? `$${value.toFixed(2)}` : '-';
        }

        function setFairValueDisplay(fairValue, upsidePct) {
            const el = document.getElementById('stat-cap');
            if (!Number.isFinite(fairValue)) { el.innerText = '-'; return; }
            if (!Number.isFinite(upsidePct)) {
                el.innerText = formatUsd(fairValue);
                return;
            }
            const color = upsidePct >= 0 ? 'var(--green)' : 'var(--red)';
            const sign = upsidePct >= 0 ? '+' : '';
            el.innerHTML = `${formatUsd(fairValue)} <span style="font-size:11px; color:${color};">(${sign}${upsidePct}%)</span>`;
        }

        function srConfidenceColor(confidence) {
            if (confidence === 'High Confidence') return 'var(--green)';
            if (confidence === 'Medium') return 'var(--gold)';
            return 'var(--text-muted)';
        }

        function renderSRLadder() {
            const banner = document.getElementById('sr-alert-banner');
            const ladder = document.getElementById('sr-ladder');
            const basisLabel = document.getElementById('sr-basis-label');
            if (!srData) { ladder.innerHTML = ''; banner.style.display = 'none'; return; }

            basisLabel.innerText = srData.basis_timeframe === 'week' ? 'อ้างอิง Week' : `อ้างอิง ${srData.basis_timeframe}`;

            const rowHtml = (item, type) => {
                const near = item.distance_pct !== null && item.distance_pct !== undefined && item.distance_pct <= 1.5;
                const labelColor = type === 'resistance' ? 'var(--red)' : 'var(--green)';
                const zoneRange = (Number.isFinite(item.zone_low) && Number.isFinite(item.zone_high))
                    ? '<div class="sr-zone-range">โซน ' + formatPrice(item.zone_low) + ' - ' + formatPrice(item.zone_high) + '</div>'
                    : '';
                const reasons = (item.reasons || []).join(' | ').replace(/"/g, '&quot;');
                const confColor = srConfidenceColor(item.confidence);
                const strengthTxt = (item.strength !== null && item.strength !== undefined) ? item.strength + '%' : 'N/A';

                let html = '<div class="sr-row ' + type + (near ? ' near' : '') + '" title="' + reasons + '">';
                html += '<span class="sr-label" style="color:' + labelColor + '">' + item.label + '</span>';
                html += '<div class="sr-main">';
                html += '<span class="sr-price">' + formatPrice(item.level) + ' <span class="sr-eta">' + (Number.isFinite(item.distance_pct) ? item.distance_pct + '%' : '-') + (item.eta ? ' · ' + item.eta : '') + '</span></span>';
                html += zoneRange;
                html += '</div>';
                html += '<span class="sr-strength-badge" style="background:' + confColor + '22; color:' + confColor + ';">' + strengthTxt + ' · ' + (item.confidence || '') + '</span>';
                html += '</div>';
                return html;
            };

            const resistancesDesc = Array.isArray(srData.resistance) ? [...srData.resistance].reverse() : [];
            let html = resistancesDesc.map(r => rowHtml(r, 'resistance')).join('');
            html += '<div class="sr-current-marker">💲 ราคาปัจจุบัน ' + formatPrice(srData.current_price) + '</div>';
            html += Array.isArray(srData.support) ? srData.support.map(s => rowHtml(s, 'support')).join('') : '';
            ladder.innerHTML = html;

            if (srData.closest_alert) {
                const c = srData.closest_alert;
                const isRes = c.label && c.label.startsWith('R');
                banner.style.display = 'block';
                banner.style.background = isRes ? 'rgba(255,59,48,0.12)' : 'rgba(0,197,127,0.12)';
                banner.style.color = isRes ? 'var(--red)' : 'var(--green)';
                const distanceText = Number.isFinite(c.distance_pct) ? c.distance_pct.toFixed(2) + '%' : '-';
                const strengthText = Number.isFinite(c.strength) ? c.strength + '%' : '-';
                banner.innerText = '🔔 ใกล้ถึง ' + c.label + ' ที่ ' + formatPrice(c.level) + ' (ห่าง ' + distanceText + ', Strength ' + strengthText + ' · ' + (c.confidence || '') + ')' + (c.eta ? ' · คาดว่าอีกประมาณ ' + c.eta : '');
            } else {
                banner.style.display = 'none';
            }
        }

        function recomputeSRDistances(livePrice) {
            if (!srData || !livePrice) return;
            srData.current_price = livePrice;
            const upd = (item) => {
                const distance = Math.abs(item.level - livePrice);
                item.distance_pct = Math.round((distance / livePrice) * 10000) / 100;
            };
            srData.support.forEach(upd);
            srData.resistance.forEach(upd);
            const all = [...srData.support, ...srData.resistance];
            srData.closest_alert = all.length ? all.reduce((a, b) => a.distance_pct <= b.distance_pct ? a : b) : null;
            renderSRLadder();
        }

        function updatePriceChangeDisplay() {
            // ราคาหลัก: เทียบกับราคาปิดวันก่อนหน้า
            const changeEl = document.getElementById('price-change');
            if (changeEl) {
                if (typeof currentLivePrice === 'number' && Number.isFinite(currentLivePrice) && currentPrevClose > 0) {
                    const diff = currentLivePrice - currentPrevClose;
                    const pct = (diff / currentPrevClose) * 100;
                    const sign = diff >= 0 ? '+' : '';
                    changeEl.innerText = `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
                    changeEl.className = `price-change ${diff >= 0 ? 'up' : 'down'}`;
                } else {
                    changeEl.innerText = '-';
                    changeEl.className = 'price-change';
                }
            }

            // ราคา Post-Market: เทียบกับราคาปิดตลาดปกติของวันนั้น
            const postChangeEl = document.getElementById('post-change');
            const postPriceEl = document.getElementById('post-price');
            if (postChangeEl && postPriceEl) {
                const postPriceText = postPriceEl.innerText;
                const postPrice = parseFloat(postPriceText.replace('$', ''));
                if (currentClosePrice > 0 && !isNaN(postPrice)) {
                    const diff = postPrice - currentClosePrice;
                    const pct = (diff / currentClosePrice) * 100;
                    const sign = diff >= 0 ? '+' : '';
                    postChangeEl.innerText = `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
                    postChangeEl.className = `price-change ${diff >= 0 ? 'up' : 'down'}`;
                } else {
                    postChangeEl.innerText = '-';
                    postChangeEl.className = 'price-change';
                }
            }
        }

        async function fetchDashboardDataLegacy() {
            isChangingData = true;
            document.getElementById('stats-title').innerText = `${currentTicker} Key Statistics`;

            try {
                // 1. Fetch Stats
                const statsRes = await fetch(`/api/stats?ticker=${currentTicker}`);
                if (!statsRes.ok) {
                    const text = await statsRes.text();
                    throw new Error(`Stats request failed: ${statsRes.status} ${statsRes.statusText} - ${text.slice(0, 250)}`);
                }
                const stats = await statsRes.json();
                const livePriceRaw = stats.current_price;
                const livePriceNum = typeof livePriceRaw === 'number'
                    ? livePriceRaw
                    : (typeof livePriceRaw === 'string' && livePriceRaw.trim() !== '' ? Number(livePriceRaw) : NaN);
                currentLivePrice = Number.isFinite(livePriceNum) ? livePriceNum : null;
                currentMarketSession = stats.market_session || "CLOSED";

                const livePriceEl = document.getElementById('live-price');
                if (livePriceEl) {
                    livePriceEl.innerText = Number.isFinite(currentLivePrice) ? `$${currentLivePrice.toFixed(2)}` : '-';
                }

                // เก็บราคาปิดวันก่อนหน้า/ราคาปิดปกติไว้ใช้คำนวณ % แบบ real-time
                currentPrevClose = Number(stats.prev_close) || 0;
                currentClosePrice = Number(stats.close_price) || 0;
                updateHomeMarketSurface(stats);

                document.getElementById('stat-pe').innerText = stats.pe_ratio;
                setFairValueDisplay(stats.fair_value, stats.fair_value_upside_pct);
                document.getElementById('stat-vol').innerText = stats.volume;
                document.getElementById('stat-pcr').innerText = stats.put_call_ratio;

                document.getElementById('iv-val').innerText = Number.isFinite(Number(stats.iv_rank)) ? `${Number(stats.iv_rank)}%` : '-';
                document.getElementById('iv-fill').style.width = `${Math.min(Number.isFinite(Number(stats.iv_rank)) ? Number(stats.iv_rank) : 0, 100)}%`;

                // Market session badge + pre/post prices
                const sessionLabels = { REGULAR: "🟢 กำลังเทรด", PRE: "🌅 Pre-Market", POST: "🌆 After-Hours", CLOSED: "🔴 ตลาดปิด" };
                const badge = document.getElementById('session-badge');
                badge.innerText = sessionLabels[currentMarketSession] || currentMarketSession;
                badge.className = `market-session-badge session-${currentMarketSession}`;
                document.getElementById('post-price').innerText = Number.isFinite(Number(stats.post_price)) ? `$${Number(stats.post_price).toFixed(2)}` : '-';

                // ตอนนี้ live-price และ post-price ถูกตั้งค่าแล้ว จึงคำนวณ % ได้
                updatePriceChangeDisplay();

                // Call/Put gauges
                document.getElementById('call-score-val').innerText = `${stats.call_score}/100`;
                document.getElementById('call-score-fill').style.width = `${stats.call_score}%`;
                document.getElementById('put-score-val').innerText = `${stats.put_score}/100`;
                document.getElementById('put-score-fill').style.width = `${stats.put_score}%`;

                // 2. Fetch Chart Data
                const chartRes = await fetch(`/api/chart-data?ticker=${currentTicker}&timeframe=${currentTimeframe}`);
                if (!chartRes.ok) {
                    const text = await chartRes.text();
                    throw new Error(`Chart-data request failed: ${chartRes.status} ${chartRes.statusText} - ${text.slice(0, 250)}`);
                }
                let chartData;
                try {
                    chartData = await chartRes.json();
                } catch (parseErr) {
                    const text = await chartRes.text();
                    throw new Error(`Chart-data JSON parse failed: ${parseErr.message} - ${text.slice(0, 250)}`);
                }
                if (!Array.isArray(chartData) || chartData.length === 0) {
                    throw new Error('Chart-data response empty or invalid');
                }
                globalChartData = chartData;

                const candles = chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }));

                // ⭐ [แก้ไขฟีดข้อมูล] แปลงข้อมูลจัดส่งเข้า Volume Histogram
                const volumes = chartData.map(d => ({
                    time: d.time,
                    value: d.volume,
                    color: d.close >= d.open ? '#00c57f' : '#ff3b30' // หากปิดบวกให้แท่งวอลลุ่มสีเขียว ปิดลบสีแดง
                }));

                candleSeries.setData(candles);
                updateEMASeries(); // วาด/อัปเดตเส้น EMA ให้ตรงกับข้อมูลแท่งเทียนล่าสุด
                volumeSeries.setData(volumes); // นำข้อมูลเข้าสู่หน้าอินดิเคเตอร์ตัวใหม่

                // 🔄 Sync volume chart timeScale กับ main chart เพื่อให้แท่งตรงกัน
                const logicalRange = chart.timeScale().getVisibleLogicalRange();
                if (logicalRange) {
                    volumeChart.timeScale().setVisibleLogicalRange(logicalRange);
                }
                requestAnimationFrame(syncPriceScaleWidths); // 🛠️ บังคับแกนราคาสองกราฟให้กว้างเท่ากันเป๊ะทุกครั้งที่โหลดข้อมูลใหม่
                renderDashboardOverlay();

                // 3. Fetch Indicators (S/R)
                const indRes = await fetch(`/api/indicators?ticker=${currentTicker}&timeframe=${currentTimeframe}`);
                if (!indRes.ok) {
                    const text = await indRes.text();
                    throw new Error(`Indicators request failed: ${indRes.status} ${indRes.statusText} - ${text.slice(0, 250)}`);
                }
                srData = await indRes.json();
                renderSRLadder();

                // 4. Connect WebSocket & Fetch Portfolio
                if (currentMarketSession === "REGULAR") {
                    initWebSocket();
                } else {
                    closeLivePriceSocket();
                }
                await fetchPortfolio();
                setTimeout(resetChartView, 50);

                // 6. Phase 5: Full Gauge Suite (non-blocking)
                loadFullGauges(currentTicker);

            } catch (err) {
                console.error("Dashboard fetch error:", err);
            } finally {
                isChangingData = false;
            }
        }

        async function fetchDashboardData() {
            const context = makeDashboardContext();
            isChangingData = true;
            document.getElementById('stats-title').innerText = `${context.ticker} Key Statistics`;

            try {
                const [statsRes, chartRes] = await Promise.all([
                    fetch(`/api/stats?ticker=${encodeURIComponent(context.ticker)}`, { signal: context.signal, cache: 'no-store' }),
                    fetch(`/api/chart-data?ticker=${encodeURIComponent(context.ticker)}&timeframe=${encodeURIComponent(context.timeframe)}`, { signal: context.signal, cache: 'no-store' }),
                ]);
                if (!isCurrentView(context)) return;
                if (!statsRes.ok) throw new Error(`Stats request failed: ${statsRes.status} ${statsRes.statusText}`);
                if (!chartRes.ok) throw new Error(`Chart-data request failed: ${chartRes.status} ${chartRes.statusText}`);

                const [stats, chartData] = await Promise.all([statsRes.json(), chartRes.json()]);
                if (!isCurrentView(context)) return;
                if (!Array.isArray(chartData) || chartData.length === 0) {
                    throw new Error('Chart-data response empty or invalid');
                }

                const livePriceRaw = stats.current_price;
                const livePriceNum = typeof livePriceRaw === 'number'
                    ? livePriceRaw
                    : (typeof livePriceRaw === 'string' && livePriceRaw.trim() !== '' ? Number(livePriceRaw) : NaN);
                currentLivePrice = Number.isFinite(livePriceNum) ? livePriceNum : null;
                currentMarketSession = stats.market_session || 'CLOSED';
                currentPrevClose = Number(stats.prev_close) || 0;
                currentClosePrice = Number(stats.close_price) || 0;

                const livePriceEl = document.getElementById('live-price');
                if (livePriceEl) {
                    livePriceEl.innerText = Number.isFinite(currentLivePrice) ? `$${currentLivePrice.toFixed(2)}` : '-';
                    livePriceEl.removeAttribute('data-stale');
                    livePriceEl.removeAttribute('title');
                }
                updateHomeMarketSurface(stats);

                document.getElementById('stat-pe').innerText = stats.pe_ratio;
                setFairValueDisplay(stats.fair_value, stats.fair_value_upside_pct);
                document.getElementById('stat-vol').innerText = stats.volume;
                document.getElementById('stat-pcr').innerText = stats.put_call_ratio;
                document.getElementById('iv-val').innerText = Number.isFinite(Number(stats.iv_rank)) ? `${Number(stats.iv_rank)}%` : '-';
                document.getElementById('iv-fill').style.width = `${Math.min(Number.isFinite(Number(stats.iv_rank)) ? Number(stats.iv_rank) : 0, 100)}%`;

                const sessionLabels = { REGULAR: '🟢 ตลาดเปิด', PRE: '🌅 Pre-Market', POST: '🌆 After-Hours', CLOSED: '🔒 ตลาดปิด' };
                const badge = document.getElementById('session-badge');
                badge.innerText = sessionLabels[currentMarketSession] || currentMarketSession;
                badge.className = `market-session-badge session-${currentMarketSession}`;
                document.getElementById('post-price').innerText = Number.isFinite(Number(stats.post_price)) ? `$${Number(stats.post_price).toFixed(2)}` : '-';
                updatePriceChangeDisplay();

                document.getElementById('call-score-val').innerText = `${stats.call_score}/100`;
                document.getElementById('call-score-fill').style.width = `${stats.call_score}%`;
                document.getElementById('put-score-val').innerText = `${stats.put_score}/100`;
                document.getElementById('put-score-fill').style.width = `${stats.put_score}%`;

                globalChartData = chartData;
                const candles = chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }));
                const volumes = chartData.map(d => ({
                    time: d.time,
                    value: d.volume,
                    color: d.close >= d.open ? '#00c57f' : '#ff3b30'
                }));
                candleSeries.setData(candles);
                updateEMASeries();
                volumeSeries.setData(volumes);
                const logicalRange = chart.timeScale().getVisibleLogicalRange();
                if (logicalRange) volumeChart.timeScale().setVisibleLogicalRange(logicalRange);
                requestAnimationFrame(syncPriceScaleWidths);
                renderDashboardOverlay();

                const indRes = await fetch(`/api/indicators?ticker=${encodeURIComponent(context.ticker)}&timeframe=${encodeURIComponent(context.timeframe)}`, { signal: context.signal, cache: 'no-store' });
                if (!isCurrentView(context)) return;
                if (!indRes.ok) throw new Error(`Indicators request failed: ${indRes.status} ${indRes.statusText}`);
                const indicators = await indRes.json();
                if (!isCurrentView(context)) return;
                srData = indicators;
                renderSRLadder();

                if (currentMarketSession === 'REGULAR') initWebSocket(context);
                else closeLivePriceSocket();
                fetchPortfolio();
                window.setTimeout(() => { if (isCurrentView(context)) resetChartView(); }, 50);
                loadFullGauges(context);
            } catch (err) {
                if (!isAbortError(err) && isCurrentView(context)) {
                    console.error('Dashboard fetch error:', err);
                }
            } finally {
                if (isCurrentView(context)) isChangingData = false;
            }
        }

        function switchStock(ticker) {
            const nextTicker = String(ticker || '').toUpperCase().trim();
            if (!/^[A-Z0-9.-]{1,12}$/.test(nextTicker)) return;
            invalidateViewRequests();
            closeLivePriceSocket();
            currentTicker = nextTicker;
            currentLivePrice = null;
            updateHomeMarketSurface({ current_price: null, prev_close: null, market_session: 'LOADING' });
            removeSRLines();
            fetchDashboardData();
            renderWatchlist();
        }

        function searchStock() {
            const input = document.getElementById('search-input').value.toUpperCase().trim();
            if (!input) return;
            switchStock(input);
        }

        // 🛠️ [แก้บั๊ก] เดิม Volume ของแท่งล่าสุดจะค้างอยู่ค่าตอนโหลดหน้าครั้งแรกตลอด เพราะ
        // WebSocket ส่งมาแค่ "ราคา" ไม่มี "วอลลุ่ม" เลย ฟังก์ชันนี้จะดึงแท่งเทียน+วอลลุ่มชุดล่าสุด
        // มาแทนที่เป็นระยะ เพื่อให้ Volume ตรงกับแท่งราคาจริงเสมอ โดยไม่รบกวนตำแหน่งที่ผู้ใช้กำลังดูอยู่
        // (setData แทนที่ทั้งชุดทุกครั้ง จึงไม่มีแท่งซ้อนหรือช่องว่างผิดปกติ เพราะ time เดียวกันจะถูกอัปเดตทับ ไม่ใช่เพิ่มใหม่)
        let isRefreshingChart = false;
        async function refreshChartOnlyLegacy() {
            if (isChangingData || isRefreshingChart) return; // อย่าชนกับการโหลดข้อมูลเต็มรูปแบบ (เปลี่ยนหุ้น/timeframe)
            isRefreshingChart = true;
            try {
                const chartRes = await fetch(`/api/chart-data?ticker=${currentTicker}&timeframe=${currentTimeframe}`);
                if (!chartRes.ok) {
                    const text = await chartRes.text();
                    console.error(`Chart refresh failed: ${chartRes.status} ${chartRes.statusText} -`, text.slice(0, 250));
                    return;
                }
                const chartData = await chartRes.json();
                if (!Array.isArray(chartData) || chartData.length === 0) return;
                globalChartData = chartData;

                const candles = chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }));
                // ⭐ Candle และ Volume มาจาก chartData ชุดเดียวกันเป๊ะ ใช้ d.time เดียวกันทั้งคู่
                // จึงการันตีว่าแท่ง Volume จะตรงกับแท่งเทียนทุกแท่งเสมอ
                const volumes = chartData.map(d => ({
                    time: d.time,
                    value: d.volume,
                    color: d.close >= d.open ? '#00c57f' : '#ff3b30'
                }));

                // จำตำแหน่งที่ผู้ใช้กำลังดูอยู่ไว้ก่อน ไม่ให้กราฟกระตุกไปที่ real-time ทุกครั้งที่รีเฟรชเบื้องหลัง
                const savedRange = chart.timeScale().getVisibleLogicalRange();

                candleSeries.setData(candles);
                volumeSeries.setData(volumes);
                updateEMASeries();

                if (savedRange) {
                    isSyncing = true;
                    chart.timeScale().setVisibleLogicalRange(savedRange);
                    volumeChart.timeScale().setVisibleLogicalRange(savedRange);
                    isSyncing = false;
                }
                requestAnimationFrame(syncPriceScaleWidths); // 🛠️ บังคับแกนราคาสองกราฟให้กว้างเท่ากันเป๊ะ
            } catch (err) {
                console.error("Chart refresh error:", err);
            } finally {
                isRefreshingChart = false;
            }
        }

        async function refreshChartOnly() {
            if (!isPageVisible || !isNetworkOnline || isChangingData || isRefreshingChart) return;
            if (chartRefreshAbortController && !chartRefreshAbortController.signal.aborted) {
                chartRefreshAbortController.abort();
            }
            const controller = new AbortController();
            chartRefreshAbortController = controller;
            const context = {
                epoch: viewEpoch,
                ticker: currentTicker,
                timeframe: currentTimeframe,
                signal: controller.signal,
            };
            isRefreshingChart = true;

            try {
                const chartRes = await fetch(
                    `/api/chart-data?ticker=${encodeURIComponent(context.ticker)}&timeframe=${encodeURIComponent(context.timeframe)}`,
                    { signal: context.signal, cache: 'no-store' }
                );
                if (!isCurrentView(context)) return;
                if (!chartRes.ok) throw new Error(`Chart refresh failed: ${chartRes.status} ${chartRes.statusText}`);
                const chartData = await chartRes.json();
                if (!isCurrentView(context) || !Array.isArray(chartData) || chartData.length === 0) return;

                globalChartData = chartData;
                const candles = chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }));
                const volumes = chartData.map(d => ({
                    time: d.time,
                    value: d.volume,
                    color: d.close >= d.open ? '#00c57f' : '#ff3b30'
                }));
                const savedRange = chart.timeScale().getVisibleLogicalRange();
                candleSeries.setData(candles);
                volumeSeries.setData(volumes);
                updateEMASeries();
                if (savedRange && isCurrentView(context)) {
                    isSyncing = true;
                    chart.timeScale().setVisibleLogicalRange(savedRange);
                    volumeChart.timeScale().setVisibleLogicalRange(savedRange);
                    isSyncing = false;
                }
                requestAnimationFrame(syncPriceScaleWidths);
            } catch (err) {
                if (!isAbortError(err) && isCurrentView(context)) console.error('Chart refresh error:', err);
            } finally {
                if (chartRefreshAbortController === controller) chartRefreshAbortController = null;
                if (controller.signal.aborted || chartRefreshAbortController === null) isRefreshingChart = false;
            }
        }

        let chartRefreshTimer = null;
        function startChartAutoRefresh() {
            if (chartRefreshTimer) clearInterval(chartRefreshTimer);
            chartRefreshTimer = setInterval(refreshChartOnly, 15000); // รีเฟรชแท่งเทียน+วอลลุ่มทุก 15 วิ
        }

        async function addCurrentToWatchlist() {
            if (authState.configured === true && !authState.authenticated) {
                openProfileSheet();
                setAuthStatus('Sign in before changing a cloud watchlist.', 'error');
                return;
            }
            if (cloudWorkspaceEnabled()) {
                if (!selectedCloudWatchlist()) await loadCloudWorkspace();
                if (selectedCloudWatchlist()) {
                    await addTickerToSelectedCloudWatchlist(currentTicker);
                    return;
                }
                setCloudWorkspaceStatus('Your cloud watchlist is unavailable. Try opening Profile and refreshing the workspace.', 'error');
                return;
            }
            try {
                const res = await authFetch(`/api/watchlist?ticker=${encodeURIComponent(currentTicker)}`, {
                    method: 'POST', headers: authHeaders(),
                });
                if (!res.ok) throw new Error(`Watchlist update failed: ${res.status}`);
                fetchWatchlist();
            } catch (err) {
                console.error('Error adding watchlist item:', err);
            }
        }
        async function deleteWatchlist(ticker) {
            const wasCurrent = currentTicker === ticker;
            try {
                if (cloudWorkspaceEnabled()) {
                    if (!selectedCloudWatchlist()) await loadCloudWorkspace();
                    if (!selectedCloudWatchlist()) {
                        setCloudWorkspaceStatus('Your cloud watchlist is unavailable. Try opening Profile and refreshing the workspace.', 'error');
                        return;
                    }
                    const result = await removeTickerFromSelectedCloudWatchlist(ticker);
                    if (result && wasCurrent) switchStock(watchlist[0] || 'NVDA');
                    return;
                }
                const res = await authFetch(`/api/watchlist/${encodeURIComponent(ticker)}`, {
                    method: 'DELETE', headers: authHeaders(),
                });
                if (!res.ok) throw new Error(`Watchlist delete failed: ${res.status}`);
                watchlist = await res.json();
                updateHomeWatchlistSurface();
                if (wasCurrent) switchStock(watchlist[0] || 'NVDA');
                else renderWatchlist();
            } catch (err) {
                console.error('Error deleting watchlist item:', err);
            }
        }

        function changeTimeframe(tf, btn) {
            if (tf === currentTimeframe) return;
            document.querySelectorAll('#timeframe-group button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            invalidateViewRequests();
            currentTimeframe = tf;
            removeSRLines();
            fetchDashboardData();
        }

        function toggleSupportResistance() {
            if (isSRVisible) { removeSRLines(); }
            else {
                if (!srData) return;
                const resColors = ['#ff8a80', '#ff5c4d', '#ff3b30'];
                const supColors = ['#69f0ae', '#2ee08a', '#00c57f'];
                const widths = [4, 3, 3];
                const f = (p, c, w, t) => candleSeries.createPriceLine({ price: p, color: c, lineWidth: w, lineStyle: LightweightCharts.LineStyle.Solid, title: t });

                // On small screens, only show primary S/R labels to avoid crowding the chart
                const isMobile = window.innerWidth <= 768;
                const allowedMobile = new Set(['R1','R2','R3','S1','S2','S3']);

                const filterFn = (it) => {
                    if (!it || !it.label) return false;
                    const token = String(it.label).trim().split(/\s|[:\-]/)[0];
                    return allowedMobile.has(token);
                };

                const resToShow = isMobile
                    ? (Array.isArray(srData.resistance) ? srData.resistance.filter(filterFn) : [])
                    : (Array.isArray(srData.resistance) ? srData.resistance.slice() : []);
                const supToShow = isMobile
                    ? (Array.isArray(srData.support) ? srData.support.filter(filterFn) : [])
                    : (Array.isArray(srData.support) ? srData.support.slice() : []);

                resToShow.forEach((r, i) => srLines.push(f(r.level, resColors[i] || '#ff3b30', widths[i] || 3, `${r.label} แนวต้าน (${r.strength}% ${r.confidence})`)));
                supToShow.forEach((s, i) => srLines.push(f(s.level, supColors[i] || '#00c57f', widths[i] || 3, `${s.label} แนวรับ (${s.strength}% ${s.confidence})`)));

                isSRVisible = true; document.getElementById('toggle-sr').classList.add('active');
            }
        }
        function removeSRLines() { srLines.forEach(l => candleSeries.removePriceLine(l)); srLines = []; isSRVisible = false; document.getElementById('toggle-sr').classList.remove('active'); }

        // --- 💼 Portfolio Engine Via API ---
        async function fetchPortfolio() {
            const sessionEpoch = authSessionEpoch;
            if (authState.configured === true && !authState.authenticated) {
                activePositions = [];
                renderPortfolioTable();
                updateHomePortfolioSurface();
                return;
            }
            try {
                const res = await authFetch('/api/positions', { cache: 'no-store' });
                if (!res.ok) throw new Error(`Portfolio request failed: ${res.status}`);
                const positions = await res.json();
                if (sessionEpoch !== authSessionEpoch) return;
                activePositions = Array.isArray(positions) ? positions : [];
                renderPortfolioTable();
                updateHomePortfolioSurface();
            } catch (err) { console.error("Error fetching portfolio:", err); }
        }

        function renderPortfolioTable() {
            const tbody = document.getElementById('portfolio-rows');
            const finiteNumber = value => {
                if (value === null || value === undefined || value === '') return null;
                const number = Number(value);
                return Number.isFinite(number) ? number : null;
            };
            if (activePositions.length === 0) {
                tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">💼 พอร์ตว่างเปล่า ลองระบุเงื่อนไขด้านบนเพื่อเปิดสถานะสัญญาจำลอง</td></tr>`;
                return;
            }
            tbody.innerHTML = activePositions.map(p => {
                const liveUnderlying = finiteNumber(p.current_underlying_price);
                const entryUnderlying = finiteNumber(p.entry_underlying_price);
                const currentUPrice = liveUnderlying !== null && liveUnderlying > 0 ? liveUnderlying : (entryUnderlying !== null && entryUnderlying > 0 ? entryUnderlying : null);
                const staleUnderlying = !(liveUnderlying !== null && liveUnderlying > 0);
                const pnl = finiteNumber(p.pnl);
                const pnlPercent = finiteNumber(p.pnl_percent);
                const premiumPaid = finiteNumber(p.premium_paid);
                const quantity = finiteNumber(p.quantity);
                const ivDisp = p.iv ? p.iv + '%' : '-';
                const deltaDisp = p.delta ? p.delta : '-';

                let currentSellPrice = null;
                if (premiumPaid !== null && pnl !== null && quantity !== null && quantity > 0) {
                    currentSellPrice = premiumPaid + (pnl / (quantity * 100));
                    if (currentSellPrice < 0.01) currentSellPrice = 0.01;
                    if (!Number.isFinite(currentSellPrice)) currentSellPrice = null;
                }

                const color = pnl === null ? 'var(--text-muted)' : (pnl >= 0 ? 'var(--green)' : 'var(--red)');
                const sign = pnl !== null && pnl >= 0 ? '+' : '';
                const underlyingDisplay = currentUPrice === null
                    ? '<span style="color:var(--text-muted);">—</span>'
                    : `$${currentUPrice.toFixed(2)}${staleUnderlying ? ' <span style="font-size:10px; color:var(--gold);">stale</span>' : ''}`;
                const pnlDisplay = pnl === null
                    ? '<span style="color:var(--text-muted);">—</span>'
                    : `${sign}$${pnl.toFixed(2)} <span style="font-size:12px;">(${pnlPercent === null ? '—' : `${sign}${pnlPercent.toFixed(2)}%`})</span>`;

                return `
<tr>
<td style="font-weight:bold; color:white;">${p.ticker}</td>
<td style="color:${p.option_type === 'CALL' ? 'var(--green)' : 'var(--red)'}; font-weight:bold;">${p.option_type}</td>
<td>$${p.strike_price}</td>
<td>${p.expiration}</td>
<td>${premiumPaid === null ? '—' : `$${premiumPaid.toFixed(2)}`}</td>
<td>${p.quantity}</td>
<td style="color:var(--text-muted); font-size:12px;">${ivDisp} / ${deltaDisp}</td>
<td id="table-underlying-${p.id}" title="${staleUnderlying ? 'Live quote unavailable; showing entry price when available.' : 'Latest underlying price'}">${underlyingDisplay}</td>
<td id="table-sellprice-${p.id}" style="font-weight:bold; color:${currentSellPrice === null ? 'var(--text-muted)' : 'var(--gold)'};">${currentSellPrice === null ? '—' : `$${currentSellPrice.toFixed(2)}`}</td>
<td id="table-pnl-${p.id}" class="pnl-cell" style="color:${color}">${pnlDisplay}</td>
<td><button style="background:rgba(255,59,48,0.1); color:var(--red); border:1px solid var(--red); padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer;" onclick="closePosition(${p.id})">ปิดสัญญา</button></td>
</tr>
`}).join('');
        }

        async function submitPosition(e) {
            e.preventDefault();
            const payload = {
                ticker: currentTicker,
                strike_price: parseFloat(document.getElementById('form-strike').value),
                option_type: document.getElementById('form-type').value,
                expiration: document.getElementById('form-exp').value,
                premium_paid: parseFloat(document.getElementById('form-premium').value),
                quantity: parseInt(document.getElementById('form-qty').value),
                iv: parseFloat(document.getElementById('form-iv').value) || 0.0,
                delta: parseFloat(document.getElementById('form-delta').value) || 0.0
            };
            const portfolioId = cloudWorkspaceId(document.getElementById('form-portfolio-id')?.value);
            if (cloudWorkspaceEnabled() && portfolioId) payload.portfolio_id = portfolioId;

            const res = await authFetch('/api/positions', {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const error = await res.json().catch(() => ({}));
                throw new Error(error.detail || 'Unable to add position.');
            }
            document.getElementById('pos-form').reset();
            updatePositionPortfolioSelector();
            fetchPortfolio();
        }

        async function closePosition(id) {
            const res = await authFetch(`/api/positions/${id}`, {
                method: 'DELETE', headers: authHeaders(),
            });
            if (!res.ok) throw new Error('Unable to close position.');
            fetchPortfolio();
        }

        // --- ⚡ Real-Time WebSocket Connection ---
        function closeLivePriceSocketLegacy(resetRetries = true) {
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            if (resetRetries) wsReconnectAttempts = 0;
            if (!ws) return;

            const socket = ws;
            ws = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.close();
        }

        function scheduleLivePriceReconnectLegacy(liveTicker) {
            if (wsReconnectTimer || liveTicker !== currentTicker || currentMarketSession !== "REGULAR") return;
            const delay = Math.min(1000 * (2 ** wsReconnectAttempts), 30000);
            wsReconnectAttempts = Math.min(wsReconnectAttempts + 1, 5);
            wsReconnectTimer = window.setTimeout(() => {
                wsReconnectTimer = null;
                if (liveTicker === currentTicker && currentMarketSession === "REGULAR") initWebSocket();
            }, delay);
        }

        function initWebSocketLegacy() {
            closeLivePriceSocket(false);
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const liveTicker = currentTicker;
            const wsUrl = `${protocol}//${window.location.host}/ws/price/${liveTicker}`;
            const socket = new WebSocket(wsUrl);
            ws = socket;

            socket.onopen = function () {
                wsReconnectAttempts = 0;
            };

            socket.onmessage = function (event) {
                if (socket !== ws || liveTicker !== currentTicker) return;
                const data = JSON.parse(event.data);
                if (data.market_session && data.market_session !== "REGULAR") {
                    currentMarketSession = data.market_session;
                    closeLivePriceSocket();
                    return;
                }
                const newPrice = data.price;
                const lastPrice = currentLivePrice;
                currentLivePrice = newPrice;

                const priceDisplay = document.getElementById('live-price');
                if (priceDisplay) {
                    priceDisplay.innerText = Number.isFinite(currentLivePrice) ? `$${currentLivePrice.toFixed(2)}` : '-';
                    priceDisplay.style.color = Number.isFinite(currentLivePrice) && Number.isFinite(lastPrice) && currentLivePrice >= lastPrice ? 'var(--green)' : 'var(--red)';
                }

                // ราคาขยับ -> คำนวณ % ใหม่ทุกครั้ง
                updatePriceChangeDisplay();
                updateHomeMarketSurface({ current_price: currentLivePrice, prev_close: currentPrevClose, market_session: currentMarketSession });

                recomputeSRDistances(currentLivePrice);

                if (globalChartData.length > 0) {
                    const lastData = globalChartData[globalChartData.length - 1];
                    lastData.close = currentLivePrice;
                    if (currentLivePrice > lastData.high) lastData.high = currentLivePrice;
                    if (currentLivePrice < lastData.low) lastData.low = currentLivePrice;
                    candleSeries.update(lastData);
                    updateEMASeries(); // ราคาแท่งล่าสุดขยับ -> เส้น EMA ต้องขยับตาม
                }

                // อัปเดตราคา P&L แบบ Real-time
                activePositions.forEach(p => {
                    if (p.ticker === currentTicker) {
                        const entryU = parseFloat(p.entry_underlying_price);
                        const initialPremium = parseFloat(p.premium_paid);
                        let currentPremium = initialPremium;

                        if (p.delta && parseFloat(p.delta) !== 0) {
                            let actualDelta = parseFloat(p.delta);
                            if (p.option_type === "PUT" && actualDelta > 0) actualDelta = -actualDelta;
                            currentPremium = initialPremium + (actualDelta * (currentLivePrice - entryU));
                        } else {
                            if (p.option_type === "CALL") {
                                currentPremium += (currentLivePrice - entryU) * 0.5;
                            } else {
                                currentPremium += (entryU - currentLivePrice) * 0.5;
                            }
                        }

                        currentPremium = Math.max(currentPremium, 0.01);
                        let pnl = (currentPremium - initialPremium) * 100 * p.quantity;

                        const principal = initialPremium * p.quantity * 100;
                        const pnlPercent = principal > 0 ? (pnl / principal) * 100 : 0;

                        const cellPrice = document.getElementById(`table-underlying-${p.id}`);
                        const cellPnl = document.getElementById(`table-pnl-${p.id}`);
                        const cellSellPrice = document.getElementById(`table-sellprice-${p.id}`);

                        if (cellPrice) cellPrice.innerText = Number.isFinite(currentLivePrice) ? `$${currentLivePrice.toFixed(2)}` : '-';
                        if (cellSellPrice) cellSellPrice.innerText = `$${currentPremium.toFixed(2)}`;

                        if (cellPnl) {
                            const sign = pnl >= 0 ? '+' : '';
                            cellPnl.innerHTML = `${sign}$${pnl.toFixed(2)} <span style="font-size:12px;">(${sign}${pnlPercent.toFixed(2)}%)</span>`;
                            cellPnl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
                        }
                    }
                });
            };

            socket.onclose = function () {
                if (socket !== ws) return;
                ws = null;
                scheduleLivePriceReconnect(liveTicker);
            };
        }

        // --- 🔮 What-If Simulator Logic ---
        function stopLiveSocketWatchdog() {
            if (wsWatchdogTimer) {
                clearInterval(wsWatchdogTimer);
                wsWatchdogTimer = null;
            }
        }

        function closeLivePriceSocket(resetRetries = true) {
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            stopLiveSocketWatchdog();
            if (resetRetries) wsReconnectAttempts = 0;
            wsConnectionEpoch += 1;
            if (!ws) return;

            const socket = ws;
            ws = null;
            socket.onopen = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close(1000, 'Client reconnecting');
            }
        }

        function canRunLiveFeed(context) {
            return isCurrentView(context) && isNetworkOnline && currentMarketSession === 'REGULAR';
        }

        function scheduleLivePriceReconnect(context) {
            if (wsReconnectTimer || !canRunLiveFeed(context)) return;
            const baseDelay = Math.min(1000 * (2 ** wsReconnectAttempts), 30000);
            const delay = Math.round(baseDelay * (0.85 + Math.random() * 0.3));
            wsReconnectAttempts = Math.min(wsReconnectAttempts + 1, 5);
            wsReconnectTimer = window.setTimeout(() => {
                wsReconnectTimer = null;
                if (canRunLiveFeed(context)) initWebSocket(context);
            }, delay);
        }

        function startLiveSocketWatchdog(socket, context, connectionId) {
            stopLiveSocketWatchdog();
            wsWatchdogTimer = window.setInterval(() => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) {
                    stopLiveSocketWatchdog();
                    return;
                }
                if (!isNetworkOnline || Date.now() - wsLastMessageAt <= 20000) return;
                socket.close(4000, 'Live quote heartbeat timed out');
            }, 5000);
        }

        function applyLiveQuote(data, context) {
            if (!isCurrentView(context) || !data || data.ticker !== context.ticker) return;
            if (data.market_session) currentMarketSession = data.market_session;
            const newPrice = Number(data.price);
            const isValidPrice = Number.isFinite(newPrice) && newPrice > 0;
            const lastPrice = currentLivePrice;
            const priceDisplay = document.getElementById('live-price');

            if (priceDisplay) {
                if (data.stale) {
                    priceDisplay.dataset.stale = 'true';
                    priceDisplay.title = 'Last known polling price. The market-data provider is temporarily unavailable.';
                } else {
                    priceDisplay.removeAttribute('data-stale');
                    priceDisplay.title = `${data.provider || 'Market data'} polling update`;
                }
            }

            if (currentMarketSession !== 'REGULAR') {
                updateHomeMarketSurface({ current_price: isValidPrice ? newPrice : currentLivePrice, prev_close: currentPrevClose, market_session: currentMarketSession });
                closeLivePriceSocket();
                return;
            }
            if (!isValidPrice) return;

            currentLivePrice = newPrice;
            if (priceDisplay) {
                priceDisplay.innerText = `$${currentLivePrice.toFixed(2)}`;
                priceDisplay.style.color = Number.isFinite(lastPrice)
                    ? (currentLivePrice >= lastPrice ? 'var(--green)' : 'var(--red)')
                    : 'var(--pt-white)';
            }
            updatePriceChangeDisplay();
            updateHomeMarketSurface({ current_price: currentLivePrice, prev_close: currentPrevClose, market_session: currentMarketSession });
            recomputeSRDistances(currentLivePrice);

            if (globalChartData.length > 0) {
                const lastData = globalChartData[globalChartData.length - 1];
                lastData.close = currentLivePrice;
                if (currentLivePrice > lastData.high) lastData.high = currentLivePrice;
                if (currentLivePrice < lastData.low) lastData.low = currentLivePrice;
                candleSeries.update(lastData);
                updateEMASeries();
            }

            activePositions.forEach(position => {
                if (position.ticker !== currentTicker) return;
                const entryUnderlying = parseFloat(position.entry_underlying_price);
                const initialPremium = parseFloat(position.premium_paid);
                if (!Number.isFinite(entryUnderlying) || !Number.isFinite(initialPremium)) return;
                let currentPremium = initialPremium;
                if (position.delta && parseFloat(position.delta) !== 0) {
                    let delta = parseFloat(position.delta);
                    if (position.option_type === 'PUT' && delta > 0) delta = -delta;
                    currentPremium = initialPremium + (delta * (currentLivePrice - entryUnderlying));
                } else if (position.option_type === 'CALL') {
                    currentPremium += (currentLivePrice - entryUnderlying) * 0.5;
                } else {
                    currentPremium += (entryUnderlying - currentLivePrice) * 0.5;
                }
                currentPremium = Math.max(currentPremium, 0.01);
                const pnl = (currentPremium - initialPremium) * 100 * position.quantity;
                const principal = initialPremium * position.quantity * 100;
                const pnlPercent = principal > 0 ? (pnl / principal) * 100 : 0;
                const cellPrice = document.getElementById(`table-underlying-${position.id}`);
                const cellPnl = document.getElementById(`table-pnl-${position.id}`);
                const cellSellPrice = document.getElementById(`table-sellprice-${position.id}`);
                if (cellPrice) cellPrice.innerText = `$${currentLivePrice.toFixed(2)}`;
                if (cellSellPrice) cellSellPrice.innerText = `$${currentPremium.toFixed(2)}`;
                if (cellPnl) {
                    const sign = pnl >= 0 ? '+' : '';
                    cellPnl.innerHTML = `${sign}$${pnl.toFixed(2)} <span style="font-size:12px;">(${sign}${pnlPercent.toFixed(2)}%)</span>`;
                    cellPnl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
                }
            });
        }

        function initWebSocket(context = currentViewContext()) {
            if (!canRunLiveFeed(context)) return;
            closeLivePriceSocket(false);
            const connectionId = ++wsConnectionEpoch;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/price/${encodeURIComponent(context.ticker)}`;
            let socket;
            try {
                socket = new WebSocket(wsUrl);
            } catch (err) {
                console.warn('Live socket could not be opened:', err);
                scheduleLivePriceReconnect(context);
                return;
            }
            ws = socket;
            wsLastSequence = 0;
            wsLastMessageAt = Date.now();

            socket.onopen = () => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) {
                    socket.close(1000, 'Stale connection');
                    return;
                }
                wsReconnectAttempts = 0;
                wsLastMessageAt = Date.now();
                startLiveSocketWatchdog(socket, context, connectionId);
            };

            socket.onmessage = event => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) return;
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    console.warn('Ignoring malformed live quote payload:', err);
                    return;
                }
                if (!data || data.type !== 'quote' || data.ticker !== context.ticker) return;
                const sequence = Number(data.seq);
                if (Number.isFinite(sequence) && sequence <= wsLastSequence) return;
                if (Number.isFinite(sequence)) wsLastSequence = sequence;
                wsLastMessageAt = Date.now();
                applyLiveQuote(data, context);
            };

            socket.onerror = () => {
                if (socket === ws && connectionId === wsConnectionEpoch) socket.close();
            };

            socket.onclose = () => {
                if (socket !== ws || connectionId !== wsConnectionEpoch) return;
                ws = null;
                stopLiveSocketWatchdog();
                scheduleLivePriceReconnect(context);
            };
        }

        async function reconcileLiveState() {
            if (!isNetworkOnline) return;
            const context = currentViewContext();
            try {
                const res = await fetch(`/api/quote?ticker=${encodeURIComponent(context.ticker)}`, { cache: 'no-store' });
                if (res.ok) {
                    const quote = await res.json();
                    if (isCurrentView(context)) applyLiveQuote(quote, context);
                }
            } catch (err) {
                console.warn('Live quote reconciliation failed:', err);
            }
            if (isCurrentView(context)) fetchDashboardData();
        }

        function requestTerminalResync(delay = 0) {
            if (terminalResyncTimer) clearTimeout(terminalResyncTimer);
            terminalResyncTimer = window.setTimeout(() => {
                terminalResyncTimer = null;
                reconcileLiveState();
            }, delay);
        }

        document.addEventListener('visibilitychange', () => {
            isPageVisible = document.visibilityState === 'visible';
            if (isPageVisible) {
                requestTerminalResync();
                if (alertCenterEnabled()) {
                    void refreshAlertCenter({ quiet: true });
                    startAlertCenterPolling();
                }
            } else {
                stopAlertCenterPolling();
            }
        });
        window.addEventListener('online', () => {
            isNetworkOnline = true;
            requestTerminalResync();
            if (alertCenterEnabled()) {
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        });
        window.addEventListener('offline', () => {
            isNetworkOnline = false;
            closeLivePriceSocket(false);
            stopAlertCenterPolling();
        });
        window.addEventListener('pagehide', () => {
            closeLivePriceSocket(false);
            invalidateViewRequests();
            stopAlertCenterPolling();
        });
        window.addEventListener('pageshow', () => {
            isPageVisible = true;
            isNetworkOnline = navigator.onLine;
            requestTerminalResync();
            if (alertCenterEnabled()) {
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        });

        // --- Calculator desk -------------------------------------------------
        // These inputs deliberately stay in the current page only.  The server
        // validates every value again and no calculator value is persisted.
        let activeToolsCalculator = 'position';
        let toolsGrowthMode = 'compound';
        let toolsCalculatorAbortController = null;
        let toolsCalculatorRequestVersion = 0;

        function toolsCalculatorMarketPrice() {
            const live = Number(currentLivePrice);
            if (Number.isFinite(live) && live > 0) return live;
            const latestBar = Array.isArray(globalChartData) ? globalChartData[globalChartData.length - 1] : null;
            const close = Number(latestBar && latestBar.close);
            return Number.isFinite(close) && close > 0 ? close : '';
        }

        function toolsCalculatorInput(id, label, options = {}) {
            const value = options.value;
            const numericValue = value !== '' && value !== undefined && value !== null && Number.isFinite(Number(value))
                ? ` value="${Number(value)}"`
                : '';
            const min = options.min !== undefined ? ` min="${options.min}"` : '';
            const step = options.step || 'any';
            const placeholder = options.placeholder ? ` placeholder="${options.placeholder}"` : '';
            const wide = options.wide ? ' wide' : '';
            return `<label class="pt-tools-field${wide}"><span>${label}</span><input id="${id}" type="number" inputmode="decimal" step="${step}"${min}${numericValue}${placeholder}></label>`;
        }

        function toolsCalculatorSelect(id, label, options, selected, wide = false) {
            const items = options.map(option => {
                const isSelected = option.value === selected ? ' selected' : '';
                return `<option value="${option.value}"${isSelected}>${option.label}</option>`;
            }).join('');
            return `<label class="pt-tools-field${wide ? ' wide' : ''}"><span>${label}</span><select id="${id}">${items}</select></label>`;
        }

        function renderToolsCalculatorFields() {
            const host = document.getElementById('tools-calculator-fields');
            const submit = document.getElementById('tools-calculator-submit');
            if (!host || !submit) return;
            const marketPrice = toolsCalculatorMarketPrice();
            let fields = '';
            let buttonText = 'Calculate';

            if (activeToolsCalculator === 'position') {
                buttonText = 'Calculate position';
                fields = [
                    toolsCalculatorInput('tools-position-account', 'Account value ($)', { value: 10000, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-position-risk', 'Risk per trade (%)', { value: 1, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-position-entry', 'Entry price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-position-stop', 'Stop price ($)', { min: 0, step: '0.01' }),
                    toolsCalculatorSelect('tools-position-side', 'Position side', [
                        { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' },
                    ], 'LONG'),
                    toolsCalculatorInput('tools-position-max', 'Max exposure (%)', { value: 100, min: 0, step: '0.01' }),
                ].join('');
            } else if (activeToolsCalculator === 'move') {
                buttonText = 'Calculate expected move';
                fields = [
                    toolsCalculatorInput('tools-move-price', 'Underlying price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-move-iv', 'Implied volatility (%)', { value: 30, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-move-days', 'Days to expiry', { value: 30, min: 0, step: '1' }),
                    toolsCalculatorInput('tools-move-days-year', 'Days per year', { value: 365, min: 1, step: '1' }),
                ].join('');
            } else if (activeToolsCalculator === 'probability') {
                buttonText = 'Calculate probability';
                fields = [
                    toolsCalculatorInput('tools-probability-spot', 'Spot price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-probability-target', 'Target price ($)', { min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-iv', 'Implied volatility (%)', { value: 30, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-days', 'Days to target', { value: 30, min: 0, step: '1' }),
                    toolsCalculatorInput('tools-probability-rate', 'Risk-free rate (%)', { value: 4.5, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-dividend', 'Dividend yield (%)', { value: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-days-year', 'Days per year', { value: 365, min: 1, step: '1' }),
                ].join('');
            } else if (activeToolsCalculator === 'growth') {
                const isDca = toolsGrowthMode === 'dca';
                buttonText = isDca ? 'Project DCA plan' : 'Project compound growth';
                const rateLabel = isDca ? 'Annual return (%)' : 'Annual rate (%)';
                const frequencyLabel = isDca ? 'Contributions per year' : 'Compounds per year';
                fields = [
                    toolsCalculatorSelect('tools-growth-mode', 'Projection type', [
                        { value: 'compound', label: 'Compound growth' },
                        { value: 'dca', label: 'DCA projection' },
                    ], toolsGrowthMode),
                    toolsCalculatorInput('tools-growth-initial', 'Initial investment ($)', { value: 1000, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-contribution', 'Periodic contribution ($)', { value: 100, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-rate', rateLabel, { value: 8, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-years', 'Years', { value: 10, min: 0, step: '0.5' }),
                    toolsCalculatorInput('tools-growth-frequency', frequencyLabel, { value: 12, min: 1, step: '1' }),
                    toolsCalculatorSelect('tools-growth-timing', 'Contribution timing', [
                        { value: 'end', label: 'End of each period' },
                        { value: 'begin', label: 'Beginning of each period' },
                    ], 'end'),
                ].join('');
                window.setTimeout(() => {
                    const mode = document.getElementById('tools-growth-mode');
                    if (mode) mode.addEventListener('change', event => setGrowthCalculatorMode(event.target.value), { once: true });
                }, 0);
            } else if (activeToolsCalculator === 'fair') {
                buttonText = 'Calculate fair value';
                fields = [
                    toolsCalculatorInput('tools-fair-fcf', 'Free cash flow / share ($)', { value: 5, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-growth', 'Growth rate (%)', { value: 6, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-discount', 'Discount rate (%)', { value: 10, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-terminal', 'Terminal growth (%)', { value: 2.5, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-years', 'Projection years', { value: 5, min: 1, step: '1' }),
                    toolsCalculatorInput('tools-fair-price', 'Current price ($, optional)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Optional' }),
                    toolsCalculatorInput('tools-fair-safety', 'Margin of safety (%)', { value: 20, min: 0, step: '0.01' }),
                ].join('');
            }

            host.innerHTML = fields;
            submit.textContent = buttonText;
        }

        function selectToolsCalculator(calculator, source) {
            if (!['position', 'move', 'probability', 'growth', 'fair'].includes(calculator)) return;
            activeToolsCalculator = calculator;
            toolsCalculatorRequestVersion += 1;
            if (toolsCalculatorAbortController && !toolsCalculatorAbortController.signal.aborted) {
                toolsCalculatorAbortController.abort();
            }
            toolsCalculatorAbortController = null;
            document.querySelectorAll('.pt-tools-tab').forEach(tab => {
                const active = tab.dataset.calculator === calculator;
                tab.classList.toggle('is-active', active);
                tab.setAttribute('aria-selected', String(active));
            });
            if (source) source.focus({ preventScroll: true });
            hideToolsCalculatorResult();
            renderToolsCalculatorFields();
        }

        function setGrowthCalculatorMode(mode) {
            toolsGrowthMode = mode === 'dca' ? 'dca' : 'compound';
            hideToolsCalculatorResult();
            renderToolsCalculatorFields();
        }

        function toolsCalculatorNumber(id, label, options = {}) {
            const input = document.getElementById(id);
            const raw = input ? input.value.trim() : '';
            if (!raw && options.optional) return undefined;
            if (!raw) throw new Error(`${label} is required.`);
            const value = Number(raw);
            if (!Number.isFinite(value)) throw new Error(`${label} must be a valid number.`);
            if (options.integer && !Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
            return value;
        }

        function toolsCalculatorPayload() {
            if (activeToolsCalculator === 'position') {
                return {
                    endpoint: '/api/tools/position-size',
                    payload: {
                        account_value: toolsCalculatorNumber('tools-position-account', 'Account value'),
                        risk_percent: toolsCalculatorNumber('tools-position-risk', 'Risk per trade'),
                        entry_price: toolsCalculatorNumber('tools-position-entry', 'Entry price'),
                        stop_price: toolsCalculatorNumber('tools-position-stop', 'Stop price'),
                        side: document.getElementById('tools-position-side').value,
                        max_position_percent: toolsCalculatorNumber('tools-position-max', 'Maximum exposure'),
                    },
                };
            }
            if (activeToolsCalculator === 'move') {
                return {
                    endpoint: '/api/tools/expected-move',
                    payload: {
                        price: toolsCalculatorNumber('tools-move-price', 'Underlying price'),
                        implied_volatility_percent: toolsCalculatorNumber('tools-move-iv', 'Implied volatility'),
                        days: toolsCalculatorNumber('tools-move-days', 'Days to expiry'),
                        days_per_year: toolsCalculatorNumber('tools-move-days-year', 'Days per year'),
                    },
                };
            }
            if (activeToolsCalculator === 'probability') {
                return {
                    endpoint: '/api/tools/probability',
                    payload: {
                        spot_price: toolsCalculatorNumber('tools-probability-spot', 'Spot price'),
                        target_price: toolsCalculatorNumber('tools-probability-target', 'Target price'),
                        implied_volatility_percent: toolsCalculatorNumber('tools-probability-iv', 'Implied volatility'),
                        days: toolsCalculatorNumber('tools-probability-days', 'Days to target'),
                        risk_free_rate_percent: toolsCalculatorNumber('tools-probability-rate', 'Risk-free rate'),
                        dividend_yield_percent: toolsCalculatorNumber('tools-probability-dividend', 'Dividend yield'),
                        days_per_year: toolsCalculatorNumber('tools-probability-days-year', 'Days per year'),
                    },
                };
            }
            if (activeToolsCalculator === 'growth') {
                const mode = document.getElementById('tools-growth-mode').value === 'dca' ? 'dca' : 'compound';
                const initial = toolsCalculatorNumber('tools-growth-initial', 'Initial investment');
                const contribution = toolsCalculatorNumber('tools-growth-contribution', 'Periodic contribution');
                const rate = toolsCalculatorNumber('tools-growth-rate', 'Annual rate');
                const years = toolsCalculatorNumber('tools-growth-years', 'Years');
                const frequency = toolsCalculatorNumber('tools-growth-frequency', 'Compounds per year', { integer: true });
                const timing = document.getElementById('tools-growth-timing').value;
                return mode === 'dca'
                    ? {
                        endpoint: '/api/tools/dca',
                        payload: {
                            initial_investment: initial,
                            periodic_contribution: contribution,
                            annual_return_percent: rate,
                            years,
                            contributions_per_year: frequency,
                            contribution_timing: timing,
                        },
                    }
                    : {
                        endpoint: '/api/tools/compound',
                        payload: {
                            initial_investment: initial,
                            annual_rate_percent: rate,
                            years,
                            periodic_contribution: contribution,
                            compounds_per_year: frequency,
                            contribution_timing: timing,
                        },
                    };
            }

            const currentPrice = toolsCalculatorNumber('tools-fair-price', 'Current price', { optional: true });
            const payload = {
                free_cash_flow_per_share: toolsCalculatorNumber('tools-fair-fcf', 'Free cash flow per share'),
                growth_rate_percent: toolsCalculatorNumber('tools-fair-growth', 'Growth rate'),
                discount_rate_percent: toolsCalculatorNumber('tools-fair-discount', 'Discount rate'),
                terminal_growth_rate_percent: toolsCalculatorNumber('tools-fair-terminal', 'Terminal growth'),
                projection_years: toolsCalculatorNumber('tools-fair-years', 'Projection years', { integer: true }),
                margin_of_safety_percent: toolsCalculatorNumber('tools-fair-safety', 'Margin of safety'),
            };
            if (currentPrice !== undefined) payload.current_price = currentPrice;
            return { endpoint: '/api/tools/fair-value', payload };
        }

        function toolsCalculatorDisplayNumber(value, digits = 2) {
            const number = Number(value);
            return Number.isFinite(number) ? number.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: digits,
            }) : '—';
        }

        function toolsCalculatorDisplayMoney(value) {
            const number = Number(value);
            return Number.isFinite(number) ? `$${number.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}` : '—';
        }

        function toolsCalculatorDisplayPercent(value, signed = false) {
            const number = Number(value);
            if (!Number.isFinite(number)) return '—';
            return `${signed && number >= 0 ? '+' : ''}${toolsCalculatorDisplayNumber(number, 2)}%`;
        }

        function hideToolsCalculatorResult() {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = true;
            host.classList.remove('is-error');
            host.replaceChildren();
        }

        function showToolsCalculatorMessage(title, message, isError = false) {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = false;
            host.classList.toggle('is-error', isError);
            host.replaceChildren();
            const heading = document.createElement('p');
            heading.className = isError ? 'pt-tools-result-error' : 'pt-tools-result-title';
            heading.textContent = title;
            const copy = document.createElement('p');
            copy.className = isError ? 'pt-tools-result-error' : 'pt-tools-result-summary';
            copy.textContent = message;
            host.append(heading, copy);
        }

        function showToolsCalculatorResult(title, summary, metrics, note = '') {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = false;
            host.classList.remove('is-error');
            host.replaceChildren();

            const heading = document.createElement('p');
            heading.className = 'pt-tools-result-title';
            heading.textContent = title;
            const copy = document.createElement('p');
            copy.className = 'pt-tools-result-summary';
            copy.textContent = summary;
            const grid = document.createElement('div');
            grid.className = 'pt-tools-result-grid';
            metrics.forEach(metric => {
                const card = document.createElement('div');
                card.className = `pt-tools-result-metric${metric.tone ? ` ${metric.tone}` : ''}`;
                const label = document.createElement('span');
                label.textContent = metric.label;
                const value = document.createElement('strong');
                value.textContent = metric.value;
                card.append(label, value);
                grid.appendChild(card);
            });
            host.append(heading, copy, grid);
            if (note) {
                const noteEl = document.createElement('p');
                noteEl.className = 'pt-tools-result-summary';
                noteEl.textContent = note;
                host.appendChild(noteEl);
            }
        }

        function toolsCalculatorErrorMessage(data, fallback) {
            if (!data) return fallback;
            if (typeof data.detail === 'string') return data.detail;
            if (typeof data.message === 'string') return data.message;
            if (Array.isArray(data.detail)) {
                const details = data.detail.map(item => item && (item.msg || item.message)).filter(Boolean);
                if (details.length) return details.join(' ');
            }
            return fallback;
        }

        function renderToolsCalculatorResponse(data, calculator) {
            if (calculator === 'position') {
                const capped = Boolean(data.is_capped_by_max_position);
                showToolsCalculatorResult(
                    'Position sizing result',
                    capped ? 'The risk-based quantity was capped by your maximum exposure setting.' : 'Quantity is sized from the stop-loss risk budget you supplied.',
                    [
                        { label: 'Recommended units', value: toolsCalculatorDisplayNumber(data.recommended_quantity, 0) },
                        { label: 'Position value', value: toolsCalculatorDisplayMoney(data.position_value) },
                        { label: 'Max loss at stop', value: toolsCalculatorDisplayMoney(data.max_loss_at_stop), tone: 'negative' },
                        { label: 'Risk budget used', value: toolsCalculatorDisplayPercent(data.risk_budget_used_percent) },
                    ],
                    `Risk per unit: ${toolsCalculatorDisplayMoney(data.risk_per_unit)} · Exposure cap: ${toolsCalculatorDisplayMoney(data.maximum_position_value)}`
                );
                return;
            }
            if (calculator === 'move') {
                showToolsCalculatorResult(
                    'One-standard-deviation expected move',
                    'Range is derived from the IV and time horizon supplied; it is not a prediction of direction.',
                    [
                        { label: 'Expected move', value: toolsCalculatorDisplayMoney(data.expected_move) },
                        { label: 'Expected move', value: toolsCalculatorDisplayPercent(data.expected_move_percent) },
                        { label: 'Lower bound', value: toolsCalculatorDisplayMoney(data.lower_bound), tone: 'negative' },
                        { label: 'Upper bound', value: toolsCalculatorDisplayMoney(data.upper_bound), tone: 'positive' },
                    ]
                );
                return;
            }
            if (calculator === 'probability') {
                showToolsCalculatorResult(
                    'Risk-neutral probability',
                    'This is a lognormal model assumption, not a directional price forecast.',
                    [
                        { label: 'Above target', value: toolsCalculatorDisplayPercent(data.probability_above_percent), tone: 'positive' },
                        { label: 'Below / at target', value: toolsCalculatorDisplayPercent(data.probability_below_or_equal_percent), tone: 'negative' },
                        { label: 'Forward price', value: toolsCalculatorDisplayMoney(data.forward_price) },
                        { label: 'Model', value: String(data.model || '—').replace(/_/g, ' ') },
                    ],
                    data.assumption || ''
                );
                return;
            }
            if (calculator === 'growth') {
                const isDca = toolsGrowthMode === 'dca';
                const schedule = Array.isArray(data.schedule) && data.schedule.length ? data.schedule[data.schedule.length - 1] : null;
                showToolsCalculatorResult(
                    isDca ? 'DCA projection' : 'Compound growth projection',
                    'Projection uses the return, contribution cadence, and timing you supplied.',
                    [
                        { label: 'Future value', value: toolsCalculatorDisplayMoney(data.future_value), tone: 'positive' },
                        { label: 'Total invested', value: toolsCalculatorDisplayMoney(data.total_invested) },
                        { label: 'Investment gain', value: toolsCalculatorDisplayMoney(data.investment_gain), tone: Number(data.investment_gain) >= 0 ? 'positive' : 'negative' },
                        { label: isDca ? 'Periods' : 'Effective annual rate', value: isDca ? toolsCalculatorDisplayNumber(data.periods, 0) : toolsCalculatorDisplayPercent(data.effective_annual_rate_percent) },
                    ],
                    schedule ? `Latest schedule point: year ${toolsCalculatorDisplayNumber(schedule.year, 2)} · ${toolsCalculatorDisplayMoney(schedule.portfolio_value)}` : ''
                );
                return;
            }

            const upside = Number(data.upside_downside_percent);
            showToolsCalculatorResult(
                'DCF fair value',
                'Two-stage DCF based only on the cash-flow and rate assumptions you supplied.',
                [
                    { label: 'Fair value / share', value: toolsCalculatorDisplayMoney(data.fair_value_per_share), tone: 'positive' },
                    { label: 'After safety margin', value: toolsCalculatorDisplayMoney(data.value_after_margin_of_safety) },
                    { label: 'Current price', value: toolsCalculatorDisplayMoney(data.current_price) },
                    { label: 'Upside / downside', value: toolsCalculatorDisplayPercent(data.upside_downside_percent, true), tone: Number.isFinite(upside) ? (upside >= 0 ? 'positive' : 'negative') : '' },
                ],
                `Terminal present value: ${toolsCalculatorDisplayMoney(data.terminal_present_value)}`
            );
        }

        async function runToolsCalculator(event) {
            event.preventDefault();
            const requestVersion = ++toolsCalculatorRequestVersion;
            const calculator = activeToolsCalculator;
            let request;
            try {
                request = toolsCalculatorPayload();
            } catch (error) {
                showToolsCalculatorMessage('Check calculator inputs', error.message || 'Enter valid values and try again.', true);
                return;
            }

            if (toolsCalculatorAbortController && !toolsCalculatorAbortController.signal.aborted) {
                toolsCalculatorAbortController.abort();
            }
            const controller = new AbortController();
            toolsCalculatorAbortController = controller;
            const submit = document.getElementById('tools-calculator-submit');
            if (submit) submit.disabled = true;
            showToolsCalculatorMessage('Calculating', 'Validating assumptions with the calculator service…');

            try {
                const response = await fetch(request.endpoint, {
                    method: 'POST',
                    headers: authHeaders(true),
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                    body: JSON.stringify(request.payload),
                });
                const data = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(toolsCalculatorErrorMessage(data, `Calculator request failed (${response.status}).`));
                }
                if (requestVersion !== toolsCalculatorRequestVersion || calculator !== activeToolsCalculator) return;
                renderToolsCalculatorResponse(data || {}, calculator);
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                if (requestVersion !== toolsCalculatorRequestVersion || calculator !== activeToolsCalculator) return;
                showToolsCalculatorMessage('Calculator unavailable', error.message || 'Unable to calculate right now. Please try again.', true);
            } finally {
                if (toolsCalculatorAbortController === controller) toolsCalculatorAbortController = null;
                if (requestVersion === toolsCalculatorRequestVersion && submit) submit.disabled = false;
            }
        }

        async function runSimulator() {
            const payload = {
                strike_price: parseFloat(document.getElementById('sim-strike').value),
                option_type: document.getElementById('sim-type').value,
                expiration: document.getElementById('sim-exp').value,
                premium_paid: parseFloat(document.getElementById('sim-premium').value),
                current_iv: parseFloat(document.getElementById('sim-iv').value),
                target_price: parseFloat(document.getElementById('sim-target-price').value),
                target_date: document.getElementById('sim-target-date').value
            };

            if (Object.values(payload).some(val => val === "" || isNaN(val) && typeof val !== 'string')) {
                alert("กรุณากรอกข้อมูลจำลองให้ครบทุกช่องครับ");
                return;
            }

            try {
                const res = await fetch('/api/simulate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                const resDiv = document.getElementById('sim-result');
                resDiv.style.display = 'block';

                if (data.error) {
                    resDiv.innerHTML = `<span style="color:var(--red); font-weight:bold;">⚠️ เกิดข้อผิดพลาด: ${data.error}</span>`;
                    return;
                }
                if (data.detail) {
                    resDiv.innerHTML = `<span style="color:var(--red); font-weight:bold;">⚠️ ข้อมูลที่ส่งไปไม่ถูกต้อง (API Error): ${JSON.stringify(data.detail)}</span>`;
                    return;
                }
                if (data.simulated_premium === undefined) {
                    resDiv.innerHTML = `<span style="color:var(--red); font-weight:bold;">⚠️ เชื่อมต่อ API ล้มเหลว กรุณาตรวจสอบการตั้งค่าเซิร์ฟเวอร์</span>`;
                    return;
                }

                const color = data.pnl_total >= 0 ? 'var(--green)' : 'var(--red)';
                const sign = data.pnl_total >= 0 ? '+' : '';

                resDiv.innerHTML = `
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
<div>
<span style="color:var(--text-muted); font-size:12px;">จุดคุ้มทุน (Break-Even)</span><br>
<strong style="font-size:16px;">$${data.break_even}</strong>
</div>
<div>
<span style="color:var(--text-muted); font-size:12px;">พรีเมียมคาดการณ์ ณ วันเป้าหมาย</span><br>
<strong style="font-size:16px; color:var(--gold);">$${data.simulated_premium}</strong>
</div>
<div>
<span style="color:var(--text-muted); font-size:12px;">กำไร/ขาดทุนโดยประมาณ (ต่อสัญญา)</span><br>
<strong style="font-size:16px; color:${color};">${sign}$${data.pnl_total} (${sign}${data.pnl_percent}%)</strong>
</div>
</div>
<div style="margin-top:10px; font-size:12px; color:var(--text-muted); border-top: 1px dashed var(--panel-border); padding-top: 10px;">
*เหลือเวลาจนถึงวันหมดอายุ <strong>${data.days_remaining} วัน</strong> (ผลลัพธ์นี้คำนวณหัก Time Decay จากค่า IV ที่ให้มาเรียบร้อยแล้ว)
</div>
`;
            } catch (err) {
                console.error(err);
                alert("ไม่สามารถติดต่อเซิร์ฟเวอร์ได้");
            }
        }

        // --- 🏛️ Phase 5: Full Gauge Suite ---------------------------------
        const GAUGE_LABELS = {
            bullish_score: "Bullish", bearish_score: "Bearish", momentum_score: "Momentum",
            trend_score: "Trend", iv_score: "IV Score", iv_rank: "IV Rank", iv_percentile: "IV %ile",
            gamma_risk: "Gamma Risk", theta_risk: "Theta Risk", vega_risk: "Vega Risk",
            dealer_gamma: "Dealer Gamma", dealer_position: "Dealer Pos.", flow_strength: "Flow Strength",
            institutional_activity: "Institutional", dark_pool_activity: "Dark Pool",
            smart_money_score: "Smart Money", market_fear_index: "Fear Index", sentiment_score: "Sentiment",
        };

        function gaugeColor(score) {
            if (score === null || score === undefined) return "#3a3f4d";
            if (score >= 70) return "var(--green)";
            if (score >= 55) return "#7ed957";
            if (score >= 45) return "var(--gold)";
            if (score >= 30) return "#ff8a3d";
            return "var(--red)";
        }

        async function loadFullGaugesLegacy(ticker) {
            const grid = document.getElementById('full-gauges-grid');
            try {
                const res = await fetch(`/api/gauges?ticker=${ticker}`);
                const data = await res.json();
                const gauges = data.gauges || {};

                const conf = gauges.confidence_score;
                document.getElementById('gauges-confidence-badge').innerText =
                    conf && conf.score !== null ? `${conf.score}% data-backed` : '-';

                grid.innerHTML = Object.entries(GAUGE_LABELS).map(([key, label]) => {
                    const g = gauges[key];
                    if (!g) return '';
                    const score = g.score;
                    // ⛔ ไม่มีข้อมูล (N/A) -> ไม่ต้องแสดงการ์ดนี้ ตัดออกไปเลยกันรก
                    if (score === null || score === undefined) return '';
                    const display = Number.isInteger(score) ? score : score.toFixed(1);
                    const reasons = (g.reasons || []).join(' | ').replace(/"/g, '&quot;');
                    return `<div class="mini-gauge" title="${reasons}">
                        <div class="mg-label">${label}</div>
                        <div class="mg-score" style="color:${gaugeColor(score)};">${display}</div>
                        <div class="mg-tag" style="background:${gaugeColor(score)}22; color:${gaugeColor(score)};">${g.label || ''}</div>
                    </div>`;
                }).join('');

                if (!grid.innerHTML.trim()) {
                    grid.innerHTML = `<div style="grid-column: 1 / -1; font-size:12px; color:var(--text-muted);">ยังไม่มีข้อมูลเกจสำหรับหุ้นตัวนี้</div>`;
                }
            } catch (err) {
                console.error("Gauges fetch error:", err);
                grid.innerHTML = `<div style="font-size:12px; color:var(--red);">โหลดเกจไม่สำเร็จ</div>`;
            }
        }

        async function loadFullGauges(context) {
            if (!isCurrentView(context)) return;
            if (gaugesAbortController && !gaugesAbortController.signal.aborted) {
                gaugesAbortController.abort();
            }
            const controller = new AbortController();
            gaugesAbortController = controller;
            const gaugeContext = { ...context, signal: controller.signal };
            const grid = document.getElementById('full-gauges-grid');
            const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));

            try {
                const res = await authFetch(`/api/gauges?ticker=${encodeURIComponent(gaugeContext.ticker)}`, {
                    signal: gaugeContext.signal,
                    cache: 'no-store',
                });
                if (!isCurrentView(gaugeContext)) return;
                if (!res.ok) throw new Error(`Gauges request failed: ${res.status}`);
                const data = await res.json();
                if (!isCurrentView(gaugeContext)) return;
                const gauges = data.gauges || {};
                const conf = gauges.confidence_score;
                document.getElementById('gauges-confidence-badge').innerText =
                    conf && conf.score !== null ? `${conf.score}% data-backed` : '-';

                grid.innerHTML = Object.entries(GAUGE_LABELS).map(([key, label]) => {
                    const gauge = gauges[key];
                    if (!gauge || gauge.score === null || gauge.score === undefined) return '';
                    const score = Number(gauge.score);
                    if (!Number.isFinite(score)) return '';
                    const display = Number.isInteger(score) ? score : score.toFixed(1);
                    const color = gaugeColor(score);
                    const reasons = escapeHtml((gauge.reasons || []).join(' | '));
                    return `<div class="mini-gauge" title="${reasons}">
                        <div class="mg-label">${escapeHtml(label)}</div>
                        <div class="mg-score" style="color:${color};">${display}</div>
                        <div class="mg-tag" style="background:${color}22; color:${color};">${escapeHtml(gauge.label)}</div>
                    </div>`;
                }).join('');

                if (!grid.innerHTML.trim()) {
                    grid.innerHTML = '<div style="grid-column: 1 / -1; font-size:12px; color:var(--text-muted);">No gauge data is available for this symbol.</div>';
                }
            } catch (err) {
                if (!isAbortError(err) && isCurrentView(gaugeContext)) {
                    console.error('Gauges fetch error:', err);
                    grid.innerHTML = '<div style="font-size:12px; color:var(--red);">Unable to load gauges.</div>';
                }
            } finally {
                if (gaugesAbortController === controller) gaugesAbortController = null;
            }
        }

        let expectedMoveDashboardVisible = false;

        function toggleExpectedMoveDashboard() {
            expectedMoveDashboardVisible = !expectedMoveDashboardVisible;
            const el = document.getElementById('dashboard-overlay');
            const btn = document.getElementById('toggle-dashboard');
            if (expectedMoveDashboardVisible) {
                el.style.display = 'block';
                btn.innerText = '📈 Dashboard ▾';
            } else {
                el.style.display = 'none';
                btn.innerText = '📈 Dashboard ▸';
            }
        }

        function getTimeframeSeconds(timeframe) {
            const mapping = {
                '1m': 60, '5m': 300, '10m': 600, '15m': 900,
                '1h': 3600, '4h': 14400, '1d': 86400, 'week': 604800,
            };
            return mapping[timeframe] || 86400;
        }

        function calculateExpectedMoves(data, price, lookback) {
            if (!Array.isArray(data) || data.length < 3 || !price || lookback < 3) {
                return null;
            }
            const bars = data.slice(-lookback);
            const returns = [];
            for (let i = 1; i < bars.length; i++) {
                const prev = Number(bars[i - 1].close);
                const curr = Number(bars[i].close);
                if (prev > 0 && curr > 0) {
                    returns.push(Math.log(curr / prev));
                }
            }
            if (!returns.length) return null;
            const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
            const variance = returns.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / returns.length;
            const sigma = Math.sqrt(variance);
            const secondsPerBar = getTimeframeSeconds(currentTimeframe);
            const dailyFactor = 86400 / secondsPerBar;
            const dailyVol = sigma * Math.sqrt(Math.max(dailyFactor, 1));
            const weeklyVol = sigma * Math.sqrt(Math.max(dailyFactor * 5, 5));
            return {
                dailyMovePct: dailyVol * 100,
                weeklyMovePct: weeklyVol * 100,
            };
        }

        function calculateVolumeFlow(data, lookback) {
            const bars = Array.isArray(data) ? data.slice(-lookback) : [];
            let upVol = 0;
            let downVol = 0;
            let neutralVol = 0;
            for (const bar of bars) {
                const vol = Number(bar.volume) || 0;
                if (bar.close > bar.open) upVol += vol;
                else if (bar.close < bar.open) downVol += vol;
                else neutralVol += vol;
            }
            const total = upVol + downVol;
            const bullish = total ? (upVol / total) * 100 : 50;
            const bearish = total ? (downVol / total) * 100 : 50;
            return { upVol, downVol, neutralVol, bullish, bearish, total };
        }

        function renderDashboardOverlay() {
            const lookbackInput = document.getElementById('dashboard-lookback');
            const lookback = Math.min(Math.max(Number(lookbackInput.value) || 10, 3), 50);
            lookbackInput.value = lookback;
            const dailyEl = document.getElementById('daily-move-range');
            const weeklyEl = document.getElementById('weekly-move-range');
            const flowEl = document.getElementById('volume-flow-text');
            const noteEl = document.getElementById('dashboard-note');
            const sourcePrice = currentLivePrice || (globalChartData.length ? globalChartData[globalChartData.length - 1].close : null);
            if (!globalChartData.length || !sourcePrice) {
                dailyEl.innerText = '-';
                weeklyEl.innerText = '-';
                flowEl.innerText = '-';
                noteEl.innerText = 'รอข้อมูลกราฟหรือราคาปัจจุบัน...';
                return;
            }
            const moves = calculateExpectedMoves(globalChartData, sourcePrice, lookback);
            const flow = calculateVolumeFlow(globalChartData, lookback);
            if (moves) {
                const dailyLower = sourcePrice * (1 - moves.dailyMovePct / 100);
                const dailyUpper = sourcePrice * (1 + moves.dailyMovePct / 100);
                const weeklyLower = sourcePrice * (1 - moves.weeklyMovePct / 100);
                const weeklyUpper = sourcePrice * (1 + moves.weeklyMovePct / 100);
                dailyEl.innerHTML = `<span style="display:block; font-size:11px; color:var(--text-muted);">±${moves.dailyMovePct.toFixed(1)}%</span><strong>$${dailyLower.toFixed(2)} — $${dailyUpper.toFixed(2)}</strong>`;
                weeklyEl.innerHTML = `<span style="display:block; font-size:11px; color:var(--text-muted);">±${moves.weeklyMovePct.toFixed(1)}%</span><strong>$${weeklyLower.toFixed(2)} — $${weeklyUpper.toFixed(2)}</strong>`;
            } else {
                dailyEl.innerText = 'ข้อมูลไม่พอ';
                weeklyEl.innerText = 'ข้อมูลไม่พอ';
            }
            const bullishColor = flow.bullish >= flow.bearish ? 'var(--green)' : 'var(--red)';
            flowEl.innerHTML = `<span style="display:block; font-size:11px; color:var(--text-muted);">Up ${flow.upVol.toLocaleString()} / Down ${flow.downVol.toLocaleString()}</span><strong style="color:${bullishColor};">Bullish ${flow.bullish.toFixed(0)}% / Bearish ${flow.bearish.toFixed(0)}%</strong>`;
            noteEl.innerText = `Lookback ${lookback} bars · Volume imbalance over the latest ${lookback} bars.`;
        }

        document.getElementById('dashboard-lookback').addEventListener('change', renderDashboardOverlay);

        // --- 🚀 Phase 5: Advanced Multi-Scenario Monte Carlo Simulator -----
        let scenarioCount = 0;
        function addScenarioCard() {
            scenarioCount++;
            const id = scenarioCount;
            const container = document.getElementById('scenario-cards');
            const card = document.createElement('div');
            card.className = 'scenario-card';
            card.id = `scenario-${id}`;
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <input type="text" class="sc-label" value="Scenario ${id}" style="background:transparent; border:none; color:var(--gold); font-weight:bold; font-size:14px; width:150px;">
                    <button onclick="document.getElementById('scenario-${id}').remove()" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:16px;">✕</button>
                </div>
                <div class="form-grid">
                    <div class="field-wrap">
                        <input type="number" class="sc-strike" placeholder="Strike ($)" step="0.01">
                        <small class="field-hint">ราคาใช้สิทธิของสัญญาออปชัน (Strike)</small>
                    </div>
                    <div class="field-wrap">
                        <select class="sc-type"><option value="CALL">CALL</option><option value="PUT">PUT</option></select>
                        <small class="field-hint">CALL = คาดว่าราคาขึ้น, PUT = คาดว่าราคาลง</small>
                    </div>
                    <div class="field-wrap">
                        <input type="date" class="sc-exp" title="วันหมดอายุ">
                        <small class="field-hint">วันที่สัญญาออปชันนี้หมดอายุ</small>
                    </div>
                    <div class="field-wrap">
                        <input type="date" class="sc-target-date" title="วันที่เป้าหมาย (Target date)">
                        <small class="field-hint">วันที่อยากดูผลลัพธ์ล่วงหน้า (ต้องไม่เกินวันหมดอายุ)</small>
                    </div>
                    <div class="field-wrap">
                        <input type="number" class="sc-premium" placeholder="ราคาที่ซื้อมา ($)" step="0.01">
                        <small class="field-hint">ราคาต่อหุ้นที่คุณจ่ายตอนซื้อสัญญา (พรีเมียม)</small>
                    </div>
                    <div class="field-wrap">
                        <input type="number" class="sc-iv" placeholder="Current IV (%)" step="0.1">
                        <small class="field-hint">ค่าความผันผวนปัจจุบันของสัญญา (ดูได้จากหน้าสัญญา)</small>
                    </div>
                    <div class="field-wrap">
                        <input type="number" class="sc-qty" placeholder="Quantity (สัญญา)" value="1">
                        <small class="field-hint">จำนวนสัญญาที่ถือ (เช่น 1, 2, 3...)</small>
                    </div>
                    <div class="field-wrap">
                        <input type="number" class="sc-iv-shock" placeholder="IV Shock (pts, e.g. -10)" step="0.5" value="0">
                        <small class="field-hint">จำลองการเปลี่ยน IV เช่น -10 = IV ลดลง 10 จุด</small>
                    </div>
                    <div class="field-wrap">
                        <input type="number" class="sc-rate-shock" placeholder="Rate Shock (%, e.g. 0.5)" step="0.1" value="0">
                        <small class="field-hint">จำลองการเปลี่ยนดอกเบี้ย เช่น 0.5 = เพิ่มขึ้น 0.5%</small>
                    </div>
                    <div class="field-wrap">
                        <select class="sc-nsims">
                            <option value="1000">1,000 paths</option>
                            <option value="5000">5,000 paths</option>
                            <option value="10000" selected>10,000 paths</option>
                            <option value="50000">50,000 paths</option>
                        </select>
                        <small class="field-hint">จำนวนรอบจำลอง ยิ่งมากยิ่งแม่นยำแต่ใช้เวลานานขึ้น</small>
                    </div>
                </div>`;
            container.appendChild(card);
        }

        async function runAdvancedSimulator() {
            const cards = document.querySelectorAll('.scenario-card');
            if (cards.length === 0) { alert("กรุณาเพิ่มอย่างน้อย 1 Scenario"); return; }

            const scenarios = Array.from(cards).map(card => ({
                label: card.querySelector('.sc-label').value || "Scenario",
                strike_price: parseFloat(card.querySelector('.sc-strike').value) || 0,
                option_type: card.querySelector('.sc-type').value,
                expiration: card.querySelector('.sc-exp').value,
                target_date: card.querySelector('.sc-target-date').value,
                premium_paid: parseFloat(card.querySelector('.sc-premium').value) || 0,
                current_iv: parseFloat(card.querySelector('.sc-iv').value) || 30,
                quantity: parseInt(card.querySelector('.sc-qty').value) || 1,
                iv_shock_pts: parseFloat(card.querySelector('.sc-iv-shock').value) || 0,
                rate_shock_pts: parseFloat(card.querySelector('.sc-rate-shock').value) || 0,
                n_sims: parseInt(card.querySelector('.sc-nsims').value) || 10000,
            }));

            const resDiv = document.getElementById('advanced-sim-result');
            resDiv.innerHTML = `<span style="color:var(--text-muted);">⏳ กำลังรัน Monte Carlo...</span>`;

            try {
                const res = await fetch('/api/simulate-advanced', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: currentTicker, scenarios })
                });
                const data = await res.json();
                if (data.error) {
                    resDiv.innerHTML = `<span style="color:var(--red);">⚠️ ${data.error}</span>`;
                    return;
                }

                const rows = data.results.map(r => {
                    const color = r.expected_pl >= 0 ? 'var(--green)' : 'var(--red)';
                    return `<tr>
                        <td>${r.label}</td>
                        <td>${r.n_sims.toLocaleString()}</td>
                        <td>$${r.expected_underlying_price}</td>
                        <td>$${r.expected_option_price}</td>
                        <td style="color:${color}; font-weight:bold;">$${r.expected_pl} (${r.expected_return_pct}%)</td>
                        <td style="color:var(--green);">${r.probability_of_profit}%</td>
                        <td style="color:var(--red);">${r.worst_case_pl}</td>
                        <td style="color:var(--green);">${r.best_case_pl}</td>
                        <td>[${r.ci_95[0]}, ${r.ci_95[1]}]</td>
                        <td>${r.expected_delta}</td>
                        <td>${r.expected_theta_decay_per_day}</td>
                    </tr>`;
                }).join('');

                resDiv.innerHTML = `
                    <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Underlying (${data.ticker}): <strong style="color:white;">$${data.underlying_price}</strong></div>
                    <div class="table-responsive">
                    <table class="scenario-result-table">
                        <thead><tr>
                            <th>Scenario</th><th>Paths</th><th>Exp. S</th><th>Exp. Option</th><th>Exp. P&L</th>
                            <th>POP</th><th>Worst</th><th>Best</th><th>95% CI</th><th>Δ</th><th>Θ/day</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    </div>`;
            } catch (err) {
                console.error(err);
                resDiv.innerHTML = `<span style="color:var(--red);">⚠️ ไม่สามารถติดต่อเซิร์ฟเวอร์ได้</span>`;
            }
        }

        async function bootTerminal() {
            renderIndicatorsPanel();
            renderToolsCalculatorFields();
            void loadCategoryRail();
            addScenarioCard();
            await consumeAuthHash();
            await loadAuthSession();
            await fetchWatchlist();
            await fetchDashboardData();
            startChartAutoRefresh();
        }

        bootTerminal();
