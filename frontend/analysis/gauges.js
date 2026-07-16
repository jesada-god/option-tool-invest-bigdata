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

        async function loadFullGauges(context) {
            if (typeof context === 'string') context = { ...currentViewContext(), ticker: context };
            if (!isCurrentView(context)) return;
            if (gaugesAbortController && !gaugesAbortController.signal.aborted) {
                gaugesAbortController.abort();
            }
            const controller = new AbortController();
            gaugesAbortController = controller;
            const gaugeContext = { ...context, signal: controller.signal };
            const grid = document.getElementById('full-gauges-grid');
            const badge = document.getElementById('gauges-confidence-badge');
            if (!grid || !badge) return;
            const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));

            grid.innerHTML = '<div style="grid-column: 1 / -1; font-size:12px; color:var(--text-muted);">Loading gauges…</div>';
            try {
                const res = await authFetch(`/api/gauges?ticker=${encodeURIComponent(gaugeContext.ticker)}`, {
                    signal: gaugeContext.signal,
                    cache: 'no-store',
                });
                if (!isCurrentView(gaugeContext)) return;
                const data = await res.json().catch(() => null);
                if (!isCurrentView(gaugeContext)) return;
                if (!res.ok) throw new Error(data?.detail || `Gauges request failed: ${res.status}`);
                if (!data || typeof data !== 'object' || !data.gauges || typeof data.gauges !== 'object') {
                    throw new Error('Gauge data was unavailable.');
                }
                const gauges = data.gauges;
                const conf = gauges.confidence_score;
                badge.innerText =
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
                    reportQuantoraError(err, { area: 'gauges' });
                    badge.innerText = 'Unavailable';
                    const detail = escapeHtml(err.message || 'Unable to load gauges.');
                    grid.innerHTML = `<div style="grid-column:1 / -1; font-size:12px; color:var(--red);">${detail} <button type="button" onclick="loadFullGauges(currentViewContext())" style="margin-left:8px; border:1px solid var(--red); background:transparent; color:var(--red); border-radius:4px; cursor:pointer;">Retry</button></div>`;
                }
            } finally {
                if (gaugesAbortController === controller) gaugesAbortController = null;
            }
        }

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

