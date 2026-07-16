        function toolsCalculatorMarketPrice() {
            const live = Number(currentLivePrice);
            if (Number.isFinite(live) && live > 0) return live;
            const latestBar = Array.isArray(globalChartData) ? globalChartData[globalChartData.length - 1] : null;
            const close = Number(latestBar && latestBar.close);
            return Number.isFinite(close) && close > 0 ? close : '';
        }

        function toolsCalculatorInput(id, label, options = {}) {
            const value = options.value;
            const numericValue = value !== '' && value !== undefined && value !== null && Number.isFinite(Number(value))
                ? ` value="${Number(value)}"`
                : '';
            const min = options.min !== undefined ? ` min="${options.min}"` : '';
            const step = options.step || 'any';
            const placeholder = options.placeholder ? ` placeholder="${options.placeholder}"` : '';
            const wide = options.wide ? ' wide' : '';
            return `<label class="pt-tools-field${wide}"><span>${label}</span><input id="${id}" type="number" inputmode="decimal" step="${step}"${min}${numericValue}${placeholder}></label>`;
        }

        function toolsCalculatorSelect(id, label, options, selected, wide = false) {
            const items = options.map(option => {
                const isSelected = option.value === selected ? ' selected' : '';
                return `<option value="${option.value}"${isSelected}>${option.label}</option>`;
            }).join('');
            return `<label class="pt-tools-field${wide ? ' wide' : ''}"><span>${label}</span><select id="${id}">${items}</select></label>`;
        }

        function renderToolsCalculatorFields() {
            const host = document.getElementById('tools-calculator-fields');
            const submit = document.getElementById('tools-calculator-submit');
            if (!host || !submit) return;
            const marketPrice = toolsCalculatorMarketPrice();
            let fields = '';
            let buttonText = 'Calculate';

            if (activeToolsCalculator === 'position') {
                buttonText = 'Calculate position';
                fields = [
                    toolsCalculatorInput('tools-position-account', 'Account value ($)', { value: 10000, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-position-risk', 'Risk per trade (%)', { value: 1, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-position-entry', 'Entry price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-position-stop', 'Stop price ($)', { min: 0, step: '0.01' }),
                    toolsCalculatorSelect('tools-position-side', 'Position side', [
                        { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' },
                    ], 'LONG'),
                    toolsCalculatorInput('tools-position-max', 'Max exposure (%)', { value: 100, min: 0, step: '0.01' }),
                ].join('');
            } else if (activeToolsCalculator === 'move') {
                buttonText = 'Calculate expected move';
                fields = [
                    toolsCalculatorInput('tools-move-price', 'Underlying price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-move-iv', 'Implied volatility (%)', { value: 30, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-move-days', 'Days to expiry', { value: 30, min: 0, step: '1' }),
                    toolsCalculatorInput('tools-move-days-year', 'Days per year', { value: 365, min: 1, step: '1' }),
                ].join('');
            } else if (activeToolsCalculator === 'probability') {
                buttonText = 'Calculate probability';
                fields = [
                    toolsCalculatorInput('tools-probability-spot', 'Spot price ($)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Current price' }),
                    toolsCalculatorInput('tools-probability-target', 'Target price ($)', { min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-iv', 'Implied volatility (%)', { value: 30, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-days', 'Days to target', { value: 30, min: 0, step: '1' }),
                    toolsCalculatorInput('tools-probability-rate', 'Risk-free rate (%)', { value: 4.5, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-dividend', 'Dividend yield (%)', { value: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-probability-days-year', 'Days per year', { value: 365, min: 1, step: '1' }),
                ].join('');
            } else if (activeToolsCalculator === 'growth') {
                const isDca = toolsGrowthMode === 'dca';
                buttonText = isDca ? 'Project DCA plan' : 'Project compound growth';
                const rateLabel = isDca ? 'Annual return (%)' : 'Annual rate (%)';
                const frequencyLabel = isDca ? 'Contributions per year' : 'Compounds per year';
                fields = [
                    toolsCalculatorSelect('tools-growth-mode', 'Projection type', [
                        { value: 'compound', label: 'Compound growth' },
                        { value: 'dca', label: 'DCA projection' },
                    ], toolsGrowthMode),
                    toolsCalculatorInput('tools-growth-initial', 'Initial investment ($)', { value: 1000, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-contribution', 'Periodic contribution ($)', { value: 100, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-rate', rateLabel, { value: 8, step: '0.01' }),
                    toolsCalculatorInput('tools-growth-years', 'Years', { value: 10, min: 0, step: '0.5' }),
                    toolsCalculatorInput('tools-growth-frequency', frequencyLabel, { value: 12, min: 1, step: '1' }),
                    toolsCalculatorSelect('tools-growth-timing', 'Contribution timing', [
                        { value: 'end', label: 'End of each period' },
                        { value: 'begin', label: 'Beginning of each period' },
                    ], 'end'),
                ].join('');
                window.setTimeout(() => {
                    const mode = document.getElementById('tools-growth-mode');
                    if (mode) mode.addEventListener('change', event => setGrowthCalculatorMode(event.target.value), { once: true });
                }, 0);
            } else if (activeToolsCalculator === 'fair') {
                buttonText = 'Calculate fair value';
                fields = [
                    toolsCalculatorInput('tools-fair-fcf', 'Free cash flow / share ($)', { value: 5, min: 0, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-growth', 'Growth rate (%)', { value: 6, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-discount', 'Discount rate (%)', { value: 10, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-terminal', 'Terminal growth (%)', { value: 2.5, step: '0.01' }),
                    toolsCalculatorInput('tools-fair-years', 'Projection years', { value: 5, min: 1, step: '1' }),
                    toolsCalculatorInput('tools-fair-price', 'Current price ($, optional)', { value: marketPrice, min: 0, step: '0.01', placeholder: 'Optional' }),
                    toolsCalculatorInput('tools-fair-safety', 'Margin of safety (%)', { value: 20, min: 0, step: '0.01' }),
                ].join('');
            }

            host.innerHTML = fields;
            submit.textContent = buttonText;
        }

        function selectToolsCalculator(calculator, source) {
            if (!['position', 'move', 'probability', 'growth', 'fair'].includes(calculator)) return;
            activeToolsCalculator = calculator;
            toolsCalculatorRequestVersion += 1;
            if (toolsCalculatorAbortController && !toolsCalculatorAbortController.signal.aborted) {
                toolsCalculatorAbortController.abort();
            }
            toolsCalculatorAbortController = null;
            document.querySelectorAll('.pt-tools-tab').forEach(tab => {
                const active = tab.dataset.calculator === calculator;
                tab.classList.toggle('is-active', active);
                tab.setAttribute('aria-selected', String(active));
            });
            if (source) source.focus({ preventScroll: true });
            hideToolsCalculatorResult();
            renderToolsCalculatorFields();
        }

        function setGrowthCalculatorMode(mode) {
            toolsGrowthMode = mode === 'dca' ? 'dca' : 'compound';
            hideToolsCalculatorResult();
            renderToolsCalculatorFields();
        }

        function toolsCalculatorNumber(id, label, options = {}) {
            const input = document.getElementById(id);
            const raw = input ? input.value.trim() : '';
            if (!raw && options.optional) return undefined;
            if (!raw) throw new Error(`${label} is required.`);
            const value = Number(raw);
            if (!Number.isFinite(value)) throw new Error(`${label} must be a valid number.`);
            if (options.integer && !Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
            return value;
        }

        function toolsCalculatorPayload() {
            if (activeToolsCalculator === 'position') {
                return {
                    endpoint: '/api/tools/position-size',
                    payload: {
                        account_value: toolsCalculatorNumber('tools-position-account', 'Account value'),
                        risk_percent: toolsCalculatorNumber('tools-position-risk', 'Risk per trade'),
                        entry_price: toolsCalculatorNumber('tools-position-entry', 'Entry price'),
                        stop_price: toolsCalculatorNumber('tools-position-stop', 'Stop price'),
                        side: document.getElementById('tools-position-side').value,
                        max_position_percent: toolsCalculatorNumber('tools-position-max', 'Maximum exposure'),
                    },
                };
            }
            if (activeToolsCalculator === 'move') {
                return {
                    endpoint: '/api/tools/expected-move',
                    payload: {
                        price: toolsCalculatorNumber('tools-move-price', 'Underlying price'),
                        implied_volatility_percent: toolsCalculatorNumber('tools-move-iv', 'Implied volatility'),
                        days: toolsCalculatorNumber('tools-move-days', 'Days to expiry'),
                        days_per_year: toolsCalculatorNumber('tools-move-days-year', 'Days per year'),
                    },
                };
            }
            if (activeToolsCalculator === 'probability') {
                return {
                    endpoint: '/api/tools/probability',
                    payload: {
                        spot_price: toolsCalculatorNumber('tools-probability-spot', 'Spot price'),
                        target_price: toolsCalculatorNumber('tools-probability-target', 'Target price'),
                        implied_volatility_percent: toolsCalculatorNumber('tools-probability-iv', 'Implied volatility'),
                        days: toolsCalculatorNumber('tools-probability-days', 'Days to target'),
                        risk_free_rate_percent: toolsCalculatorNumber('tools-probability-rate', 'Risk-free rate'),
                        dividend_yield_percent: toolsCalculatorNumber('tools-probability-dividend', 'Dividend yield'),
                        days_per_year: toolsCalculatorNumber('tools-probability-days-year', 'Days per year'),
                    },
                };
            }
            if (activeToolsCalculator === 'growth') {
                const mode = document.getElementById('tools-growth-mode').value === 'dca' ? 'dca' : 'compound';
                const initial = toolsCalculatorNumber('tools-growth-initial', 'Initial investment');
                const contribution = toolsCalculatorNumber('tools-growth-contribution', 'Periodic contribution');
                const rate = toolsCalculatorNumber('tools-growth-rate', 'Annual rate');
                const years = toolsCalculatorNumber('tools-growth-years', 'Years');
                const frequency = toolsCalculatorNumber('tools-growth-frequency', 'Compounds per year', { integer: true });
                const timing = document.getElementById('tools-growth-timing').value;
                return mode === 'dca'
                    ? {
                        endpoint: '/api/tools/dca',
                        payload: {
                            initial_investment: initial,
                            periodic_contribution: contribution,
                            annual_return_percent: rate,
                            years,
                            contributions_per_year: frequency,
                            contribution_timing: timing,
                        },
                    }
                    : {
                        endpoint: '/api/tools/compound',
                        payload: {
                            initial_investment: initial,
                            annual_rate_percent: rate,
                            years,
                            periodic_contribution: contribution,
                            compounds_per_year: frequency,
                            contribution_timing: timing,
                        },
                    };
            }

            const currentPrice = toolsCalculatorNumber('tools-fair-price', 'Current price', { optional: true });
            const payload = {
                free_cash_flow_per_share: toolsCalculatorNumber('tools-fair-fcf', 'Free cash flow per share'),
                growth_rate_percent: toolsCalculatorNumber('tools-fair-growth', 'Growth rate'),
                discount_rate_percent: toolsCalculatorNumber('tools-fair-discount', 'Discount rate'),
                terminal_growth_rate_percent: toolsCalculatorNumber('tools-fair-terminal', 'Terminal growth'),
                projection_years: toolsCalculatorNumber('tools-fair-years', 'Projection years', { integer: true }),
                margin_of_safety_percent: toolsCalculatorNumber('tools-fair-safety', 'Margin of safety'),
            };
            if (currentPrice !== undefined) payload.current_price = currentPrice;
            return { endpoint: '/api/tools/fair-value', payload };
        }

        function toolsCalculatorDisplayNumber(value, digits = 2) {
            const number = Number(value);
            return Number.isFinite(number) ? number.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: digits,
            }) : '—';
        }

        function toolsCalculatorDisplayMoney(value) {
            const number = Number(value);
            return Number.isFinite(number) ? `$${number.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}` : '—';
        }

        function toolsCalculatorDisplayPercent(value, signed = false) {
            const number = Number(value);
            if (!Number.isFinite(number)) return '—';
            return `${signed && number >= 0 ? '+' : ''}${toolsCalculatorDisplayNumber(number, 2)}%`;
        }

        function hideToolsCalculatorResult() {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = true;
            host.classList.remove('is-error');
            host.replaceChildren();
        }

        function showToolsCalculatorMessage(title, message, isError = false) {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = false;
            host.classList.toggle('is-error', isError);
            host.replaceChildren();
            const heading = document.createElement('p');
            heading.className = isError ? 'pt-tools-result-error' : 'pt-tools-result-title';
            heading.textContent = title;
            const copy = document.createElement('p');
            copy.className = isError ? 'pt-tools-result-error' : 'pt-tools-result-summary';
            copy.textContent = message;
            host.append(heading, copy);
        }

        function showToolsCalculatorResult(title, summary, metrics, note = '') {
            const host = document.getElementById('tools-calculator-result');
            if (!host) return;
            host.hidden = false;
            host.classList.remove('is-error');
            host.replaceChildren();

            const heading = document.createElement('p');
            heading.className = 'pt-tools-result-title';
            heading.textContent = title;
            const copy = document.createElement('p');
            copy.className = 'pt-tools-result-summary';
            copy.textContent = summary;
            const grid = document.createElement('div');
            grid.className = 'pt-tools-result-grid';
            metrics.forEach(metric => {
                const card = document.createElement('div');
                card.className = `pt-tools-result-metric${metric.tone ? ` ${metric.tone}` : ''}`;
                const label = document.createElement('span');
                label.textContent = metric.label;
                const value = document.createElement('strong');
                value.textContent = metric.value;
                card.append(label, value);
                grid.appendChild(card);
            });
            host.append(heading, copy, grid);
            if (note) {
                const noteEl = document.createElement('p');
                noteEl.className = 'pt-tools-result-summary';
                noteEl.textContent = note;
                host.appendChild(noteEl);
            }
        }

        function toolsCalculatorErrorMessage(data, fallback) {
            if (!data) return fallback;
            if (typeof data.detail === 'string') return data.detail;
            if (typeof data.message === 'string') return data.message;
            if (Array.isArray(data.detail)) {
                const details = data.detail.map(item => item && (item.msg || item.message)).filter(Boolean);
                if (details.length) return details.join(' ');
            }
            return fallback;
        }

        function renderToolsCalculatorResponse(data, calculator) {
            if (calculator === 'position') {
                const capped = Boolean(data.is_capped_by_max_position);
                showToolsCalculatorResult(
                    'Position sizing result',
                    capped ? 'The risk-based quantity was capped by your maximum exposure setting.' : 'Quantity is sized from the stop-loss risk budget you supplied.',
                    [
                        { label: 'Recommended units', value: toolsCalculatorDisplayNumber(data.recommended_quantity, 0) },
                        { label: 'Position value', value: toolsCalculatorDisplayMoney(data.position_value) },
                        { label: 'Max loss at stop', value: toolsCalculatorDisplayMoney(data.max_loss_at_stop), tone: 'negative' },
                        { label: 'Risk budget used', value: toolsCalculatorDisplayPercent(data.risk_budget_used_percent) },
                    ],
                    `Risk per unit: ${toolsCalculatorDisplayMoney(data.risk_per_unit)} · Exposure cap: ${toolsCalculatorDisplayMoney(data.maximum_position_value)}`
                );
                return;
            }
            if (calculator === 'move') {
                showToolsCalculatorResult(
                    'One-standard-deviation expected move',
                    'Range is derived from the IV and time horizon supplied; it is not a prediction of direction.',
                    [
                        { label: 'Expected move', value: toolsCalculatorDisplayMoney(data.expected_move) },
                        { label: 'Expected move', value: toolsCalculatorDisplayPercent(data.expected_move_percent) },
                        { label: 'Lower bound', value: toolsCalculatorDisplayMoney(data.lower_bound), tone: 'negative' },
                        { label: 'Upper bound', value: toolsCalculatorDisplayMoney(data.upper_bound), tone: 'positive' },
                    ]
                );
                return;
            }
            if (calculator === 'probability') {
                showToolsCalculatorResult(
                    'Risk-neutral probability',
                    'This is a lognormal model assumption, not a directional price forecast.',
                    [
                        { label: 'Above target', value: toolsCalculatorDisplayPercent(data.probability_above_percent), tone: 'positive' },
                        { label: 'Below / at target', value: toolsCalculatorDisplayPercent(data.probability_below_or_equal_percent), tone: 'negative' },
                        { label: 'Forward price', value: toolsCalculatorDisplayMoney(data.forward_price) },
                        { label: 'Model', value: String(data.model || '—').replace(/_/g, ' ') },
                    ],
                    data.assumption || ''
                );
                return;
            }
            if (calculator === 'growth') {
                const isDca = toolsGrowthMode === 'dca';
                const schedule = Array.isArray(data.schedule) && data.schedule.length ? data.schedule[data.schedule.length - 1] : null;
                showToolsCalculatorResult(
                    isDca ? 'DCA projection' : 'Compound growth projection',
                    'Projection uses the return, contribution cadence, and timing you supplied.',
                    [
                        { label: 'Future value', value: toolsCalculatorDisplayMoney(data.future_value), tone: 'positive' },
                        { label: 'Total invested', value: toolsCalculatorDisplayMoney(data.total_invested) },
                        { label: 'Investment gain', value: toolsCalculatorDisplayMoney(data.investment_gain), tone: Number(data.investment_gain) >= 0 ? 'positive' : 'negative' },
                        { label: isDca ? 'Periods' : 'Effective annual rate', value: isDca ? toolsCalculatorDisplayNumber(data.periods, 0) : toolsCalculatorDisplayPercent(data.effective_annual_rate_percent) },
                    ],
                    schedule ? `Latest schedule point: year ${toolsCalculatorDisplayNumber(schedule.year, 2)} · ${toolsCalculatorDisplayMoney(schedule.portfolio_value)}` : ''
                );
                return;
            }

            const upside = Number(data.upside_downside_percent);
            showToolsCalculatorResult(
                'DCF fair value',
                'Two-stage DCF based only on the cash-flow and rate assumptions you supplied.',
                [
                    { label: 'Fair value / share', value: toolsCalculatorDisplayMoney(data.fair_value_per_share), tone: 'positive' },
                    { label: 'After safety margin', value: toolsCalculatorDisplayMoney(data.value_after_margin_of_safety) },
                    { label: 'Current price', value: toolsCalculatorDisplayMoney(data.current_price) },
                    { label: 'Upside / downside', value: toolsCalculatorDisplayPercent(data.upside_downside_percent, true), tone: Number.isFinite(upside) ? (upside >= 0 ? 'positive' : 'negative') : '' },
                ],
                `Terminal present value: ${toolsCalculatorDisplayMoney(data.terminal_present_value)}`
            );
        }

        async function runToolsCalculator(event) {
            event.preventDefault();
            const requestVersion = ++toolsCalculatorRequestVersion;
            const calculator = activeToolsCalculator;
            let request;
            try {
                request = toolsCalculatorPayload();
            } catch (error) {
                showToolsCalculatorMessage('Check calculator inputs', error.message || 'Enter valid values and try again.', true);
                return;
            }

            if (toolsCalculatorAbortController && !toolsCalculatorAbortController.signal.aborted) {
                toolsCalculatorAbortController.abort();
            }
            const controller = new AbortController();
            toolsCalculatorAbortController = controller;
            const submit = document.getElementById('tools-calculator-submit');
            if (submit) submit.disabled = true;
            showToolsCalculatorMessage('Calculating', 'Validating assumptions with the calculator service…');

            try {
                const response = await fetch(request.endpoint, {
                    method: 'POST',
                    headers: authHeaders(true),
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                    body: JSON.stringify(request.payload),
                });
                const data = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(toolsCalculatorErrorMessage(data, `Calculator request failed (${response.status}).`));
                }
                if (requestVersion !== toolsCalculatorRequestVersion || calculator !== activeToolsCalculator) return;
                renderToolsCalculatorResponse(data || {}, calculator);
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                if (requestVersion !== toolsCalculatorRequestVersion || calculator !== activeToolsCalculator) return;
                showToolsCalculatorMessage('Calculator unavailable', error.message || 'Unable to calculate right now. Please try again.', true);
            } finally {
                if (toolsCalculatorAbortController === controller) toolsCalculatorAbortController = null;
                if (requestVersion === toolsCalculatorRequestVersion && submit) submit.disabled = false;
            }
        }

        let simulatorInFlight = false;
        async function runSimulator() {
            if (simulatorInFlight) return;
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

            simulatorInFlight = true;
            const submit = document.querySelector('[onclick="runSimulator()"]');
            let simulatorFailed = false;
            if (submit) setTerminalButtonBusy(submit, true, 'Calculating…');
            try {
                const res = await fetch('/api/simulate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const responsePayload = await res.json().catch(() => null);
                const data = responsePayload && typeof responsePayload === 'object' ? responsePayload : {};
                const hasSimulationResult = Number.isFinite(Number(data.simulated_premium));
                if (typeof data.error === 'string') data.error = escapeHtml(data.error);
                if (data.detail !== undefined) data.detail = escapeHtml(JSON.stringify(data.detail));
                ['break_even', 'simulated_premium', 'pnl_total', 'pnl_percent', 'days_remaining'].forEach(key => {
                    const value = Number(data[key]);
                    data[key] = Number.isFinite(value) ? value : '—';
                });

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
                if (!res.ok || !hasSimulationResult) {
                    resDiv.innerHTML = `<span style="color:var(--red); font-weight:bold;">⚠️ เชื่อมต่อ API ล้มเหลว กรุณาตรวจสอบการตั้งค่าเซิร์ฟเวอร์</span>`;
                    return;
                }

                recordCloudActivity('/api/simulation-history', {
                    ticker: currentTicker,
                    simulation_type: 'what_if',
                    input_data: payload,
                    result_data: data,
                });

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
                simulatorFailed = true;
                reportQuantoraError(err, { area: 'simulator' });
            } finally {
                simulatorInFlight = false;
                if (submit) setTerminalButtonBusy(submit, false);
                if (!simulatorFailed) return;
                alert("ไม่สามารถติดต่อเซิร์ฟเวอร์ได้");
            }
        }
