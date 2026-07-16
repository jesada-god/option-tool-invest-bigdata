        // --- 🔮 What-If Simulator Logic ---
        function stopLiveSocketWatchdog() {
            if (wsWatchdogTimer) {
                clearInterval(wsWatchdogTimer);
                wsWatchdogTimer = null;
            }
        }

        let queuedLiveQuote = null;
        let liveQuoteAnimationFrame = null;

        function clearQueuedLiveQuote() {
            queuedLiveQuote = null;
            if (liveQuoteAnimationFrame !== null) {
                window.cancelAnimationFrame(liveQuoteAnimationFrame);
                liveQuoteAnimationFrame = null;
            }
        }

        function queueLiveQuote(data, context) {
            queuedLiveQuote = { data, context };
            if (liveQuoteAnimationFrame !== null) return;
            liveQuoteAnimationFrame = window.requestAnimationFrame(() => {
                liveQuoteAnimationFrame = null;
                const next = queuedLiveQuote;
                queuedLiveQuote = null;
                if (next) applyLiveQuote(next.data, next.context);
            });
        }

        function closeLivePriceSocket(resetRetries = true) {
            clearQueuedLiveQuote();
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            stopLiveSocketWatchdog();
            if (resetRetries) wsReconnectAttempts = 0;
            wsConnectionEpoch += 1;
            if (!ws) return;

            const socket = ws;
            ws = null;
            socket.onopen = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close(1000, 'Client reconnecting');
            }
        }

        function canRunLiveFeed(context) {
            return isCurrentView(context) && isNetworkOnline && currentMarketSession === 'REGULAR';
        }

        function scheduleLivePriceReconnect(context) {
            if (wsReconnectTimer || !canRunLiveFeed(context)) return;
            if (typeof incrementQuantoraMetric === 'function') incrementQuantoraMetric('websocketReconnects');
            const baseDelay = Math.min(1000 * (2 ** wsReconnectAttempts), 30000);
            const delay = Math.round(baseDelay * (0.85 + Math.random() * 0.3));
            wsReconnectAttempts = Math.min(wsReconnectAttempts + 1, 5);
            wsReconnectTimer = window.setTimeout(() => {
                wsReconnectTimer = null;
                if (canRunLiveFeed(context)) initWebSocket(context);
            }, delay);
        }

        function startLiveSocketWatchdog(socket, context, connectionId) {
            stopLiveSocketWatchdog();
            wsWatchdogTimer = window.setInterval(() => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) {
                    stopLiveSocketWatchdog();
                    return;
                }
                if (!isNetworkOnline || Date.now() - wsLastMessageAt <= 20000) return;
                socket.close(4000, 'Live quote heartbeat timed out');
            }, 5000);
        }

        function applyLiveQuote(data, context) {
            if (!isCurrentView(context) || !data || data.ticker !== context.ticker) return;
            if (data.market_session) currentMarketSession = data.market_session;
            const newPrice = Number(data.price);
            const isValidPrice = Number.isFinite(newPrice) && newPrice > 0;
            const lastPrice = currentLivePrice;
            const priceDisplay = document.getElementById('live-price');

            if (priceDisplay) {
                if (data.stale) {
                    priceDisplay.dataset.stale = 'true';
                    priceDisplay.title = 'Last known polling price. The market-data provider is temporarily unavailable.';
                } else {
                    priceDisplay.removeAttribute('data-stale');
                    priceDisplay.title = `${data.provider || 'Market data'} polling update`;
                }
            }

            if (currentMarketSession !== 'REGULAR') {
                updateHomeMarketSurface({ current_price: isValidPrice ? newPrice : currentLivePrice, prev_close: currentPrevClose, market_session: currentMarketSession });
                closeLivePriceSocket();
                return;
            }
            if (!isValidPrice) return;

            currentLivePrice = newPrice;
            const quoteDirection = Number.isFinite(lastPrice) && currentLivePrice !== lastPrice ? (currentLivePrice > lastPrice ? 'up' : 'down') : '';
            if (priceDisplay) {
                priceDisplay.innerText = `$${currentLivePrice.toFixed(2)}`;
                priceDisplay.style.color = Number.isFinite(lastPrice)
                    ? (currentLivePrice >= lastPrice ? 'var(--green)' : 'var(--red)')
                    : 'var(--pt-white)';
                if (quoteDirection) {
                    priceDisplay.removeAttribute('data-quote-direction');
                    requestAnimationFrame(() => { if (priceDisplay.isConnected) priceDisplay.dataset.quoteDirection = quoteDirection; });
                }
            }
            updatePriceChangeDisplay();
            announceLivePrice?.(`$${currentLivePrice.toFixed(2)}`, context.ticker, document.getElementById('price-change')?.textContent?.trim());
            updateHomeMarketSurface({ current_price: currentLivePrice, prev_close: currentPrevClose, market_session: currentMarketSession, quote_direction: quoteDirection });
            recomputeSRDistances(currentLivePrice);

            if (globalChartData.length > 0) {
                const lastData = globalChartData[globalChartData.length - 1];
                lastData.close = currentLivePrice;
                if (currentLivePrice > lastData.high) lastData.high = currentLivePrice;
                if (currentLivePrice < lastData.low) lastData.low = currentLivePrice;
                candleSeries.update(lastData);
                updateLiveEMASeries(lastData);
            }

            activePositions.forEach(position => {
                if (position.ticker !== currentTicker) return;
                const entryUnderlying = parseFloat(position.entry_underlying_price);
                const initialPremium = parseFloat(position.premium_paid);
                if (!Number.isFinite(entryUnderlying) || !Number.isFinite(initialPremium)) return;
                let currentPremium = initialPremium;
                if (position.delta && parseFloat(position.delta) !== 0) {
                    let delta = parseFloat(position.delta);
                    if (position.option_type === 'PUT' && delta > 0) delta = -delta;
                    currentPremium = initialPremium + (delta * (currentLivePrice - entryUnderlying));
                } else if (position.option_type === 'CALL') {
                    currentPremium += (currentLivePrice - entryUnderlying) * 0.5;
                } else {
                    currentPremium += (entryUnderlying - currentLivePrice) * 0.5;
                }
                currentPremium = Math.max(currentPremium, 0.01);
                const pnl = (currentPremium - initialPremium) * 100 * position.quantity;
                const principal = initialPremium * position.quantity * 100;
                const pnlPercent = principal > 0 ? (pnl / principal) * 100 : 0;
                position.current_underlying_price = currentLivePrice;
                position.current_option_premium = currentPremium;
                position.pnl = pnl;
                position.pnl_percent = pnlPercent;
                const cellPrice = document.getElementById(`table-underlying-${position.id}`);
                const cellPnl = document.getElementById(`table-pnl-${position.id}`);
                const cellSellPrice = document.getElementById(`table-sellprice-${position.id}`);
                if (cellPrice) cellPrice.innerText = `$${currentLivePrice.toFixed(2)}`;
                if (cellSellPrice) cellSellPrice.innerText = `$${currentPremium.toFixed(2)}`;
                if (cellPnl) {
                    const sign = pnl >= 0 ? '+' : '';
                    cellPnl.innerHTML = `${sign}$${pnl.toFixed(2)} <span style="font-size:12px;">(${sign}${pnlPercent.toFixed(2)}%)</span>`;
                    cellPnl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
                    pulseTerminalElement(cellPnl, pnl >= 0 ? 'pnl-flash-up' : 'pnl-flash-down');
                }
            });
            updateHomePortfolioSurface();
        }

        function initWebSocket(context = currentViewContext()) {
            if (!canRunLiveFeed(context)) return;
            closeLivePriceSocket(false);
            const connectionId = ++wsConnectionEpoch;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/price/${encodeURIComponent(context.ticker)}`;
            let socket;
            try {
                socket = new WebSocket(wsUrl);
            } catch (err) {
                reportQuantoraError(err, { area: 'websocket-connect' });
                scheduleLivePriceReconnect(context);
                return;
            }
            ws = socket;
            wsLastSequence = 0;
            wsLastMessageAt = Date.now();

            socket.onopen = () => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) {
                    socket.close(1000, 'Stale connection');
                    return;
                }
                wsReconnectAttempts = 0;
                wsLastMessageAt = Date.now();
                startLiveSocketWatchdog(socket, context, connectionId);
            };

            socket.onmessage = event => {
                if (socket !== ws || connectionId !== wsConnectionEpoch || !isCurrentView(context)) return;
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    reportQuantoraError(err, { area: 'websocket-payload' });
                    return;
                }
                if (!data || data.type !== 'quote' || data.ticker !== context.ticker) return;
                const sequence = Number(data.seq);
                if (Number.isFinite(sequence) && sequence <= wsLastSequence) return;
                if (Number.isFinite(sequence)) wsLastSequence = sequence;
                wsLastMessageAt = Date.now();
                queueLiveQuote(data, context);
            };

            socket.onerror = () => {
                if (socket === ws && connectionId === wsConnectionEpoch) socket.close();
            };

            socket.onclose = () => {
                if (socket !== ws || connectionId !== wsConnectionEpoch) return;
                ws = null;
                stopLiveSocketWatchdog();
                scheduleLivePriceReconnect(context);
            };
        }

        async function reconcileLiveState() {
            if (!isNetworkOnline || !['home', 'analysis'].includes(currentTerminalRoute())) return;
            const context = currentViewContext();
            try {
                const res = await fetch(`/api/quote?ticker=${encodeURIComponent(context.ticker)}`, { cache: 'no-store' });
                if (res.ok) {
                    const quote = await res.json();
                    if (isCurrentView(context)) queueLiveQuote(quote, context);
                }
            } catch (err) {
                reportQuantoraError(err, { area: 'websocket-reconcile' });
            }
            if (isCurrentView(context)) fetchDashboardData();
        }

        function requestTerminalResync(delay = 0) {
            if (terminalResyncTimer) clearTimeout(terminalResyncTimer);
            terminalResyncTimer = window.setTimeout(() => {
                terminalResyncTimer = null;
                reconcileLiveState();
            }, delay);
        }

        document.addEventListener('visibilitychange', () => {
            isPageVisible = document.visibilityState === 'visible';
            if (isPageVisible) {
                requestTerminalResync();
                if (alertCenterEnabled()) {
                    void refreshAlertCenter({ quiet: true });
                    startAlertCenterPolling();
                }
            } else {
                stopAlertCenterPolling();
            }
        });
        window.addEventListener('online', () => {
            isNetworkOnline = true;
            requestTerminalResync();
            if (alertCenterEnabled()) {
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        });
        window.addEventListener('offline', () => {
            isNetworkOnline = false;
            closeLivePriceSocket(false);
            stopAlertCenterPolling();
        });
        window.addEventListener('pagehide', () => {
            closeLivePriceSocket(false);
            invalidateViewRequests();
            if (portfolioPresentationAbortController) portfolioPresentationAbortController.abort();
            stopAlertCenterPolling();
            if (portfolioRefreshTimer) clearInterval(portfolioRefreshTimer);
        });
        window.addEventListener('pageshow', () => {
            isPageVisible = true;
            isNetworkOnline = navigator.onLine;
            requestTerminalResync();
            startPortfolioAutoRefresh();
            if (alertCenterEnabled()) {
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        });

        // --- Calculator desk -------------------------------------------------
        // These inputs deliberately stay in the current page only.  The server
        // validates every value again and no calculator value is persisted.
        let activeToolsCalculator = 'position';
        let toolsGrowthMode = 'compound';
        let toolsCalculatorAbortController = null;
        let toolsCalculatorRequestVersion = 0;

