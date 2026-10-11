<div dir="rtl">

# ZX AI — راهنمای توسعه

برای کسی که می‌خواهد کد را تغییر بدهد، تست کند و نسخه‌ی تازه بیرون بدهد. اول [ARCHITECTURE.md](ARCHITECTURE.md) را بخوانید.

## پیش‌نیاز

- **Node.js 24** یا تازه‌تر. `node:sqlite`، `--experimental-sea-config` و TypeScript با `tsx` به آن تکیه دارند.
- یک مرورگر Chromium (Chrome، Edge، Brave) نسخه‌ی ۱۱۶ یا تازه‌تر.
- ویندوز برای پنجره‌ی انتخاب پوشه و فایل نصب. بقیه‌ی کد روی هر سیستمی اجرا می‌شود.
- git (برای ابزار `exec git` و تست‌هایش).

## راه‌اندازی

<div dir="ltr">

```bash
npm install
npm run ext
npm start
```

</div>

`npm run ext` افزونه را در `extension/dist` می‌سازد. در مرورگر: `chrome://extensions` ← Developer mode ← Load unpacked ← `extension/dist`. بعد روی آیکون ZX AI بزنید و شماره‌ی موبایل نویسنده را وارد کنید (بخش «فعال‌سازی» را ببینید).

`npm start` سرور را مستقیم و بدون راه‌انداز اجرا می‌کند. برای کار روزمره `npm run up` بهتر است، چون دکمه‌های روشن و خاموش افزونه به راه‌انداز نیاز دارند.

## دستورها

| دستور | کار |
|---|---|
| `npm start` | سرور از سورس با `tsx` (`src/main.ts`) |
| `npm run up` | اجرای راه‌انداز (اگر نیست) و روشن کردن سرور از راه آن |
| `npm run down` | خاموش کردن سرور و راه‌انداز |
| `npm run ext` | ساخت افزونه در `extension/dist` و نوشتن `version_name` با هش محتوا |
| `npm run typecheck` | `tsc` برای سرور و افزونه (دو tsconfig) |
| `npm test` | همه‌ی تست‌ها با vitest |
| `npm run check` | typecheck، تست و ساخت افزونه. **قبل از هر commit** |
| `npm run package` | ساخت `release/ZX-AI-Setup.exe` |

## ساختار پوشه‌ها

<div dir="ltr">

```
src/
  main.ts            CLI entry of the server
  sea.ts             single-file entry (setup / --launcher / --server / --version)
  app.ts             App: settings, workspace, approvals, state()
  agent/             session loop, text protocol, extension link, sites, diff
  core/              path guard, approval gate & queue, audit log, registry, text io, errors
  tools/             fs_read, fs_list, fs_grep, fs_write, fs_apply_diff, exec
  server/            http.ts (all routes), request-guard.ts
  shared/            protocol.ts (bridge <-> extension types), version.ts
extension/
  manifest.json      MV3; "key" fixes the extension id
  src/               background, page, settle, awake, panel, options, activation, chrome.d.ts
  dist/              build output (git-ignored), what the browser loads
host/                launcher-core.mjs (+ .d.mts), zx-launcher.mjs (dev entry)
scripts/             build-extension, launcher (up/down), package (installer)
ui/index.html        the whole UI: one file, Persian, RTL, no framework
test/                vitest, one file per unit plus server and session end to end
docs/                ARCHITECTURE, API, DEVELOPMENT, DESIGN
```

</div>

## تست

<div dir="ltr">

```bash
npm test
npx vitest run test/session.test.ts
npx vitest run -t "two browsers"
```

</div>

حدود ۵۸۰ تست در ۲۷ فایل. مهم‌ترین‌ها:

