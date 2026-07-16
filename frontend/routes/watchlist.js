import { loadClassicAsset } from '/assets/utils/load-classic.js?v=20260717.1';

export default async () => {
    await loadClassicAsset('/assets/pages/watchlist.js');
    return window.__quantoraRouteApi?.activate('watchlist');
};
