// Quantora application-shell module: boot
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        const loggedBootstrapErrors = new WeakSet();

        function bootstrapHttpDetails(error) {
            if (!error || typeof error !== 'object') return null;
            const status = error.httpStatus ?? error.status;
            const body = error.responseBody ?? error.body;
            const url = error.responseUrl ?? error.url;
            if (status === undefined && body === undefined && url === undefined) return null;
            return { status: status ?? null, url: url ?? null, body: body ?? null };
        }

        function logBootstrapFailure(step, error, observedResponses = []) {
            const exception = error instanceof Error ? error : new Error(String(error));
            // This intentionally goes straight to the browser console. The
            // normal client reporter is opt-in, which made a boot failure
            // impossible to diagnose in a production browser.
            console.warn('[Quantora bootstrap failed]', {
                step,
                name: exception.name,
                message: exception.message,
                stack: exception.stack || null,
                http: bootstrapHttpDetails(error) || observedResponses,
            });
        }

        async function runBootstrapStep(step, operation) {
            const originalFetch = window.fetch;
            const observedResponses = [];
            window.fetch = async (...args) => {
                const response = await originalFetch(...args);
                if (!response.ok) {
                    let body;
                    try {
                        body = await response.clone().text();
                    } catch (bodyError) {
                        body = `[Response body could not be read: ${bodyError.message || bodyError}]`;
                    }
                    observedResponses.push({
                        url: response.url,
                        status: response.status,
                        statusText: response.statusText,
                        body,
                    });
                }
                return response;
            };
            try {
                return await operation();
            } catch (error) {
                logBootstrapFailure(step, error, observedResponses);
                if (error && typeof error === 'object') loggedBootstrapErrors.add(error);
                reportQuantoraError(error, { area: `bootstrap:${step}` });
                throw error;
            } finally {
                window.fetch = originalFetch;
            }
        }

        async function bootTerminal() {
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).then(registration => {
                    return registration.update();
                }).catch(error => {
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
                await runBootstrapStep('loadAuthSession', () => loadAuthSession());
                await runBootstrapStep('prepareTerminalWorkspaceRestore', () => prepareTerminalWorkspaceRestore());
                await runBootstrapStep('applyRouteFromLocation', () => applyRouteFromLocation());
                const initialRoute = currentTerminalRoute();
                await runBootstrapStep('loadRouteModule', () => loadRouteModule(
                    Object.prototype.hasOwnProperty.call(ROUTE_MODULE_IMPORTERS, initialRoute) ? initialRoute : null
                ));
                if (typeof renderIndicatorsPanel === 'function') renderIndicatorsPanel();
                if (typeof startChartAutoRefresh === 'function') startChartAutoRefresh();
                if (typeof startPortfolioAutoRefresh === 'function') startPortfolioAutoRefresh();
                await runBootstrapStep('finishTerminalWorkspaceRestore', () => finishTerminalWorkspaceRestore());
                setTerminalWorkspaceBooted();
            } catch (error) {
                if (!error || typeof error !== 'object' || !loggedBootstrapErrors.has(error)) {
                    logBootstrapFailure('bootTerminal', error);
                    reportQuantoraError(error, { area: 'bootstrap' });
                }
                showSystemScreen('Unable to start Quantora AI', 'Check your connection, then try loading the workspace again.');
                throw error;
            } finally {
                setInitialSkeletonLoading(false);
            }
        }
