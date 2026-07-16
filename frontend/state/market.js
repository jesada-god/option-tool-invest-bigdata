(function (state) {
    state.market = state.createStore('market', {
        ticker: 'NVDA', timeframe: '1d', session: 'CLOSED', chartData: [],
        livePrice: null, previousClose: 0, closePrice: 0,
    });
}(window.quantoraState));
