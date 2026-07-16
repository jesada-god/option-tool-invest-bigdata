import { loadClassicAsset } from '/assets/utils/load-classic.js';

export default async () => {
    await loadClassicAsset('/assets/pages/watchlist.js');
    return window.__quantoraRouteApi?.activate('watchlist');
};
