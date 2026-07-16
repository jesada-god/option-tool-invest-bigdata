import { loadClassicAsset } from '/assets/utils/load-classic.js?v=20260716.3';

export default async () => {
    await loadClassicAsset('/assets/portfolio/terminal.js');
    window.startPortfolioAutoRefresh?.();
    return window.__quantoraRouteApi?.activate('portfolio');
};
