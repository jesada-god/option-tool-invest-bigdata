        async function fetchWatchlist() {
            const sessionEpoch = authSessionEpoch;
            // On an auth-enabled deployment, a signed-out screen must not
            // repopulate a previous cloud account through a late refresh.
            // Auth-disabled deployments retain the legacy watchlist route.
            if (authState.configured === true && !authState.authenticated) {
                setWatchlistItems([]);
                return;
            }
            if (authState.configured === true && authState.authenticated && !authState.cloudSyncEnabled) {
                setWatchlistItems(localWatchlistItems());
                return;
            }
            if (authState.configured === false) {
                setWatchlistItems(localWatchlistItems());
                return;
            }
            if (cloudWorkspaceEnabled()) {
                const loaded = cloudWorkspace.loaded || await loadCloudWorkspace();
                if (sessionEpoch !== authSessionEpoch) return;
                if (loaded) {
                    syncSelectedCloudWatchlist();
                } else {
                    setWatchlistItems([]);
                    setWatchlistStatus('Unable to load the watchlist. Please retry.', 'error');
                }
                return;
            }
            try {
                const res = await authFetch('/api/watchlist', { cache: 'no-store' });
                if (!res.ok) throw new Error(`Watchlist request failed: ${res.status}`);
                const items = await res.json();
                if (sessionEpoch !== authSessionEpoch) return;
                setWatchlistItems(items);
            } catch (err) {
                reportQuantoraError(err, { area: 'watchlist-load' });
                setWatchlistStatus('Unable to load the watchlist. Please retry.', 'error');
            }
        }

        function setWatchlistStatus(message = '', tone = '') {
            const status = document.getElementById('watchlist-status');
            if (!status) return;
            status.textContent = message;
            status.style.color = tone === 'error' ? 'var(--red)' : tone === 'success' ? 'var(--green)' : 'var(--text-muted)';
        }

        function localWatchlistItems() {
            try {
                const parsed = JSON.parse(window.localStorage.getItem(LOCAL_WATCHLIST_STORAGE_KEY) || '[]');
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                reportQuantoraError(error, { area: 'watchlist-storage-read' });
                return [];
            }
        }

        function saveLocalWatchlistItems(items) {
            try {
                window.localStorage.setItem(LOCAL_WATCHLIST_STORAGE_KEY, JSON.stringify(items));
            } catch (error) {
                reportQuantoraError(error, { area: 'watchlist-storage-write' });
                setWatchlistStatus('Unable to save the watchlist on this device.', 'error');
            }
        }

        function setWatchlistItems(items) {
            const unique = new Set();
            watchlist = (Array.isArray(items) ? items : [])
                .map(value => String(value || '').toUpperCase().trim())
                .filter(ticker => /^[A-Z0-9.-]{1,12}$/.test(ticker))
                .filter(ticker => {
                    if (unique.has(ticker)) return false;
                    unique.add(ticker);
                    return true;
                });
            renderWatchlist();
            updateHomeWatchlistSurface();
        }

        function renderWatchlist() {
            const container = document.getElementById('watchlist-row');
            if (!container) return;
            container.replaceChildren();
            const items = Array.isArray(watchlist) ? watchlist : [];
            if (!items.length) {
                const empty = document.createElement('span');
                empty.style.cssText = 'color:var(--text-muted); font-size:12px; padding:8px 0;';
                empty.textContent = 'No saved symbols yet.';
                container.appendChild(empty);
                return;
            }
            items.forEach(value => {
                const ticker = String(value || '').toUpperCase().trim();
                if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return;

                const tag = document.createElement('div');
                tag.className = `watchlist-tag${ticker === currentTicker ? ' active' : ''}`;
                tag.setAttribute('role', 'button');
                tag.tabIndex = 0;
                tag.setAttribute('aria-label', `Open ${ticker} analysis`);
                tag.appendChild(document.createTextNode(ticker));
                tag.addEventListener('click', () => switchStock(ticker));
                tag.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        switchStock(ticker);
                    }
                });

                const remove = document.createElement('span');
                remove.className = 'remove-btn';
                remove.textContent = '×';
                remove.setAttribute('role', 'button');
                remove.tabIndex = 0;
                remove.setAttribute('aria-label', `Remove ${ticker} from watchlist`);
                const removeTicker = event => {
                    event.preventDefault();
                    event.stopPropagation();
                    void deleteWatchlist(ticker);
                };
                remove.addEventListener('click', removeTicker);
                remove.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') removeTicker(event);
                });
                tag.appendChild(remove);
                container.appendChild(tag);
            });
        }

