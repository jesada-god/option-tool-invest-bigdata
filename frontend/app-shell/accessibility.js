// Accessibility enhancements. This module deliberately augments presentation
// semantics and keyboard behavior without owning application state.
        (function initializeTerminalAccessibility() {
            const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

            function visibleFocusable(container) {
                return [...container.querySelectorAll(focusableSelector)].filter(element => !element.hidden && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'));
            }

            function activeModal() {
                const nativeDialog = document.querySelector('dialog[open]');
                if (nativeDialog) return nativeDialog;
                const profile = document.getElementById('profile-sheet');
                if (profile?.classList.contains('is-open')) return profile.querySelector('[role="dialog"]');
                if (commandPaletteOpen && commandPalette && !commandPalette.hidden) return commandPalette;
                return null;
            }

            function trapModalFocus(event) {
                if (event.key !== 'Tab') return;
                const modal = activeModal();
                if (!modal) return;
                const controls = visibleFocusable(modal);
                if (!controls.length) { event.preventDefault(); return; }
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }

            function inferredControlLabel(control) {
                const nearbyLabel = control.closest('label')?.querySelector('span');
                return nearbyLabel?.textContent?.trim() || control.getAttribute('title') || control.getAttribute('placeholder') || control.name || control.id?.replace(/[-_]/g, ' ') || '';
            }

            function improveControls(root = document) {
                root.querySelectorAll('input, select, textarea').forEach(control => {
                    if (control.type === 'hidden' || control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby') || control.labels?.length) return;
                    const label = inferredControlLabel(control);
                    if (label) control.setAttribute('aria-label', label);
                });
                root.querySelectorAll('table').forEach((table, index) => {
                    table.querySelectorAll('thead th').forEach(header => header.setAttribute('scope', 'col'));
                    if (!table.querySelector('caption')) {
                        const caption = document.createElement('caption');
                        caption.className = 'sr-only';
                        caption.textContent = table.getAttribute('aria-label') || table.dataset.a11yCaption || `Data table ${index + 1}`;
                        table.prepend(caption);
                    }
                });
            }

            function improveTablist(tablist) {
                const tabs = [...tablist.querySelectorAll('[role="tab"]')];
                if (!tabs.length) return;
                const refresh = () => tabs.forEach(tab => { tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1; });
                refresh();
                tablist.addEventListener('click', () => window.requestAnimationFrame(refresh));
                tablist.addEventListener('keydown', event => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                    const current = Math.max(0, tabs.indexOf(document.activeElement));
                    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + direction + tabs.length) % tabs.length;
                    event.preventDefault();
                    tabs[next].focus();
                    tabs[next].click();
                });
            }

            let lastPriceAnnouncement = '';
            let lastPriceAnnouncementAt = 0;
            window.announceLivePrice = function announceLivePrice(price, ticker, change) {
                const message = `${ticker || 'Current'} price ${price || 'unavailable'}${change ? `, ${change}` : ''}`;
                if (message === lastPriceAnnouncement || Date.now() - lastPriceAnnouncementAt < 15000) return;
                const region = document.getElementById('live-price-announcement');
                if (!region) return;
                lastPriceAnnouncement = message;
                lastPriceAnnouncementAt = Date.now();
                region.textContent = message;
            };

            function initializeDocumentAccessibility() {
                improveControls();
                document.querySelectorAll('[role="tablist"]').forEach(improveTablist);
                const main = document.getElementById('main-content');
                if (main && !main.hasAttribute('tabindex')) main.tabIndex = -1;
                new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) improveControls(node);
                }))).observe(document.body, { childList: true, subtree: true });
            }

            document.addEventListener('keydown', trapModalFocus, true);
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                const profile = document.getElementById('profile-sheet');
                if (profile?.classList.contains('is-open')) { event.preventDefault(); closeProfileSheet?.(); }
            }, true);
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeDocumentAccessibility, { once: true });
            else initializeDocumentAccessibility();
        }());
