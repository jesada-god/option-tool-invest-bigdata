        function syncPriceScaleWidths() {
            const mainWidth = chart.priceScale('right').width();
            const volWidth = volumeChart.priceScale('right').width();
            const target = Math.max(mainWidth, volWidth, 56);
            if (target > 0 && target !== syncedPriceScaleWidth) {
                syncedPriceScaleWidth = target;
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
            return JSON.parse(JSON.stringify(EMA_DEFAULTS));
        }

        function saveEmaSettings() {
            queuePreferenceSync();
        }

        // ปุ่มหลัก "เปิดใช้งาน EMA" — กดครั้งแรกให้ขึ้นทุกเส้นทันที ไม่ต้องเลือกทีละเส้น
        // ผู้ใช้ค่อยไปติ๊กเอาเส้นที่ไม่ต้องการออกทีหลังได้จากรายการด้านล่าง
        function loadEmaMaster() {
            return false;
        }
        function saveEmaMaster() {
            queuePreferenceSync();
        }

        let emaSettings = loadEmaSettings();
        let emaMasterEnabled = loadEmaMaster();
        const emaSeriesMap = { 20: null, 50: null, 100: null, 200: null };
        const emaLastValue = { 20: null, 50: null, 100: null, 200: null }; // เก็บราคาล่าสุดของแต่ละเส้นไว้โชว์บน legend
        // The EMA immediately before the mutable, in-progress candle.  It
        // lets live prices update the last point in O(enabled indicators)
        // instead of recalculating every point in the chart on each quote.
        const emaLiveBaseValue = { 20: null, 50: null, 100: null, 200: null };
        let syncedPriceScaleWidth = 0;

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
                    emaLiveBaseValue[period] = data.length > 1 ? data[data.length - 2].value : null;
                } else if (emaSeriesMap[period]) {
                    chart.removeSeries(emaSeriesMap[period]);
                    emaSeriesMap[period] = null;
                    emaLastValue[period] = null;
                    emaLiveBaseValue[period] = null;
                } else {
                    emaLastValue[period] = null;
                    emaLiveBaseValue[period] = null;
                }
            });
            updateEmaLegend();
        }

        function updateLiveEMASeries(lastCandle) {
            if (!lastCandle || !Number.isFinite(lastCandle.close)) return;
            const enabledPeriods = EMA_PERIODS.filter(period => emaSettings[period].enabled && emaSeriesMap[period]);
            if (!enabledPeriods.length) return;
            // A single seeded EMA point has no preceding EMA value. This is
            // rare for normal chart payloads; retain the exact full method.
            if (enabledPeriods.some(period => globalChartData.length <= period || !Number.isFinite(emaLiveBaseValue[period]))) {
                updateEMASeries();
                return;
            }
            enabledPeriods.forEach(period => {
                const smoothing = 2 / (period + 1);
                const value = (lastCandle.close * smoothing) + (emaLiveBaseValue[period] * (1 - smoothing));
                emaSeriesMap[period].update({ time: lastCandle.time, value });
                emaLastValue[period] = value;
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

        let chartResizeFrame = null;
        let lastChartSize = '';
        const resizeCharts = () => {
            chartResizeFrame = null;
            const chartWidth = chartContainer.clientWidth;
            const chartHeight = chartContainer.clientHeight;
            const volumeWidth = volumeContainer.clientWidth;
            const volumeHeight = volumeContainer.clientHeight;
            const size = `${chartWidth}x${chartHeight}:${volumeWidth}x${volumeHeight}`;
            if (size === lastChartSize || !chartWidth || !chartHeight || !volumeWidth || !volumeHeight) return;
            lastChartSize = size;
            chart.applyOptions({ width: chartWidth, height: chartHeight });
            volumeChart.applyOptions({ width: volumeWidth, height: volumeHeight });
            window.requestAnimationFrame(syncPriceScaleWidths);
        };
        const chartResizeObserver = new ResizeObserver(() => {
            if (chartResizeFrame === null) chartResizeFrame = window.requestAnimationFrame(resizeCharts);
        });
        chartResizeObserver.observe(chartContainer);
        chartResizeObserver.observe(volumeContainer);

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
