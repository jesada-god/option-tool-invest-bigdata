import { loadClassicAsset } from '/assets/utils/load-classic.js?v=20260717.3';

export default async () => {
    await loadClassicAsset('/assets/components/indicators.js');
    await loadClassicAsset('/assets/analysis/market-terminal.js');
    await loadClassicAsset('/assets/services/live-price.js');
    await loadClassicAsset('/assets/analysis/gauges.js');
    await loadClassicAsset('/assets/pages/home.js');
    window.startChartAutoRefresh?.();
    return window.__quantoraRouteApi?.activate('home');
};