| فایل | چه چیزی را نگه می‌دارد |
|---|---|
| `path-guard.test.ts` | فرار از پوشه: `..`، junction، 8.3، ADS، نام‌های رزرو |
| `exec.test.ts` | allowlist، پرچم‌های ممنوع git، مهلت، سقف خروجی، محیط کودک |
| `session.test.ts` | حلقه با رجیستری واقعی: اجرا، تلاش دوباره، توقف وسط ابزارها، سقف گام |
| `agent-protocol.test.ts` | استخراج بلوک‌ها، ترمیم JSON، بلوک بریده، نتیجه‌ی ساختگی |
| `link.test.ts` | job، مهلت، resume، دو مرورگر |
| `settle.test.ts` | تشخیص پایان پاسخ، تب پنهان |
| `awake.test.ts` | فریم‌ها در تب پنهان، با window و document ساختگی |
| `server.test.ts` | سرور واقعی با WebSocket و Origin افزونه |
| `modes.test.ts` | حالت‌های مجوز و «همیشه در این گفتگو» |
| `version.test.ts` | یکسان بودن نسخه در `package.json`، مانیفست و `version.ts` |

تست‌ها پوشه‌های موقت می‌سازند (`test/helpers.ts`) و در `afterEach` پاکشان می‌کنند. شیئی که `App` می‌سازد باید `app.close()` شود، وگرنه ویندوز فایل `audit.db` را قفل نگه می‌دارد و پاک کردن پوشه با `EPERM` خطا می‌دهد.

## اجرای سرتاسری بدون UI

برای آزمودن یک دور واقعی روی سایت زنده، API را مستقیم صدا بزنید:

<div dir="ltr">

```js
const base = "http://127.0.0.1:39271";
await fetch(base + "/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "..." }) });
// poll GET /api/state until busy === false, then read state.items
```

</div>

هر پیام واقعاً به سایت چت کاربر فرستاده می‌شود. پیام آزمایشی کوتاه و فقط‌خواندنی بفرستید. حالت مجوز را عوض نکنید و پیش از راه‌اندازی دوباره‌ی سرور ببینید کسی وسط کار نباشد، چون گفتگوی داخل برنامه پاک می‌شود.

## اشکال‌زدایی

| کجا | چه چیزی |
|---|---|
| `%APPDATA%\zx-ai\server.log` | خروجی سرور، اتصال و قطع افزونه با نام مرورگر |
| `%APPDATA%\zx-ai\launcher.log` | start و stop راه‌انداز |
| تنظیمات ZX ← «گزارش افزونه» | خطاهای service worker (همان `log` ها) |
| تنظیمات ZX ← «کارهای انجام‌شده» | لاگ ممیزی |
| تنظیمات ZX ← «بررسی سایت» | کدام انتخابگر پیدا شد. با `needle` (`POST /api/probe {needle}`) مسیر عنصری که متنی را دارد برمی‌گردد و برای پیدا کردن انتخابگر تازه مفید است |
| `chrome://extensions` ← ZX AI ← service worker | کنسول worker |
| DevTools تب سایت ← Console، context «ZX AI» | `__zx` و `__zxState` در دنیای ISOLATED. `__zxAwake` در دنیای اصلی صفحه است |

اتصال مدام قطع و وصل می‌شود؟ در `server.log` دنبال «connected (X)» و «disconnected (code ...)» بگردید. کد `4001` یعنی مرورگر دیگری ZX را دارد. چند مرورگر با افزونه‌ی فعال همین را نشان می‌دهند.

## کارهای رایج

### اضافه کردن سایت تازه

1. در مرورگر به سایت بروید و وارد شوید.
2. صفحه‌ی تنظیمات افزونه ← اجازه‌ی میزبان برای آن سایت.
3. تنظیمات ZX ← «انتخابگرهای سایت» ← یک JSON با `id` تازه و همه‌ی فیلدهای `Site` ← ذخیره.
4. «بررسی سایت» تا همه‌ی انتخابگرها ✓ شوند. اول انتخابگرهای ساختاری (role، `data-*`، `aria-label`) را امتحان کنید؛ class های هش‌شده با هر deploy عوض می‌شوند.

