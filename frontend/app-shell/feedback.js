// Quantora application-shell module: presentation feedback helpers.
// These helpers do not own application state; they only reflect outcomes from
// the existing route and portfolio flows.

        let terminalToastTimer = null;

        function showTerminalToast(message, tone = 'success') {
            if (!message) return;
            let region = document.getElementById('terminal-toast-region');
            if (!region) {
                region = document.createElement('div');
                region.id = 'terminal-toast-region';
                region.className = 'pt-toast-region';
                region.setAttribute('aria-live', 'polite');
                region.setAttribute('aria-atomic', 'true');
                document.body.appendChild(region);
            }
            const toast = document.createElement('div');
            toast.className = `pt-toast pt-toast-${tone === 'error' ? 'error' : 'success'}`;
            toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
            toast.textContent = message;
            region.replaceChildren(toast);
            requestAnimationFrame(() => toast.classList.add('is-visible'));
            if (terminalToastTimer) clearTimeout(terminalToastTimer);
            terminalToastTimer = window.setTimeout(() => {
                toast.classList.remove('is-visible');
                window.setTimeout(() => { if (toast.parentElement) toast.remove(); }, 180);
            }, 3600);
        }

        function setTerminalButtonBusy(button, busy, label = 'Working…') {
            if (!button) return;
            if (busy) {
                if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
                button.disabled = true;
                button.dataset.busy = 'true';
                button.setAttribute('aria-busy', 'true');
                button.textContent = label;
                return;
            }
            button.disabled = false;
            button.removeAttribute('data-busy');
            button.removeAttribute('aria-busy');
            if (button.dataset.defaultLabel) button.textContent = button.dataset.defaultLabel;
            delete button.dataset.defaultLabel;
        }

        function pulseTerminalElement(element, className) {
            if (!element || !className) return;
            element.classList.remove(className);
            requestAnimationFrame(() => {
                if (element.isConnected) element.classList.add(className);
            });
        }

        document.addEventListener('click', event => {
            const trigger = event.target.closest('[data-copy-value]');
            if (!trigger || !navigator.clipboard) return;
            const value = trigger.dataset.copyValue;
            if (!value) return;
            navigator.clipboard.writeText(value).then(() => {
                const original = trigger.textContent;
                trigger.textContent = 'Copied';
                showTerminalToast('Copied to clipboard.');
                window.setTimeout(() => { if (trigger.isConnected) trigger.textContent = original; }, 1300);
            }).catch(() => showTerminalToast('Could not copy that value.', 'error'));
        });
