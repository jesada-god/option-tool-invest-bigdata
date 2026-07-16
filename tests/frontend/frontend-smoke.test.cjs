'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('classic asset loader loads each requested asset once', async () => {
    const source = read('frontend/utils/load-classic.js').replace('export function loadClassicAsset', 'function loadClassicAsset');
    const appended = [];
    const document = {
        createElement() { return { async: true, onload: null, onerror: null, src: '' }; },
        head: {
            appendChild(script) {
                appended.push(script.src);
                queueMicrotask(() => script.onload());
            },
        },
    };
    const { loadClassicAsset } = new Function('document', `${source}\nreturn { loadClassicAsset };`)(document);

    const first = loadClassicAsset('/assets/pages/home.js');
    const second = loadClassicAsset('/assets/pages/home.js');
    assert.strictEqual(first, second);
    await first;
    assert.deepEqual(appended, ['/assets/pages/home.js?v=20260717.1']);
});

test('route smoke coverage includes every navigation destination and chunk', () => {
    const router = read('frontend/app-shell/router.js');
    const expected = ['home', 'watchlist', 'search', 'analysis', 'tools', 'portfolio'];
    for (const route of expected) {
        const importer = `${route}: () => import(` + '`' + `/assets/routes/${route}.js?v=\${ROUTE_MODULE_REVISION}` + '`' + ')';
        assert.ok(router.includes(importer), `missing revisioned ${route} route importer`);
        assert.ok(fs.existsSync(path.join(root, 'frontend', 'routes', `${route}.js`)));
    }
    assert.match(router, /const routeModuleLoads = new Map\(\)/);
    assert.match(router, /function prefetchRouteModule\(target\)/);
});

test('the watchlist route can boot before the home route is loaded', () => {
    const watchlist = read('frontend/pages/watchlist.js');
    assert.match(watchlist, /typeof updateHomeWatchlistSurface === 'function'/);
    assert.doesNotMatch(watchlist, /\n\s*updateHomeWatchlistSurface\(\);/);
});

