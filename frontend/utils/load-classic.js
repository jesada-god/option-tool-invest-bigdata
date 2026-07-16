const loadedAssets = new Map();

/**
 * Load an existing global-scope script once. Route engines intentionally stay
 * classic scripts so existing inline event handlers and shared state retain
 * their current behavior while routes can be loaded on demand.
 */
export function loadClassicAsset(src) {
    if (loadedAssets.has(src)) return loadedAssets.get(src);

    const load = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => {
            loadedAssets.delete(src);
            reject(new Error(`Unable to load frontend asset: ${src}`));
        };
        document.head.appendChild(script);
    });
    loadedAssets.set(src, load);
    return load;
}
