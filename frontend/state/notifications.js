(function (state) {
    state.notifications = state.createStore('notifications', {
        alerts: [], notifications: [], unreadCount: 0, loading: false, error: '',
        statusMessage: '', statusTone: '', requestVersion: 0, draft: null, abortController: null, pollTimer: null,
    });
}(window.quantoraState));
