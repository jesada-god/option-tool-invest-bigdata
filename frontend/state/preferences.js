(function (state) {
    const defaults = { theme: 'dark', language: 'en', currency: 'USD', timezone: 'UTC', default_timeframe: '1d', default_indicator: 'Smart S/R' };
    state.preferences = state.createStore('preferences', defaults, {
        persistKey: 'quantora.preferences.v1',
        restore: fallback => {
            try { return { ...fallback, ...(JSON.parse(localStorage.getItem('quantora.preferences.v1') || '{}')) }; } catch (_) { return fallback; }
        },
        serialize: value => ({ theme: value.theme, language: value.language, currency: value.currency, timezone: value.timezone, default_timeframe: value.default_timeframe, default_indicator: value.default_indicator }),
    });
}(window.quantoraState));
