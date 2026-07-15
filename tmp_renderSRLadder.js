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
                    ? `<div class="sr-zone-range">โซน ${formatPrice(item.zone_low)} - ${formatPrice(item.zone_high)}</div>` : '';
                const reasons = (item.reasons || []).join(' | ').replace(/"/g, '&quot;');
                const confColor = srConfidenceColor(item.confidence);
                const strengthTxt = (item.strength !== null && item.strength !== undefined) ? `${item.strength}%` : 'N/A';
                return `<div class="sr-row ${type} ${near ? 'near' : ''}" title="${reasons}">
<span class="sr-label" style="color:${labelColor}">${item.label}</span>
<div class="sr-main">
    <span class="sr-price">${formatPrice(item.level)} <span class="sr-eta">${item.distance_pct}%${item.eta ? ' · ' + item.eta : ''}</span></span>
    ${zoneRange}
</div>
<span class="sr-strength-badge" style="background:${confColor}22; color:${confColor};">${strengthTxt} · ${item.confidence || ''}</span>
</div>`;
            };

            const resistancesDesc = [...srData.resistance].reverse();
            let html = resistancesDesc.map(r => rowHtml(r, 'resistance')).join('');
            html += `<div class="sr-current-marker">💲 ราคาปัจจุบัน ${formatPrice(srData.current_price)}</div>`;
            html += srData.support.map(s => rowHtml(s, 'support')).join('');
            ladder.innerHTML = html;

            if (srData.closest_alert) {
                const c = srData.closest_alert;

                const isRes = c.label.startsWith('R');
                banner.style.display = 'block';
                banner.style.background = isRes ? 'rgba(255,59,48,0.12)' : 'rgba(0,197,127,0.12)';
                banner.style.color = isRes ? 'var(--red)' : 'var(--green)';
                banner.innerText = `🔔 ใกล้ถึง ${c.label} ที่ ${formatPrice(c.level)} (ห่าง ${Number.isFinite(c.distance_pct) ? c.distance_pct.toFixed(2) + '%' : '-'}, Strength ${Number.isFinite(c.strength) ? c.strength : '-'}% · ${c.confidence})${c.eta ? ' · คาดว่าอีกประมาณ ' + c.eta : ''}`;
            } else {
                banner.style.display = 'none';
            }
        }

        