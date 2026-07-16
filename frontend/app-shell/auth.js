// Quantora application-shell module: auth
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        function authHeaders(includeJson = false) {
            const headers = {};
            if (includeJson) headers['Content-Type'] = 'application/json';
            // Prefer the readable double-submit cookie to cached state so a
            // token refreshed in another tab cannot cause a stale-token 403.
            const csrfCookie = document.cookie.split('; ').find(cookie => cookie.startsWith('pt_csrf='));
            const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice('pt_csrf='.length)) : authState.csrfToken;
            if (csrfToken) {
                authState.csrfToken = csrfToken;
                headers['X-CSRF-Token'] = csrfToken;
            }
            return headers;
        }



        function authClientValidation(email, password, confirmation, isSignUp) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'เธเธฃเธธเธ“เธฒเธเธฃเธญเธเธญเธตเน€เธกเธฅเนเธซเนเธ–เธนเธเธ•เนเธญเธ / Enter a valid email address.';
            if (!password || password.length < 8) return 'เธฃเธซเธฑเธชเธเนเธฒเธเธ•เนเธญเธเธกเธตเธญเธขเนเธฒเธเธเนเธญเธข 8 เธ•เธฑเธงเธญเธฑเธเธฉเธฃ / Use at least 8 characters.';
            if (isSignUp && password !== confirmation) return 'เธฃเธซเธฑเธชเธเนเธฒเธเธ—เธฑเนเธเธชเธญเธเธเนเธญเธเนเธกเนเธ•เธฃเธเธเธฑเธ / Password confirmation does not match.';
            return '';
        }

        function friendlyAuthError(error, email = '') {
            const raw = String(error?.message || error || 'Unable to complete authentication.');
            const normalized = raw.toLowerCase();
            if (/confirm|verify|not confirmed/.test(normalized)) {
                showVerificationAction(email);
                return 'เธเธฃเธธเธ“เธฒเธขเธทเธเธขเธฑเธเธญเธตเน€เธกเธฅเธเนเธญเธเน€เธเนเธฒเธชเธนเนเธฃเธฐเธเธ เนเธฅเนเธงเธเธ” Resend confirmation เนเธ”เนเธซเธฒเธเธขเธฑเธเนเธกเนเนเธ”เนเธฃเธฑเธเธญเธตเน€เธกเธฅ';
            }
            if (/already registered|already been registered|user already exists/.test(normalized)) return 'เธญเธตเน€เธกเธฅเธเธตเนเธกเธตเธเธฑเธเธเธตเธญเธขเธนเนเนเธฅเนเธง เธฅเธญเธเน€เธเนเธฒเธชเธนเนเธฃเธฐเธเธเธซเธฃเธทเธญเธฃเธตเน€เธเนเธ•เธฃเธซเธฑเธชเธเนเธฒเธ';
            if (/invalid login|invalid credentials|password/.test(normalized)) return 'เธญเธตเน€เธกเธฅเธซเธฃเธทเธญเธฃเธซเธฑเธชเธเนเธฒเธเนเธกเนเธ–เธนเธเธ•เนเธญเธ';
            if (/too many|rate limit|429/.test(normalized)) return 'เธฅเธญเธเนเธซเธกเนเธ เธฒเธขเธซเธฅเธฑเธเธชเธฑเธเธเธฃเธนเน เธฃเธฐเธเธเธเธณเธเธฑเธ”เธเธณเธเธงเธเธเธฃเธฑเนเธเน€เธเธทเนเธญเธเธงเธฒเธกเธเธฅเธญเธ”เธ เธฑเธข';
            if (/network|failed to fetch|temporarily unavailable/.test(normalized)) return 'เน€เธเธทเนเธญเธกเธ•เนเธญเธฃเธฐเธเธเนเธกเนเนเธ”เน เธเธฃเธธเธ“เธฒเธ•เธฃเธงเธเธชเธญเธเธญเธดเธเน€เธ—เธญเธฃเนเน€เธเนเธ•เนเธฅเนเธงเธฅเธญเธเนเธซเธกเน';
            return raw;
        }

        async function loadAuthSession() {
            const sessionEpoch = ++authSessionEpoch;
            const res = await authFetch('/api/auth/me', { cache: 'no-store' });
            if (sessionEpoch !== authSessionEpoch) return;
            if (res.status === 404) {
                authState = { ...authState, configured: false, authenticated: false, user: null, cloudSyncEnabled: false, configurationError: null, csrfToken: null };
            } else if (!res.ok) {
                const responseBody = await res.text();
                const error = new Error(`Account session request failed: HTTP ${res.status} ${res.statusText}.`);
                error.name = 'HttpResponseError';
                error.httpStatus = res.status;
                error.responseUrl = res.url;
                error.responseBody = responseBody;
                throw error;
            } else {
                const data = await res.json();
                if (sessionEpoch !== authSessionEpoch) return;
                const configurationError = typeof data.configuration_error === 'string' && data.configuration_error.trim()
                    ? data.configuration_error.trim()
                    : null;
                authState = {
                    ...authState,
                    configured: Boolean(data.auth_enabled ?? data.configured),
                    authenticated: Boolean(data.authenticated),
                    user: data.user || data.profile || null,
                    // A missing field is not a provider-disable signal.
                    // Keep the last known value so a partial/degraded
                    // auth response cannot remove the Google entry point.
                    googleEnabled: typeof data.google_enabled === 'boolean'
                        ? data.google_enabled
                        : authState.googleEnabled,
                    // An authenticated session remains valid when optional
                    // cloud provisioning is degraded. Keep the application in
                    // local mode even if a faulty server response says both
                    // cloud sync and configuration_error are enabled.
                    cloudSyncEnabled: Boolean(data.cloud_sync_enabled) && !configurationError,
                    configurationError,
                    csrfToken: data.csrf_token || null,
                };
            }
            if (sessionEpoch !== authSessionEpoch) return;
            // A renewed session can belong to a different account. Clear the
            // previous account's inbox before any new profile UI is rendered.
            resetAlertCenter();
            if (authState.authenticated && authState.cloudSyncEnabled && !authState.configurationError) {
                try {
                    await Promise.all([
                        loadCloudPreferences(),
                        loadCloudFavorites(),
                        loadRecentViewed(),
                        loadCloudWorkspace(),
                    ]);
                    if (sessionEpoch !== authSessionEpoch) return;
                    void refreshAlertCenter({ quiet: true });
                    startAlertCenterPolling();
                } catch (error) {
                    // Cloud data is optional. A failed initial sync must not
                    // turn a valid authenticated session into a fatal boot.
                    reportQuantoraError(error, { area: 'cloud-bootstrap' });
                    authState = {
                        ...authState,
                        cloudSyncEnabled: false,
                        configurationError: 'Cloud sync is temporarily unavailable.',
                    };
                }
            }
            if (!authState.authenticated || !authState.cloudSyncEnabled || authState.configurationError) {
                resetCloudWorkspace();
                favoriteTickers = new Set();
                updateFavoriteButton();
                renderRecentViewed(sessionRecentViewed);
            }
            if (sessionEpoch !== authSessionEpoch) return;
            setCloudSyncWarning(Boolean(authState.authenticated && authState.configurationError));
            renderProfileAuthContent();
            setAuthGate(authState.configured === true && !authState.authenticated && !authState.recoveryMode);
            if (authState.authenticated && authState.user && (authState.user.needs_onboarding || !authState.user.username)) openProfileSheet();
            if (typeof restoreTerminalWorkspaceAfterLogin === 'function') void restoreTerminalWorkspaceAfterLogin();
        }

        async function submitAuth(event) {
            event.preventDefault();
            const email = document.getElementById('auth-email').value.trim();
            const password = document.getElementById('auth-password').value;
            const fullName = document.getElementById('auth-full-name')?.value.trim();
            const confirmation = document.getElementById('auth-confirm-password')?.value;
            const remember = Boolean(document.getElementById('auth-remember')?.checked);
            const clientError = authClientValidation(email, password, confirmation, authFormMode === 'sign-up');
            if (clientError) {
                setAuthStatus(clientError, 'error');
                return;
            }
            const endpoint = authFormMode === 'sign-up' ? '/api/auth/sign-up' : '/api/auth/sign-in';
            setAuthStatus('Working securelyโ€ฆ');
            setAuthBusy(true);
            try {
                const res = await authFetch(endpoint, {
                    method: 'POST',
                    headers: authHeaders(true),
                    credentials: 'same-origin',
                    body: JSON.stringify({ email, password, full_name: fullName || null, remember_me: remember }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to complete authentication.');
                if (authFormMode === 'sign-up' && !data.authenticated) {
                    authVerificationEmail = email;
                    showVerificationAction(email);
                    setAuthStatus(data.message || 'Check your email to confirm the account.', 'success');
                    return;
                }
                await loadAuthSession();
                renderProfileAuthContent();
                if (authState.authenticated && authState.user && !(authState.user.needs_onboarding || !authState.user.username)) closeProfileSheet();
            } catch (err) {
                setAuthStatus(friendlyAuthError(err, email), 'error');
            } finally {
                setAuthBusy(false);
            }
        }

        function signInWithGoogle() {
            window.location.assign('/api/auth/google/start');
        }

        async function sendPasswordReset() {
            const email = document.getElementById('auth-email')?.value.trim();
            if (!email) {
                setAuthStatus('Enter your email first, then request a reset link.', 'error');
                return;
            }
            setAuthStatus('Sending reset emailโ€ฆ');
            setAuthBusy(true, 'Sendingโ€ฆ');
            try {
                const res = await authFetch('/api/auth/forgot-password', {
                    method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to send reset email.');
                setAuthStatus(data.message || 'If this address exists, a reset link is on its way.', 'success');
            } catch (err) {
                setAuthStatus(friendlyAuthError(err, email), 'error');
            } finally {
                setAuthBusy(false);
            }
        }

        async function sendVerificationEmail() {
            const email = document.getElementById('auth-email')?.value.trim() || authVerificationEmail;
            if (!email) {
                setAuthStatus('Enter your email first, then request a confirmation link.', 'error');
                return;
            }
            setAuthStatus('Sending confirmation emailโ€ฆ');
            setAuthBusy(true, 'Sendingโ€ฆ');
            try {
                const res = await authFetch('/api/auth/verify-email', {
                    method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to send confirmation email.');
                setAuthStatus(data.message || 'If this address needs confirmation, a new link is on its way.', 'success');
            } catch (err) {
                setAuthStatus(friendlyAuthError(err, email), 'error');
            } finally {
                setAuthBusy(false);
            }
        }

        async function completeOnboarding() {
            const username = document.getElementById('onboarding-username')?.value.trim();
            if (!username) { setAuthStatus('Choose a username to continue.', 'error'); return; }
            setAuthStatus('Saving your profileโ€ฆ');
            try {
                const res = await authFetch('/api/me', {
                    method: 'PUT', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ username })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to save your profile.');
                authState.user = data.user || data.profile || { ...authState.user, username, needs_onboarding: false };
                authState.user.needs_onboarding = false;
                renderProfileAuthContent();
                closeProfileSheet();
            } catch (err) {
                setAuthStatus(err.message || 'Unable to save your profile.', 'error');
            }
        }

        async function signOut() {
            try {
                await authFetch('/api/auth/logout', { method: 'POST', headers: authHeaders(true) });
            } finally {
                authSessionEpoch += 1;
                authState = { configured: authState.configured, authenticated: false, user: null, googleEnabled: authState.googleEnabled, cloudSyncEnabled: false, configurationError: null, csrfToken: null, recoveryMode: false };
                setCloudSyncWarning(false);
                resetCloudWorkspace();
                resetAlertCenter();
                watchlist = [];
                activePositions = [];
                optionsPortfolioEngineLoaded = false;
                if (typeof renderWatchlist === 'function') renderWatchlist();
                if (typeof renderPortfolioTable === 'function') renderPortfolioTable();
                if (typeof updateHomeWatchlistSurface === 'function') updateHomeWatchlistSurface();
                if (typeof updateHomePortfolioSurface === 'function') updateHomePortfolioSurface();
                if (typeof loadEmaSettings === 'function') emaSettings = loadEmaSettings();
                if (typeof loadEmaMaster === 'function') emaMasterEnabled = loadEmaMaster();
                if (typeof renderIndicatorsPanel === 'function') renderIndicatorsPanel();
                if (typeof updateEMASeries === 'function') updateEMASeries();
                renderProfileAuthContent();
                setAuthGate(authState.configured === true);
                window.location.hash = '#/home';
            }
        }

        async function submitPasswordRecovery() {
            const password = document.getElementById('auth-new-password')?.value;
            if (!password || password.length < 8) { setAuthStatus('Use at least 8 characters.', 'error'); return; }
            try {
                const res = await authFetch('/api/auth/update-password', {
                    method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify({ password })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || data.message || 'Unable to update password.');
                authState.recoveryMode = false;
                await loadAuthSession();
                setAuthStatus('Password updated.', 'success');
            } catch (err) {
                setAuthStatus(err.message || 'Unable to update password.', 'error');
            }
        }

        async function consumeAuthHash() {
            const params = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '');
            const accessToken = params.get('access_token');
            const type = params.get('type');
            // Google uses the server-side PKCE callback. This legacy fragment
            // exchange remains only for Supabase email confirmation/recovery.
            if (!accessToken || !['recovery', 'signup'].includes(type || '')) return;
            const refreshToken = params.get('refresh_token');
            // Remove bearer material from the address bar before the exchange
            // request, including when the provider rejects the handoff.
            history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
            try {
                const res = await authFetch('/api/auth/session', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
                });
                if (!res.ok) throw new Error('Secure session exchange failed.');
                authState.recoveryMode = type === 'recovery';
            } catch (err) {
                reportQuantoraError(err, { area: 'auth-callback' });
            }
        }

