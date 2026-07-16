        // --- 🚀 Phase 5: Advanced Multi-Scenario Monte Carlo Simulator -----
        let scenarioCount = 0;
        let advancedSimulatorInFlight = false;

        function addScenarioCard() {
            scenarioCount++;
            const id = scenarioCount;
            const container = document.getElementById('scenario-cards');
            const card = document.createElement('div');
            card.className = 'scenario-card';
            card.id = `scenario-${id}`;
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <input type="text" class="sc-label" aria-label="Scenario ${id} name" value="Scenario ${id}" style="background:transparent; border:none; color:var(--gold); font-weight:bold; font-size:14px; width:150px;">
                    <button type="button" aria-label="Remove scenario ${id}" onclick="document.getElementById('scenario-${id}').remove()" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:16px;">✕</button>
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
            if (advancedSimulatorInFlight) return;
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
            const runButton = document.getElementById('advanced-sim-run');
            advancedSimulatorInFlight = true;
            if (runButton) runButton.disabled = true;
            resDiv.replaceChildren();
            const loading = document.createElement('span');
            loading.style.color = 'var(--text-muted)';
            loading.textContent = '⏳ กำลังรัน Monte Carlo...';
            resDiv.appendChild(loading);

            try {
                const res = await fetch('/api/simulate-advanced', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: currentTicker, scenarios })
                });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || data.error) {
                    throw new Error(toolsCalculatorErrorMessage(data, `Monte Carlo request failed (${res.status}).`));
                }
                if (!Array.isArray(data.results)) throw new Error('Monte Carlo returned an invalid result set.');
                recordCloudActivity('/api/simulation-history', {
                    ticker: currentTicker,
                    simulation_type: 'advanced_monte_carlo',
                    input_data: { scenarios },
                    result_data: { results: data.results },
                });

                const rows = data.results.map(r => {
                    const expectedPl = Number(r.expected_pl);
                    const color = Number.isFinite(expectedPl) && expectedPl >= 0 ? 'var(--green)' : 'var(--red)';
                    return `<tr>
                        <td>${escapeHtml(r.label)}</td>
                        <td>${Number(r.n_sims).toLocaleString()}</td>
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
                    <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Underlying (${escapeHtml(data.ticker)}): <strong style="color:white;">$${data.underlying_price}</strong></div>
                    <div class="table-responsive">
                    <table class="scenario-result-table" aria-label="Advanced Monte Carlo simulation results">
                        <caption class="sr-only">Advanced Monte Carlo simulation results</caption>
                        <thead><tr>
                            <th scope="col">Scenario</th><th scope="col">Paths</th><th scope="col">Exp. S</th><th scope="col">Exp. Option</th><th scope="col">Exp. P&L</th>
                            <th scope="col">POP</th><th scope="col">Worst</th><th scope="col">Best</th><th scope="col">95% CI</th><th scope="col">Δ</th><th scope="col">Θ/day</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    </div>`;
            } catch (err) {
                reportQuantoraError(err, { area: 'advanced-simulator' });
                resDiv.replaceChildren();
                const error = document.createElement('span');
                error.setAttribute('role', 'alert');
                error.style.color = 'var(--red)';
                error.textContent = `⚠️ ${err && err.message ? err.message : 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้'}`;
                resDiv.appendChild(error);
            } finally {
                advancedSimulatorInFlight = false;
                if (runButton) runButton.disabled = false;
            }
        }

