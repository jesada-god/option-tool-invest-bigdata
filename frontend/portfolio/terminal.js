// --- Dedicated portfolio module ------------------------------------
        let portfolioModuleView = 'overview';
        let stockPortfolioItems = [];
        let portfolioOverviewItems = [];
        // Summaries and holding pages have intentionally independent caches.
        // A summary refresh never invalidates already-rendered holding rows.
        const stockPortfolioSummaryCache = new Map();
        const stockPortfolioHoldingCache = new Map();
        const STOCK_HOLDINGS_PAGE_SIZE = 50;
        const STOCK_HOLDING_ROW_HEIGHT = 230;
        let optionsPortfolioEngineLoaded = false;
        let portfolioCacheOwner = null;
        let stockTradeSaving = false;
        let portfolioDialogSaving = false;
        let portfolioDialogReturnFocus = null;
        const closingPositionIds = new Set();

        function ensurePortfolioCacheOwner() {
            const owner = authState.user && (authState.user.id || authState.user.email) || 'guest';
            if (portfolioCacheOwner === owner) return;
            portfolioCacheOwner = owner;
            stockPortfolioSummaryCache.clear();
            stockPortfolioHoldingCache.clear();
            portfolioStockPresentation.clear();
            portfolioOverviewItems = [];
            stockPortfolioItems = [];
        }

        function portfolioMoney(value, currency = 'USD') {
            if (value === null || value === undefined || value === '') return '—';
            const amount = Number(value);
            if (!Number.isFinite(amount)) return '—';
            try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); }
            catch (_) { return `${currency} ${amount.toFixed(2)}`; }
        }

        function portfolioSignedMoney(value, currency = 'USD') {
            const amount = Number(value);
            if (!Number.isFinite(amount)) return '—';
            return `${amount >= 0 ? '+' : '−'}${portfolioMoney(Math.abs(amount), currency)}`;
        }

        function selectedPortfolioCurrency(id) {
            const portfolio = (cloudWorkspace.portfolios || []).find(item => cloudWorkspaceId(item && item.id) === cloudWorkspaceId(id));
            return (portfolio && portfolio.currency) || 'USD';
        }

        async function submitStockTrade(event) {
            event.preventDefault();
            if (stockTradeSaving) return;
            if (!cloudWorkspaceEnabled()) { const status = document.getElementById('stock-portfolio-status'); if (status) status.textContent = 'Sign in with cloud sync enabled to record a stock trade.'; return; }
            const payload = {
                portfolio_id: Number(document.getElementById('stock-portfolio-id').value), ticker: document.getElementById('stock-ticker').value.trim().toUpperCase(),
                side: document.getElementById('stock-side').value, shares: Number(document.getElementById('stock-shares').value), price: Number(document.getElementById('stock-price').value), notes: document.getElementById('stock-notes').value.trim() || null,
            };
            const status = document.getElementById('stock-portfolio-status');
            if (!payload.portfolio_id || !/^[A-Z0-9.-]{1,12}$/.test(payload.ticker) || !(payload.shares > 0) || !(payload.price >= 0)) { if (status) status.textContent = 'Enter a valid portfolio, ticker, share quantity, and price.'; return; }
            const submit = event.target.querySelector('button[type="submit"]');
            stockTradeSaving = true;
            setTerminalButtonBusy(submit, true, 'Recording…');
            try {
                const response = await authFetch('/api/portfolio/stocks/trades', { method: 'POST', headers: authHeaders(true), body: JSON.stringify(payload) });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.detail || 'Trade could not be recorded.');
                event.target.reset(); if (status) status.textContent = `${payload.side} recorded for ${payload.ticker}.`;
                showTerminalToast(`${payload.side} recorded for ${payload.ticker}.`);
                invalidateStockPortfolio(payload.portfolio_id);
                await loadPortfolioModuleData();
            } catch (error) {
                if (status) status.textContent = error.message || 'Trade could not be recorded.';
                showTerminalToast(error.message || 'Trade could not be recorded.', 'error');
            } finally {
                stockTradeSaving = false;
                setTerminalButtonBusy(submit, false);
            }
        }

        async function createPortfolioFromModule() {
            const name = document.getElementById('portfolio-settings-create')?.value.trim();
            const currency = document.getElementById('portfolio-settings-create-currency')?.value.trim().toUpperCase() || 'USD';
            if (!name) return;
            const response = await authFetch('/api/portfolios', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name, currency }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { window.alert(data.detail || 'Portfolio could not be created.'); return; }
            cloudWorkspace.selectedPortfolioId = cloudWorkspaceId(data.portfolio && data.portfolio.id);
            await loadCloudWorkspace(); await loadPortfolioModuleData();
        }

        async function savePortfolioSettings() {
            const selected = selectedCloudPortfolio(); if (!selected) return;
            const name = document.getElementById('portfolio-settings-name')?.value.trim();
            const currency = document.getElementById('portfolio-settings-currency')?.value.trim().toUpperCase();
            if (!name) return;
            const response = await authFetch(`/api/portfolios/${selected.id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ name, currency }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { window.alert(data.detail || 'Portfolio could not be updated.'); return; }
            await loadCloudWorkspace(); await loadPortfolioModuleData();
        }

        async function archivePortfolioFromModule() {
            const selected = selectedCloudPortfolio(); if (!selected || selected.is_default) return;
            if (!window.confirm(`Archive portfolio “${selected.name}”? Holdings and history will remain available in the archive.`)) return;
            const response = await authFetch(`/api/portfolios/${selected.id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { window.alert(data.detail || 'Portfolio could not be archived.'); return; }
            await loadCloudWorkspace(); await loadPortfolioModuleData();
        }

        // --- Portfolio UX layer: presentation only; existing APIs remain authoritative. ---
        let portfolioModuleLoadPromise = null;
        let portfolioPresentationAbortController = null;
        let holdingDetailId = null;
        let holdingDetailTab = 'overview';
        let stockPortfolioScrollPosition = 0;
        let portfolioLandingScrollPosition = 0;
        let portfolioDialogMode = 'create';
        const portfolioStockPresentation = new Map();
        const portfolioStockPresentationPending = new Set();
        let stockHoldingRenderFrame = null;

        function portfolioPresentationKey() {
            return `portfolio-presentation:${authState.user && (authState.user.id || authState.user.email) || 'local'}`;
        }
        function portfolioPresentation() {
            try { return JSON.parse(localStorage.getItem(portfolioPresentationKey()) || '{}') || {}; } catch (_) { return {}; }
        }
        function portfolioPresentationFor(id) { return portfolioPresentation()[String(id)] || {}; }
        function savePortfolioPresentation(id, value) {
            try { const data = portfolioPresentation(); data[String(id)] = { ...(data[String(id)] || {}), ...value }; localStorage.setItem(portfolioPresentationKey(), JSON.stringify(data)); } catch (_) { /* Optional visual preferences never block portfolio access. */ }
        }

        function portfolioSelectedItem() {
            const selectedId = cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
            return portfolioOverviewItems.find(item => cloudWorkspaceId(item && item.id) === selectedId)
                || (cloudWorkspace.portfolios || []).find(item => cloudWorkspaceId(item && item.id) === selectedId)
                || portfolioOverviewItems[0] || (cloudWorkspace.portfolios || [])[0] || null;
        }

        function portfolioNumber(value) {
            if (value === null || value === undefined || value === '') return null;
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
        }

        function portfolioChange(value, currency) {
            const number = portfolioNumber(value);
            if (number === null) return '<strong>—</strong>';
            const color = number >= 0 ? 'var(--green)' : 'var(--red)';
            return `<strong style="color:${color}">${portfolioSignedMoney(number, currency)}</strong>`;
        }
        function portfolioTone(value) { const number = portfolioNumber(value); return number === null ? 'var(--text-muted)' : number >= 0 ? 'var(--green)' : 'var(--red)'; }

        async function enrichStockPortfolioPresentation(items) {
            if (!portfolioPresentationAbortController || portfolioPresentationAbortController.signal.aborted) {
                portfolioPresentationAbortController = new AbortController();
            }
            const controller = portfolioPresentationAbortController;
            const tickers = [...new Set((items || []).map(item => String(item && item.ticker || '').toUpperCase()).filter(Boolean))]
                .filter(ticker => !portfolioStockPresentation.has(ticker) && !portfolioStockPresentationPending.has(ticker));
            if (!tickers.length) return;
            tickers.forEach(ticker => portfolioStockPresentationPending.add(ticker));
            await Promise.all(tickers.map(async ticker => {
                try {
                    const [companyResponse, statsResponse] = await Promise.all([
                        fetch(`/api/company?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal }),
                        fetch(`/api/stats?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal }),
                    ]);
                    const company = companyResponse.ok ? await companyResponse.json() : {};
                    const stats = statsResponse.ok ? await statsResponse.json() : {};
                    portfolioStockPresentation.set(ticker, {
                        name: typeof company.name === 'string' && company.name.trim() ? company.name.trim() : null,
                        previousClose: portfolioNumber(stats.prev_close),
                        currentPrice: portfolioNumber(stats.current_price),
                    });
                } catch (error) {
                    if (error && error.name !== 'AbortError') {
                        portfolioStockPresentation.set(ticker, portfolioStockPresentation.get(ticker) || {});
                    }
                } finally {
                    portfolioStockPresentationPending.delete(ticker);
                }
            }));
        }

        function stockHoldingPresentation(holding) {
            const market = portfolioStockPresentation.get(holding.ticker) || {};
            const shares = portfolioNumber(holding.shares) || 0;
            const currentPrice = portfolioNumber(holding.current_price) ?? portfolioNumber(market.currentPrice);
            const previousClose = portfolioNumber(market.previousClose);
            const marketValue = currentPrice === null ? portfolioNumber(holding.market_value) : currentPrice * shares;
            const unrealized = currentPrice === null ? portfolioNumber(holding.unrealized_pnl) : (currentPrice - (portfolioNumber(holding.average_cost) || 0)) * shares;
            const dailyPnl = currentPrice !== null && previousClose !== null ? (currentPrice - previousClose) * shares : null;
            const dailyPercent = currentPrice !== null && previousClose && previousClose > 0 ? ((currentPrice - previousClose) / previousClose) * 100 : null;
            const costBasis = (portfolioNumber(holding.average_cost) || 0) * shares;
            const totalPnl = unrealized === null ? null : unrealized + (portfolioNumber(holding.realized_pnl) || 0);
            const roi = costBasis > 0 && unrealized !== null ? (unrealized / costBasis) * 100 : null;
            return { ...holding, companyName: market.name || 'Company name unavailable', currentPrice, marketValue, unrealized, dailyPnl, dailyPercent, costBasis, totalPnl, roi };
        }

        function renderPortfolioOverview() {
            const host = document.getElementById('portfolio-overview-summary');
            if (!host) return;
            if (!cloudWorkspaceEnabled()) {
                host.innerHTML = '<div class="portfolio-empty-state"><h4>Portfolio is unavailable</h4><p>Sign in to view the portfolios saved to your account.</p></div>';
                return;
            }
            const selected = portfolioSelectedItem();
            if (!selected) {
                host.innerHTML = '<div class="portfolio-empty-state"><h4>Create your first portfolio</h4><p>Build a stock or options portfolio using your account data.</p><button class="btn-submit" type="button" onclick="openPortfolioDialog()">Create portfolio</button></div>';
                return;
            }
            const currency = selected.currency || 'USD';
            const summary = stockPortfolioSummaryCache.get(cloudWorkspaceId(selected.id))?.data || selected;
            const stockValue = portfolioNumber(summary.stock_value);
            const stockDaily = null;
            const stockPrior = null;
            const optionPositions = optionsPortfolioEngineLoaded
                ? activePositions.filter(item => cloudWorkspaceId(item && item.portfolio_id) === cloudWorkspaceId(selected.id))
                : [];
            const optionValue = optionsPortfolioEngineLoaded
                ? optionPositions.reduce((total, position) => total
                    + ((portfolioNumber(position.premium_paid) || 0) * (portfolioNumber(position.quantity) || 0) * 100)
                    + (portfolioNumber(position.pnl) || 0), 0)
                : null;
            const presentation = portfolioPresentationFor(selected.id);
            const icon = escapeHtml(presentation.icon || '▣');
            const card = (type, value, dailyPnl, dailyPercent, holdings, action) => `<button class="portfolio-type-card" type="button" aria-label="Open ${escapeHtml(selected.name)} ${type}" onclick="${action}"><div class="portfolio-card-top"><div><p class="portfolio-card-eyebrow">${icon} ${type}</p><h4 class="portfolio-card-name">${escapeHtml(selected.name)}</h4></div><span style="color:var(--blue); font-size:18px;" aria-hidden="true">→</span></div><strong class="portfolio-card-value">${portfolioMoney(value, currency)}</strong><div class="portfolio-card-metrics"><div><span>Daily P/L</span>${portfolioChange(dailyPnl, currency)}</div><div><span>Daily %</span><strong style="color:${dailyPercent === null ? 'var(--text-muted)' : dailyPercent >= 0 ? 'var(--green)' : 'var(--red)'}">${dailyPercent === null ? '—' : `${dailyPercent >= 0 ? '+' : ''}${dailyPercent.toFixed(2)}%`}</strong></div><div><span>Holdings</span><strong>${holdings}</strong></div></div></button>`;
            host.innerHTML = card('Stock Portfolio', stockValue, stockDaily, stockPrior !== null && stockPrior > 0 ? (stockDaily / stockPrior) * 100 : null, Number(summary.holding_count || 0), "openPortfolioType('stocks')")
                + card('Options Portfolio', optionValue, null, null, optionsPortfolioEngineLoaded ? optionPositions.length : '—', "openPortfolioType('options')");
        }

        function renderStockPortfolio() {
            const host = document.getElementById('stock-portfolio-rows');
            const selector = document.getElementById('stock-portfolio-id');
            const summary = document.getElementById('stock-portfolio-summary');
            const title = document.getElementById('stock-portfolio-title');
            if (!host || !selector || !summary) return;
            const portfolios = (cloudWorkspace.portfolios || []).filter(item => item && !item.archived_at);
            selector.replaceChildren();
            portfolios.forEach(item => {
                const option = document.createElement('option'); option.value = String(item.id);
                option.textContent = `${item.name} · ${item.currency || 'USD'}`;
                option.selected = cloudWorkspaceId(item.id) === cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
                selector.appendChild(option);
            });
            selector.disabled = !cloudWorkspaceEnabled() || !portfolios.length;
            selector.onchange = event => { selectCloudPortfolio(event.target.value); void loadPortfolioModuleData(); };
            const selected = portfolioSelectedItem();
            if (title) title.textContent = selected ? selected.name : 'Stock Portfolio';
            if (!cloudWorkspaceEnabled()) {
                summary.innerHTML = ''; host.innerHTML = '<div class="portfolio-empty-state"><h4>Portfolio is unavailable</h4><p>Sign in to access the stock holdings saved to your account.</p></div>'; return;
            }
            if (!selected) {
                summary.innerHTML = ''; host.innerHTML = '<div class="portfolio-empty-state"><h4>Create your first portfolio</h4><p>Then add a stock trade to begin tracking holdings.</p><button class="btn-submit" type="button" onclick="openPortfolioDialog()">Create portfolio</button></div>'; return;
            }
            const currency = selected.currency || 'USD';
            const cache = stockPortfolioHoldingCache.get(cloudWorkspaceId(selected.id));
            const summaryData = stockPortfolioSummaryCache.get(cloudWorkspaceId(selected.id))?.data || selected;
            const items = (cache?.items || []).map(stockHoldingPresentation)
                .sort((left, right) => (portfolioNumber(right.marketValue) ?? -Infinity) - (portfolioNumber(left.marketValue) ?? -Infinity));
            const holdingCount = Number(summaryData.holding_count || 0);
            summary.innerHTML = [['Market value', portfolioMoney(summaryData.stock_value, currency)], ['Today’s P/L', '—'], ['Total P/L', portfolioMoney(summaryData.total_pnl, currency)], ['Holdings', String(holdingCount)]].map(([label, value]) => `<div class="stat-box"><span>${label}</span><strong>${value}</strong></div>`).join('');
            if (!holdingCount && !(cache?.items?.length)) { host.innerHTML = '<div class="portfolio-empty-state"><h4>Add your first stock</h4><p>Record a buy above to start this portfolio. No sample holdings are shown.</p><button class="btn-submit" type="button" onclick="document.getElementById(\'stock-ticker\')?.focus()">Add stock</button></div>'; return; }
            if (!cache) { host.innerHTML = '<p class="portfolio-module-note">Loading holdings…</p>'; return; }
            renderVirtualStockHoldingList(host, items, currency, cache);
        }

        function stockHoldingCard(item, currency) {
            const id = Number(item.id);
            if (!Number.isSafeInteger(id) || id < 1) return '';
            item.id = id;
            return `<button class="stock-holding-card" type="button" aria-label="Open ${escapeHtml(item.ticker)} holding details" onclick="openHoldingDetail(${id})"><div class="holding-card-top"><div><p class="holding-card-eyebrow">${escapeHtml(item.ticker)}</p><h4 class="holding-card-ticker">${escapeHtml(item.ticker)}</h4></div><strong style="color:${portfolioTone(item.totalPnl)}">${portfolioSignedMoney(item.totalPnl, currency)}</strong></div><p class="holding-company">${escapeHtml(item.companyName)}</p><div class="holding-card-metrics"><div><span>Shares</span><strong>${Number(item.shares).toLocaleString()}</strong></div><div><span>Average cost</span><strong>${portfolioMoney(item.average_cost, currency)}</strong></div><div><span>Current price</span><strong>${portfolioMoney(item.currentPrice, currency)}</strong></div><div><span>Market value</span><strong>${portfolioMoney(item.marketValue, currency)}</strong></div><div><span>Today’s P/L</span><strong style="color:${portfolioTone(item.dailyPnl)}">${portfolioSignedMoney(item.dailyPnl, currency)}</strong></div><div><span>Total P/L · ROI</span><strong style="color:${portfolioTone(item.totalPnl)}">${portfolioSignedMoney(item.totalPnl, currency)} · ${item.roi === null ? '—' : `${item.roi >= 0 ? '+' : ''}${item.roi.toFixed(2)}%`}</strong></div></div></button>`;
        }

        function renderVirtualStockHoldingList(host, items, currency, cache) {
            const columns = window.matchMedia('(max-width: 700px)').matches ? 1 : 2;
            const visibleRows = Math.ceil((host.clientHeight || 760) / STOCK_HOLDING_ROW_HEIGHT);
            const firstRow = Math.max(0, Math.floor(host.scrollTop / STOCK_HOLDING_ROW_HEIGHT) - 2);
            const start = firstRow * columns;
            const end = Math.min(items.length, (firstRow + visibleRows + 4) * columns);
            const totalRows = Math.ceil(Math.max(items.length, Number(cache.total || 0)) / columns);
            const visible = items.slice(start, end);
            host.innerHTML = `<div class="stock-holding-spacer" style="height:${Math.max(1, totalRows * STOCK_HOLDING_ROW_HEIGHT)}px"><div class="stock-holding-virtual-list" style="top:${firstRow * STOCK_HOLDING_ROW_HEIGHT}px">${visible.map(item => stockHoldingCard(item, currency)).join('')}</div></div>`;
            host.onscroll = () => {
                if (portfolioModuleView !== 'stocks') return;
                if (cache.hasMore && host.scrollTop + host.clientHeight >= host.scrollHeight - (STOCK_HOLDING_ROW_HEIGHT * 3)) void loadStockHoldingsPage(cloudWorkspaceId(portfolioSelectedItem()?.id));
                if (stockHoldingRenderFrame !== null) return;
                stockHoldingRenderFrame = window.requestAnimationFrame(() => {
                    stockHoldingRenderFrame = null;
                    if (portfolioModuleView === 'stocks' && host.isConnected) renderStockPortfolio();
                });
            };
            const unpresented = visible.filter(item => !portfolioStockPresentation.has(item.ticker) && !portfolioStockPresentationPending.has(item.ticker));
            if (unpresented.length) void enrichStockPortfolioPresentation(unpresented).then(() => {
                if (portfolioModuleView === 'stocks') renderStockPortfolio();
            });
        }

        function openPortfolioType(view) { portfolioLandingScrollPosition = window.scrollY; selectPortfolioModuleView(view, null); }
        function backToPortfolioLanding() { selectPortfolioModuleView('overview', null); window.setTimeout(() => window.scrollTo({ top: portfolioLandingScrollPosition, behavior: 'auto' }), 0); }

        function openHoldingDetail(id) {
            const holding = stockPortfolioItems.find(item => Number(item.id) === Number(id));
            if (!holding) return;
            holdingDetailId = Number(id); holdingDetailTab = 'overview'; stockPortfolioScrollPosition = window.scrollY;
            selectPortfolioModuleView('holding', null);
        }

        function backToStockPortfolio() {
            selectPortfolioModuleView('stocks', null, true);
            window.requestAnimationFrame(() => window.scrollTo({ top: stockPortfolioScrollPosition, behavior: 'auto' }));
        }

        function selectedHoldingDetail() { return stockPortfolioItems.find(item => Number(item.id) === Number(holdingDetailId)) || null; }

        function renderHoldingDetail() {
            const holding = selectedHoldingDetail();
            if (!holding) { backToStockPortfolio(); return; }
            const item = stockHoldingPresentation(holding); const currency = selectedPortfolioCurrency(item.portfolio_id);
            document.getElementById('holding-detail-title').textContent = item.ticker;
            document.getElementById('holding-detail-company').textContent = item.companyName;
            const metric = (label, value, tone = '') => `<div class="holding-detail-metric"><span>${label}</span><strong${tone ? ` style="color:${tone}"` : ''}>${value}</strong></div>`;
            document.getElementById('holding-detail-overview').innerHTML = `<div class="holding-detail-grid">${metric('Ticker', escapeHtml(item.ticker))}${metric('Company name', escapeHtml(item.companyName))}${metric('Shares', Number(item.shares).toLocaleString())}${metric('Average cost', portfolioMoney(item.average_cost, currency))}${metric('Current price', portfolioMoney(item.currentPrice, currency))}${metric('Market value', portfolioMoney(item.marketValue, currency))}${metric('Cost basis', portfolioMoney(item.costBasis, currency))}${metric('Unrealized P/L', portfolioSignedMoney(item.unrealized, currency), portfolioTone(item.unrealized))}${metric('Realized P/L', portfolioSignedMoney(item.realized_pnl, currency), portfolioTone(item.realized_pnl))}${metric('ROI', item.roi === null ? '—' : `${item.roi >= 0 ? '+' : ''}${item.roi.toFixed(2)}%`, portfolioTone(item.roi))}</div>`;
            document.getElementById('holding-detail-performance').innerHTML = `<div class="holding-detail-grid">${metric('Today’s P/L', portfolioSignedMoney(item.dailyPnl, currency), portfolioTone(item.dailyPnl))}${metric('Today’s %', item.dailyPercent === null ? '—' : `${item.dailyPercent >= 0 ? '+' : ''}${item.dailyPercent.toFixed(2)}%`, portfolioTone(item.dailyPercent))}${metric('Total P/L', portfolioSignedMoney(item.totalPnl, currency), portfolioTone(item.totalPnl))}</div>`;
            const transaction = trade => `<tr><td>${escapeHtml(trade.traded_at)}</td><td style="color:${trade.side === 'BUY' ? 'var(--green)' : 'var(--red)'}; font-weight:700;">${trade.side}</td><td>${Number(trade.shares).toLocaleString()}</td><td>${portfolioMoney(trade.price, currency)}</td><td>${escapeHtml(trade.notes || '—')}</td></tr>`;
            const history = [...(item.buy_history || []).map(trade => ({ ...trade, side: 'BUY' })), ...(item.sell_history || []).map(trade => ({ ...trade, side: 'SELL' }))].sort((a, b) => String(b.traded_at).localeCompare(String(a.traded_at)));
            document.getElementById('holding-detail-transactions').innerHTML = history.length ? `<div class="table-responsive"><table class="pos-table" aria-label="${escapeHtml(item.ticker)} transaction history"><caption class="sr-only">${escapeHtml(item.ticker)} transaction history</caption><thead><tr><th scope="col">Date</th><th scope="col">Side</th><th scope="col">Shares</th><th scope="col">Price</th><th scope="col">Notes</th></tr></thead><tbody>${history.map(transaction).join('')}</tbody></table></div>` : '<div class="portfolio-empty-state"><h4>No transactions yet</h4><p>Buy and sell activity will appear here.</p></div>';
            document.getElementById('holding-detail-notes').innerHTML = `<form onsubmit="saveHoldingNotes(event)" aria-label="Holding notes"><div class="portfolio-dialog-fields"><textarea id="holding-notes-input" maxlength="4000" rows="7" placeholder="Add notes about this holding" aria-label="Notes for ${escapeHtml(item.ticker)} holding">${escapeHtml(item.notes || '')}</textarea></div><p id="holding-notes-status" class="portfolio-module-note" role="status" aria-live="polite"></p><button class="btn-submit" type="submit">Save notes</button></form>`;
            selectHoldingDetailTab(holdingDetailTab, null);
        }

        function selectHoldingDetailTab(tab, button) {
            holdingDetailTab = tab;
            ['overview', 'performance', 'transactions', 'notes'].forEach(name => { const panel = document.getElementById(`holding-detail-${name}`); if (panel) panel.hidden = name !== tab; });
            document.querySelectorAll('[data-holding-tab]').forEach(element => { const active = element.dataset.holdingTab === tab; element.classList.toggle('is-active', active); element.setAttribute('aria-selected', String(active)); });
            if (button) button.focus({ preventScroll: true });
        }

        async function saveHoldingNotes(event) {
            event.preventDefault(); const holding = selectedHoldingDetail(); if (!holding) return;
            const status = document.getElementById('holding-notes-status'); const notes = document.getElementById('holding-notes-input').value;
            try {
                const response = await authFetch(`/api/portfolio/stocks/${holding.id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ notes }) });
                const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || 'Notes could not be saved.');
                const index = stockPortfolioItems.findIndex(item => Number(item.id) === Number(holding.id)); if (index >= 0) stockPortfolioItems[index] = data.holding;
                if (status) status.textContent = 'Notes saved.'; renderHoldingDetail();
            } catch (error) { if (status) status.textContent = error.message || 'Notes could not be saved.'; }
        }

        function openPortfolioDialog() {
            const dialog = document.getElementById('portfolio-dialog'); if (!dialog) return;
            if (!dialog.dataset.focusRestore) { dialog.dataset.focusRestore = 'true'; dialog.addEventListener('close', () => { portfolioDialogReturnFocus?.focus?.({ preventScroll: true }); portfolioDialogReturnFocus = null; }); }
            portfolioDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            portfolioDialogMode = 'create'; document.getElementById('portfolio-dialog-form').reset(); document.getElementById('portfolio-dialog-type').disabled = false; document.getElementById('portfolio-dialog-title').textContent = 'Create portfolio'; document.getElementById('portfolio-dialog-submit').textContent = 'Create'; document.getElementById('portfolio-dialog-archive').style.display = 'none'; document.getElementById('portfolio-dialog-currency').value = 'USD'; document.getElementById('portfolio-dialog-status').textContent = '';
            dialog.showModal(); document.getElementById('portfolio-dialog-name').focus();
        }
        function openPortfolioEditDialog() {
            const selected = portfolioSelectedItem(); if (!selected) { openPortfolioDialog(); return; }
            const dialog = document.getElementById('portfolio-dialog'); if (!dialog.dataset.focusRestore) { dialog.dataset.focusRestore = 'true'; dialog.addEventListener('close', () => { portfolioDialogReturnFocus?.focus?.({ preventScroll: true }); portfolioDialogReturnFocus = null; }); } portfolioDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; const presentation = portfolioPresentationFor(selected.id); portfolioDialogMode = 'edit';
            document.getElementById('portfolio-dialog-title').textContent = 'Manage portfolio'; document.getElementById('portfolio-dialog-submit').textContent = 'Save changes'; document.getElementById('portfolio-dialog-name').value = selected.name; document.getElementById('portfolio-dialog-currency').value = selected.currency || 'USD'; document.getElementById('portfolio-dialog-description').value = presentation.description || ''; document.getElementById('portfolio-dialog-icon').value = presentation.icon || '▣'; document.getElementById('portfolio-dialog-type').value = portfolioModuleView === 'options' ? 'options' : 'stocks'; document.getElementById('portfolio-dialog-type').disabled = true; document.getElementById('portfolio-dialog-archive').style.display = selected.is_default ? 'none' : ''; document.getElementById('portfolio-dialog-status').textContent = ''; dialog.showModal(); document.getElementById('portfolio-dialog-name').focus();
        }
        function closePortfolioDialog() {
            document.getElementById('portfolio-dialog-type').disabled = false;
            const dialog = document.getElementById('portfolio-dialog');
            // The one-time `close` listener restores focus. Restoring it here
            // as well caused the same focus transition to run twice.
            if (dialog?.open) dialog.close();
            else {
                portfolioDialogReturnFocus?.focus?.({ preventScroll: true });
                portfolioDialogReturnFocus = null;
            }
        }
        async function createPortfolioFromDialog(event) {
            event.preventDefault(); const name = document.getElementById('portfolio-dialog-name').value.trim(); const currency = document.getElementById('portfolio-dialog-currency').value.trim().toUpperCase(); const type = document.getElementById('portfolio-dialog-type').value; const status = document.getElementById('portfolio-dialog-status');
            if (!name || !/^[A-Z]{3}$/.test(currency)) { status.textContent = 'Enter a portfolio name and a three-letter currency.'; return; }
            if (portfolioDialogSaving) return;
            const submit = document.getElementById('portfolio-dialog-submit');
            portfolioDialogSaving = true;
            setTerminalButtonBusy(submit, true, 'Saving…');
            try {
                const isEdit = portfolioDialogMode === 'edit'; const selected = portfolioSelectedItem(); const response = await authFetch(isEdit ? `/api/portfolios/${selected.id}` : '/api/portfolios', { method: isEdit ? 'PATCH' : 'POST', headers: authHeaders(true), body: JSON.stringify({ name, currency }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || 'Portfolio could not be saved.');
                const portfolio = data.portfolio; const portfolioId = cloudWorkspaceId(portfolio && portfolio.id); savePortfolioPresentation(portfolioId, { icon: document.getElementById('portfolio-dialog-icon').value, description: document.getElementById('portfolio-dialog-description').value.trim() }); cloudWorkspace.selectedPortfolioId = portfolioId; document.getElementById('portfolio-dialog-type').disabled = false; closePortfolioDialog(); await loadCloudWorkspace(); await loadPortfolioModuleData(); selectPortfolioModuleView(type, null);
                showTerminalToast(isEdit ? 'Portfolio changes saved.' : 'Portfolio created.');
            } catch (error) {
                status.textContent = error.message || 'Portfolio could not be created.';
                showTerminalToast(error.message || 'Portfolio could not be created.', 'error');
            } finally {
                portfolioDialogSaving = false;
                setTerminalButtonBusy(submit, false);
            }
        }
        async function archivePortfolioFromDialog() {
            const selected = portfolioSelectedItem(); if (!selected || selected.is_default || !window.confirm(`Archive “${selected.name}”? Holdings and history will remain available.`)) return;
            const status = document.getElementById('portfolio-dialog-status'); try { const response = await authFetch(`/api/portfolios/${selected.id}`, { method: 'DELETE', headers: authHeaders() }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || 'Portfolio could not be archived.'); closePortfolioDialog(); await loadCloudWorkspace(); await loadPortfolioModuleData(); } catch (error) { status.textContent = error.message || 'Portfolio could not be archived.'; }
        }

        function selectPortfolioModuleView(view, button, suppressRouteUpdate = false) {
            const valid = ['overview', 'stocks', 'options', 'holding']; if (!valid.includes(view)) return;
            portfolioModuleView = view;
            valid.forEach(name => { const section = document.getElementById(`portfolio-${name}-view`); if (section) section.hidden = name !== view; });
            document.querySelectorAll('[data-portfolio-view]').forEach(tab => { const active = tab.dataset.portfolioView === view; tab.classList.toggle('is-active', active); tab.setAttribute('aria-selected', String(active)); });
            if (button) button.focus({ preventScroll: true });
            if (!suppressRouteUpdate && view !== 'holding' && window.location.hash !== `#/portfolio/${view}`) window.location.hash = `#/portfolio/${view}`;
            if (view === 'holding') renderHoldingDetail(); else void loadPortfolioModuleData();
        }

        async function loadStockPortfolioSummary(portfolioId, force = false) {
            const id = cloudWorkspaceId(portfolioId);
            if (!id) return null;
            const cached = stockPortfolioSummaryCache.get(id);
            if (!force && cached?.data) return cached.data;
            if (cached?.promise) return cached.promise;
            const promise = (async () => {
                const response = await authFetch(`/api/portfolio/stocks/summary?portfolio_id=${encodeURIComponent(id)}`, { cache: 'no-store' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.detail || 'Stock portfolio summary is unavailable.');
                const summary = Array.isArray(data.items) ? data.items[0] : null;
                stockPortfolioSummaryCache.set(id, { data: summary, promise: null });
                portfolioOverviewItems = [...stockPortfolioSummaryCache.values()].map(entry => entry.data).filter(Boolean);
                return summary;
            })();
            stockPortfolioSummaryCache.set(id, { data: cached?.data || null, promise });
            try { return await promise; } finally {
                const entry = stockPortfolioSummaryCache.get(id);
                if (entry?.promise === promise) entry.promise = null;
            }
        }

        async function loadStockHoldingsPage(portfolioId, force = false) {
            const id = cloudWorkspaceId(portfolioId);
            if (!id) return null;
            let cache = stockPortfolioHoldingCache.get(id);
            if (force || !cache) {
                cache = { items: [], nextOffset: 0, hasMore: true, total: 0, promise: null };
                stockPortfolioHoldingCache.set(id, cache);
            }
            if (cache.promise || !cache.hasMore) return cache.promise || cache;
            const offset = cache.nextOffset;
            const promise = (async () => {
                const response = await authFetch(`/api/portfolio/stocks?portfolio_id=${encodeURIComponent(id)}&include_closed=true&offset=${offset}&limit=${STOCK_HOLDINGS_PAGE_SIZE}`, { cache: 'no-store' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.detail || 'Stock holdings are unavailable.');
                const incoming = Array.isArray(data.items) ? data.items : [];
                const existingIds = new Set(cache.items.map(item => Number(item.id)));
                cache.items.push(...incoming.filter(item => !existingIds.has(Number(item.id))));
                cache.nextOffset = data.next_offset;
                cache.hasMore = Boolean(data.has_more);
                cache.total = Number(stockPortfolioSummaryCache.get(id)?.data?.holding_count || cache.items.length);
                stockPortfolioItems = cache.items;
                return cache;
            })();
            cache.promise = promise;
            try { return await promise; } finally { if (cache.promise === promise) cache.promise = null; }
        }

        function invalidateStockPortfolio(portfolioId) {
            const id = cloudWorkspaceId(portfolioId);
            if (!id) return;
            stockPortfolioSummaryCache.delete(id);
            stockPortfolioHoldingCache.delete(id);
            if (cloudWorkspaceId(portfolioSelectedItem()?.id) === id) stockPortfolioItems = [];
        }

        async function loadPortfolioModuleData() {
            ensurePortfolioCacheOwner();
            renderPortfolioOverview(); renderStockPortfolio();
            if (!cloudWorkspaceEnabled()) return;
            const task = (async () => {
                try {
                    if (!cloudWorkspace.loaded) await loadCloudWorkspace();
                    const selectedId = cloudWorkspaceId(portfolioSelectedItem()?.id);
                    if (portfolioModuleView === 'options') {
                        await fetchPortfolio();
                        renderPortfolioOverview();
                        return;
                    }
                    await loadStockPortfolioSummary(selectedId);
                    if (portfolioModuleView === 'stocks') await loadStockHoldingsPage(selectedId);
                    const cachedHoldings = stockPortfolioHoldingCache.get(selectedId);
                    stockPortfolioItems = cachedHoldings?.items || [];
                    renderPortfolioOverview(); renderStockPortfolio(); if (portfolioModuleView === 'holding') renderHoldingDetail();
                } catch (error) { if (!error || error.name !== 'AbortError') { const status = document.getElementById('stock-portfolio-status'); if (status) status.textContent = 'Portfolio data is temporarily unavailable.'; } }
            })();
            portfolioModuleLoadPromise = task; try { return await task; } finally { if (portfolioModuleLoadPromise === task) portfolioModuleLoadPromise = null; }
        }

        // --- 💼 Portfolio Engine Via API ---
        async function fetchPortfolio() {
            if (portfolioRefreshInFlight) return;
            const sessionEpoch = authSessionEpoch;
            if (authState.configured === true && !authState.authenticated) {
                activePositions = [];
                optionsPortfolioEngineLoaded = true;
                renderPortfolioTable();
                updateHomePortfolioSurface();
                return;
            }
            if (!cloudWorkspaceEnabled()) {
                // Use session-local state whenever cloud storage is disabled
                // or auth is unavailable; never call /api/positions then.
                activePositions = [...localPositions];
                optionsPortfolioEngineLoaded = true;
                renderPortfolioTable();
                updateHomePortfolioSurface();
                return;
            }
            portfolioRefreshInFlight = true;
            try {
                setPositionFormStatus('กำลังอัปเดตพอร์ต…');
                const res = await authFetch('/api/positions', { cache: 'no-store' });
                if (!res.ok) throw new Error(`Portfolio request failed: ${res.status}`);
                const positions = await res.json();
                if (sessionEpoch !== authSessionEpoch) return;
                activePositions = Array.isArray(positions) ? positions.filter(position => position && Number.isFinite(Number(position.id))) : [];
                optionsPortfolioEngineLoaded = true;
                renderPortfolioTable();
                updateHomePortfolioSurface();
                renderPortfolioOverview();
                setPositionFormStatus(activePositions.length ? '' : 'ยังไม่มีสัญญาที่ถืออยู่');
            } catch (err) {
                reportQuantoraError(err, { area: 'portfolio-load' });
                setPositionFormStatus('โหลดพอร์ตไม่สำเร็จ กรุณาลองใหม่', 'error');
            } finally {
                portfolioRefreshInFlight = false;
            }
        }

        function startPortfolioAutoRefresh() {
            if (portfolioRefreshTimer) clearInterval(portfolioRefreshTimer);
            portfolioRefreshTimer = window.setInterval(() => {
                if (!isPageVisible || !isNetworkOnline || portfolioModuleView !== 'options' || !activePositions.length) return;
                void fetchPortfolio();
            }, 5000);
        }

        function renderPortfolioTable() {
            const tbody = document.getElementById('portfolio-rows');
            const finiteNumber = value => {
                if (value === null || value === undefined || value === '') return null;
                const number = Number(value);
                return Number.isFinite(number) ? number : null;
            };
            const selectedId = cloudWorkspaceId(cloudWorkspace.selectedPortfolioId);
            const displayedPositions = cloudWorkspaceEnabled() && selectedId
                ? activePositions.filter(position => cloudWorkspaceId(position && position.portfolio_id) === selectedId)
                : activePositions;
            if (displayedPositions.length === 0) {
                tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">ยังไม่มีสัญญาที่ถืออยู่ — กรอกข้อมูลด้านบนเพื่อเปิดสัญญา</td></tr>`;
                return;
            }
            tbody.innerHTML = displayedPositions.map(p => {
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

                const nearMoney = currentUPrice !== null && Math.abs(Number(p.strike_price) - currentUPrice) / currentUPrice <= 0.02;
                const contractClass = `option-contract option-${String(p.option_type || '').toLowerCase()}${nearMoney ? ' option-near-money' : ''}${pnl !== null && pnl >= 0 ? ' option-profitable' : ''}`;
                return `
<tr class="${contractClass}">
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
<td style="white-space:nowrap;"><button style="background:transparent; color:var(--blue); border:1px solid var(--blue); padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer;" onclick="editPosition(${p.id})">แก้ไข</button> <button style="background:rgba(255,59,48,0.1); color:var(--red); border:1px solid var(--red); padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer;" onclick="closePosition(${p.id})">ปิดสัญญา</button></td>
</tr>
`}).join('');
        }

        let editingPositionId = null;

        function setPositionFormStatus(message = '', tone = '') {
            const status = document.getElementById('position-form-status');
            if (!status) return;
            status.textContent = message;
            status.style.color = tone === 'error' ? 'var(--red)' : tone === 'success' ? 'var(--green)' : 'var(--text-muted)';
        }

        function positionPayloadFromForm() {
            return {
                ticker: currentTicker,
                strike_price: Number(document.getElementById('form-strike').value),
                option_type: document.getElementById('form-type').value,
                expiration: document.getElementById('form-exp').value,
                premium_paid: Number(document.getElementById('form-premium').value),
                quantity: Number(document.getElementById('form-qty').value),
                iv: Number(document.getElementById('form-iv').value),
                delta: Number(document.getElementById('form-delta').value),
            };
        }

        function validatePositionPayload(payload) {
            if (!(payload.strike_price > 0)) return 'กรุณาระบุราคาใช้สิทธิที่มากกว่า 0';
            if (!payload.expiration || new Date(`${payload.expiration}T00:00:00`) < new Date(new Date().toDateString())) return 'กรุณาระบุวันหมดอายุที่ไม่ใช่วันย้อนหลัง';
            if (!(payload.premium_paid > 0)) return 'ค่า Premium ต้องมากกว่า 0';
            if (!Number.isInteger(payload.quantity) || payload.quantity < 1) return 'จำนวนสัญญาต้องเป็นจำนวนเต็มมากกว่า 0';
            if (!(payload.iv > 0)) return 'ค่า IV ต้องมากกว่า 0';
            if (!(payload.delta >= -1 && payload.delta <= 1)) return 'ค่า Delta ต้องอยู่ระหว่าง -1 และ 1';
            return '';
        }

        function positionErrorMessage(message) {
            const raw = String(message || 'ไม่สามารถบันทึกสัญญาได้');
            if (/strike_price|strike|greater than 0/i.test(raw)) return 'ราคาใช้สิทธิต้องมากกว่า 0';
            if (/expiration|past/i.test(raw)) return 'กรุณาระบุวันหมดอายุที่ถูกต้องและไม่ใช่วันย้อนหลัง';
            if (/premium/i.test(raw)) return 'ค่า Premium ต้องมากกว่า 0';
            if (/quantity/i.test(raw)) return 'จำนวนสัญญาต้องมากกว่า 0';
            if (/delta/i.test(raw)) return 'ค่า Delta ต้องอยู่ระหว่าง -1 และ 1';
            if (/iv/i.test(raw)) return 'ค่า IV ต้องมากกว่า 0';
            return raw;
        }

        function updatePortfolioState(position) {
            if (!position || !Number.isFinite(Number(position.id))) return;
            const index = activePositions.findIndex(item => Number(item && item.id) === Number(position.id));
            if (index >= 0) activePositions.splice(index, 1, position);
            else activePositions.unshift(position);
            renderPortfolioTable();
            updateHomePortfolioSurface();
        }

        async function submitPosition(e) {
            e.preventDefault();
            if (authState.configured === true && !authState.authenticated) {
                openProfileSheet();
                setAuthStatus('Sign in before changing a cloud portfolio.', 'error');
                return;
            }
            const payload = positionPayloadFromForm();
            const validationMessage = validatePositionPayload(payload);
            if (validationMessage) { setPositionFormStatus(validationMessage, 'error'); return; }
            if (!cloudWorkspaceEnabled()) {
                const saved = {
                    ...payload,
                    id: editingPositionId || Date.now(),
                    entry_underlying_price: Number(currentLivePrice) || 0,
                    current_underlying_price: Number(currentLivePrice) || null,
                    pnl: 0,
                    pnl_percent: 0,
                };
                localPositions = editingPositionId
                    ? localPositions.map(position => Number(position.id) === Number(editingPositionId) ? saved : position)
                    : [saved, ...localPositions];
                updatePortfolioState(saved);
                const wasEditing = Boolean(editingPositionId);
                if (submit) delete submit.dataset.defaultLabel;
                cancelPositionEdit();
                setPositionFormStatus(wasEditing ? 'Saved on this device for this session.' : 'Position saved on this device for this session.', 'success');
                return;
            }
            const portfolioId = cloudWorkspaceId(document.getElementById('form-portfolio-id')?.value);
            if (!editingPositionId && cloudWorkspaceEnabled() && portfolioId) payload.portfolio_id = portfolioId;
            const submit = document.querySelector('#pos-form .btn-submit');
            setTerminalButtonBusy(submit, true, editingPositionId ? 'Saving…' : 'Opening…');
            setPositionFormStatus(editingPositionId ? 'กำลังบันทึกการแก้ไข…' : 'กำลังเปิดสัญญา…');
            try {
                const url = editingPositionId ? `/api/positions/${editingPositionId}` : '/api/positions';
                const requestPayload = editingPositionId ? (({ ticker, portfolio_id, ...editable }) => editable)(payload) : payload;
                const res = await authFetch(url, { method: editingPositionId ? 'PATCH' : 'POST', headers: authHeaders(true), body: JSON.stringify(requestPayload) });
                const saved = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(positionErrorMessage(saved.detail));
                updatePortfolioState(saved);
                const wasEditing = Boolean(editingPositionId);
                cancelPositionEdit();
                setPositionFormStatus(wasEditing ? 'บันทึกการแก้ไขแล้ว' : 'เปิดสัญญาและอัปเดตพอร์ตแล้ว', 'success');
                showTerminalToast(wasEditing ? 'Position changes saved.' : 'Option position opened.');
                await fetchPortfolio();
            } catch (error) {
                reportQuantoraError(error, { area: 'position-save' });
                setPositionFormStatus(error.message || 'ไม่สามารถบันทึกสัญญาได้', 'error');
                showTerminalToast(error.message || 'Position could not be saved.', 'error');
            } finally {
                setTerminalButtonBusy(submit, false);
            }
        }

        function editPosition(id) {
            const position = activePositions.find(item => Number(item && item.id) === Number(id));
            if (!position) return;
            editingPositionId = Number(id);
            document.getElementById('form-strike').value = position.strike_price;
            document.getElementById('form-type').value = position.option_type;
            document.getElementById('form-exp').value = position.expiration;
            document.getElementById('form-premium').value = position.premium_paid;
            document.getElementById('form-qty').value = position.quantity;
            document.getElementById('form-iv').value = position.iv;
            document.getElementById('form-delta').value = position.delta;
            document.querySelector('#pos-form .btn-submit').textContent = 'บันทึกการแก้ไข';
            document.getElementById('position-cancel-edit').style.display = '';
            setPositionFormStatus(`กำลังแก้ไขสัญญา ${position.ticker}`);
            document.getElementById('form-strike').focus();
        }

        function cancelPositionEdit() {
            editingPositionId = null;
            document.getElementById('pos-form').reset();
            updatePositionPortfolioSelector();
            const submit = document.querySelector('#pos-form .btn-submit');
            if (submit) submit.textContent = 'เปิดสัญญา';
            const cancel = document.getElementById('position-cancel-edit');
            if (cancel) cancel.style.display = 'none';
        }

        async function closePosition(id) {
            if (closingPositionIds.has(id)) return;
            if (authState.configured === true && !authState.authenticated) {
                openProfileSheet();
                setAuthStatus('Sign in before changing a cloud portfolio.', 'error');
                return;
            }
            if (!cloudWorkspaceEnabled()) {
                closingPositionIds.add(id);
                localPositions = localPositions.filter(position => Number(position.id) !== Number(id));
                activePositions = activePositions.filter(position => Number(position.id) !== Number(id));
                renderPortfolioTable();
                updateHomePortfolioSurface();
                setPositionFormStatus('Position removed from this device.', 'success');
                showTerminalToast('Position removed from this device.');
                closingPositionIds.delete(id);
                return;
            }
            closingPositionIds.add(id);
            try {
                const res = await authFetch(`/api/positions/${id}`, { method: 'DELETE', headers: authHeaders() });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(result.detail || 'ไม่สามารถปิดสัญญาได้');
                activePositions = activePositions.filter(item => Number(item && item.id) !== Number(id));
                renderPortfolioTable();
                updateHomePortfolioSurface();
                setPositionFormStatus('ปิดสัญญาและอัปเดตพอร์ตแล้ว', 'success');
                showTerminalToast('Option position closed.');
                await fetchPortfolio();
            } catch (error) {
                reportQuantoraError(error, { area: 'position-close' });
                setPositionFormStatus(error.message || 'ไม่สามารถปิดสัญญาได้', 'error');
                showTerminalToast(error.message || 'Position could not be closed.', 'error');
            } finally {
                closingPositionIds.delete(id);
            }
        }

        // --- ⚡ Real-Time WebSocket Connection ---
