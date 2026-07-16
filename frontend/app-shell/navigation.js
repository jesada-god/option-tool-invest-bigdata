// Quantora application-shell module: navigation
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        function setActiveNavigation(target) {
            document.querySelectorAll('.pt-nav-item').forEach(item => {
                item.classList.toggle('is-active', item.dataset.nav === target);
            });
        }

        function navigateTerminal(target, source, suppressRouteUpdate = false) {
            if (target === 'profile') {
                setActiveNavigation('profile');
                openProfileSheet();
                if (!suppressRouteUpdate && window.location.hash !== '#/profile') window.location.hash = '#/profile';
                return;
            }

            const targets = {
                home: 'home-section',
                watchlist: 'watchlist-row',
                search: 'search-input',
                analysis: 'tvchart',
                tools: 'tools-section',
                portfolio: 'portfolio-section',
            };
            const targetEl = document.getElementById(targets[target]);
            if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            void loadRouteModule(target).catch(error => reportQuantoraError(error, { area: `route:${target}` }));

            if (target === 'search') {
                setActiveNavigation('search');
                window.setTimeout(() => searchInput.focus({ preventScroll: true }), 220);
            } else if (target !== 'analysis') {
                setActiveNavigation(target);
            }

            if (source) setActiveNavigation(source.dataset.nav || target);
            if (!suppressRouteUpdate && window.location.hash !== `#/${target}`) window.location.hash = `#/${target}`;
        }

