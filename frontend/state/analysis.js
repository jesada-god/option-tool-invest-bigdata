(function (state) {
    state.analysis = state.createStore('analysis', { srVisible: false, srLines: [], srData: null, categoryRail: [], selectedCategory: '' });
}(window.quantoraState));
