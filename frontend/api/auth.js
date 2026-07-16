        async function authFetch(input, init = {}) {
            const response = await fetch(input, { ...init, credentials: 'same-origin' });
            const refreshedCsrf = response.headers.get('X-CSRF-Token');
            if (refreshedCsrf) authState.csrfToken = refreshedCsrf;
            const isAuthRequest = String(input).startsWith('/api/auth/');
            if (response.status === 401 && !isAuthRequest && authState.configured === true) {
                openProfileSheet();
                window.requestAnimationFrame(() => setAuthStatus('Your session has expired. Please sign in again.', 'error'));
            }
            return response;
        }
