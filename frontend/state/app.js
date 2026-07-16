(function (state) {
    state.app = state.createStore('app', {
        route: 'home', networkOnline: navigator.onLine, pageVisible: document.visibilityState === 'visible',
        skeletonLoading: false, workspace: { loaded: false, loading: false, error: '', statusMessage: '', statusTone: '', requestVersion: 0 },
    });
}(window.quantoraState));
