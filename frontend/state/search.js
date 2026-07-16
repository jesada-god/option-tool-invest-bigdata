(function (state) {
    state.search = state.createStore('search', { query: '', results: [], status: 'idle' });
}(window.quantoraState));