برای سایت پیش‌فرض: به `DEFAULT_SITES` در `src/agent/sites.ts` اضافه کنید، میزبان را به `host_permissions` در `extension/manifest.json` بیفزایید (`content_scripts` همان فهرست را برای `awake.js` به کار می‌برد)، و `npm run check` را اجرا کنید.

### اضافه کردن ابزار

1. فایل `src/tools/<name>.ts` با الگوی ابزارهای موجود: `name`، `opClass`، `describe()` (یک خط برای primer، با شکل آرگومان‌ها)، `parseArgs` (رد کردن هر ورودی بد با `ZxError`)، `summarize`، `run(args, signal)`. هر مسیر فقط از راه `guard.resolve`.
2. ثبت در `buildTools` در `src/app.ts`.
3. اگر می‌نویسد، `opClass: "write"` بدهید تا gate و حالت‌ها رویش اعمال شوند. پیش‌نمایش diff در `App.#preview` برای `fs_write` و `fs_apply_diff` است.
4. تست در `test/<name>.test.ts`. موارد رد شدن را هم بنویسید، نه فقط حالت موفق.

### تغییر پیام بین سرور و افزونه

نوع را در `src/shared/protocol.ts` عوض کنید. هر دو طرف آن را import می‌کنند، پس ناسازگاری خطای کامپایل می‌شود. افزونه‌ای که از قبل باز است نسخه‌ی قدیمی را اجرا می‌کند تا reload شود. سرور هنگام `hello`، اگر build روی دیسک فرق کند و کاری در جریان نباشد، `reload` می‌فرستد (حداکثر هر ۶۰ ثانیه یک بار).

### تغییر UI

همه‌چیز در `ui/index.html` است: CSS با توکن‌های `:root` (و `prefers-color-scheme: dark`)، HTML، و یک `<script>` بدون وابستگی. با هر push، `render()` اجرا می‌شود و هر بخش فقط وقتی DOM را دست می‌زند که داده‌اش عوض شده باشد (`setText`، `setClass`، کلیدهای `dataset.key`). متن‌ها فارسی و کوتاه بمانند. هیچ HTML از داده ساخته نمی‌شود؛ همه با `textContent` و `el()`. خطاها با `toast()` نشان داده می‌شوند، نه `alert()`، چون پنل کناری ممکن است دیالوگ را نشان ندهد.

بعد از تغییر، صفحه را در عرض ۳۸۰ پیکسل (پنل کناری) و در حالت تاریک هم ببینید.

## فعال‌سازی

