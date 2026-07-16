const loadedAssets = new Map();
const ASSET_REVISION = '20260717.1';

function revisionedAssetUrl(src) {
    const url = new URL(src, 'http://quantora.local');
    url.searchParams.set('v', ASSET_REVISION);
    return url.pathname + url.search;
}

/**
 * Load an existing global-scope script once. Route engines intentionally stay
 * classic scripts so existing inline event handlers and shared state retain
 * their current behavior while routes can be loaded on demand.
 */
export function loadClassicAsset(src) {
    const requestUrl = revisionedAssetUrl(src);
    if (loadedAssets.has(requestUrl)) return loadedAssets.get(requestUrl);

    const load = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = requestUrl;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => {
            loadedAssets.delete(requestUrl);
            reject(new Error(`Unable to load frontend asset: ${requestUrl}`));
        };
        document.head.appendChild(script);
    });
    loadedAssets.set(requestUrl, load);
    return load;
}
