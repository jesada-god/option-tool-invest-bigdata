
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
        let searchDebounce = null;

        function getSRRightOffset() {
            const offset = Math.max(80, Math.min(120, Math.floor(window.innerWidth * 0.12)));
            return offset;
        }

        const searchInput = document.getElementById('search-input');
        const autocompleteList = document.getElementById('autocomplete-list');

        // --- 🔎 ค้นหาหุ้นจากฐานข้อมูล Ticker ฝั่ง Backend ---
        async function fetchTickerMatches(val) {
            try {
                const res = await fetch(`/api/tickers?q=${encodeURIComponent(val)}`);
                return await res.json();
            } catch (err) { return []; }
        }

        searchInput.addEventListener('input', function () {
            this.value = this.value.toUpperCase();
            const val = this.value;
            if (!val) { autocompleteList.innerHTML = ''; autocompleteList.style.display = 'none'; return; }

            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(async () => {
                const matches = await fetchTickerMatches(val);
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
            try {
                const saved = JSON.parse(localStorage.getItem('emaSettings') || 'null');
                if (saved) {
                    const merged = {};
                    EMA_PERIODS.forEach(p => { merged[p] = { ...EMA_DEFAULTS[p], ...(saved[p] || {}) }; });
                    return merged;
                }
            } catch (e) { /* ignore corrupted storage */ }
            return JSON.parse(JSON.stringify(EMA_DEFAULTS));
        }

        function saveEmaSettings() {
            try { localStorage.setItem('emaSettings', JSON.stringify(emaSettings)); } catch (e) { /* storage full/unavailable */ }
        }

        // ปุ่มหลัก "เปิดใช้งาน EMA" — กดครั้งแรกให้ขึ้นทุกเส้นทันที ไม่ต้องเลือกทีละเส้น
        // ผู้ใช้ค่อยไปติ๊กเอาเส้นที่ไม่ต้องการออกทีหลังได้จากรายการด้านล่าง
        function loadEmaMaster() {
            try { return localStorage.getItem('emaMasterEnabled') === 'true'; } catch (e) { return false; }
        }
        function saveEmaMaster() {
            try { localStorage.setItem('emaMasterEnabled', String(emaMasterEnabled)); } catch (e) { /* storage full/unavailable */ }
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
            try {
                const res = await fetch('/api/watchlist');
                watchlist = await res.json();
                renderWatchlist();
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

        async function fetchDashboardData() {
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
                const chartData = await chartRes.json();
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
                } else if (ws) {
                    ws.close(); ws = null;
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

        function switchStock(ticker) { currentTicker = ticker; removeSRLines(); fetchDashboardData(); renderWatchlist(); }
        function searchStock() { const input = document.getElementById('search-input').value.toUpperCase().trim(); if (!input) return; currentTicker = input; removeSRLines(); fetchDashboardData(); renderWatchlist(); }

        // 🛠️ [แก้บั๊ก] เดิม Volume ของแท่งล่าสุดจะค้างอยู่ค่าตอนโหลดหน้าครั้งแรกตลอด เพราะ
        // WebSocket ส่งมาแค่ "ราคา" ไม่มี "วอลลุ่ม" เลย ฟังก์ชันนี้จะดึงแท่งเทียน+วอลลุ่มชุดล่าสุด
        // มาแทนที่เป็นระยะ เพื่อให้ Volume ตรงกับแท่งราคาจริงเสมอ โดยไม่รบกวนตำแหน่งที่ผู้ใช้กำลังดูอยู่
        // (setData แทนที่ทั้งชุดทุกครั้ง จึงไม่มีแท่งซ้อนหรือช่องว่างผิดปกติ เพราะ time เดียวกันจะถูกอัปเดตทับ ไม่ใช่เพิ่มใหม่)
        let isRefreshingChart = false;
        async function refreshChartOnly() {
            if (isChangingData || isRefreshingChart) return; // อย่าชนกับการโหลดข้อมูลเต็มรูปแบบ (เปลี่ยนหุ้น/timeframe)
            isRefreshingChart = true;
            try {
                const chartRes = await fetch(`/api/chart-data?ticker=${currentTicker}&timeframe=${currentTimeframe}`);
                const chartData = await chartRes.json();
                if (!chartData || chartData.length === 0) return;
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

        let chartRefreshTimer = null;
        function startChartAutoRefresh() {
            if (chartRefreshTimer) clearInterval(chartRefreshTimer);
            chartRefreshTimer = setInterval(refreshChartOnly, 15000); // รีเฟรชแท่งเทียน+วอลลุ่มทุก 15 วิ
        }

        async function addCurrentToWatchlist() {
            await fetch(`/api/watchlist?ticker=${currentTicker}`, { method: 'POST' });
            fetchWatchlist();
        }
        async function deleteWatchlist(ticker) {
            await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
            if (currentTicker === ticker) currentTicker = watchlist[0] || "NVDA";
            fetchWatchlist();
            if (currentTicker === ticker) fetchDashboardData();
        }

        function changeTimeframe(tf, btn) {
            document.querySelectorAll('#timeframe-group button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active'); currentTimeframe = tf; removeSRLines(); fetchDashboardData();
        }

        function toggleSupportResistance() {
            if (isSRVisible) { removeSRLines(); }
            else {
                if (!srData) return;
                const resColors = ['#ff8a80', '#ff5c4d', '#ff3b30'];
                const supColors = ['#69f0ae', '#2ee08a', '#00c57f'];
                const widths = [4, 3, 3];
                const f = (p, c, w, t) => candleSeries.createPriceLine({ price: p, color: c, lineWidth: w, lineStyle: LightweightCharts.LineStyle.Solid, title: t });

                srData.resistance.forEach((r, i) => srLines.push(f(r.level, resColors[i] || '#ff3b30', widths[i] || 3, `${r.label} แนวต้าน (${r.strength}% ${r.confidence})`)));
                srData.support.forEach((s, i) => srLines.push(f(s.level, supColors[i] || '#00c57f', widths[i] || 3, `${s.label} แนวรับ (${s.strength}% ${s.confidence})`)));

                isSRVisible = true; document.getElementById('toggle-sr').classList.add('active');
            }
        }
        function removeSRLines() { srLines.forEach(l => candleSeries.removePriceLine(l)); srLines = []; isSRVisible = false; document.getElementById('toggle-sr').classList.remove('active'); }

        // --- 💼 Portfolio Engine Via API ---
        async function fetchPortfolio() {
            try {
                const res = await fetch('/api/positions');
                activePositions = await res.json();
                renderPortfolioTable();
            } catch (err) { console.error("Error fetching portfolio:", err); }
        }

        function renderPortfolioTable() {
            const tbody = document.getElementById('portfolio-rows');
            if (activePositions.length === 0) {
                tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">💼 พอร์ตว่างเปล่า ลองระบุเงื่อนไขด้านบนเพื่อเปิดสถานะสัญญาจำลอง</td></tr>`;
                return;
            }
            tbody.innerHTML = activePositions.map(p => {
                const currentUPrice = parseFloat(p.current_underlying_price || p.entry_underlying_price);
                const pnl = parseFloat(p.pnl);
                const pnlPercent = parseFloat(p.pnl_percent);
                const ivDisp = p.iv ? p.iv + '%' : '-';
                const deltaDisp = p.delta ? p.delta : '-';

                let currentSellPrice = parseFloat(p.premium_paid) + (pnl / (p.quantity * 100));
                if (currentSellPrice < 0.01) currentSellPrice = 0.01;

                const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
                const sign = pnl >= 0 ? '+' : '';

                return `
<tr>
<td style="font-weight:bold; color:white;">${p.ticker}</td>
<td style="color:${p.option_type === 'CALL' ? 'var(--green)' : 'var(--red)'}; font-weight:bold;">${p.option_type}</td>
<td>$${p.strike_price}</td>
<td>${p.expiration}</td>
<td>$${parseFloat(p.premium_paid).toFixed(2)}</td>
<td>${p.quantity}</td>
<td style="color:var(--text-muted); font-size:12px;">${ivDisp} / ${deltaDisp}</td>
<td id="table-underlying-${p.id}">$${currentUPrice.toFixed(2)}</td>
<td id="table-sellprice-${p.id}" style="font-weight:bold; color:var(--gold);">$${currentSellPrice.toFixed(2)}</td>
<td id="table-pnl-${p.id}" class="pnl-cell" style="color:${color}">${sign}$${pnl.toFixed(2)} <span style="font-size:12px;">(${sign}${pnlPercent.toFixed(2)}%)</span></td>
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

            await fetch('/api/positions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            document.getElementById('pos-form').reset();
            fetchPortfolio();
        }

        async function closePosition(id) {
            await fetch(`/api/positions/${id}`, { method: 'DELETE' });
            fetchPortfolio();
        }

        // --- ⚡ Real-Time WebSocket Connection ---
        function initWebSocket() {
            if (ws) ws.close();
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/price/${currentTicker}`;
            ws = new WebSocket(wsUrl);

            ws.onmessage = function (event) {
                const data = JSON.parse(event.data);
                if (data.market_session && data.market_session !== "REGULAR") {
                    currentMarketSession = data.market_session;
                    ws.close(); ws = null;
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
        }

        // --- 🔮 What-If Simulator Logic ---
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

        async function loadFullGauges(ticker) {
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
            addScenarioCard();
            await fetchWatchlist();
            await fetchDashboardData();
            startChartAutoRefresh();
        }

        bootTerminal();
    