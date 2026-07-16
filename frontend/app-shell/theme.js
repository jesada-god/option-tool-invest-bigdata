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
                loading: 'กำลังโหลดข้อมูลวิเคราะห์…',
                company_unavailable: 'ยังไม่มีรายละเอียดบริษัทจากผู้ให้บริการข้อมูลในขณะนี้',
                company_source: 'คำอธิบายฉบับเต็มจากแหล่งข้อมูล (ภาษาเดิม)',
                sector: 'กลุ่มธุรกิจ', industry: 'อุตสาหกรรม', exchange: 'ตลาดหลักทรัพย์', employees: 'จำนวนพนักงาน', market_cap: 'มูลค่าตลาด', website: 'เว็บไซต์',
                trailing_pe: 'P/E ย้อนหลัง', forward_pe: 'P/E คาดการณ์', revenue: 'รายได้', profit_margin: 'อัตรากำไรสุทธิ', dividend_yield: 'อัตราเงินปันผล', fair_value: 'มูลค่าพื้นฐาน',
                financial_note: 'ข้อมูลจากผู้ให้บริการตลาด ใช้ประกอบการวิเคราะห์ ไม่ใช่คำแนะนำทางบัญชีหรือการลงทุน',
                news_note: 'แสดงข่าวล่าสุดที่เกี่ยวข้องกับหุ้นนี้ ไม่เกิน 5 ข่าว และย้อนหลังไม่เกิน 3 เดือน',
                news_original_language: 'พาดหัวแสดงตามภาษาของแหล่งข่าว',
                no_news: 'ยังไม่พบข่าวสำคัญที่เกี่ยวข้องในช่วง 3 เดือนล่าสุด',
                forecast_note: 'สัญญาณเชิงวิเคราะห์เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำให้ซื้อหรือขาย',
                signal: 'สัญญาณ', confidence: 'ความเชื่อมั่น', bullish: 'โอกาสขึ้น', bearish: 'โอกาสลง', closest_weekly_sr: 'แนวรับ/ต้านรายสัปดาห์ที่ใกล้สุด', distance: 'ระยะห่าง',
                unavailable: 'ข้อมูลนี้ยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง',
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
            const name = data.name || data.ticker || 'บริษัทนี้';
            const industry = data.industry && data.industry !== 'Unavailable' ? data.industry : 'กลุ่มธุรกิจที่เกี่ยวข้อง';
            const sector = data.sector && data.sector !== 'Unavailable' ? data.sector : 'ตลาดทุน';
            return `${name} ดำเนินธุรกิจในอุตสาหกรรม ${industry} ภายใต้กลุ่มธุรกิจ ${sector} ข้อมูลด้านล่างอ้างอิงจากผู้ให้บริการข้อมูลตลาดล่าสุด.`;
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
            if (search) search.placeholder = userPreferences.language === 'th' ? 'ค้นหาหุ้น เช่น AAPL, TSLA...' : 'Search stocks, e.g. AAPL, TSLA...';
            const settingsButton = document.getElementById('app-settings-button');
            if (settingsButton) {
                const label = userPreferences.language === 'th' ? 'ตั้งค่า' : 'Settings';
                settingsButton.title = label;
                settingsButton.setAttribute('aria-label', label);
            }
            updateFavoriteButton();
            setProfileSummary();
        }

