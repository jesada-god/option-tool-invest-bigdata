        function formatUsd(value) {
            return (typeof value === 'number' && Number.isFinite(value)) ? `$${value.toFixed(2)}` : '-';
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
                item = {
                    ...item,
                    eta: item.eta ? escapeHtml(item.eta) : '',
                    confidence: escapeHtml(item.confidence || ''),
                };
                const near = item.distance_pct !== null && item.distance_pct !== undefined && item.distance_pct <= 1.5;
                const labelColor = type === 'resistance' ? 'var(--red)' : 'var(--green)';
                const zoneRange = (Number.isFinite(item.zone_low) && Number.isFinite(item.zone_high))
                    ? '<div class="sr-zone-range">โซน ' + formatPrice(item.zone_low) + ' - ' + formatPrice(item.zone_high) + '</div>'
                    : '';
                const reasons = escapeHtml((item.reasons || []).join(' | '));
                const confColor = srConfidenceColor(item.confidence);
                const strength = Number(item.strength);
                const strengthTxt = Number.isFinite(strength) ? `${strength}%` : 'N/A';

                let html = '<div class="sr-row ' + type + (near ? ' near' : '') + '" title="' + reasons + '">';
                html += '<span class="sr-label" style="color:' + labelColor + '">' + escapeHtml(item.label) + '</span>';
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

        async function fetchDashboardData() {
            const context = makeDashboardContext();
            isChangingData = true;
            document.getElementById('stats-title').innerText = `${context.ticker} Key Statistics`;
            const chartContainer = document.querySelector('.chart-container');
            const sidePanel = document.querySelector('.side-panel');
            chartContainer?.classList.add('is-refreshing');
            sidePanel?.classList.add('is-refreshing');
            chartContainer?.setAttribute('aria-busy', 'true');

            try {
                // S/R is an enhancement to the existing chart, not a
                // prerequisite for it.  A temporary provider failure in the
                // indicator endpoint used to abort this whole request, which
                // left both the chart EMA controls and S/R appearing broken.
                const indicatorsRequest = fetch(
                    `/api/indicators?ticker=${encodeURIComponent(context.ticker)}&timeframe=${encodeURIComponent(context.timeframe)}`,
                    { signal: context.signal, cache: 'no-store' }
                )
                    .then(async response => {
                        if (!response.ok) throw new Error(`Indicators request failed: ${response.status} ${response.statusText}`);
                        return response.json();
                    })
                    .catch(error => {
                        if (!isAbortError(error) && isCurrentView(context)) {
                            reportQuantoraError(error, { area: 'indicators' });
                        }
                        return null;
                    });
                const [statsRes, chartRes, indicators] = await Promise.all([
                    fetch(`/api/stats?ticker=${encodeURIComponent(context.ticker)}`, { signal: context.signal, cache: 'no-store' }),
                    fetch(`/api/chart-data?ticker=${encodeURIComponent(context.ticker)}&timeframe=${encodeURIComponent(context.timeframe)}`, { signal: context.signal, cache: 'no-store' }),
                    indicatorsRequest,
                ]);
                if (!isCurrentView(context)) return;
                if (!statsRes.ok) throw new Error(`Stats request failed: ${statsRes.status} ${statsRes.statusText}`);
                if (!chartRes.ok) throw new Error(`Chart-data request failed: ${chartRes.status} ${chartRes.statusText}`);

                const [statsPayload, chartPayload] = await Promise.all([statsRes.json(), chartRes.json()]);
                if (!isCurrentView(context)) return;
                const showNoMarketData = () => {
                    globalChartData = [];
                    candleSeries.setData([]);
                    volumeSeries.setData([]);
                    document.getElementById('stats-title').innerText = 'No market data available';
                };
                if (statsPayload?.success === true && Array.isArray(statsPayload.data) && statsPayload.data.length === 0) {
                    showNoMarketData();
                    return;
                }
                const stats = statsPayload;
                const chartData = Array.isArray(chartPayload) ? chartPayload : chartPayload?.data;
                if (!Array.isArray(chartData) || chartData.length === 0) {
                    showNoMarketData();
                    return;
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
                announceLivePrice?.(Number.isFinite(currentLivePrice) ? `$${currentLivePrice.toFixed(2)}` : '-', context.ticker);
                const chartSummary = document.getElementById('chart-accessibility-summary');
                if (chartSummary) chartSummary.textContent = Number.isFinite(currentLivePrice) ? `${context.ticker} price chart loaded. Current price ${currentLivePrice.toFixed(2)}.` : `${context.ticker} price chart loaded. Current price is unavailable.`;
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

                if (!isCurrentView(context)) return;
                // Keep the established S/R payload shape even while its
                // request is being retried, so the existing UI can remain
                // safely interactive.
                srData = indicators && typeof indicators === 'object'
                    ? indicators
                    : { support: [], resistance: [], closest_alert: null, basis_timeframe: context.timeframe };
                renderSRLadder();

                if (currentMarketSession === 'REGULAR') initWebSocket(context);
                else closeLivePriceSocket();
                window.setTimeout(() => { if (isCurrentView(context)) resetChartView(); }, 50);
                loadFullGauges(context);
            } catch (err) {
                if (!isAbortError(err) && isCurrentView(context)) {
                    reportQuantoraError(err, { area: 'dashboard' });
                }
            } finally {
                if (isCurrentView(context)) {
                    isChangingData = false;
                    chartContainer?.classList.remove('is-refreshing');
                    sidePanel?.classList.remove('is-refreshing');
                    chartContainer?.removeAttribute('aria-busy');
                }
            }
        }

        function switchStock(ticker) {
            const nextTicker = String(ticker || '').toUpperCase().trim();
            if (!/^[A-Z0-9.-]{1,12}$/.test(nextTicker)) return;
            invalidateViewRequests();
            closeLivePriceSocket();
            currentTicker = nextTicker;
            recordRecentViewed(nextTicker);
            void loadHomeAiRecommendation(nextTicker);
            if (stockWorkspaceTab !== 'overview' && stockWorkspaceTab !== 'options' && stockWorkspaceTab !== 'simulator') {
                void openStockWorkspaceTab(stockWorkspaceTab);
            }
            currentLivePrice = null;
            updateHomeMarketSurface({ current_price: null, prev_close: null, market_session: 'LOADING' });
            removeSRLines();
            fetchDashboardData();
        }

        function searchStock() {
            const input = document.getElementById('search-input').value.toUpperCase().trim();
            if (!input) return;
            if (typeof rememberSearchHistory === 'function') rememberSearchHistory(input, input);
            recordCloudActivity('/api/search-history', { ticker: input, query: input });
            switchStock(input);
        }

        // 🛠️ [แก้บั๊ก] เดิม Volume ของแท่งล่าสุดจะค้างอยู่ค่าตอนโหลดหน้าครั้งแรกตลอด เพราะ
        // WebSocket ส่งมาแค่ "ราคา" ไม่มี "วอลลุ่ม" เลย ฟังก์ชันนี้จะดึงแท่งเทียน+วอลลุ่มชุดล่าสุด
        // มาแทนที่เป็นระยะ เพื่อให้ Volume ตรงกับแท่งราคาจริงเสมอ โดยไม่รบกวนตำแหน่งที่ผู้ใช้กำลังดูอยู่
        // (setData แทนที่ทั้งชุดทุกครั้ง จึงไม่มีแท่งซ้อนหรือช่องว่างผิดปกติ เพราะ time เดียวกันจะถูกอัปเดตทับ ไม่ใช่เพิ่มใหม่)
        let isRefreshingChart = false;
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
                if (!isAbortError(err) && isCurrentView(context)) reportQuantoraError(err, { area: 'chart-refresh' });
            } finally {
                if (chartRefreshAbortController === controller) chartRefreshAbortController = null;
                if (controller.signal.aborted || chartRefreshAbortController === null) isRefreshingChart = false;
            }
        }

        let chartRefreshTimer = null;
        function startChartAutoRefresh() {
            if (chartRefreshTimer) clearInterval(chartRefreshTimer);
            chartRefreshTimer = setInterval(() => {
                if (!isPageVisible || !isNetworkOnline || !['home', 'analysis'].includes(currentTerminalRoute())) return;
                void refreshChartOnly();
            }, 15000); // รีเฟรชแท่งเทียน+วอลลุ่มทุก 15 วิ
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
                    const result = await addTickerToSelectedCloudWatchlist(currentTicker);
                    if (result) {
                        syncSelectedCloudWatchlist();
                        setWatchlistStatus(`${currentTicker} added to the watchlist.`, 'success');
                    }
                    return;
                }
                setCloudWorkspaceStatus('Your cloud watchlist is unavailable. Try opening Profile and refreshing the workspace.', 'error');
                setWatchlistStatus('Watchlist is unavailable. Please retry after refreshing your workspace.', 'error');
                return;
            }
            if (!authState.authenticated || (authState.configured === true && !authState.cloudSyncEnabled)) {
                const items = localWatchlistItems();
                if (!items.includes(currentTicker)) items.push(currentTicker);
                saveLocalWatchlistItems(items);
                setWatchlistItems(items);
                setWatchlistStatus(`${currentTicker} saved on this device until cloud storage is configured.`, 'success');
                return;
            }
            try {
                const res = await authFetch(`/api/watchlist?ticker=${encodeURIComponent(currentTicker)}`, {
                    method: 'POST', headers: authHeaders(),
                });
                const items = await res.json().catch(() => null);
                if (!res.ok) throw new Error(items?.detail || `Watchlist update failed: ${res.status}`);
                setWatchlistItems(items);
                setWatchlistStatus(`${currentTicker} added to the watchlist.`, 'success');
            } catch (err) {
                reportQuantoraError(err, { area: 'watchlist-add' });
                setWatchlistStatus(err.message || 'Unable to add this symbol. Please try again.', 'error');
            }
        }
        async function deleteWatchlist(ticker) {
            const wasCurrent = currentTicker === ticker;
            try {
                if (authState.configured === true && !authState.authenticated) {
                    openProfileSheet();
                    setAuthStatus('Sign in before changing a cloud watchlist.', 'error');
                    return;
                }
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
                if (!authState.authenticated || (authState.configured === true && !authState.cloudSyncEnabled)) {
                    const items = localWatchlistItems().filter(item => String(item).toUpperCase() !== String(ticker).toUpperCase());
                    saveLocalWatchlistItems(items);
                    setWatchlistItems(items);
                    setWatchlistStatus(`${ticker} removed from the watchlist.`, 'success');
                    if (wasCurrent) switchStock(watchlist[0] || 'NVDA');
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
                reportQuantoraError(err, { area: 'watchlist-remove' });
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
                if (!srData || !candleSeries) return;
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

                resToShow
                    .filter(level => Number.isFinite(Number(level?.level)))
                    .forEach((r, i) => srLines.push(f(Number(r.level), resColors[i] || '#ff3b30', widths[i] || 3, `${r.label} แนวต้าน (${r.strength}% ${r.confidence})`)));
                supToShow
                    .filter(level => Number.isFinite(Number(level?.level)))
                    .forEach((s, i) => srLines.push(f(Number(s.level), supColors[i] || '#00c57f', widths[i] || 3, `${s.label} แนวรับ (${s.strength}% ${s.confidence})`)));

                // Do not leave the control active when an unavailable
                // provider returned no usable levels.
                if (!srLines.length) return;
                isSRVisible = true; document.getElementById('toggle-sr').classList.add('active');
            }
        }
        function removeSRLines() { srLines.forEach(l => candleSeries.removePriceLine(l)); srLines = []; isSRVisible = false; document.getElementById('toggle-sr').classList.remove('active'); }
