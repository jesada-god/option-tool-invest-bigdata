import { loadClassicAsset } from '/assets/utils/load-classic.js?v=20260717.1';

export default async () => {
    await loadClassicAsset('/assets/pages/tools.js');
    await loadClassicAsset('/assets/analysis/advanced-simulator.js');
    return window.__quantoraRouteApi?.activate('tools');
};
