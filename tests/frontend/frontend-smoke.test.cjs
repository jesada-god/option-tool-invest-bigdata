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
    assert.deepEqual(appended, ['/assets/pages/home.js']);
});

test('route smoke coverage includes every navigation destination and chunk', () => {
    const router = read('frontend/app-shell/router.js');
    const expected = ['home', 'watchlist', 'search', 'analysis', 'tools', 'portfolio'];
    for (const route of expected) {
        assert.match(router, new RegExp(`${route}: \\(\\) => import\\('/assets/routes/${route}\\.js'\\)`));
        assert.ok(fs.existsSync(path.join(root, 'frontend', 'routes', `${route}.js`)));
    }
    assert.match(router, /const routeModuleLoads = new Map\(\)/);
    assert.match(router, /function prefetchRouteModule\(target\)/);
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
        'prepareTerminalWorkspaceRestore',
        'applyRouteFromLocation',
        'loadRouteModule',
        'finishTerminalWorkspaceRestore',
    ]) {
        assert.match(boot, new RegExp(`runBootstrapStep\\('${step}'`));
    }
    assert.match(boot, /console\.warn\('\[Quantora bootstrap failed\]'/);
    assert.match(boot, /stack: exception\.stack \|\| null/);
    assert.match(boot, /response\.clone\(\)\.text\(\)/);
    assert.match(boot, /throw error;/);
});

test('cache, route restoration, and service-worker guards remain enabled', () => {
    const cache = read('frontend/api/cache.js');
    const router = read('frontend/app-shell/router.js');
    const worker = read('service-worker.js');
    assert.match(cache, /if \(inFlight\.has\(key\)\)/);
    assert.match(cache, /respectingAbort/);
    assert.match(router, /requested\.startsWith\('portfolio\/'\)/);
    assert.match(worker, /const CACHE_NAME = 'quantora-shell-v\d+'/);
    assert.match(worker, /if \(isShellAsset && !bypassCache\) \{\s+const cached = await caches\.match\(event\.request\);\s+if \(cached\) return cached;/);
});
