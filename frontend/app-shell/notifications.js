// Quantora application-shell module: notifications
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

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
            alertCenterPollGeneration += 1;
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
            alertCenterPollGeneration += 1;
        }

        function startAlertCenterPolling() {
            stopAlertCenterPolling();
            if (!alertCenterEnabled() || !isPageVisible || !isNetworkOnline) return;
            const pollGeneration = alertCenterPollGeneration;
            const poll = () => {
                if (pollGeneration !== alertCenterPollGeneration || !alertCenterEnabled() || !isPageVisible || !isNetworkOnline) {
                    alertCenter.pollTimer = null;
                    return;
                }
                void refreshAlertCenter({ quiet: true }).finally(() => {
                    if (pollGeneration === alertCenterPollGeneration && alertCenterEnabled() && isPageVisible && isNetworkOnline) {
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
                        'span', '', `${ticker} ยท ${alertCenterTypeLabel(type)} ยท ${condition} ${target} ยท ${state} ยท ${alertCenterFormatCooldown(alert.cooldown_seconds)}`,
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
                    ].filter(Boolean).join(' ยท ');
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
                host.appendChild(alertCenterElement('p', 'pt-alert-status', 'Loading your alert rules and inboxโ€ฆ'));
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
            setAlertCenterStatus('Saving alert changeโ€ฆ');
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
                setAlertCenterStatus('Cooldown must be a whole number of seconds (0โ€“604800).', 'error');
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
