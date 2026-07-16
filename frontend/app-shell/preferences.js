// Quantora application-shell module: preferences
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        async function loadCloudPreferences() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return;
            try {
                const res = await authFetch('/api/preferences', { headers: authHeaders(), cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                const preference = data.preferences || data;
                userPreferences = { ...userPreferences, ...preference };
                document.documentElement.dataset.theme = userPreferences.theme || 'dark';
                applyLanguage(userPreferences.language);
                const savedSettings = preference.ema_settings;
                if (savedSettings && typeof savedSettings === 'object') {
                    const merged = {};
                    EMA_PERIODS.forEach(period => { merged[period] = { ...EMA_DEFAULTS[period], ...(savedSettings[period] || {}) }; });
                    emaSettings = merged;
                }
                if (typeof preference.ema_master_enabled === 'boolean') emaMasterEnabled = preference.ema_master_enabled;
                renderIndicatorsPanel();
                updateEMASeries();
            } catch (err) {
                reportQuantoraError(err, { area: 'preferences-load' });
                throw err;
            }
        }

        function queuePreferenceSync() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) return;
            if (preferenceSyncTimer) clearTimeout(preferenceSyncTimer);
            preferenceSyncTimer = window.setTimeout(async () => {
                try {
                    await authFetch('/api/preferences', {
                        method: 'PUT', headers: authHeaders(true),
                        body: JSON.stringify({ ema_settings: emaSettings, ema_master_enabled: emaMasterEnabled }),
                    });
                } catch (err) {
                    reportQuantoraError(err, { area: 'preferences-save' });
                }
            }, 350);
        }

        async function saveUserSettings() {
            const payload = {
                theme: document.getElementById('setting-theme')?.value || userPreferences.theme,
                language: document.getElementById('setting-language')?.value || userPreferences.language,
                currency: document.getElementById('setting-currency')?.value || userPreferences.currency,
                default_timeframe: document.getElementById('setting-timeframe')?.value || userPreferences.default_timeframe,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                default_indicator: userPreferences.default_indicator || 'Smart S/R',
            };
            userPreferences = { ...userPreferences, ...payload };
            document.documentElement.dataset.theme = userPreferences.theme || 'dark';
            applyLanguage(payload.language);
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                setAuthStatus(t('settings_session_only', 'Changes apply to this session. Sign in to sync them across devices.'));
                return;
            }
            try {
                const response = await authFetch('/api/preferences', { method: 'PUT', headers: authHeaders(true), body: JSON.stringify(payload) });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.detail || 'Unable to save settings.');
                userPreferences = { ...userPreferences, ...(data.preferences || data) };
                document.documentElement.dataset.theme = userPreferences.theme || 'dark';
                applyLanguage(userPreferences.language);
                renderProfileAuthContent();
            } catch (error) {
                reportQuantoraError(error, { area: 'preferences-save' });
            }
        }

