(function (state) {
    state.auth = state.createStore('auth', {
        configured: null, authenticated: false, user: null, googleEnabled: false,
        cloudSyncEnabled: false, configurationError: null, csrfToken: null, recoveryMode: false,
    });
}(window.quantoraState));
