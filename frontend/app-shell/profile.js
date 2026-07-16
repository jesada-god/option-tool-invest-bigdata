// Quantora application-shell module: profile
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        function openProfileSheet() {
            const sheet = document.getElementById('profile-sheet');
            const activeElement = document.activeElement;
            profileSheetReturnFocus = activeElement instanceof HTMLElement && !sheet.contains(activeElement) ? activeElement : null;
            renderProfileAuthContent();
            sheet.classList.add('is-open');
            sheet.setAttribute('aria-hidden', 'false');
            window.requestAnimationFrame(() => sheet.querySelector('[aria-label="Close profile"]')?.focus());
            if (cloudWorkspaceEnabled()) {
                void loadCloudWorkspace();
                void refreshAlertCenter({ quiet: true });
                startAlertCenterPolling();
            }
        }

        function closeProfileSheet() {
            const sheet = document.getElementById('profile-sheet');
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && sheet.contains(activeElement)) {
                const fallback = document.getElementById('profile-avatar-button');
                (profileSheetReturnFocus || fallback)?.focus();
            }
            sheet.classList.remove('is-open');
            sheet.setAttribute('aria-hidden', 'true');
        }



        function openSettingsSheet() {
            openProfileSheet();
            window.requestAnimationFrame(() => {
                const details = document.getElementById('settings-details');
                if (details) details.open = true;
            });
        }

        function profileInitials(user) {
            const source = user && (user.username || user.email || user.display_name);
            if (!source) return 'QA';
            return String(source).trim().slice(0, 2).toUpperCase() || 'PT';
        }

        function localProfileAvatarUrl(value) {
            return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value) ? value : '';
        }



        function setProfileSummary() {
            const user = authState.user;
            const initials = profileInitials(user);
            const avatarButton = document.getElementById('profile-avatar-button');
            const avatar = document.getElementById('profile-sheet-avatar');
            const name = document.getElementById('profile-sheet-name');
            const email = document.getElementById('profile-sheet-email');
            const avatarUrl = localProfileAvatarUrl(user?.avatar_url);
            [avatarButton, avatar].forEach(element => {
                if (!element) return;
                element.textContent = initials;
                element.style.backgroundImage = avatarUrl ? `url("${avatarUrl}")` : '';
                element.style.backgroundSize = avatarUrl ? 'cover' : '';
                element.style.backgroundPosition = avatarUrl ? 'center' : '';
                element.style.color = avatarUrl ? 'transparent' : '';
            });
            if (!authState.authenticated || !user) {
                if (name) name.textContent = authState.configured === false ? 'Quantora AI' : 'Quantora AI User';
                if (email) email.textContent = authState.configured === false ? 'Cloud authentication is not configured' : 'Secure session required';
                const greeting = document.getElementById('home-welcome-title');
                const greetingCopy = document.getElementById('home-welcome-copy');
                if (greeting) greeting.innerHTML = userPreferences.language === 'th' ? 'เธขเธดเธเธ”เธตเธ•เนเธญเธเธฃเธฑเธเธชเธนเน <span>Quantora AI</span>' : 'Welcome to <span>Quantora AI</span>';
                if (greetingCopy) greetingCopy.textContent = userPreferences.language === 'th' ? 'เธ”เธนเธเนเธญเธกเธนเธฅเธ•เธฅเธฒเธ” เธงเธดเน€เธเธฃเธฒเธฐเธซเนเธซเธธเนเธ เนเธฅเธฐเธเธฑเธ”เธเธฒเธฃเธเธญเธฃเนเธ•เธเธญเธเธเธธเธ“เนเธ”เนเนเธเธ—เธตเนเน€เธ”เธตเธขเธง' : 'Welcome to your portfolio. Live market analysis, Smart Support & Resistance, option tools, and portfolio intelligence in one premium workspace.';
                return;
            }
            if (name) name.textContent = user.username || user.display_name || 'Welcome to Quantora AI';
            if (email) email.textContent = user.email || 'Signed in securely';
            const greeting = document.getElementById('home-welcome-title');
            const greetingCopy = document.getElementById('home-welcome-copy');
            const nickname = user.username || user.display_name;
            if (greeting && nickname) greeting.innerHTML = userPreferences.language === 'th' ? `เธชเธงเธฑเธชเธ”เธต ${escapeHtml(nickname)} <span>๐‘</span>` : `Hello ${escapeHtml(nickname)} <span>๐‘</span>`;
            if (greetingCopy && nickname) greetingCopy.textContent = userPreferences.language === 'th' ? 'เธขเธดเธเธ”เธตเธ•เนเธญเธเธฃเธฑเธเธชเธนเนเธเธญเธฃเนเธ•เธเธญเธเธเธธเธ“ เธเนเธญเธกเธนเธฅเธเธญเธเธเธธเธ“เธเธดเธเธเนเน€เธฃเธตเธขเธเธฃเนเธญเธขเนเธฅเนเธง' : 'Welcome to your Portfolio. Your synced Quantora workspace is ready.';
        }

        function setProfileImagePreview(url) {
            const preview = document.getElementById('profile-image-preview');
            if (!preview) return;
            url = localProfileAvatarUrl(url);
            preview.style.backgroundImage = url ? `url("${url}")` : '';
            preview.style.backgroundSize = url ? 'cover' : '';
            preview.style.backgroundPosition = url ? 'center' : '';
            preview.textContent = url ? '' : profileInitials(authState.user);
        }

        async function previewProfileImage(input) {
            const file = input && input.files && input.files[0];
            if (!file) return;
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                setAuthStatus('เธฃเธญเธเธฃเธฑเธเน€เธเธเธฒเธฐเนเธเธฅเน JPG, PNG เนเธฅเธฐ WEBP', 'error');
                input.value = '';
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                setAuthStatus('เธฃเธนเธเธ เธฒเธเธ•เนเธญเธเธกเธตเธเธเธฒเธ”เนเธกเนเน€เธเธดเธ 5 MB', 'error');
                input.value = '';
                return;
            }
            const sourceUrl = URL.createObjectURL(file);
            try {
                const image = await new Promise((resolve, reject) => {
                    const candidate = new Image();
                    candidate.onload = () => resolve(candidate);
                    candidate.onerror = () => reject(new Error('เนเธกเนเธชเธฒเธกเธฒเธฃเธ–เธญเนเธฒเธเธฃเธนเธเธ เธฒเธเธเธตเนเนเธ”เน'));
                    candidate.src = sourceUrl;
                });
                const side = Math.min(image.naturalWidth, image.naturalHeight);
                const sourceX = (image.naturalWidth - side) / 2;
                const sourceY = (image.naturalHeight - side) / 2;
                const canvas = document.createElement('canvas');
                canvas.width = 160;
                canvas.height = 160;
                canvas.getContext('2d').drawImage(image, sourceX, sourceY, side, side, 0, 0, 160, 160);
                pendingProfileAvatarUrl = canvas.toDataURL('image/webp', 0.82);
                setProfileImagePreview(pendingProfileAvatarUrl);
                setAuthStatus('เธ•เธฑเธงเธญเธขเนเธฒเธเธฃเธนเธเธ เธฒเธเธเธฃเนเธญเธกเธเธฑเธเธ—เธถเธเนเธฅเนเธง', 'success');
            } catch (error) {
                setAuthStatus(error.message || 'เนเธกเนเธชเธฒเธกเธฒเธฃเธ–เน€เธ•เธฃเธตเธขเธกเธฃเธนเธเธ เธฒเธเนเธ”เน', 'error');
            } finally {
                URL.revokeObjectURL(sourceUrl);
            }
        }

        async function saveProfileDetails() {
            if (!authState.authenticated || !authState.cloudSyncEnabled) {
                setAuthStatus('Cloud sync unavailable', 'error');
                return;
            }
            const username = document.getElementById('profile-display-name')?.value.trim() || '';
            if (username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
                setAuthStatus('เธเธทเนเธญเธ—เธตเนเนเธชเธ”เธเธ•เนเธญเธเธกเธต 3โ€“32 เธ•เธฑเธงเธญเธฑเธเธฉเธฃ เนเธฅเธฐเนเธเนเนเธ”เนเน€เธเธเธฒเธฐเธ•เธฑเธงเธญเธฑเธเธฉเธฃ เธ•เธฑเธงเน€เธฅเธ เธเธธเธ” เธเธตเธ”เธฅเนเธฒเธ เธซเธฃเธทเธญเธเธตเธ”เธเธฅเธฒเธ', 'error');
                return;
            }
            if (!username && !pendingProfileAvatarUrl) {
                setAuthStatus('Choose a username or profile image to save.', 'error');
                return;
            }
            const payload = {};
            if (username) payload.username = username;
            if (pendingProfileAvatarUrl) payload.avatar_url = pendingProfileAvatarUrl;
            try {
                const response = await authFetch('/api/me', { method: 'PUT', headers: authHeaders(true), body: JSON.stringify(payload) });
                const data = await response.json().catch(() => ({}));
                if (!response.ok && response.status >= 500) throw new Error('Cloud sync unavailable');
                if (!response.ok) throw new Error(data.detail || 'เนเธกเนเธชเธฒเธกเธฒเธฃเธ–เธเธฑเธเธ—เธถเธเนเธเธฃเนเธเธฅเนเนเธ”เน');
                authState.user = data.user || authState.user;
                pendingProfileAvatarUrl = null;
                setProfileSummary();
                renderProfileAuthContent();
                setAuthStatus('เธเธฑเธเธ—เธถเธเนเธเธฃเนเธเธฅเนเนเธฅเนเธง', 'success');
            } catch (error) {
                setAuthStatus(error.message || 'เนเธกเนเธชเธฒเธกเธฒเธฃเธ–เธเธฑเธเธ—เธถเธเนเธเธฃเนเธเธฅเนเนเธ”เน', 'error');
            }
        }

        function setAuthStatus(message, tone = '') {
            const el = document.getElementById('profile-auth-status');
            if (!el) return;
            el.textContent = message || '';
            el.className = `pt-auth-status${tone ? ` ${tone}` : ''}`;
        }

        function sessionSettingsMarkup() {
            return `<details id="settings-details" class="pt-sync-note" style="margin:14px 0 0" open><summary style="cursor:pointer; color:#f4f6ff; font-weight:700;">${t('workspace_settings', 'Workspace settings')}</summary><div class="pt-tools-fields" style="margin-top:12px"><label class="pt-tools-field"><span>${t('theme', 'Theme')}</span><select id="setting-theme" onchange="saveUserSettings()"><option value="dark" ${userPreferences.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${userPreferences.theme === 'light' ? 'selected' : ''}>Light</option><option value="system" ${userPreferences.theme === 'system' ? 'selected' : ''}>System</option></select></label><label class="pt-tools-field"><span>${t('language', 'Language')}</span><select id="setting-language" onchange="saveUserSettings()"><option value="en" ${userPreferences.language === 'en' ? 'selected' : ''}>English</option><option value="th" ${userPreferences.language === 'th' ? 'selected' : ''}>เนเธ—เธข</option></select></label><label class="pt-tools-field"><span>${t('currency', 'Currency')}</span><select id="setting-currency" onchange="saveUserSettings()"><option value="USD" ${userPreferences.currency === 'USD' ? 'selected' : ''}>USD</option><option value="THB" ${userPreferences.currency === 'THB' ? 'selected' : ''}>THB</option></select></label><label class="pt-tools-field"><span>${t('timeframe', 'Default timeframe')}</span><select id="setting-timeframe" onchange="saveUserSettings()"><option value="1d" ${userPreferences.default_timeframe === '1d' ? 'selected' : ''}>Daily</option><option value="week" ${userPreferences.default_timeframe === 'week' ? 'selected' : ''}>Weekly</option></select></label></div><p style="margin:10px 0 0; color:#aeb7d2; font-size:10px;">${cloudWorkspaceEnabled() ? t('auto_save', 'Changes save automatically to your cloud workspace.') : t('settings_session_only', 'Changes apply to this session. Sign in to sync them across devices.')}</p></details>`;
        }

        function renderProfileAuthContent() {
            setProfileSummary();
            const host = document.getElementById('profile-auth-content');
            if (!host) return;

            if (authState.configured === null) {
                host.innerHTML = '<div class="pt-sync-note">Checking the secure account serviceโ€ฆ</div>';
                return;
            }
            if (authState.configured === false && !authState.googleEnabled) {
                host.innerHTML = `<div class="pt-sync-note"><strong style="color:#f3f5ff;">Sign-in is not enabled on this deployment yet.</strong><br>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in Render, then redeploy. The Login / Create account form will appear automatically after the secure auth service is available.</div>${sessionSettingsMarkup()}<div id="profile-auth-status" class="pt-auth-status"></div>`;
                return;
            }
            if (authState.recoveryMode) {
                host.innerHTML = `
                    <div class="pt-auth-stack">
                        <p class="pt-sync-note" style="margin:0;">Choose a new password for your account.</p>
                        <input id="auth-new-password" type="password" minlength="8" autocomplete="new-password" placeholder="New password (8+ characters)">
                        <button type="button" class="pt-auth-action" onclick="submitPasswordRecovery()">Update password</button>
                        <div id="profile-auth-status" class="pt-auth-status"></div>
                    </div>`;
                return;
            }
            if (authState.authenticated && authState.user) {
                const user = authState.user;
                const needsOnboarding = Boolean(user.needs_onboarding || !user.username);
                if (needsOnboarding) {
                    host.innerHTML = `
                        <div class="pt-auth-stack">
                            <div class="pt-sync-note" style="margin:0;">Welcome to Quantora AI. Choose a unique nickname that will appear across your synced workspace.</div>
                            <input id="onboarding-username" maxlength="32" autocomplete="username" placeholder="Nickname, e.g. Bas" value="${escapeHtml(user.is_provisional_username ? '' : (user.username || ''))}">
                            <button type="button" class="pt-auth-action" onclick="completeOnboarding()">Continue to dashboard</button>
                            <div id="profile-auth-status" class="pt-auth-status"></div>
                        </div>`;
                    return;
                }
                host.innerHTML = `
                    <div class="pt-auth-stack">
                        <div class="pt-sync-note" style="margin:0;">${authState.cloudSyncEnabled ? 'Cloud sync is active for watchlists, positions, and indicator preferences on this account.' : 'Your account is signed in, but cloud storage is not configured on this deployment yet.'}</div>
                        <section class="pt-sync-note" style="margin:0;">
                            <strong style="color:#f3f5ff;">เนเธเธฃเนเธเธฅเน</strong>
                            <div style="display:flex; gap:12px; align-items:center; margin-top:10px;">
                                <div id="profile-image-preview" class="pt-sheet-avatar" style="flex:0 0 48px; width:48px; height:48px;">${escapeHtml(profileInitials(user))}</div>
                                <label class="pt-auth-field" style="margin:0; flex:1;"><span>เธเธทเนเธญเธ—เธตเนเนเธชเธ”เธ</span><input id="profile-display-name" maxlength="32" autocomplete="username" value="${escapeHtml(user.username || '')}"></label>
                            </div>
                            <label class="pt-auth-field" style="margin-top:10px;"><span>เธฃเธนเธเนเธเธฃเนเธเธฅเน (JPG, PNG เธซเธฃเธทเธญ WEBP)</span><input type="file" accept="image/jpeg,image/png,image/webp" onchange="previewProfileImage(this)"></label>
                            <p style="font-size:11px; color:#aeb7d2; margin:8px 0;">เธฃเธนเธเธเธฐเธ–เธนเธเธเธฃเธญเธเน€เธเนเธเธชเธตเนเน€เธซเธฅเธตเนเธขเธกเนเธฅเธฐเธขเนเธญเธเนเธญเธเธเธฑเธเธ—เธถเธ</p>
                            <button type="button" class="pt-auth-action" onclick="saveProfileDetails()">เธเธฑเธเธ—เธถเธเนเธเธฃเนเธเธฅเน</button>
                        </section>
                        ${authState.cloudSyncEnabled ? '<section id="cloud-workspace-manager" class="pt-workspace-manager" aria-label="Cloud workspace manager"><div id="cloud-workspace-content"></div></section><section id="alert-center-manager" class="pt-alert-manager" aria-label="Cloud alert rules and in-app notification inbox"><div id="alert-center-content"></div></section>' : ''}
                        ${authState.cloudSyncEnabled ? `<details id="settings-details" class="pt-sync-note" style="margin:0"><summary style="cursor:pointer; color:#f4f6ff; font-weight:700;">${t('workspace_settings', 'Workspace settings')}</summary><div class="pt-tools-fields" style="margin-top:12px"><label class="pt-tools-field"><span>${t('theme', 'Theme')}</span><select id="setting-theme" onchange="saveUserSettings()"><option value="dark" ${userPreferences.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${userPreferences.theme === 'light' ? 'selected' : ''}>Light</option><option value="system" ${userPreferences.theme === 'system' ? 'selected' : ''}>System</option></select></label><label class="pt-tools-field"><span>${t('language', 'Language')}</span><select id="setting-language" onchange="saveUserSettings()"><option value="en" ${userPreferences.language === 'en' ? 'selected' : ''}>English</option><option value="th" ${userPreferences.language === 'th' ? 'selected' : ''}>เนเธ—เธข</option></select></label><label class="pt-tools-field"><span>${t('currency', 'Currency')}</span><select id="setting-currency" onchange="saveUserSettings()"><option value="USD" ${userPreferences.currency === 'USD' ? 'selected' : ''}>USD</option><option value="THB" ${userPreferences.currency === 'THB' ? 'selected' : ''}>THB</option></select></label><label class="pt-tools-field"><span>${t('timeframe', 'Default timeframe')}</span><select id="setting-timeframe" onchange="saveUserSettings()"><option value="1d" ${userPreferences.default_timeframe === '1d' ? 'selected' : ''}>Daily</option><option value="week" ${userPreferences.default_timeframe === 'week' ? 'selected' : ''}>Weekly</option></select></label></div><p style="margin:10px 0 0; color:#aeb7d2; font-size:10px;">${t('auto_save', 'Changes save automatically to your cloud workspace.')}</p></details>` : ''}
                        <button type="button" class="pt-auth-action secondary" onclick="signOut()">Sign out</button>
                        <div id="profile-auth-status" class="pt-auth-status"></div>
                    </div>`;
                if (authState.cloudSyncEnabled) {
                    renderCloudWorkspaceManager();
                    renderAlertCenter();
                }
                setProfileImagePreview(user.avatar_url || '');
                return;
            }

            const isSignUp = authFormMode === 'sign-up';
            host.innerHTML = `
                <form class="pt-auth-stack" onsubmit="submitAuth(event)">
                    <p class="pt-auth-intro">${isSignUp ? 'Create your secure Quantora account. We will send a confirmation link to your email.' : 'Sign in to open your private, cloud-synced Quantora workspace.'}</p>
                    <div class="pt-auth-mode-switch" role="tablist" aria-label="Authentication mode">
                        <button type="button" class="${isSignUp ? '' : 'is-active'}" role="tab" aria-selected="${!isSignUp}" onclick="setAuthFormMode('sign-in')">Sign in</button>
                        <button type="button" class="${isSignUp ? 'is-active' : ''}" role="tab" aria-selected="${isSignUp}" onclick="setAuthFormMode('sign-up')">Create account</button>
                    </div>
                    ${isSignUp ? '<label class="pt-auth-field"><span>Full name <em style="font-style:normal; color:#8491b8;">(optional)</em></span><input id="auth-full-name" type="text" maxlength="120" autocomplete="name" placeholder="e.g. Bas Trader"></label>' : ''}
                    <label class="pt-auth-field"><span>Email</span><input id="auth-email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
                    <label class="pt-auth-field"><span>Password</span><input id="auth-password" type="password" minlength="8" autocomplete="${isSignUp ? 'new-password' : 'current-password'}" placeholder="At least 8 characters" required></label>
                    ${isSignUp ? '<label class="pt-auth-field"><span>Confirm password</span><input id="auth-confirm-password" type="password" minlength="8" autocomplete="new-password" placeholder="Type your password again" required></label>' : ''}
                    ${isSignUp ? '' : '<label style="display:flex; align-items:center; gap:8px; color:var(--text-muted); font-size:12px;"><input id="auth-remember" type="checkbox" checked style="width:auto; min-height:auto;">Remember this device</label>'}
                    <button id="auth-submit-button" type="submit" class="pt-auth-action">${isSignUp ? 'Create account' : 'Sign in'}</button>
                    ${authState.googleEnabled ? '<div class="pt-auth-divider">or</div><button type="button" class="pt-auth-action secondary" onclick="signInWithGoogle()">Continue with Google</button>' : ''}
                    <div id="auth-links" class="pt-auth-links">
                        <button type="button" onclick="setAuthFormMode('${isSignUp ? 'sign-in' : 'sign-up'}')">${isSignUp ? 'Already have an account?' : 'Create account'}</button>
                        ${isSignUp ? '<button id="auth-resend-confirmation" type="button" onclick="sendVerificationEmail()">Resend confirmation</button>' : ''}
                        ${isSignUp ? '' : '<button type="button" onclick="sendPasswordReset()">Forgot password?</button>'}
                    </div>
                    <div id="profile-auth-status" class="pt-auth-status"></div>
                </form>`;
        }

        function setAuthFormMode(mode) {
            authFormMode = mode === 'sign-up' ? 'sign-up' : 'sign-in';
            renderProfileAuthContent();
        }

        function setAuthBusy(isBusy, label = '') {
            const form = document.querySelector('#profile-auth-content form');
            if (!form) return;
            form.querySelectorAll('input, button').forEach(control => { control.disabled = Boolean(isBusy); });
            const submit = document.getElementById('auth-submit-button');
            if (submit) submit.textContent = isBusy ? (label || 'Working securelyโ€ฆ') : (authFormMode === 'sign-up' ? 'Create account' : 'Sign in');
        }

        function showVerificationAction(email = '') {
            authVerificationEmail = email || authVerificationEmail;
            const links = document.getElementById('auth-links');
            if (!links || document.getElementById('auth-resend-confirmation')) return;
            const button = document.createElement('button');
            button.id = 'auth-resend-confirmation';
            button.type = 'button';
            button.textContent = 'Resend confirmation';
            button.addEventListener('click', sendVerificationEmail);
            links.appendChild(button);
        }

