// Quantora application-shell module: boot
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        async function bootTerminal() {
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/service-worker.js').catch(error => {
                    reportQuantoraError(error, { area: 'service-worker' });
                });
            }
            setInitialSkeletonLoading(true);
            setNetworkStatus(navigator.onLine);
            applyLanguage(userPreferences.language);
            const { loadClassicAsset } = await import('/assets/utils/load-classic.js');
            await loadClassicAsset('/assets/components/indicators.js');
            await loadClassicAsset('/assets/api/resilience.js');
            await loadClassicAsset('/assets/api/cache.js');
            installQuantoraFetchHardening();
            await loadClassicAsset('/assets/api/auth.js');
            installQuantoraStateBindings();
            await consumeAuthHash();
            try {
                await loadAuthSession();
                prepareTerminalWorkspaceRestore();
                applyRouteFromLocation();
                const initialRoute = currentTerminalRoute();
                await loadRouteModule(Object.prototype.hasOwnProperty.call(ROUTE_MODULE_IMPORTERS, initialRoute) ? initialRoute : null);
                if (typeof renderIndicatorsPanel === 'function') renderIndicatorsPanel();
                if (typeof startChartAutoRefresh === 'function') startChartAutoRefresh();
                if (typeof startPortfolioAutoRefresh === 'function') startPortfolioAutoRefresh();
                await finishTerminalWorkspaceRestore();
                setTerminalWorkspaceBooted();
            } catch (error) {
                reportQuantoraError(error, { area: 'bootstrap' });
                showSystemScreen('Unable to start Quantora AI', 'Check your connection, then try loading the workspace again.');
            } finally {
                setInitialSkeletonLoading(false);
            }
        }
