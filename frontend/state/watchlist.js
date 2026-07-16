(function (state) {
    state.watchlist = state.createStore('watchlist', {
        items: [], favorites: [], byId: {}, allIds: [], selectedId: null,
    });
    state.watchlist.selectAll = value => value.allIds.map(id => value.byId[id]).filter(Boolean);
    state.watchlist.selectSelected = value => value.byId[value.selectedId] || null;
    state.watchlist.replaceCloud = items => state.watchlist.update(current => {
        const byId = Object.fromEntries((items || []).filter(item => item && item.id != null).map(item => [String(item.id), item]));
        const allIds = Object.keys(byId);
        const selectedId = byId[current.selectedId] ? current.selectedId : (allIds.find(id => byId[id].is_default) || allIds[0] || null);
        return { ...current, byId, allIds, selectedId };
    }, { type: 'watchlist/replace-cloud' });
}(window.quantoraState));
