// Quantora application-shell module: workspace
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        let stockWorkspaceTab = 'overview';
        let stockWorkspaceRequestVersion = 0;
        let stockWorkspaceAbortController = null;

        function setActiveStockWorkspaceTab(tab) {
            stockWorkspaceTab = tab;
            document.querySelectorAll('.pt-stock-tab').forEach(button => {
                const active = button.dataset.stockTab === tab;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', String(active));
            });
        }

        function stockWorkspaceMetric(label, value) {
            return `<div class="pt-company-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || 'โ€”')}</strong></div>`;
        }

        async function openStockWorkspaceTab(tab) {
            const workspace = document.getElementById('stock-workspace');
            if (!workspace) return;
            if (stockWorkspaceAbortController && !stockWorkspaceAbortController.signal.aborted) stockWorkspaceAbortController.abort();
            setActiveStockWorkspaceTab(tab);
            if (tab === 'overview') {
                workspace.classList.remove('is-open');
                document.getElementById('tvchart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (tab === 'options') { navigateTerminal('portfolio'); return; }
            if (tab === 'simulator') { navigateTerminal('tools'); return; }
            workspace.classList.add('is-open');
            const ticker = currentTicker;
            const requestVersion = ++stockWorkspaceRequestVersion;
            const controller = new AbortController();
            stockWorkspaceAbortController = controller;
            workspace.innerHTML = `<h3>${escapeHtml(ticker)}</h3><p class="pt-empty-copy">${escapeHtml(analysisText('loading', 'Loading provider-backed analysisโ€ฆ'))}</p>`;
            workspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            try {
                if (tab === 'company') {
                    const response = await fetch(`/api/company?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error('Company information is unavailable.');
                    const data = await response.json();
                    if (requestVersion !== stockWorkspaceRequestVersion || ticker !== currentTicker) return;
                    const website = data.website && /^https?:\/\//.test(data.website) ? new URL(data.website).hostname : 'โ€”';
                    const metrics = [[analysisText('sector', 'Sector'), data.sector], [analysisText('industry', 'Industry'), data.industry], [analysisText('exchange', 'Exchange'), data.exchange], [analysisText('employees', 'Employees'), Number.isFinite(Number(data.employees)) ? Number(data.employees).toLocaleString() : 'โ€”'], [analysisText('market_cap', 'Market cap'), Number.isFinite(Number(data.market_cap)) ? `$${(Number(data.market_cap) / 1e9).toFixed(1)}B` : 'โ€”'], [analysisText('website', 'Website'), website]];
                    const sourceSummary = userPreferences.language === 'th' && data.summary ? `<details class="pt-empty-copy" style="margin-top:12px;"><summary>${escapeHtml(analysisText('company_source', 'Full provider description (original language)'))}</summary><p>${escapeHtml(data.summary)}</p></details>` : '';
                    workspace.innerHTML = `<h3>${escapeHtml(data.name || ticker)}</h3><p>${escapeHtml(localizedCompanySummary(data))}</p><div class="pt-company-grid">${metrics.map(([label, value]) => stockWorkspaceMetric(label, String(value))).join('')}</div>${sourceSummary}`;
                    return;
                }
                if (tab === 'financial') {
                    const [companyResponse, statsResponse] = await Promise.all([fetch(`/api/company?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal }), fetch(`/api/stats?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal })]);
                    if (!companyResponse.ok || !statsResponse.ok) throw new Error('Financial data is unavailable.');
                    const [company, stats] = await Promise.all([companyResponse.json(), statsResponse.json()]);
                    if (requestVersion !== stockWorkspaceRequestVersion || ticker !== currentTicker) return;
                    const metrics = [[analysisText('trailing_pe', 'Trailing P/E'), company.trailing_pe], [analysisText('forward_pe', 'Forward P/E'), company.forward_pe], [analysisText('revenue', 'Revenue'), Number.isFinite(Number(company.revenue)) ? `$${(Number(company.revenue) / 1e9).toFixed(2)}B` : 'โ€”'], [analysisText('profit_margin', 'Profit margin'), Number.isFinite(Number(company.profit_margin)) ? `${(Number(company.profit_margin) * 100).toFixed(2)}%` : 'โ€”'], [analysisText('dividend_yield', 'Dividend yield'), Number.isFinite(Number(company.dividend_yield)) ? `${(Number(company.dividend_yield) * 100).toFixed(2)}%` : 'โ€”'], [analysisText('fair_value', 'Fair value'), stats.fair_value ? `$${Number(stats.fair_value).toFixed(2)}` : 'โ€”']];
                    const heading = userPreferences.language === 'th' ? `เธ เธฒเธเธฃเธงเธกเธเนเธญเธกเธนเธฅเธเธฒเธฃเน€เธเธดเธ ${ticker}` : `${ticker} financial snapshot`;
                    workspace.innerHTML = `<h3>${escapeHtml(heading)}</h3><p>${escapeHtml(analysisText('financial_note', 'Provider-reported fields may be unavailable for some instruments. Values are not accounting advice.'))}</p><div class="pt-company-grid">${metrics.map(([label, value]) => stockWorkspaceMetric(label, String(value ?? 'โ€”'))).join('')}</div>`;
                    return;
                }
                if (tab === 'news') {
                    const response = await fetch(`/api/news?ticker=${encodeURIComponent(ticker)}&limit=5`, { cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error('News is unavailable.');
                    const data = await response.json();
                    if (requestVersion !== stockWorkspaceRequestVersion || ticker !== currentTicker) return;
                    const items = Array.isArray(data.items) ? data.items : [];
                    const heading = userPreferences.language === 'th' ? `เธเนเธฒเธงเธฅเนเธฒเธชเธธเธ”เธเธญเธ ${ticker}` : `${ticker} news`;
                    const noNews = analysisText('no_news', 'No current headlines are available.');
                    workspace.innerHTML = `<h3>${escapeHtml(heading)}</h3><p>${escapeHtml(analysisText('news_note', 'Showing up to five recent, ticker-relevant headlines from the last three months.'))}</p><div class="pt-news-list">${items.length ? items.map(item => { const meta = [item.publisher || 'Market data provider', formatAnalysisDate(item.published_at)].filter(Boolean).join(' ยท '); const link = safeExternalUrl(item.link); return `<a class="pt-news-item" href="${escapeHtml(link)}" ${link !== '#' ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(item.title)}<span>${escapeHtml(meta)}</span></a>`; }).join('') : `<p class="pt-empty-copy">${escapeHtml(noNews)}</p>`}</div><p class="pt-empty-copy" style="margin-top:10px;">${escapeHtml(analysisText('news_original_language', 'Headlines are displayed in the source language.'))}</p>`;
                    return;
                }
                if (tab === 'forecast') {
                    const [aiResponse, levelsResponse] = await Promise.all([fetch(`/api/ai-recommendation?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal }), fetch(`/api/indicators?ticker=${encodeURIComponent(ticker)}&timeframe=week`, { cache: 'no-store', signal: controller.signal })]);
                    if (!aiResponse.ok || !levelsResponse.ok) throw new Error('Forecast inputs are unavailable.');
                    const [ai, levels] = await Promise.all([aiResponse.json(), levelsResponse.json()]);
                    if (requestVersion !== stockWorkspaceRequestVersion || ticker !== currentTicker) return;
                    const closest = levels.closest_alert || {};
                    const metrics = [[analysisText('signal', 'Signal'), ai.signal], [analysisText('confidence', 'Confidence'), `${Number(ai.confidence_score || 0).toFixed(1)}/100`], [analysisText('bullish', 'Bullish'), `${Number(ai.bullish_probability || 0).toFixed(1)}%`], [analysisText('bearish', 'Bearish'), `${Number(ai.bearish_probability || 0).toFixed(1)}%`], [analysisText('closest_weekly_sr', 'Closest weekly S/R'), closest.label ? `${closest.label} ยท $${Number(closest.level).toFixed(2)}` : 'โ€”'], [analysisText('distance', 'Distance'), Number.isFinite(Number(closest.distance_pct)) ? `${Number(closest.distance_pct).toFixed(2)}%` : 'โ€”']];
                    const heading = userPreferences.language === 'th' ? `เนเธเธงเนเธเนเธกเน€เธเธดเธเธงเธดเน€เธเธฃเธฒเธฐเธซเน ${ticker}` : `${ticker} analytical forecast`;
                    workspace.innerHTML = `<h3>${escapeHtml(heading)}</h3><p>${escapeHtml(userPreferences.language === 'th' ? analysisText('forecast_note') : (ai.disclaimer || 'Analytical signal only.'))}</p><div class="pt-company-grid">${metrics.map(([label, value]) => stockWorkspaceMetric(label, String(value ?? 'โ€”'))).join('')}</div>`;
                }
            } catch (error) {
                if (isAbortError(error)) return;
                if (requestVersion === stockWorkspaceRequestVersion && ticker === currentTicker) workspace.innerHTML = `<h3>${escapeHtml(ticker)}</h3><p class="pt-empty-copy">${escapeHtml(userPreferences.language === 'th' ? analysisText('unavailable') : (error.message || 'This data is temporarily unavailable. Please retry.'))}</p>`;
            } finally {
                if (stockWorkspaceAbortController === controller) stockWorkspaceAbortController = null;
            }
        }

        // --- โจ V2 application shell: navigation only, existing engines stay in place ---


        let cloudWorkspaceLoadPromise = null;

        function cloudWorkspaceEnabled() {
            return Boolean(authState.authenticated && authState.cloudSyncEnabled && !authState.configurationError);
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

        function syncSelectedCloudWatchlist() {
            if (!cloudWorkspaceEnabled() || !cloudWorkspace.loaded) return;
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
                option.textContent = `${portfolio.name}${portfolio.is_default ? ' ยท Default' : ''}`;
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
                option.textContent = `${item.name}${item.is_default ? ' ยท Default' : ''}${item.is_pinned ? ' ยท Pinned' : ''}`;
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

            const preferenceRow = cloudWorkspaceElement('div', 'pt-workspace-split');
            const pinButton = cloudWorkspaceButton(selected && selected.is_pinned ? 'Unpin list' : 'Pin list', toggleSelectedCloudWatchlistPin, 'ghost');
            const favoriteButton = cloudWorkspaceButton(selected && selected.is_favorite ? 'Unfavorite list' : 'Favorite list', toggleSelectedCloudWatchlistFavorite, 'ghost');
            pinButton.disabled = !selected;
            favoriteButton.disabled = !selected;
            preferenceRow.append(pinButton, favoriteButton);
            fields.appendChild(preferenceRow);

            const tickerList = cloudWorkspaceElement('div', 'pt-workspace-ticker-list');
            const items = selected && Array.isArray(selected.items) ? selected.items : [];
            if (!items.length) {
                tickerList.appendChild(cloudWorkspaceElement('p', 'pt-workspace-empty', 'No symbols in this watchlist yet.'));
            } else {
                items.forEach(item => {
                    const ticker = String(item && item.ticker || '').toUpperCase();
                    if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return;
                    const pill = cloudWorkspaceElement('span', 'pt-workspace-ticker', ticker);
                    const remove = cloudWorkspaceButton('ร—', () => removeTickerFromSelectedCloudWatchlist(ticker));
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
                option.textContent = `${item.name}${item.is_default ? ' ยท Default' : ''} ยท ${item.currency || 'USD'}`;
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
                host.appendChild(cloudWorkspaceElement('p', 'pt-workspace-status', 'Loading your workspaceโ€ฆ'));
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
                    throw error;
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
            setCloudWorkspaceStatus('Saving workspace changeโ€ฆ');
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
            renderPortfolioTable();
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

        async function updateSelectedCloudWatchlist(payload, successMessage) {
            const selected = selectedCloudWatchlist();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            await mutateCloudWorkspace(`/api/watchlists/${selected.id}`, {
                method: 'PATCH', headers: authHeaders(true), body: JSON.stringify(payload),
            }, successMessage);
        }

        async function toggleSelectedCloudWatchlistPin() {
            const selected = selectedCloudWatchlist();
            if (!selected) return;
            await updateSelectedCloudWatchlist({ is_pinned: !selected.is_pinned }, selected.is_pinned ? 'Watchlist unpinned.' : 'Watchlist pinned.');
        }

        async function toggleSelectedCloudWatchlistFavorite() {
            const selected = selectedCloudWatchlist();
            if (!selected) return;
            await updateSelectedCloudWatchlist({ is_favorite: !selected.is_favorite }, selected.is_favorite ? 'Watchlist removed from favorites.' : 'Watchlist added to favorites.');
        }

        async function deleteCloudWatchlist() {
            const selected = selectedCloudWatchlist();
            if (!selected) { setCloudWorkspaceStatus('Select a watchlist first.', 'error'); return; }
            if (!window.confirm(`Delete watchlist โ€${selected.name}โ€? This cannot be undone.`)) return;
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
            return await mutateCloudWorkspace(`/api/watchlists/${selected.id}/items`, {
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
            if (!window.confirm(`Archive portfolio โ€${selected.name}โ€? Existing history is retained.`)) return;
            await mutateCloudWorkspace(`/api/portfolios/${selected.id}`, {
                method: 'DELETE', headers: authHeaders(),
            }, 'Portfolio archived.');
        }

