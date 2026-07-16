        function updateHomeWatchlistSurface() {
            const el = document.getElementById('home-watchlist-count');
            if (el) el.textContent = Array.isArray(watchlist) ? String(watchlist.length) : '0';
        }

        let lastHomePortfolioPnl = null;

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
                if (lastHomePortfolioPnl !== null && pnl !== lastHomePortfolioPnl) pulseTerminalElement(pnlEl, 'summary-animate');
            }
            if (noteEl) {
                noteEl.textContent = positions.length ? `${positions.length} open option position${positions.length === 1 ? '' : 's'}` : 'No open positions';
                noteEl.classList.toggle('positive', pnl > 0);
            }
            if (countEl) countEl.textContent = String(positions.length);
            const totalPremium = positions.reduce((sum, position) => {
                const premium = Number(position.premium_paid);
                const quantity = Number(position.quantity);
                return sum + (Number.isFinite(premium) && Number.isFinite(quantity) ? premium * quantity * 100 : 0);
            }, 0);
            const totalValue = totalPremium + pnl;
            const roi = totalPremium > 0 ? (pnl / totalPremium) * 100 : 0;
            const winners = positions.filter(position => Number(position.pnl) > 0).length;
            const summary = document.getElementById('portfolio-summary');
            if (summary) {
                const metrics = [
                    ['มูลค่ารวม', `$${totalValue.toFixed(2)}`],
                    ['สัญญาที่ถืออยู่', String(positions.length)],
                    ['Premium รวม', `$${totalPremium.toFixed(2)}`],
                    ['กำไร / ขาดทุนรวม', `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`],
                    ['กำไร / ขาดทุนวันนี้', `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`],
                    ['ROI', `${roi.toFixed(2)}%`],
                    ['อัตราการชนะ', positions.length ? `${((winners / positions.length) * 100).toFixed(0)}%` : '—'],
                ];
                summary.innerHTML = metrics.map(([label, value]) => `<div class="stat-box"><span>${label}</span><strong>${value}</strong></div>`).join('');
                if (lastHomePortfolioPnl !== null && pnl !== lastHomePortfolioPnl) pulseTerminalElement(summary, 'summary-animate');
            }
            lastHomePortfolioPnl = pnl;
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
            const quoteDirection = stats.quote_direction === 'up' || stats.quote_direction === 'down' ? stats.quote_direction : '';
            const sessionNames = { REGULAR: 'Market open', PRE: 'Pre-market', POST: 'After-hours', CLOSED: 'Market closed', LOADING: 'Loading' };
            const shortSessionNames = { REGULAR: 'Open', PRE: 'Pre', POST: 'Post', CLOSED: 'Closed', LOADING: 'Loading' };
            const symbolEl = document.getElementById('home-live-symbol');
            const priceEl = document.getElementById('home-live-price');
            const changeEl = document.getElementById('home-live-change');
            const sessionEl = document.getElementById('home-market-session');
            const labelEl = document.getElementById('home-session-label');

            if (symbolEl) symbolEl.textContent = currentTicker || '—';
            if (priceEl) {
                priceEl.textContent = Number.isFinite(price) ? `$${price.toFixed(2)}` : '—';
                if (quoteDirection) {
                    priceEl.removeAttribute('data-quote-direction');
                    requestAnimationFrame(() => { if (priceEl.isConnected) priceEl.dataset.quoteDirection = quoteDirection; });
                }
            }
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

        async function loadHomeAiRecommendation(ticker = currentTicker) {
            const signalEl = document.getElementById('home-ai-signal');
            const detailEl = document.getElementById('home-ai-detail');
            if (!signalEl || !detailEl) return;
            signalEl.textContent = 'Loading…';
            signalEl.style.color = 'var(--pt-white)';
            try {
                const response = await fetch(`/api/ai-recommendation?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' });
                if (!response.ok) throw new Error('AI score unavailable');
                const data = await response.json();
                if (ticker !== currentTicker) return;
                const signal = String(data.signal || 'Neutral');
                signalEl.textContent = `${signal} · ${Number(data.confidence_score || 0).toFixed(0)}/100`;
                signalEl.style.color = signal === 'Bullish' ? 'var(--green)' : signal === 'Bearish' ? 'var(--red)' : 'var(--gold)';
                detailEl.textContent = `${data.ticker || ticker}: ${Number(data.bullish_probability || 0).toFixed(0)}% bull · ${Number(data.bearish_probability || 0).toFixed(0)}% bear`;
            } catch (_) {
                if (ticker === currentTicker) {
                    signalEl.textContent = 'Unavailable';
                    detailEl.textContent = 'AI signal will return when market data is available.';
                }
            }
        }

        async function renderTrendingIndustries() {
            const host = document.getElementById('trending-industries-list');
            if (!host) return;
            host.replaceChildren();
            TRENDING_INDUSTRIES.forEach(industry => {
                const card = document.createElement('div');
                card.className = 'pt-industry-card pt-skeleton';
                card.setAttribute('aria-busy', 'true');
                host.appendChild(card);
            });
            try {
                const response = await fetch('/api/industry-trends', { cache: 'no-store' });
                if (!response.ok) throw new Error('Industry activity is unavailable.');
                const data = await response.json();
                const industries = Array.isArray(data.items) ? data.items : [];
                host.replaceChildren();
                industrySnapshots.clear();
                industries.forEach(industry => {
                    const performance = Number(industry.performance_pct);
                    const hasPerformance = Number.isFinite(performance);
                    industrySnapshots.set(industry.name, { ...industry, performance });
                    const card = document.createElement('button');
                    card.type = 'button';
                    card.className = 'pt-industry-card';
                    card.title = `Open ${industry.name} category`;
                    const performanceText = hasPerformance ? `${performance >= 0 ? '+' : ''}${performance.toFixed(2)}%` : '—';
                    const momentum = String(industry.momentum || 'Neutral');
                    const relativeVolume = Number(industry.relative_volume);
                    const volumeText = Number.isFinite(relativeVolume) ? `Vol ${relativeVolume.toFixed(1)}x` : 'Vol —';
                    card.innerHTML = `<span class="pt-industry-name">${escapeHtml(industry.name)}</span><span class="pt-industry-performance ${performance > 0 ? 'positive' : performance < 0 ? 'negative' : ''}">${performanceText}</span><span class="pt-industry-detail">${Number(industry.stock_count || 0)} stocks · ${escapeHtml(momentum)} · ${volumeText}</span>`;
                    card.addEventListener('click', () => { void selectCategoryRail(industry.category || industry.name); navigateTerminal('home'); });
                    host.appendChild(card);
                });
                renderIndustryMovers();
            } catch (error) {
                host.replaceChildren();
                const message = document.createElement('p');
                message.className = 'pt-category-message error';
                message.textContent = error.message || 'Unable to rank industry activity right now.';
                host.appendChild(message);
            }
        }

        function renderIndustryMovers() {
            const host = document.getElementById('industry-movers');
            if (!host) return;
            const snapshots = Array.from(industrySnapshots.values()).filter(item => Number.isFinite(item.performance));
            if (!snapshots.length) return;
            host.replaceChildren();
            const makeColumn = (title, items, tone) => {
                const column = document.createElement('div');
                const heading = document.createElement('h4');
                heading.textContent = title;
                column.appendChild(heading);
                items.forEach(item => {
                    const row = document.createElement('div');
                    row.className = 'pt-mover';
                    row.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span class="${tone}">${item.performance >= 0 ? '+' : ''}${item.performance.toFixed(2)}%</span>`;
                    column.appendChild(row);
                });
                return column;
            };
            const ordered = [...snapshots].sort((a, b) => b.performance - a.performance);
            host.append(makeColumn('Top gainers', ordered.slice(0, 3), 'positive'), makeColumn('Top losers', ordered.slice(-3).reverse(), 'negative'));
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
            instruments.slice(0, 8).forEach(instrument => {
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
                const priceEl = document.createElement('span');
                priceEl.className = 'pt-category-price';
                priceEl.textContent = 'Loading price…';
                const srEl = document.createElement('span');
                srEl.className = 'pt-category-sr';
                srEl.textContent = 'Weekly S/R loading…';
                button.append(symbolEl, priceEl, srEl, nameEl);
                button.addEventListener('click', () => switchStock(symbol));
                host.appendChild(button);
                void hydrateCategoryInstrument(symbol, priceEl, srEl);
            });
            if (!host.childElementCount) setCategoryRailMessage('No valid symbols are available for this category.');
        }

        async function hydrateCategoryInstrument(symbol, priceEl, srEl) {
            try {
                const [statsResponse, levelsResponse] = await Promise.all([
                    fetch(`/api/stats?ticker=${encodeURIComponent(symbol)}`, { cache: 'no-store' }),
                    fetch(`/api/indicators?ticker=${encodeURIComponent(symbol)}&timeframe=week`, { cache: 'no-store' }),
                ]);
                if (!statsResponse.ok || !levelsResponse.ok) throw new Error('instrument data unavailable');
                const stats = await statsResponse.json();
                const levels = await levelsResponse.json();
                const price = Number(stats.current_price);
                const previous = Number(stats.prev_close);
                const change = previous > 0 && Number.isFinite(price) ? ((price - previous) / previous) * 100 : NaN;
                priceEl.textContent = `${Number.isFinite(price) ? `$${price.toFixed(2)}` : '—'} ${Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : ''}`;
                priceEl.style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
                const closest = levels && levels.closest_alert;
                srEl.textContent = closest && closest.label ? `Near ${closest.label} (Week)` : 'Weekly S/R unavailable';
            } catch (_) {
                priceEl.textContent = 'Price unavailable';
                srEl.textContent = 'Weekly S/R unavailable';
            }
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

        // --- Production search ------------------------------------------------
        // The API cache below the normal fetch call provides persistent SWR
        // caching. This small query cache paints matching results immediately
        // while the API cache/network request resolves in the background.
        const SEARCH_DEBOUNCE_MS = 300;
        const SEARCH_PAGE_SIZE = 20;
        const SEARCH_ROW_HEIGHT = 56;
        const SEARCH_OVERSCAN = 5;
        const searchQueryCache = new Map();
        let searchRequestVersion = 0;
        let searchActivityLoaded = false;
        let searchActivityLoading = null;
        let searchActivityScope = '';
        let searchHistoryItems = [];
        let recentViewedSearchItems = [];
        let trendingSearchItems = [];
        let searchAnalytics = null;
        const LOCAL_SAVED_SEARCHES_KEY = 'quantora.saved-searches.v1';
        const SEARCH_ALIASES = Object.freeze({ GOOG: 'GOOGL', FB: 'META', GOOGLE: 'GOOGL', FACEBOOK: 'META', SP500: 'SPY', NASDAQ100: 'QQQ' });
        const SEARCH_SOURCE_PRIORITY = Object.freeze({ Pinned: 0, Favorite: 1, Watchlist: 2, 'Recently viewed': 3, 'Recent search': 4, Trending: 5, Popular: 6, Option: 7, Saved: 8, Filter: 9, Suggestion: 10 });
        const FILTER_AUTOCOMPLETE = Object.freeze({
            sector: ['technology', 'financials', 'healthcare', 'materials', 'utilities'],
            industry: ['semiconductor', 'biotech', 'energy', 'dividend', 'growth'],
            exchange: ['nasdaq', 'nyse', 'nyse arca'], country: ['us'],
            marketcap: ['>10B', '>100B'], price: ['<100', '>100'], pe: ['<20', '<30'], dividend: ['>2', '>4'],
        });
        const POPULAR_SEARCHES = Object.freeze([
            { symbol: 'NVDA', name: 'NVIDIA Corporation' }, { symbol: 'AAPL', name: 'Apple Inc.' },
            { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust' }, { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
        ]);
        const searchLatencyMetrics = { requests: 0, cacheRenders: 0, under100ms: 0, totalMs: 0, lastMs: 0 };
        let savedSearches = [];
        const searchState = {
            query: '', results: [], selectedIndex: -1, visibleCount: SEARCH_PAGE_SIZE,
            scrollTop: 0, loading: false, error: '', open: false,
        };
        let searchScrollRenderFrame = null;

        function normalizedSearchText(value) {
            return String(value || '').toUpperCase().trim();
        }

        function comparableSearchText(value) {
            return normalizedSearchText(value).replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
        }

        function validSearchTicker(value) {
            return /^[A-Z0-9.-]{1,12}$/.test(normalizedSearchText(value));
        }

        function loadSavedSearches() {
            try {
                const saved = JSON.parse(window.localStorage.getItem(LOCAL_SAVED_SEARCHES_KEY) || '[]');
                savedSearches = Array.isArray(saved)
                    ? saved.map(item => String(item && item.query || '').trim()).filter(Boolean).slice(0, 12)
                    : [];
            } catch (_) { savedSearches = []; }
        }

        function saveCurrentSearch(query) {
            const normalized = String(query || '').trim();
            if (!normalized) return;
            savedSearches = [normalized, ...savedSearches.filter(item => item !== normalized)].slice(0, 12);
            try { window.localStorage.setItem(LOCAL_SAVED_SEARCHES_KEY, JSON.stringify(savedSearches.map(item => ({ query: item })))); }
            catch (error) { reportQuantoraError(error, { area: 'search-storage' }); }
        }

        function recordSearchLatency(duration, cachedRender = false) {
            const elapsed = Math.max(0, Number(duration) || 0);
            searchLatencyMetrics.requests += 1;
            searchLatencyMetrics.totalMs += elapsed;
            searchLatencyMetrics.lastMs = elapsed;
            if (cachedRender) searchLatencyMetrics.cacheRenders += 1;
            if (elapsed < 100) searchLatencyMetrics.under100ms += 1;
            window.quantoraSearchMetrics = { ...searchLatencyMetrics, averageMs: searchLatencyMetrics.totalMs / searchLatencyMetrics.requests };
        }

        loadSavedSearches();

        function searchResultType(item) {
            const category = String(item.category || '').toUpperCase();
            if (category === 'ETF') return 'ETF';
            if (category === 'INDEX') return 'Index';
            return 'Stock';
        }

        function searchRank(item, query) {
            const symbol = normalizedSearchText(item.symbol);
            const name = comparableSearchText(item.name);
            const comparableQuery = comparableSearchText(query);
            if (!query) return 9;
            if (symbol === query) return 0;
            if (SEARCH_ALIASES[query] === symbol) return 0;
            if (name === comparableQuery) return 1;
            if (symbol.startsWith(query) || name.startsWith(comparableQuery)) return 2;
            if (symbol.includes(query) || name.includes(comparableQuery)) return 3;
            return 4;
        }

        function searchMatches(item, query) {
            if (!query) return true;
            const comparableQuery = comparableSearchText(query);
            return normalizedSearchText(item.symbol).includes(query)
                || Boolean(comparableQuery && comparableSearchText(item.name).includes(comparableQuery));
        }

        function searchSourceEntries() {
            const entries = [];
            const add = (ticker, source, name = '', metadata = {}) => {
                const symbol = normalizedSearchText(ticker);
                if (!validSearchTicker(symbol)) return;
                const { symbol: _symbol, ticker: _ticker, name: _name, source: _source, ...details } = metadata || {};
                entries.push({ symbol, name, source, ...details });
            };
            (favoriteTickers instanceof Set ? Array.from(favoriteTickers) : []).forEach(ticker => {
                // Favorites are the existing durable user-owned pin mechanism.
                add(ticker, 'Pinned');
                add(ticker, 'Favorite');
            });
            (Array.isArray(watchlist) ? watchlist : []).forEach(ticker => add(ticker, 'Watchlist'));
            (Array.isArray(cloudWorkspace && cloudWorkspace.watchlists) ? cloudWorkspace.watchlists : []).forEach(list => {
                (Array.isArray(list && list.items) ? list.items : []).forEach(item => add(item && item.ticker, 'Watchlist'));
            });
            (Array.isArray(activePositions) ? activePositions : []).forEach(position => add(position && position.ticker, 'Option'));
            searchHistoryItems.forEach(item => add(item && item.ticker, 'Recent search', item && item.query));
            recentViewedSearchItems.forEach(item => add(item && item.ticker, 'Recently viewed'));
            (Array.isArray(sessionRecentViewed) ? sessionRecentViewed : []).forEach(item => add(item && item.ticker, 'Recently viewed'));
            trendingSearchItems.forEach(item => add(item && (item.symbol || item.ticker), 'Trending', item && item.name, item || {}));
            return entries;
        }

        function sourcePriority(sources) {
            return sources.reduce((priority, source) => Math.min(priority, SEARCH_SOURCE_PRIORITY[source] ?? 6), 6);
        }

        function currentSearchActivityScope() {
            const user = authState && authState.authenticated && authState.user;
            return user ? `user:${String(user.id || user.email || '')}` : 'guest';
        }

        function resetSearchActivityForScope() {
            const scope = currentSearchActivityScope();
            if (scope === searchActivityScope) return;
            if (searchActivityAbortController && !searchActivityAbortController.signal.aborted) searchActivityAbortController.abort();
            searchActivityScope = scope;
            searchActivityLoaded = false;
            searchActivityLoading = null;
            searchHistoryItems = [];
            recentViewedSearchItems = [];
            trendingSearchItems = [];
            searchAnalytics = null;
        }

        function rememberSearchHistory(ticker, query = ticker) {
            resetSearchActivityForScope();
            const symbol = normalizedSearchText(ticker);
            if (!validSearchTicker(symbol)) return;
            const entry = { ticker: symbol, query: String(query || symbol) };
            searchHistoryItems = [entry, ...searchHistoryItems.filter(item => normalizedSearchText(item && item.ticker) !== symbol)].slice(0, 20);
        }

        function mergeSearchResults(catalogItems, query) {
            const bySymbol = new Map();
            const add = (item, source, trustedCatalogResult = false, catalogRank = Number.MAX_SAFE_INTEGER) => {
                const symbol = normalizedSearchText(item && item.symbol);
                const existing = bySymbol.get(symbol);
                if (existing) {
                    if (item.name && !existing.name) existing.name = String(item.name);
                    if (item.category && !existing.category) existing.category = String(item.category);
                    existing.catalogRank = Math.min(existing.catalogRank, catalogRank);
                    existing.sources.add(source);
                    return;
                }
                if (!validSearchTicker(symbol) || (!trustedCatalogResult && !searchMatches(item, query))) return;
                bySymbol.set(symbol, {
                    symbol,
                    name: String(item.name || ''),
                    category: String(item.category || ''),
                    sector: String(item.sector || ''),
                    country: String(item.country || ''),
                    exchange: String(item.exchange || ''),
                    catalogRank,
                    sources: new Set([source]),
                });
            };
            (Array.isArray(catalogItems) ? catalogItems : []).forEach((item, index) => add(item, searchResultType(item), true, index));
            searchSourceEntries().forEach(item => add(item, item.source));
            return Array.from(bySymbol.values())
                .map(item => ({ ...item, sources: Array.from(item.sources).sort((left, right) => (SEARCH_SOURCE_PRIORITY[left] ?? 6) - (SEARCH_SOURCE_PRIORITY[right] ?? 6)) }))
                .sort((left, right) => searchRank(left, query) - searchRank(right, query)
                    || sourcePriority(left.sources) - sourcePriority(right.sources)
                    || left.catalogRank - right.catalogRank
                    || left.symbol.localeCompare(right.symbol) || left.name.localeCompare(right.name));
        }

        function filterAutocompleteResults(query) {
            const match = String(query || '').trim().match(/(?:^|\s)([a-z]+)(?::([^\s]*))?$/i);
            if (!match) return [];
            const key = match[1].toLowerCase();
            const hasSeparator = query.includes(':');
            const value = String(match[2] || '').toLowerCase();
            const keys = Object.keys(FILTER_AUTOCOMPLETE);
            if (!hasSeparator && !keys.some(item => item.startsWith(key))) return [];
            if (!hasSeparator) {
                return keys.filter(item => item.startsWith(key)).map(item => ({
                    kind: 'query', symbol: `${item}:`, name: `Filter by ${item}`, query: `${item}:`, sources: ['Filter'], catalogRank: -1,
                }));
            }
            if (!Object.prototype.hasOwnProperty.call(FILTER_AUTOCOMPLETE, key)) return [];
            const prefix = String(query).replace(/(?:^|\s)[^\s]*$/, '');
            return FILTER_AUTOCOMPLETE[key].filter(item => item.toLowerCase().startsWith(value)).map(item => ({
                kind: 'query', symbol: `${key}:${item}`, name: `Filter by ${key}`, query: `${prefix}${key}:${item}`, sources: ['Filter'], catalogRank: -1,
            }));
        }

        function savedSearchResults() {
            return savedSearches.filter(query => !validSearchTicker(query)).map(query => ({
                kind: 'query', symbol: query, name: 'Saved search', query, sources: ['Saved'], catalogRank: -1,
            }));
        }

        function zeroResultSuggestions() {
            const candidates = trendingSearchItems.length ? trendingSearchItems : POPULAR_SEARCHES;
            return candidates.slice(0, 4).map(item => ({
                symbol: normalizedSearchText(item.symbol || item.ticker), name: String(item.name || 'Popular instrument'),
                category: String(item.category || ''), sources: ['Suggestion'], catalogRank: Number.MAX_SAFE_INTEGER,
            })).filter(item => validSearchTicker(item.symbol));
        }

        function composeSearchResults(catalogItems, query) {
            const merged = mergeSearchResults(catalogItems, query);
            const filters = filterAutocompleteResults(query);
            if (!query) return [...savedSearchResults(), ...mergeSearchResults(POPULAR_SEARCHES, '')];
            return merged.length ? [...filters, ...merged] : [...filters, ...zeroResultSuggestions()];
        }

        function hideSearchResults() {
            if (searchScrollRenderFrame !== null) {
                window.cancelAnimationFrame(searchScrollRenderFrame);
                searchScrollRenderFrame = null;
            }
            searchState.open = false;
            searchState.selectedIndex = -1;
            autocompleteList.style.display = 'none';
            searchInput.setAttribute('aria-expanded', 'false');
            searchInput.removeAttribute('aria-activedescendant');
        }

        function showSearchResults() {
            searchState.open = true;
            autocompleteList.style.display = 'block';
            searchInput.setAttribute('aria-expanded', 'true');
        }

        function appendSearchHighlight(target, value, query) {
            const text = String(value || '');
            const index = query ? text.toUpperCase().indexOf(query) : -1;
            if (index < 0) { target.textContent = text; return; }
            target.append(document.createTextNode(text.slice(0, index)));
            const match = document.createElement('mark');
            match.textContent = text.slice(index, index + query.length);
            target.append(match, document.createTextNode(text.slice(index + query.length)));
        }

        function ensureSelectedSearchResultVisible() {
            if (searchState.selectedIndex < 0) return;
            if (searchState.selectedIndex >= searchState.visibleCount) {
                searchState.visibleCount = Math.min(searchState.results.length, searchState.selectedIndex + 1);
            }
            const top = searchState.selectedIndex * SEARCH_ROW_HEIGHT;
            const bottom = top + SEARCH_ROW_HEIGHT;
            const viewportBottom = autocompleteList.scrollTop + autocompleteList.clientHeight;
            if (top < autocompleteList.scrollTop) autocompleteList.scrollTop = top;
            if (bottom > viewportBottom) autocompleteList.scrollTop = bottom - autocompleteList.clientHeight;
            searchState.scrollTop = autocompleteList.scrollTop;
        }

        function renderSearchResults({ preserveScroll = true } = {}) {
            const previousScrollTop = preserveScroll ? searchState.scrollTop : 0;
            autocompleteList.replaceChildren();
            if (searchState.loading && !searchState.results.length) {
                const state = document.createElement('div');
                state.className = 'search-result-state';
                state.textContent = 'Searching…';
                autocompleteList.appendChild(state);
                showSearchResults();
                return;
            }
            if (searchState.error && !searchState.results.length) {
                const state = document.createElement('div');
                state.className = 'search-result-state is-error';
                state.textContent = searchState.error;
                autocompleteList.appendChild(state);
                showSearchResults();
                return;
            }
            if (!searchState.results.length) {
                const state = document.createElement('div');
                state.className = 'search-result-state';
                state.textContent = searchState.query ? 'No matching instruments found.' : 'No recent searches yet.';
                autocompleteList.appendChild(state);
                showSearchResults();
                return;
            }
            const resultCount = Math.min(searchState.visibleCount, searchState.results.length);
            const viewport = document.createElement('div');
            viewport.className = 'autocomplete-viewport';
            viewport.style.height = `${resultCount * SEARCH_ROW_HEIGHT}px`;
            const viewportHeight = autocompleteList.clientHeight || 250;
            const start = Math.max(0, Math.floor(previousScrollTop / SEARCH_ROW_HEIGHT) - SEARCH_OVERSCAN);
            const end = Math.min(resultCount, Math.ceil((previousScrollTop + viewportHeight) / SEARCH_ROW_HEIGHT) + SEARCH_OVERSCAN);
            for (let index = start; index < end; index += 1) {
                const item = searchState.results[index];
                const option = document.createElement('button');
                option.type = 'button';
                option.id = `search-result-${index}`;
                option.className = `search-result-option${index === searchState.selectedIndex ? ' is-active' : ''}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', String(index === searchState.selectedIndex));
                option.style.transform = `translateY(${index * SEARCH_ROW_HEIGHT}px)`;
                const copy = document.createElement('span');
                copy.className = 'search-result-copy';
                const symbol = document.createElement('strong');
                symbol.className = 'search-result-symbol';
                appendSearchHighlight(symbol, item.symbol, searchState.query);
                const name = document.createElement('span');
                name.className = 'search-result-name';
                appendSearchHighlight(name, item.name || item.category || 'Open analysis', searchState.query);
                copy.append(symbol, name);
                const source = document.createElement('span');
                source.className = 'search-result-source';
                source.textContent = item.sources.join(' · ');
                option.append(copy, source);
                option.addEventListener('mousedown', event => event.preventDefault());
                option.addEventListener('click', () => selectSearchResult(item));
                viewport.appendChild(option);
            }
            autocompleteList.appendChild(viewport);
            showSearchResults();
            autocompleteList.scrollTop = Math.min(previousScrollTop, Math.max(0, resultCount * SEARCH_ROW_HEIGHT - autocompleteList.clientHeight));
            searchState.scrollTop = autocompleteList.scrollTop;
            if (searchState.selectedIndex >= 0) searchInput.setAttribute('aria-activedescendant', `search-result-${searchState.selectedIndex}`);
            else searchInput.removeAttribute('aria-activedescendant');
        }

        function selectSearchResult(item) {
            if (item && item.kind === 'query' && item.query) {
                searchInput.value = String(item.query);
                searchInput.focus({ preventScroll: true });
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            const ticker = normalizedSearchText(item && item.symbol);
            if (!validSearchTicker(ticker)) return;
            searchInput.value = ticker;
            hideSearchResults();
            // Keep the established synchronous selection handoff: the chart
            // starts its transition before any history write can complete.
            rememberSearchHistory(ticker);
            recordCloudActivity('/api/search-history', { ticker, query: ticker });
            switchStock(ticker);
        }

        async function loadSearchActivity() {
            resetSearchActivityForScope();
            if (searchActivityLoaded || searchActivityLoading) return searchActivityLoading;
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                return undefined;
            }
            if (searchActivityAbortController && !searchActivityAbortController.signal.aborted) searchActivityAbortController.abort();
            const controller = new AbortController();
            const requestScope = searchActivityScope;
            searchActivityAbortController = controller;
            const task = Promise.all([
                authFetch('/api/search-history?limit=20', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                authFetch('/api/recent-viewed?limit=20', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                authFetch('/api/search-analytics/trending?limit=8', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
                authFetch('/api/search-analytics', { headers: authHeaders(), cache: 'no-store', signal: controller.signal }),
            ]).then(async ([historyResponse, viewedResponse, trendingResponse, analyticsResponse]) => {
                if (!historyResponse.ok || !viewedResponse.ok) throw new Error('Unable to load recent searches.');
                const [historyData, viewedData, trendingData, analyticsData] = await Promise.all([
                    historyResponse.json(),
                    viewedResponse.json(),
                    trendingResponse.ok ? trendingResponse.json() : Promise.resolve({}),
                    analyticsResponse.ok ? analyticsResponse.json() : Promise.resolve(null),
                ]);
                if (controller.signal.aborted || requestScope !== currentSearchActivityScope()) return;
                searchHistoryItems = Array.isArray(historyData.items) ? historyData.items : [];
                recentViewedSearchItems = Array.isArray(viewedData.items) ? viewedData.items : [];
                trendingSearchItems = Array.isArray(trendingData.items) ? trendingData.items : [];
                searchAnalytics = analyticsData && typeof analyticsData === 'object' ? analyticsData : null;
                searchActivityLoaded = true;
                if (searchState.query && searchInput.value === searchState.query) {
                    searchState.results = composeSearchResults(searchQueryCache.get(searchState.query) || [], searchState.query);
                    renderSearchResults();
                }
            }).catch(error => {
                if (!isAbortError(error)) reportQuantoraError(error, { area: 'search-activity' });
            }).finally(() => {
                if (searchActivityAbortController === controller) searchActivityAbortController = null;
                if (searchActivityLoading === task) searchActivityLoading = null;
            });
            searchActivityLoading = task;
            return task;
        }

        async function fetchTickerMatches(query, signal) {
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=50`, { signal, cache: 'no-store' });
            if (!response.ok) throw new Error('Search is temporarily unavailable.');
            const data = await response.json();
            return Array.isArray(data.items) ? data.items : [];
        }

        async function showSearchHistory() {
            if (searchInput.value) return;
            resetSearchActivityForScope();
            searchState.query = '';
            searchState.loading = !searchActivityLoaded && authState.authenticated && authState.cloudSyncEnabled;
            searchState.error = '';
            searchState.results = composeSearchResults([], '');
            searchState.selectedIndex = -1;
            searchState.visibleCount = SEARCH_PAGE_SIZE;
            searchState.scrollTop = 0;
            renderSearchResults({ preserveScroll: false });
            await loadSearchActivity();
            if (searchInput.value) return;
            searchState.loading = false;
            searchState.results = composeSearchResults([], '');
            renderSearchResults({ preserveScroll: false });
        }

        function startSearch(query) {
            const requestVersion = ++searchRequestVersion;
            const startedAt = performance.now();
            // Warm only the small route chunk; do not activate it or trigger
            // dashboard work until the user actually selects a result.
            if (typeof prefetchRouteModule === 'function') prefetchRouteModule('analysis');
            const cached = searchQueryCache.get(query);
            searchState.query = query;
            searchState.selectedIndex = -1;
            searchState.visibleCount = SEARCH_PAGE_SIZE;
            searchState.scrollTop = 0;
            searchState.error = '';
            searchState.loading = !cached;
            searchState.results = composeSearchResults(cached || [], query);
            renderSearchResults({ preserveScroll: false });
            if (cached) recordSearchLatency(performance.now() - startedAt, true);
            const controller = new AbortController();
            tickerSearchAbortController = controller;
            void fetchTickerMatches(query, controller.signal).then(items => {
                if (controller.signal.aborted || requestVersion !== searchRequestVersion || searchInput.value !== query) return;
                searchQueryCache.set(query, items);
                searchState.loading = false;
                searchState.results = composeSearchResults(items, query);
                renderSearchResults();
                if (!cached) recordSearchLatency(performance.now() - startedAt);
            }).catch(error => {
                if (controller.signal.aborted || requestVersion !== searchRequestVersion) return;
                searchState.loading = false;
                searchState.error = error.message || 'Search is temporarily unavailable.';
                renderSearchResults();
                if (!cached) recordSearchLatency(performance.now() - startedAt);
            }).finally(() => {
                if (tickerSearchAbortController === controller) tickerSearchAbortController = null;
            });
        }

        searchInput.addEventListener('input', function () {
            this.value = normalizedSearchText(this.value);
            const query = this.value;
            clearTimeout(searchDebounce);
            if (tickerSearchAbortController && !tickerSearchAbortController.signal.aborted) tickerSearchAbortController.abort();
            if (!query) { void showSearchHistory(); return; }
            searchDebounce = window.setTimeout(() => startSearch(query), SEARCH_DEBOUNCE_MS);
        });

        searchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                saveCurrentSearch(searchInput.value);
                searchState.results = composeSearchResults(searchQueryCache.get(searchState.query) || [], searchState.query);
                renderSearchResults();
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                hideSearchResults();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!searchState.results.length) return;
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                searchState.selectedIndex = Math.max(0, Math.min(searchState.results.length - 1, searchState.selectedIndex + direction));
                ensureSelectedSearchResultVisible();
                renderSearchResults();
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                const selected = searchState.results[searchState.selectedIndex];
                if (selected) selectSearchResult(selected); else searchStock();
            }
        });
        searchInput.addEventListener('focus', () => {
            if (!searchInput.value) void showSearchHistory();
            else if (searchState.results.length) renderSearchResults();
        });
        autocompleteList.addEventListener('scroll', () => {
            searchState.scrollTop = autocompleteList.scrollTop;
            if (searchState.results.length > searchState.visibleCount && autocompleteList.scrollTop + autocompleteList.clientHeight >= searchState.visibleCount * SEARCH_ROW_HEIGHT - (SEARCH_ROW_HEIGHT * 3)) {
                searchState.visibleCount = Math.min(searchState.results.length, searchState.visibleCount + SEARCH_PAGE_SIZE);
            }
            if (!searchState.open || searchScrollRenderFrame !== null) return;
            searchScrollRenderFrame = window.requestAnimationFrame(() => {
                searchScrollRenderFrame = null;
                if (searchState.open) renderSearchResults();
            });
        }, { passive: true });
        document.addEventListener('click', event => {
            if (!searchInput.contains(event.target) && !autocompleteList.contains(event.target)) hideSearchResults();
        });

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
        initializeChartIndicators();

        // --- 🛠️ [แก้บั๊ก] แท่งเทียนกับแท่งวอลุ่มยืนไม่ตรงกัน ---
        // สาเหตุจริง: chart กับ volumeChart เป็นคนละ chart instance กัน แม้ time ของทุกแท่งจะตรงกัน 100%
        // (มาจาก chartData ชุดเดียวกัน) แต่ "ความกว้างของแกนราคาขวา" ของแต่ละกราฟคำนวณเองอิสระ
        // ตามความกว้างของตัวเลขที่แสดง (ราคาหุ้น เช่น "203.69" กับวอลุ่ม เช่น "95.35M" กว้างไม่เท่ากัน)
        // เมื่อแกนราคากว้างไม่เท่ากัน พื้นที่วาดกราฟ (plot area) ของสองกราฟจะกว้างไม่เท่ากันไปด้วย
        // ทำให้แท่งเทียนกับแท่งวอลุ่มเลื่อนหลุดแนวกันในแนวนอน ยิ่งเลื่อนกราฟไปทางซ้ายยิ่งเห็นชัด
        // วิธีแก้: บังคับให้ minimumWidth ของแกนราคาขวาทั้งสองกราฟเท่ากันเป๊ะเสมอ (ใช้ค่าที่กว้างที่สุด)
