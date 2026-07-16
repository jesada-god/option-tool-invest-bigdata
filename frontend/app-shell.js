// Quantora application shell bootstrap.
//
// These stay classic scripts deliberately: inline controls and existing
// non-module assets share their global functions and state with this shell.
// The Home route is lazy-loaded. Queue an eager search submission instead of
// letting its inline form handler throw while that route is still downloading.
window.searchStock = function queueInitialSearch() {
    const retry = () => {
        if (window.searchStock !== queueInitialSearch) {
            window.searchStock();
            return;
        }
        window.setTimeout(retry, 50);
    };
    window.setTimeout(retry, 0);
};

(async function loadApplicationShell() {
    const APP_SHELL_REVISION = '20260717.1';
    const modules = [
        '../state/store',
        '../state/app',
        '../state/auth',
        '../state/session',
        '../state/market',
        '../state/portfolio',
        '../state/watchlist',
        '../state/search',
        '../state/analysis',
        '../state/preferences',
        '../state/notifications',
        '../state/legacy-bridge',
        'storage',
        'router',
        'auth',
        'navigation',
        'profile',
        'theme',
        'workspace',
        'preferences',
        'feedback',
        'notifications',
        'session',
        'interaction',
        'accessibility',
        'boot',
    ];

    function loadClassicModule(name) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const asset = name.startsWith('../') ? `/assets/${name.slice(3)}.js` : `/assets/app-shell/${name}.js`;
            script.src = `${asset}?v=${APP_SHELL_REVISION}`;
            script.async = false;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Unable to load application module: ${name}`));
            document.head.appendChild(script);
        });
    }

    try {
        for (const module of modules) await loadClassicModule(module);
        await bootTerminal();
    } catch (error) {
        window.reportQuantoraError?.(error, { area: 'shell-loader' });
        const screen = document.getElementById('system-screen');
        if (screen) {
            screen.classList.add('is-visible');
            screen.setAttribute('aria-hidden', 'false');
        }
        throw error;
    }
}());
