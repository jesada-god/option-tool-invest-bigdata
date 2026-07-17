# Phase 3 backend fixes

## 2026-07-17

### Anonymous demo workspace state and position IDs

- ปัญหา: ผู้ใช้ที่ปิด cloud auth ใช้ watchlist/option position state ร่วมกัน และ ID แบบสุ่มอาจชนกัน.
- สาเหตุ: legacy endpoint เก็บข้อมูลไว้ใน mutable process-wide lists (`watchlist`, `logged_positions`).
- วิธีแก้: ใช้ workspace รายเบราว์เซอร์ที่เลือกด้วย opaque `HttpOnly` demo-session cookie, ป้องกันการแก้ไขด้วย lock, และใช้ `next_position_id` แบบเพิ่มทีละหนึ่งภายใน workspace. Analytics routes ใช้ source เดียวกัน ไม่ย้อนกลับไปอ่าน state รวมกลาง.
- ผลกระทบ: demo data แยกตามเบราว์เซอร์และ ID ไม่ชนกันใน workspace; ยังเป็นข้อมูลชั่วคราวต่อ process ตามข้อจำกัด single-worker เดิม. Cloud auth, CSRF double-submit และ same-origin checks ไม่เปลี่ยน.

### Public market failure contracts

- ปัญหา: `/api/stats` และ `/api/chart-data` คืน shape ผิดจากกรณีสำเร็จเมื่อ provider timeout/unavailable.
- สาเหตุ: fallback เดิมใช้ wrapper `{success, data, message}` ต่างจาก stats object/candle array ปกติ.
- วิธีแก้: stats คืน unavailable object ที่มี key ของ stats ตามสัญญาเสมอ; chart คืน candle array ว่างเสมอเมื่อ unavailable/timeout.
- ผลกระทบ: client render loading/unavailable state ได้โดยไม่ต้องแตกแขนงตาม response shape; endpoint และ successful payload เดิมยัง backward-compatible.

### Portfolio Greeks provider degradation

- ปัญหา: `/api/portfolio/greeks` ส่ง provider exception ขึ้นเป็น 503 และยังหยิบ legacy shared positions ใน demo mode.
- สาเหตุ: route เรียก pricing callback โดยไม่มี endpoint-level fallback และอ่าน `logged_positions` โดยตรง.
- วิธีแก้: route อ่าน caller-scoped position source และคืน documented Greeks unavailable payload เมื่อ quote/provider ล้มเหลว.
- ผลกระทบ: portfolio risk panel แสดงสถานะ unavailable ได้โดยไม่ทำให้ข้อมูล portfolio อื่นหาย; pricing/portfolio engine ยังถูกใช้งานตามเดิมเมื่อข้อมูลพร้อม.

### Single-scenario simulator validation

- ปัญหา: `/api/simulate` คืน HTTP 200 พร้อม `{error}` เมื่อ target date หลัง expiration.
- สาเหตุ: business validation ถูก return เป็น payload แทน HTTP validation error.
- วิธีแก้: คืน HTTP 422 พร้อม detail ที่ชัดเจน เช่นเดียวกับ advanced simulator.
- ผลกระทบ: client ใช้ error handling มาตรฐานและแยกผลคำนวณจาก input ที่ไม่ถูกต้องได้; calculation engine และ result shape เมื่อสำเร็จไม่เปลี่ยน.

### Calculator boundary validation

- ปัญหา: calculator endpoints รับ raw JSON และ field ที่ขาด/สะกดผิดอาจเกิด `TypeError` จาก callable.
- สาเหตุ: calculators มี schema เฉพาะของ engine และไม่ได้ใช้ Pydantic request model กลาง.
- วิธีแก้: แปลง `TypeError` ที่ boundary เป็น HTTP 422; เพิ่ม regression test สำหรับ unknown/missing input shape.
- ผลกระทบ: API ให้ client error ที่ปลอดภัยและคาดเดาได้ แทน 500 โดยไม่ลด validation เชิงความหมายของ calculator engines.

### Unused legacy position input model

- ปัญหา: มี `PositionModel` ที่ไม่มี route ใช้งานและไม่มี validation ซ้ำกับ `ValidatedPositionModel` ที่เป็น boundary จริง.
- สาเหตุ: เป็น model จาก implementation เดิมที่ยังเหลือหลัง endpoint ย้ายไปใช้ validated model.
- วิธีแก้: ลบ model ที่ไม่ได้ใช้งาน โดยคง `ValidatedPositionModel`, `PositionUpdateModel` และทุก decorated API route ไว้.
- ผลกระทบ: ลดจุดที่ schema อาจ drift โดยไม่ตัด endpoint, portfolio/pricing engine หรือ validation ของ position ที่ใช้งานจริง.

# Phase 4 QA and frontend polish

### Live quote reconnect

- Added a shared browser WebSocket lifecycle for Watchlist and Analysis: exponential retry (1–15 seconds), online/offline handling, sequence-safe quote updates, and cleanup on route changes.
- Both views now show Live, Stale quote, Reconnecting, or Disconnected explicitly. A reconnect resumes without a page refresh after the server/network returns.

## 2026-07-17

### Route-level code splitting

- ปัญหา: React app import ทุก page เข้า initial bundle แม้ผู้ใช้เปิดเพียง route เดียว.
- สาเหตุ: `App.tsx` ใช้ static imports สำหรับทั้งเจ็ด pages.
- วิธีแก้: เปลี่ยนเป็น `React.lazy` พร้อม `Suspense` loading state และเพิ่ม frontend smoke test ที่ยืนยัน lazy import ของทุก page.
- ผลกระทบ: Vite สร้าง chunk แยกสำหรับ Home, Watchlist, Analysis, Portfolio, Tools, Alerts และ Account; successful routes และ API contracts เดิมไม่เปลี่ยน.

### Keyboard focus and search dialog accessibility

- ปัญหา: ไม่มี focus indicator ที่กำหนดชัดเจน, ไม่มี skip link และ Search dialog ไม่มี focus trap/focus restore.
- สาเหตุ: shell เริ่มต้นเน้นโครงสร้าง visual โดยยังไม่มี keyboard contract ครบ.
- วิธีแก้: เพิ่ม `:focus-visible`, skip-to-content link, dialog focus trap, Escape close, focus restore, listbox/option semantics และ accessible active result; เพิ่ม label ให้ profile input และกำหนด keypad buttons เป็น non-submit buttons.
- ผลกระทบ: keyboard users ข้าม navigation ได้ เห็น focus ชัดเจน และเปิด/ปิด Search โดยไม่ทำ focus หาย โดยไม่เปลี่ยน cookie, CSRF หรือ API authentication flow.

### Frontend documentation

- ปัญหา: README ยังอธิบาย navigation/auth UI ใน `index.html` แบบเก่า และไม่ได้ระบุว่าต้อง build Vite ก่อน FastAPI serve frontend.
- สาเหตุ: เอกสารไม่ได้ถูกปรับหลังย้ายเป็น React SPA.
- วิธีแก้: อธิบาย Vite/React routing, `src/` layout, lazy chunks, same-origin local build/run และ demo workspace รายเบราว์เซอร์ให้ตรง implementation ปัจจุบัน.
- ผลกระทบ: ขั้นตอน local/production และข้อจำกัด single-worker ตรงกับ build ที่ deploy จริง ลดความเสี่ยง serve SPA โดยไม่มี `dist/`.
