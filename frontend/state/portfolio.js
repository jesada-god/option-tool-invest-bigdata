(function (state) {
    state.portfolio = state.createStore('portfolio', {
        positions: [], localPositions: [], byId: {}, allIds: [], selectedId: null,
    });
    state.portfolio.selectAll = value => value.allIds.map(id => value.byId[id]).filter(Boolean);
    state.portfolio.selectSelected = value => value.byId[value.selectedId] || null;
    state.portfolio.replaceCloud = items => state.portfolio.update(current => {
        const byId = (items || []).reduce((result, item) => {
            if (item && item.id != null) result[String(item.id)] = item;
            return result;
        }, {});
        const allIds = Object.keys(byId);
        const selectedId = byId[current.selectedId] ? current.selectedId : (allIds.find(id => byId[id].is_default) || allIds[0] || null);
        return { ...current, byId, allIds, selectedId };
    }, { type: 'portfolio/replace-cloud' });
}(window.quantoraState));
