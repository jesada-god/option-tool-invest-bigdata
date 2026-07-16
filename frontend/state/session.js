(function (state) {
    state.session = state.createStore('session', {
        formMode: 'sign-in', authEpoch: 0, verificationEmail: '', recentViewed: [],
    });
}(window.quantoraState));