test('frontend auth exchanges fragment tokens without persistent token storage', () => {
    const auth = read('frontend/app-shell/auth.js');
    const cleanup = auth.indexOf('history.replaceState(null, document.title');
    const exchange = auth.indexOf("await authFetch('/api/auth/session'");
    assert.ok(cleanup >= 0 && cleanup < exchange, 'the address bar must be cleaned before the token exchange');
    assert.doesNotMatch(auth, /(localStorage|sessionStorage)\.(setItem|getItem)\([^\n]*(access_token|refresh_token)/);
});

test('bootstrap identifies and rethrows every guarded startup failure', () => {
    const boot = read('frontend/app-shell/boot.js');
    for (const step of [
        'loadAuthSession',
        'applyRouteFromLocation',
        'loadRouteModule',
    ]) {
        assert.match(boot, new RegExp(`runBootstrapStep\\('${step}'`));
    }
    assert.match(boot, /console\.warn\('\[Quantora bootstrap failed\]'/);
    assert.match(boot, /stack: exception\.stack \|\| null/);
    assert.match(boot, /response\.clone\(\)\.text\(\)/);
    assert.match(boot, /throw error;/);
    assert.match(boot, /runOptionalBootstrapStep\('prepareTerminalWorkspaceRestore'/);
    assert.match(boot, /runOptionalBootstrapStep\('finishTerminalWorkspaceRestore'/);
});

test('an authenticated cloud-sync degradation remains a non-fatal local mode', () => {
    const auth = read('frontend/app-shell/auth.js');
    const router = read('frontend/app-shell/router.js');
    const workspace = read('frontend/app-shell/workspace.js');
    const page = read('index.html');
    assert.match(auth, /cloudSyncEnabled: Boolean\(data\.cloud_sync_enabled\) && !configurationError/);
    assert.match(auth, /setCloudSyncWarning\(Boolean\(authState\.authenticated && authState\.configurationError\)\)/);
    assert.match(auth, /configurationError: 'Cloud sync is temporarily unavailable\.'/);
    assert.match(router, /function setCloudSyncWarning\(visible\)/);
    assert.match(workspace, /authState\.cloudSyncEnabled && !authState\.configurationError/);
    assert.match(page, /id="cloud-sync-warning"/);
});

test('an authenticated /api/auth/me configuration error completes in local mode', async () => {
    const authSource = read('frontend/app-shell/auth.js');
    const createHarness = new Function('response', `
        let authState = { configured: null, authenticated: false, user: null, googleEnabled: false, cloudSyncEnabled: false, configurationError: null, csrfToken: null, recoveryMode: false };
        let authSessionEpoch = 0;
        let favoriteTickers = new Set(['OLD']);
        let sessionRecentViewed = [];
        const calls = [];
        const authFetch = async () => response;
        const resetAlertCenter = () => calls.push('resetAlertCenter');
        const resetCloudWorkspace = () => calls.push('resetCloudWorkspace');
        const updateFavoriteButton = () => calls.push('updateFavoriteButton');
        const renderRecentViewed = () => calls.push('renderRecentViewed');
        const setCloudSyncWarning = value => calls.push(['setCloudSyncWarning', value]);
        const renderProfileAuthContent = () => calls.push('renderProfileAuthContent');
        const setAuthGate = value => calls.push(['setAuthGate', value]);
        ${authSource}
        return { loadAuthSession, getAuth: () => authState, calls };
    `);
    const harness = createHarness({
        status: 200,
        ok: true,
        json: async () => ({
            auth_enabled: true,
            authenticated: true,
            cloud_sync_enabled: false,
            configuration_error: 'Cloud profile is temporarily unavailable.',
            user: { id: 'user-1', username: 'quantora' },
        }),
    });

    await harness.loadAuthSession();
    assert.equal(harness.getAuth().authenticated, true);
    assert.equal(harness.getAuth().cloudSyncEnabled, false);
    assert.equal(harness.getAuth().configurationError, 'Cloud profile is temporarily unavailable.');
    assert.ok(harness.calls.includes('resetCloudWorkspace'));
    assert.ok(harness.calls.some(call => Array.isArray(call) && call[0] === 'setCloudSyncWarning' && call[1] === true));
});

test('cache, route restoration, and service-worker guards remain enabled', () => {
    const cache = read('frontend/api/cache.js');
    const router = read('frontend/app-shell/router.js');
    const worker = read('service-worker.js');
    assert.match(cache, /if \(inFlight\.has\(key\)\)/);
    assert.match(cache, /respectingAbort/);
    assert.match(router, /requested\.startsWith\('portfolio\/'\)/);
    assert.match(worker, /const CACHE_NAME = 'quantora-shell-v\d+'/);
    assert.match(worker, /const response = await fetch\(event\.request\);/);
    assert.match(worker, /catch \(_\) \{\s+const cached = await caches\.match\(event\.request\);\s+if \(cached\) return cached;/);
});

test('portfolio local mode and iOS dialog fallbacks remain runtime-safe', () => {
    const portfolio = read('frontend/portfolio/terminal.js');
    const positionSubmit = portfolio.indexOf('async function submitPosition');
    const submitLookup = portfolio.indexOf("const submit = document.querySelector('#pos-form .btn-submit');", positionSubmit);
    const localBranch = portfolio.indexOf('if (!cloudWorkspaceEnabled())', positionSubmit);
    assert.ok(submitLookup >= 0 && submitLookup < localBranch, 'local position saves must not reference submit before initialization');
    assert.match(portfolio, /function showPortfolioDialog\(dialog\)/);
    assert.match(portfolio, /typeof dialog\.showModal === 'function'/);
    assert.doesNotMatch(read('frontend/state/portfolio.js'), /Object\.fromEntries/);
    assert.doesNotMatch(read('frontend/state/watchlist.js'), /Object\.fromEntries/);
});

test('malformed route fragments remain recoverable', () => {
    const router = read('frontend/app-shell/router.js');
    assert.match(router, /function requestedTerminalPath\(\)/);
    assert.match(router, /catch \(_\) \{[\s\S]*return '';/);
});

test('corrupted translation strings cannot be rendered as UI copy', () => {
    const theme = read('frontend/app-shell/theme.js');
    const auth = read('frontend/app-shell/auth.js');
    assert.match(theme, /function isReadableUiText\(value\)/);
    assert.match(theme, /!\/\[\\u20ac\\ufffd\]\/i\.test\(value\)/);
    assert.match(auth, /function readableAuthClientValidation/);
    assert.match(auth, /function readableAuthError/);
});

test('browser-delivered text assets are strict UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const assets = [
        'index.html', 'service-worker.js', 'app.webmanifest',
        ...fs.readdirSync(path.join(root, 'frontend'), { recursive: true })
            .filter(file => file.endsWith('.js'))
            .map(file => path.join('frontend', file)),
    ];
    for (const asset of assets) {
        assert.doesNotThrow(() => decoder.decode(fs.readFileSync(path.join(root, asset))), asset);
    }
});
