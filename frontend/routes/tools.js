import { loadClassicAsset } from '/assets/utils/load-classic.js';

export default async () => {
    await loadClassicAsset('/assets/pages/tools.js');
    await loadClassicAsset('/assets/analysis/advanced-simulator.js');
    return window.__quantoraRouteApi?.activate('tools');
};
