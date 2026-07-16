// Quantora application-shell module: terminal interaction layer.
// It reuses the current router and workspace globals; no market, portfolio,
// or API state is duplicated here.

        const TERMINAL_WORKSPACE_KEY = 'quantora.terminal-workspace.v1';
        const TERMINAL_COMMANDS_KEY = 'quantora.command-history.v1';
        const TERMINAL_COMMAND_FAVORITES_KEY = 'quantora.command-favorites.v1';
        const TERMINAL_OFFLINE_QUEUE_KEY = 'quantora.safe-offline-actions.v1';
        const TERMINAL_WORKSPACE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
        const TERMINAL_OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000;
        const TERMINAL_HISTORY_LIMIT = 12;
        let commandPalette = null;
        let commandPaletteOpen = false;
        let commandPaletteResults = [];
        let commandPaletteIndex = 0;
        let commandPaletteReturnFocus = null;
        let terminalChordTimer = null;
        let terminalPendingChord = '';
        let pendingWorkspaceRestore = null;
        let terminalWorkspaceBooted = false;
        let terminalWorkspaceSaveTimer = null;
        let terminalOfflineFlushPromise = null;

        function terminalSessionScope() {
            if (authState?.authenticated && authState?.user) return String(authState.user.id || authState.user.email || 'authenticated');
            return authState?.configured ? null : 'guest';
        }

        function terminalReadJson(key, fallback) {
            try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch (_) { return fallback; }
        }

        function terminalWriteJson(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* Optional interaction memory. */ }
        }

        function terminalValidRoute(route) {
            return ['home', 'watchlist', 'search', 'analysis', 'tools', 'portfolio/overview', 'portfolio/stocks', 'portfolio/options'].includes(route);
        }

        function terminalCurrentWorkspace() {
            const holdings = document.getElementById('stock-portfolio-rows');
            return {
                version: 1,
                savedAt: Date.now(),
                owner: terminalSessionScope(),
                route: (window.location.hash || '#/home').replace(/^#\/?/, '').toLowerCase(),
                ticker: /^[A-Z0-9.-]{1,12}$/.test(String(currentTicker || '')) ? currentTicker : 'NVDA',
                timeframe: ['1m', '5m', '10m', '15m', '1h', '4h', '1d', 'week'].includes(currentTimeframe) ? currentTimeframe : '1d',
                selectedWatchlistId: cloudWorkspaceId(cloudWorkspace?.selectedWatchlistId),
                selectedPortfolioId: cloudWorkspaceId(cloudWorkspace?.selectedPortfolioId),
                stockWorkspaceTab: stockWorkspaceTab || 'overview',
                sidebar: {
                    indicators: document.getElementById('indicators-panel')?.style.display !== 'none',
                    dashboard: Boolean(expectedMoveDashboardVisible),
                },
                scroll: { page: Math.max(0, Math.round(window.scrollY || 0)), holdings: Math.max(0, Math.round(holdings?.scrollTop || 0)) },
            };
        }

        function saveTerminalWorkspace() {
            const scope = terminalSessionScope();
            if (!scope) { localStorage.removeItem(TERMINAL_WORKSPACE_KEY); return; }
            const workspace = terminalCurrentWorkspace();
            workspace.owner = scope;
            if (!terminalValidRoute(workspace.route)) workspace.route = 'home';
            terminalWriteJson(TERMINAL_WORKSPACE_KEY, workspace);
        }

        function scheduleTerminalWorkspaceSave() {
            if (terminalWorkspaceSaveTimer) clearTimeout(terminalWorkspaceSaveTimer);
            terminalWorkspaceSaveTimer = window.setTimeout(() => {
                terminalWorkspaceSaveTimer = null;
                saveTerminalWorkspace();
            }, 180);
        }

        function readTerminalWorkspace() {
            const scope = terminalSessionScope();
            if (!scope) { localStorage.removeItem(TERMINAL_WORKSPACE_KEY); return null; }
            const workspace = terminalReadJson(TERMINAL_WORKSPACE_KEY, null);
            if (!workspace || workspace.version !== 1 || workspace.owner !== scope || !Number.isFinite(workspace.savedAt) || Date.now() - workspace.savedAt > TERMINAL_WORKSPACE_MAX_AGE) {
                localStorage.removeItem(TERMINAL_WORKSPACE_KEY);
                return null;
            }
            return workspace;
        }

        function prepareTerminalWorkspaceRestore() {
            const workspace = readTerminalWorkspace();
            pendingWorkspaceRestore = workspace;
            if (!workspace) return null;
            if (/^[A-Z0-9.-]{1,12}$/.test(String(workspace.ticker || ''))) currentTicker = workspace.ticker;
            if (['1m', '5m', '10m', '15m', '1h', '4h', '1d', 'week'].includes(workspace.timeframe)) currentTimeframe = workspace.timeframe;
            if (cloudWorkspaceEnabled()) {
                if (cloudWorkspace.watchlists.some(item => cloudWorkspaceId(item?.id) === cloudWorkspaceId(workspace.selectedWatchlistId))) cloudWorkspace.selectedWatchlistId = cloudWorkspaceId(workspace.selectedWatchlistId);
                if (cloudWorkspace.portfolios.some(item => cloudWorkspaceId(item?.id) === cloudWorkspaceId(workspace.selectedPortfolioId) && !item.archived_at)) cloudWorkspace.selectedPortfolioId = cloudWorkspaceId(workspace.selectedPortfolioId);
            }
            if (typeof workspace.stockWorkspaceTab === 'string') stockWorkspaceTab = workspace.stockWorkspaceTab;
            if (terminalValidRoute(workspace.route)) history.replaceState(null, document.title, `${location.pathname}${location.search}#/${workspace.route}`);
            return workspace;
        }

        async function finishTerminalWorkspaceRestore() {
            const workspace = pendingWorkspaceRestore;
            pendingWorkspaceRestore = null;
            if (!workspace) return;
            document.querySelectorAll('#timeframe-group button').forEach(button => button.classList.toggle('active', button.textContent.trim().toLowerCase() === String(currentTimeframe).toLowerCase()));
            if (workspace.sidebar?.indicators && document.getElementById('indicators-panel')?.style.display === 'none') toggleIndicatorsPanel?.();
            if (workspace.sidebar?.dashboard && !expectedMoveDashboardVisible) toggleExpectedMoveDashboard?.();
            if (['company', 'financial', 'news', 'forecast'].includes(stockWorkspaceTab)) await openStockWorkspaceTab(stockWorkspaceTab);
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                const holdings = document.getElementById('stock-portfolio-rows');
                if (holdings && Number.isFinite(workspace.scroll?.holdings)) holdings.scrollTop = Math.max(0, workspace.scroll.holdings);
                if (Number.isFinite(workspace.scroll?.page)) window.scrollTo({ top: Math.max(0, workspace.scroll.page), behavior: 'auto' });
            }));
        }

        async function restoreTerminalWorkspaceAfterLogin() {
            if (!terminalWorkspaceBooted || !authState.authenticated) return;
            const workspace = prepareTerminalWorkspaceRestore();
            if (!workspace) return;
            applyRouteFromLocation();
            await loadRouteModule(currentTerminalRoute());
            if (['home', 'analysis'].includes(currentTerminalRoute())) await fetchDashboardData();
            await finishTerminalWorkspaceRestore();
        }

        function setTerminalWorkspaceBooted() { terminalWorkspaceBooted = true; }

        function terminalCommandHistory() {
            return terminalReadJson(TERMINAL_COMMANDS_KEY, []).filter(item => item && typeof item.id === 'string').slice(0, TERMINAL_HISTORY_LIMIT);
        }

        function terminalCommandFavorites() {
            return new Set(terminalReadJson(TERMINAL_COMMAND_FAVORITES_KEY, []).filter(item => typeof item === 'string'));
        }

        function recordTerminalCommand(command) {
            const previous = terminalCommandHistory().filter(item => item.id !== command.id);
            terminalWriteJson(TERMINAL_COMMANDS_KEY, [{ id: command.id, usedAt: Date.now() }, ...previous].slice(0, TERMINAL_HISTORY_LIMIT));
        }

        function toggleTerminalCommandFavorite(command) {
            const favorites = terminalCommandFavorites();
            if (favorites.has(command.id)) favorites.delete(command.id); else favorites.add(command.id);
            terminalWriteJson(TERMINAL_COMMAND_FAVORITES_KEY, [...favorites].slice(0, 36));
            renderTerminalCommandPalette();
        }

        function terminalStaticCommands() {
            const navigate = (route, title, keywords = '') => ({ id: `route:${route}`, title, subtitle: 'Navigate', keywords, run: () => navigateTerminal(route) });
            return [
                navigate('home', 'Go to Home', 'dashboard h'),
                navigate('analysis', 'Open Analysis', 'chart market a'),
                navigate('watchlist', 'Open Watchlist', 'symbols w'),
                navigate('portfolio', 'Open Portfolio', 'positions p'),
                navigate('tools', 'Open Tools', 'calculator simulator t'),
                { id: 'search:focus', title: 'Search stocks', subtitle: 'Focus terminal search', keywords: 'ticker symbol slash', run: () => { navigateTerminal('search'); window.setTimeout(() => searchInput?.focus({ preventScroll: true }), 0); } },
                { id: 'settings:open', title: 'Open Settings', subtitle: 'Preferences and workspace', keywords: 'profile account', run: () => openSettingsSheet?.() },
            ];
        }

        function terminalDynamicCommands() {
            const commands = [];
            const renderedRecentTickers = [...document.querySelectorAll('.pt-recent-symbol strong')].map(element => element.textContent);
            [...new Set([...(favoriteTickers || []), ...(sessionRecentViewed || []).map(item => item.ticker), ...renderedRecentTickers, currentTicker].filter(Boolean))].slice(0, 16).forEach(ticker => {
                const symbol = String(ticker).toUpperCase();
                if (/^[A-Z0-9.-]{1,12}$/.test(symbol)) commands.push({ id: `ticker:${symbol}`, title: `Open ${symbol}`, subtitle: favoriteTickers?.has(symbol) ? 'Favorite ticker' : 'Recent ticker', keywords: `stock ticker ${symbol}`, run: () => { switchStock(symbol); navigateTerminal('analysis'); } });
            });
            (cloudWorkspace?.watchlists || []).filter(item => item && !item.archived_at).forEach(item => commands.push({ id: `watchlist:${item.id}`, title: `Open watchlist: ${item.name}`, subtitle: 'Watchlist', keywords: `${item.name} watchlist`, run: () => { selectCloudWatchlist(item.id); navigateTerminal('watchlist'); } }));
            (cloudWorkspace?.portfolios || []).filter(item => item && !item.archived_at).forEach(item => commands.push({ id: `portfolio:${item.id}`, title: `Open portfolio: ${item.name}`, subtitle: 'Portfolio', keywords: `${item.name} portfolio`, run: () => { selectCloudPortfolio(item.id); navigateTerminal('portfolio'); } }));
            return commands;
        }

        function allTerminalCommands() { return [...terminalStaticCommands(), ...terminalDynamicCommands()]; }

        function terminalCommandMatches(command, query) {
            const text = `${command.title} ${command.subtitle || ''} ${command.keywords || ''}`.toLowerCase();
            return query.split(/\s+/).filter(Boolean).every(token => text.includes(token));
        }

        function terminalPaletteQuery() { return commandPalette?.querySelector('input')?.value.trim() || ''; }

        function terminalPaletteResultSet() {
            const query = terminalPaletteQuery().toLowerCase();
            const commands = allTerminalCommands();
            const favorites = terminalCommandFavorites();
            const history = terminalCommandHistory();
            const historyIndex = new Map(history.map((item, index) => [item.id, index]));
            const filtered = query ? commands.filter(command => terminalCommandMatches(command, query)) : commands;
            if (!query && history.length) {
                filtered.sort((left, right) => (historyIndex.get(left.id) ?? 999) - (historyIndex.get(right.id) ?? 999));
            }
            return filtered.sort((left, right) => Number(favorites.has(right.id)) - Number(favorites.has(left.id))).slice(0, 18);
        }

        function renderTerminalCommandPalette() {
            if (!commandPaletteOpen || !commandPalette) return;
            commandPaletteResults = terminalPaletteResultSet();
            commandPaletteIndex = Math.max(0, Math.min(commandPaletteIndex, Math.max(0, commandPaletteResults.length - 1)));
            const list = commandPalette.querySelector('[role="listbox"]');
            const hint = commandPalette.querySelector('.pt-command-palette-hint');
            const favorites = terminalCommandFavorites();
            list.replaceChildren();
            if (!commandPaletteResults.length) {
                const empty = document.createElement('p'); empty.className = 'pt-command-empty'; empty.textContent = 'No commands found. Enter a ticker to open its analysis.'; list.appendChild(empty);
            } else {
                commandPaletteResults.forEach((command, index) => {
                    const row = document.createElement('div');
                    row.id = `pt-command-${index}`; row.className = `pt-command-option${index === commandPaletteIndex ? ' is-active' : ''}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === commandPaletteIndex));
                    const copy = document.createElement('div');
                    const title = document.createElement('strong'); title.textContent = command.title;
                    const subtitle = document.createElement('span'); subtitle.textContent = command.subtitle || 'Quick action'; copy.append(title, subtitle);
                    const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'pt-command-favorite'; favorite.dataset.commandFavorite = command.id; favorite.setAttribute('aria-label', favorites.has(command.id) ? `Remove ${command.title} from favorite commands` : `Favorite ${command.title}`); favorite.textContent = favorites.has(command.id) ? '★' : '☆';
                    row.append(copy, favorite);
                    row.addEventListener('mousedown', event => { if (event.target.closest('[data-command-favorite]')) return; event.preventDefault(); void executeTerminalCommand(command); });
                    list.appendChild(row);
                });
            }
            const input = commandPalette.querySelector('input');
            input?.setAttribute('aria-activedescendant', commandPaletteResults.length ? `pt-command-${commandPaletteIndex}` : '');
            if (hint) hint.textContent = terminalPaletteQuery().includes(';') ? 'Enter runs semicolon-separated quick actions' : '↑↓ navigate · Enter run · Ctrl/⌘ Enter favorite · Esc close';
        }

        async function executeTerminalCommand(command, keepOpen = false) {
            if (!command) return;
            recordTerminalCommand(command);
            await Promise.resolve(command.run());
            scheduleTerminalWorkspaceSave();
            if (!keepOpen) closeTerminalCommandPalette(); else renderTerminalCommandPalette();
        }

        async function executeTerminalPaletteInput() {
            const raw = terminalPaletteQuery();
            if (raw.includes(';')) {
                const lookup = new Map(allTerminalCommands().map(command => [command.title.toLowerCase(), command]));
                const commands = raw.split(';').map(item => lookup.get(item.trim().toLowerCase())).filter(Boolean);
                if (commands.length) { for (const command of commands) await executeTerminalCommand(command, true); closeTerminalCommandPalette(); return; }
            }
            if (commandPaletteResults[commandPaletteIndex]) { await executeTerminalCommand(commandPaletteResults[commandPaletteIndex]); return; }
            const symbol = raw.toUpperCase();
            if (/^[A-Z0-9.-]{1,12}$/.test(symbol)) await executeTerminalCommand({ id: `ticker:${symbol}`, title: `Open ${symbol}`, run: () => { switchStock(symbol); navigateTerminal('analysis'); } });
        }

        function openTerminalCommandPalette() {
            if (commandPaletteOpen) return;
            if (!commandPalette) createTerminalCommandPalette();
            commandPaletteReturnFocus = document.activeElement;
            commandPaletteOpen = true;
            commandPalette.hidden = false;
            commandPalette.querySelector('input').value = '';
            commandPaletteIndex = 0;
            renderTerminalCommandPalette();
            requestAnimationFrame(() => commandPalette.querySelector('input')?.focus());
        }

        function closeTerminalCommandPalette() {
            if (!commandPaletteOpen) return;
            commandPaletteOpen = false;
            commandPalette.hidden = true;
            commandPaletteReturnFocus?.focus?.({ preventScroll: true });
            commandPaletteReturnFocus = null;
        }

        function createTerminalCommandPalette() {
            commandPalette = document.createElement('section');
            commandPalette.id = 'terminal-command-palette'; commandPalette.className = 'pt-command-palette'; commandPalette.hidden = true;
            commandPalette.setAttribute('role', 'dialog'); commandPalette.setAttribute('aria-modal', 'true'); commandPalette.setAttribute('aria-label', 'Command palette');
            commandPalette.innerHTML = '<div class="pt-command-backdrop"></div><div class="pt-command-surface"><label class="pt-command-search"><span aria-hidden="true">⌘</span><input type="text" autocomplete="off" spellcheck="false" placeholder="Search commands, routes, tickers, tools…" role="combobox" aria-expanded="true" aria-controls="terminal-command-results"><kbd>Esc</kbd></label><div id="terminal-command-results" class="pt-command-results" role="listbox"></div><p class="pt-command-palette-hint"></p></div>';
            document.body.appendChild(commandPalette);
            commandPalette.querySelector('.pt-command-backdrop').addEventListener('mousedown', closeTerminalCommandPalette);
            commandPalette.querySelector('input').addEventListener('input', () => { commandPaletteIndex = 0; renderTerminalCommandPalette(); });
            commandPalette.addEventListener('click', event => {
                const favorite = event.target.closest('[data-command-favorite]');
                if (!favorite) return;
                event.preventDefault(); event.stopPropagation();
                const command = allTerminalCommands().find(item => item.id === favorite.dataset.commandFavorite);
                if (command) toggleTerminalCommandFavorite(command);
            });
            const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'pt-command-launcher'; launcher.setAttribute('aria-label', 'Open command palette'); launcher.innerHTML = '<span>⌘</span><span>K</span>'; launcher.addEventListener('click', openTerminalCommandPalette); document.body.appendChild(launcher);
        }

        function terminalTypingTarget(target) {
            return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
        }

        function closeTerminalActiveDialog() {
            if (commandPaletteOpen) { closeTerminalCommandPalette(); return true; }
            const dialog = document.querySelector('dialog[open]');
            if (dialog) { dialog.close(); return true; }
            const profile = document.getElementById('profile-sheet');
            if (profile?.classList.contains('is-open')) { closeProfileSheet?.(); return true; }
            return false;
        }

        function navigateTerminalShortcut(key) {
            const target = { h: 'home', p: 'portfolio', w: 'watchlist', a: 'analysis', t: 'tools' }[key];
            if (target) navigateTerminal(target);
        }

        document.addEventListener('keydown', event => {
            const key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && key === 'k') { event.preventDefault(); openTerminalCommandPalette(); return; }
            if (commandPaletteOpen) {
                if (key === 'escape') { event.preventDefault(); closeTerminalCommandPalette(); return; }
                if (key === 'arrowdown' || key === 'arrowup') { event.preventDefault(); const size = commandPaletteResults.length; if (size) { commandPaletteIndex = (commandPaletteIndex + (key === 'arrowdown' ? 1 : -1) + size) % size; renderTerminalCommandPalette(); } return; }
                if (key === 'enter') { event.preventDefault(); if ((event.ctrlKey || event.metaKey) && commandPaletteResults[commandPaletteIndex]) toggleTerminalCommandFavorite(commandPaletteResults[commandPaletteIndex]); else void executeTerminalPaletteInput(); return; }
                return;
            }
            if (key === 'escape' && closeTerminalActiveDialog()) { event.preventDefault(); return; }
            if (terminalTypingTarget(event.target)) return;
            if (event.altKey && (key === 'arrowleft' || key === 'arrowright')) { event.preventDefault(); key === 'arrowleft' ? history.back() : history.forward(); return; }
            if (key === '/') { event.preventDefault(); navigateTerminal('search'); window.setTimeout(() => searchInput?.focus({ preventScroll: true }), 0); return; }
            if (terminalPendingChord === 'g') { clearTimeout(terminalChordTimer); terminalPendingChord = ''; navigateTerminalShortcut(key); return; }
            if (key === 'g') { terminalPendingChord = 'g'; terminalChordTimer = window.setTimeout(() => { terminalPendingChord = ''; }, 900); }
        });

        function queuedTerminalActions() { return terminalReadJson(TERMINAL_OFFLINE_QUEUE_KEY, []).filter(item => item && typeof item.type === 'string' && Number.isFinite(item.queuedAt)); }

        function queueSafeTerminalAction(type, payload) {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return false;
            const owner = terminalSessionScope();
            if (!owner) return false;
            const actions = queuedTerminalActions().filter(item => Date.now() - item.queuedAt < TERMINAL_OFFLINE_MAX_AGE && item.owner === owner);
            actions.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, payload, owner, queuedAt: Date.now() });
            terminalWriteJson(TERMINAL_OFFLINE_QUEUE_KEY, actions.slice(-40));
            return true;
        }

        async function flushSafeTerminalActions() {
            if (terminalOfflineFlushPromise || !isNetworkOnline || !authState.authenticated || !authState.cloudSyncEnabled) return terminalOfflineFlushPromise;
            const owner = terminalSessionScope();
            const actions = queuedTerminalActions();
            const keep = [];
            terminalOfflineFlushPromise = (async () => {
                for (const action of actions) {
                    if (Date.now() - action.queuedAt > TERMINAL_OFFLINE_MAX_AGE || action.owner !== owner) continue;
                    try {
                        if (action.type === 'activity' && action.payload?.path && action.payload?.payload) {
                            const response = await authFetch(action.payload.path, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(action.payload.payload) });
                            if (!response.ok) throw new Error('Activity sync was rejected.');
                        } else if (action.type === 'recent-viewed' && action.payload?.ticker) {
                            const response = await authFetch('/api/recent-viewed', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ ticker: action.payload.ticker }) });
                            if (!response.ok) throw new Error('Recent ticker sync was rejected.');
                        }
                    } catch (_) { keep.push(action); }
                }
                terminalWriteJson(TERMINAL_OFFLINE_QUEUE_KEY, keep);
                if (!keep.length && actions.length) showTerminalToast('Offline activity synced.');
            })().finally(() => { terminalOfflineFlushPromise = null; });
            return terminalOfflineFlushPromise;
        }

        window.addEventListener('pagehide', saveTerminalWorkspace);
        window.addEventListener('scroll', scheduleTerminalWorkspaceSave, { passive: true });
        window.addEventListener('hashchange', scheduleTerminalWorkspaceSave);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveTerminalWorkspace(); });
