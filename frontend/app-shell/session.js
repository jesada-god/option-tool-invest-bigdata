// Quantora application-shell module: session
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        function updateFavoriteButton() {
            const button = document.getElementById('favorite-current-button');
            if (!button) return;
            const favorite = favoriteTickers.has(currentTicker);
            button.textContent = favorite ? `โ… ${t('favorited', 'Favorited')}` : `โ ${t('favorite', 'Favorite')}`;
            button.setAttribute('aria-pressed', String(favorite));
        }

        async function loadCloudFavorites() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                favoriteTickers = new Set();
                updateFavoriteButton();
                return;
            }
            try {
                const response = await authFetch('/api/favorites', { headers: authHeaders(), cache: 'no-store' });
                if (!response.ok) throw new Error('Unable to load favorites.');
                const data = await response.json();
                favoriteTickers = new Set((data.items || []).map(item => String(item.ticker || '').toUpperCase()));
                updateFavoriteButton();
            } catch (error) {
                reportQuantoraError(error, { area: 'favorites-load' });
            }
        }

        function renderRecentViewed(items = []) {
            const host = document.getElementById('recent-viewed-list');
            if (!host) return;
            host.replaceChildren();
            if (!items.length) {
                const empty = document.createElement('p');
                empty.className = 'pt-empty-copy';
                empty.textContent = authState.authenticated ? 'Open an instrument to build your personal research trail.' : 'Open a stock to see it here. Sign in to sync this list across devices.';
                host.appendChild(empty);
                return;
            }
            items.forEach(item => {
                const ticker = String(item.ticker || '').toUpperCase();
                if (!ticker) return;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'pt-recent-symbol';
                button.innerHTML = `<strong>${escapeHtml(ticker)}</strong><span>${Number(item.count || 1)} view${Number(item.count || 1) === 1 ? '' : 's'}</span>`;
                button.addEventListener('click', () => switchStock(ticker));
                host.appendChild(button);
            });
        }

        async function loadRecentViewed() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                renderRecentViewed(sessionRecentViewed);
                return;
            }
            try {
                const response = await authFetch('/api/recent-viewed?limit=12', { headers: authHeaders(), cache: 'no-store' });
                if (!response.ok) throw new Error('Unable to load recently viewed instruments.');
                const data = await response.json();
                renderRecentViewed(Array.isArray(data.items) ? data.items : []);
            } catch (error) {
                reportQuantoraError(error, { area: 'recent-load' });
            }
        }

        function recordRecentViewed(ticker) {
            const normalizedTicker = String(ticker || '').toUpperCase().trim();
            if (!/^[A-Z0-9.-]{1,12}$/.test(normalizedTicker)) return;
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                const existing = sessionRecentViewed.find(item => item.ticker === normalizedTicker);
                sessionRecentViewed = [
                    { ticker: normalizedTicker, count: (existing?.count || 0) + 1 },
                    ...sessionRecentViewed.filter(item => item.ticker !== normalizedTicker),
                ].slice(0, 12);
                renderRecentViewed(sessionRecentViewed);
                return;
            }
            if (!isNetworkOnline) {
                queueSafeTerminalAction('recent-viewed', { ticker: normalizedTicker });
                return;
            }
            void authFetch('/api/recent-viewed', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ ticker: normalizedTicker }) })
                .then(response => response.ok ? loadRecentViewed() : undefined)
                .catch(error => reportQuantoraError(error, { area: 'recent-save' }));
        }

        async function toggleCurrentFavorite() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                openProfileSheet();
                setAuthStatus('Sign in before saving a favorite.', 'error');
                return;
            }
            const ticker = currentTicker;
            const isFavorite = favoriteTickers.has(ticker);
            try {
                const response = await authFetch(isFavorite ? `/api/favorites/${encodeURIComponent(ticker)}` : '/api/favorites', {
                    method: isFavorite ? 'DELETE' : 'POST',
                    headers: authHeaders(!isFavorite),
                    body: isFavorite ? undefined : JSON.stringify({ ticker }),
                });
                if (!response.ok) throw new Error('Unable to update favorite.');
                if (isFavorite) favoriteTickers.delete(ticker); else favoriteTickers.add(ticker);
                updateFavoriteButton();
            } catch (error) {
                reportQuantoraError(error, { area: 'favorite-save' });
            }
        }

        function recordCloudActivity(path, payload) {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return;
            if (!isNetworkOnline) {
                queueSafeTerminalAction('activity', { path, payload });
                return;
            }
            void authFetch(path, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(payload) })
                .catch(error => reportQuantoraError(error, { area: 'activity-save' }));
        }

        // --- Authenticated alert rules and notification inbox -------------
        // Only Price and Support/Resistance rules are surfaced as actionable
        // here. They are explicitly in-app notifications; push/email settings
        // are intentionally not implied by this UI.
