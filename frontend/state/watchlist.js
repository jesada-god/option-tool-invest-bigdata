(function (state) {
    state.watchlist = state.createStore('watchlist', {
        items: [], favorites: [], byId: {}, allIds: [], selectedId: null,
    });
    state.watchlist.selectAll = value => value.allIds.map(id => value.byId[id]).filter(Boolean);
    state.watchlist.selectSelected = value => value.byId[value.selectedId] || null;
    state.watchlist.replaceCloud = items => state.watchlist.update(current => {
        const byId = (items || []).reduce((result, item) => {
            if (item && item.id != null) result[String(item.id)] = item;
            return result;
        }, {});
        const allIds = Object.keys(byId);
        const selectedId = byId[current.selectedId] ? current.selectedId : (allIds.find(id => byId[id].is_default) || allIds[0] || null);
        return { ...current, byId, allIds, selectedId };
    }, { type: 'watchlist/replace-cloud' });
}(window.quantoraState));