افزونه تا وقتی در یک مرورگر فعال نشده، به سرور وصل نمی‌شود. پنل کناری شماره‌ی موبایل نویسنده را می‌پرسد. شماره در [README.md](../README.md#نصب-سریع-کاربر) آمده است.

- `extension/src/activation.ts` فقط هش را نگه می‌دارد: `SHA-256("zx-ai:" + شماره)`. شماره پیش از هش نرمال می‌شود: رقم‌های فارسی و عربی به 0-9 تبدیل می‌شوند، `+98` و `98` به `0` تبدیل می‌شوند و هر چیز غیررقمی حذف می‌شود.
- با فعال شدن، `activated: true` در `chrome.storage.local` همان پروفایل مرورگر نوشته می‌شود و برای همیشه می‌ماند.
- برای عوض کردن شماره، هش تازه را بسازید و در `ACTIVATION_HASH` بگذارید. `test/activation.test.ts` را هم به‌روز کنید:

<div dir="ltr">

```bash
node -e "console.log(require(crypto).createHash(sha256).update(zx-ai:09xxxxxxxxx).digest(hex))"
```

</div>

این قفل جلوی استفاده‌ی اتفاقی را می‌گیرد. کسی که کد را بخواند می‌تواند از آن رد شود.

## انتشار نسخه

1. شماره را در `src/shared/version.ts`، `package.json` و `extension/manifest.json` یکسان عوض کنید (`version.test.ts` بررسی می‌کند).
2. `CHANGELOG.md` را به‌روز کنید.
3. `npm run check`.
4. `npm run package`. خروجی `release/ZX-AI-Setup.exe` حدود ۹۰ مگابایت است و امضا ندارد.
5. نسخه‌ی exe را با `release\ZX-AI-Setup.exe --version` بررسی کنید.
6. commit و `git tag -a vX.Y.Z`.

فایل نصب این کارها را انجام می‌دهد (`src/sea.ts`):

- نسخه‌ی در حال اجرا را خاموش می‌کند، با راه‌انداز یا بدون آن.
- فایل‌ها را در `%LOCALAPPDATA%\ZX-AI` باز می‌کند.
- اگر exe قفل باشد، جایگزینی‌اش را تا ۱۵ بار تکرار می‌کند.
- راه‌انداز و سرور را روشن می‌کند و پوشه‌ی افزونه را باز می‌کند.

## قراردادها و تله‌ها

- **هیچ `process.exit()` بلافاصله بعد از `fetch`.** در ویندوز libuv با «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)» می‌افتد. بگذارید فرایند خودش تمام شود یا `process.exitCode` بدهید.
- **`String.prototype.replace` با رشته‌ی جایگزین** الگوهای `$&`، `` $` `` و `$$` را تفسیر می‌کند. در اسکریپت‌های patch، جایگزین را به‌صورت تابع بدهید: `s.replace(a, () => b)`.
- `git checkout` روی این مخزن فایل را CRLF برمی‌گرداند، ولی سورس‌ها LF هستند. پیش از جست‌وجوی رشته‌ای چندخطی، CRLF را LF کنید.
- `page.ts` در دنیای ISOLATED است و `document.hidden` واقعی را می‌بیند. `awake.ts` در دنیای MAIN است و `document.hidden` را برای خود سایت `false` می‌کند. منطقی که به پنهان بودن واقعی نیاز دارد باید در `page.ts` باشد.
- تایمرهای صفحه در تب پنهان حداکثر ثانیه‌ای یک بار (و بعد از مدتی دقیقه‌ای یک بار) اجرا می‌شوند. `sleep` در `page.ts` در حالت پنهان از `MessageChannel` استفاده می‌کند. نمونه‌برداری اصلی هم از service worker است، نه از خود صفحه.
- تب چت **هیچ‌وقت** به‌طور خودکار جلو آورده یا focus نمی‌شود. این خواست صریح کاربر است. فقط دکمه‌ی «نمایش تب» این کار را می‌کند.
- هر کد و کامنت و پیام commit انگلیسی است. متن رابط کاربری و مستندات فارسی است.
- هر فایل `.md` با wrapper راست‌به‌چپ نوشته می‌شود. قاعده در [CONTRIBUTING.md](../CONTRIBUTING.md#markdown-راست‌به‌چپ) آمده است.

## کارهای باز

| موضوع | وضعیت |
|---|---|
| انتخابگرهای Gemini و Claude روی صفحه‌ی زنده | آزموده نشده. DeepSeek و ChatGPT در ۲۰۲۶-۱۰ اندازه گرفته شدند |
| جدا کردن متن «thinking» (DeepSeek R1، استدلال ChatGPT) از پاسخ | باز. پیشنهاد: فهرست `exclude` در `Site` که `extract` نادیده بگیرد |
| خواندن پاسخ از جریان شبکه‌ی سایت به‌جای DOM | پیشنهاد، فقط به‌عنوان پشتیبان. قالب جریان هر سایت در [DESIGN.md](DESIGN.md) آمده |
| دکمه‌ی «Continue generating» وقتی پاسخ بریده می‌شود | باز |
| ابزارهای git نوشتنی با کلاس `destructive` | باز |
| تشخیص صفحه‌ی ورود یا captcha با انتخابگر به‌جای عنوان صفحه | باز. الان فقط `document.title` بررسی می‌شود |
| امضای دیجیتال exe | ندارد. ویندوز هشدار SmartScreen می‌دهد |

</div>
