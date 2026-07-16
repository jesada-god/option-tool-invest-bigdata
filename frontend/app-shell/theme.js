// Quantora application-shell module: theme
// Loaded in order by /assets/app-shell.js; globals remain intentionally shared with legacy assets.

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));
        }

        // Escaping protects markup contexts; URLs need an allow-list as well.
        function safeExternalUrl(value, fallback = '#') {
            try {
                const url = new URL(String(value || ''), window.location.origin);
                return /^https?:$/.test(url.protocol) ? url.href : fallback;
            } catch (_) { return fallback; }
        }

        function isReadableUiText(value) {
            // Older source imports left a handful of Thai strings double-
            // decoded (for example, mixing Thai code points with a euro sign).
            // Do not render that mojibake; the supplied English fallback is
            // always preferable and keeps the UI readable until a translated
            // string has been verified.
            return typeof value === 'string' && !/[\u20ac\ufffd]/i.test(value);
        }

        function t(key, fallback) {
            const language = userPreferences.language === 'th' ? 'th' : 'en';
            const translated = UI_TRANSLATIONS[language]?.[key];
            return isReadableUiText(translated) ? translated : (fallback || key);
        }

        function analysisText(key, fallback) {
            const thai = {
                loading: 'เธเธณเธฅเธฑเธเนเธซเธฅเธ”เธเนเธญเธกเธนเธฅเธงเธดเน€เธเธฃเธฒเธฐเธซเนโ€ฆ',
                company_unavailable: 'เธขเธฑเธเนเธกเนเธกเธตเธฃเธฒเธขเธฅเธฐเน€เธญเธตเธขเธ”เธเธฃเธดเธฉเธฑเธ—เธเธฒเธเธเธนเนเนเธซเนเธเธฃเธดเธเธฒเธฃเธเนเธญเธกเธนเธฅเนเธเธเธ“เธฐเธเธตเน',
                company_source: 'เธเธณเธญเธเธดเธเธฒเธขเธเธเธฑเธเน€เธ•เนเธกเธเธฒเธเนเธซเธฅเนเธเธเนเธญเธกเธนเธฅ (เธ เธฒเธฉเธฒเน€เธ”เธดเธก)',
                sector: 'เธเธฅเธธเนเธกเธเธธเธฃเธเธดเธ', industry: 'เธญเธธเธ•เธชเธฒเธซเธเธฃเธฃเธก', exchange: 'เธ•เธฅเธฒเธ”เธซเธฅเธฑเธเธ—เธฃเธฑเธเธขเน', employees: 'เธเธณเธเธงเธเธเธเธฑเธเธเธฒเธ', market_cap: 'เธกเธนเธฅเธเนเธฒเธ•เธฅเธฒเธ”', website: 'เน€เธงเนเธเนเธเธ•เน',
                trailing_pe: 'P/E เธขเนเธญเธเธซเธฅเธฑเธ', forward_pe: 'P/E เธเธฒเธ”เธเธฒเธฃเธ“เน', revenue: 'เธฃเธฒเธขเนเธ”เน', profit_margin: 'เธญเธฑเธ•เธฃเธฒเธเธณเนเธฃเธชเธธเธ—เธเธด', dividend_yield: 'เธญเธฑเธ•เธฃเธฒเน€เธเธดเธเธเธฑเธเธเธฅ', fair_value: 'เธกเธนเธฅเธเนเธฒเธเธทเนเธเธเธฒเธ',
                financial_note: 'เธเนเธญเธกเธนเธฅเธเธฒเธเธเธนเนเนเธซเนเธเธฃเธดเธเธฒเธฃเธ•เธฅเธฒเธ” เนเธเนเธเธฃเธฐเธเธญเธเธเธฒเธฃเธงเธดเน€เธเธฃเธฒเธฐเธซเน เนเธกเนเนเธเนเธเธณเนเธเธฐเธเธณเธ—เธฒเธเธเธฑเธเธเธตเธซเธฃเธทเธญเธเธฒเธฃเธฅเธเธ—เธธเธ',
                news_note: 'เนเธชเธ”เธเธเนเธฒเธงเธฅเนเธฒเธชเธธเธ”เธ—เธตเนเน€เธเธตเนเธขเธงเธเนเธญเธเธเธฑเธเธซเธธเนเธเธเธตเน เนเธกเนเน€เธเธดเธ 5 เธเนเธฒเธง เนเธฅเธฐเธขเนเธญเธเธซเธฅเธฑเธเนเธกเนเน€เธเธดเธ 3 เน€เธ”เธทเธญเธ',
                news_original_language: 'เธเธฒเธ”เธซเธฑเธงเนเธชเธ”เธเธ•เธฒเธกเธ เธฒเธฉเธฒเธเธญเธเนเธซเธฅเนเธเธเนเธฒเธง',
                no_news: 'เธขเธฑเธเนเธกเนเธเธเธเนเธฒเธงเธชเธณเธเธฑเธเธ—เธตเนเน€เธเธตเนเธขเธงเธเนเธญเธเนเธเธเนเธงเธ 3 เน€เธ”เธทเธญเธเธฅเนเธฒเธชเธธเธ”',
                forecast_note: 'เธชเธฑเธเธเธฒเธ“เน€เธเธดเธเธงเธดเน€เธเธฃเธฒเธฐเธซเนเน€เธเธทเนเธญเธเธฃเธฐเธเธญเธเธเธฒเธฃเธ•เธฑเธ”เธชเธดเธเนเธ เนเธกเนเนเธเนเธเธณเนเธเธฐเธเธณเนเธซเนเธเธทเนเธญเธซเธฃเธทเธญเธเธฒเธข',
                signal: 'เธชเธฑเธเธเธฒเธ“', confidence: 'เธเธงเธฒเธกเน€เธเธทเนเธญเธกเธฑเนเธ', bullish: 'เนเธญเธเธฒเธชเธเธถเนเธ', bearish: 'เนเธญเธเธฒเธชเธฅเธ', closest_weekly_sr: 'เนเธเธงเธฃเธฑเธ/เธ•เนเธฒเธเธฃเธฒเธขเธชเธฑเธเธ”เธฒเธซเนเธ—เธตเนเนเธเธฅเนเธชเธธเธ”', distance: 'เธฃเธฐเธขเธฐเธซเนเธฒเธ',
                unavailable: 'เธเนเธญเธกเธนเธฅเธเธตเนเธขเธฑเธเนเธกเนเธเธฃเนเธญเธกเนเธเนเธเธฒเธ เธเธฃเธธเธ“เธฒเธฅเธญเธเนเธซเธกเนเธญเธตเธเธเธฃเธฑเนเธ',
            };
            const translated = thai[key];
            return userPreferences.language === 'th' && isReadableUiText(translated)
                ? translated
                : (fallback || key);
        }

        function formatAnalysisDate(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '';
            return date.toLocaleDateString(userPreferences.language === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        }

        function localizedCompanySummary(data) {
            if (userPreferences.language !== 'th') return data.summary || analysisText('company_unavailable', 'Company overview is not available from the configured market-data provider.');
            const name = data.name || data.ticker || 'เธเธฃเธดเธฉเธฑเธ—เธเธตเน';
            const industry = data.industry && data.industry !== 'Unavailable' ? data.industry : 'เธเธฅเธธเนเธกเธเธธเธฃเธเธดเธเธ—เธตเนเน€เธเธตเนเธขเธงเธเนเธญเธ';
            const sector = data.sector && data.sector !== 'Unavailable' ? data.sector : 'เธ•เธฅเธฒเธ”เธ—เธธเธ';
            return `${name} เธ”เธณเน€เธเธดเธเธเธธเธฃเธเธดเธเนเธเธญเธธเธ•เธชเธฒเธซเธเธฃเธฃเธก ${industry} เธ เธฒเธขเนเธ•เนเธเธฅเธธเนเธกเธเธธเธฃเธเธดเธ ${sector} เธเนเธญเธกเธนเธฅเธ”เนเธฒเธเธฅเนเธฒเธเธญเนเธฒเธเธญเธดเธเธเธฒเธเธเธนเนเนเธซเนเธเธฃเธดเธเธฒเธฃเธเนเธญเธกเธนเธฅเธ•เธฅเธฒเธ”เธฅเนเธฒเธชเธธเธ”.`;
        }

        function applyLanguage(language) {
            userPreferences.language = language === 'th' ? 'th' : 'en';
            document.documentElement.lang = userPreferences.language;
            document.querySelectorAll('[data-i18n]').forEach(element => {
                const key = element.dataset.i18n;
                const english = element.dataset.i18nDefault || element.textContent.trim();
                if (!element.dataset.i18nDefault) element.dataset.i18nDefault = english;
                element.textContent = t(key, english);
            });
            const navKeys = { home: 'home', watchlist: 'watchlist', search: 'search', tools: 'tools', portfolio: 'portfolio', profile: 'profile' };
            document.querySelectorAll('.pt-nav-item').forEach(button => {
                const label = button.querySelector('span:not(.pt-nav-badge)');
                const key = navKeys[button.dataset.nav];
                if (label && key) {
                    if (!label.dataset.i18nDefault) label.dataset.i18nDefault = label.textContent.trim();
                    label.textContent = t(key, label.dataset.i18nDefault);
                }
            });
            const search = document.getElementById('search-input');
            if (search) search.placeholder = userPreferences.language === 'th' ? 'เธเนเธเธซเธฒเธซเธธเนเธ เน€เธเนเธ AAPL, TSLA...' : 'Search stocks, e.g. AAPL, TSLA...';
            const settingsButton = document.getElementById('app-settings-button');
            if (settingsButton) {
                const label = userPreferences.language === 'th' ? 'เธ•เธฑเนเธเธเนเธฒ' : 'Settings';
                settingsButton.title = label;
                settingsButton.setAttribute('aria-label', label);
            }
            updateFavoriteButton();
            setProfileSummary();
        }

