<div dir="rtl">

# ZX AI — معماری

نسخه‌ی `1.0.0`. این سند برای توسعه‌دهنده‌ای است که می‌خواهد کد را بفهمد و ادامه بدهد. رابط‌های دقیق (HTTP، WebSocket، قالب پیام با مدل) در [API.md](API.md) آمده‌اند. راه‌اندازی محیط، تست و انتشار در [DEVELOPMENT.md](DEVELOPMENT.md) است. چرایی تصمیم‌ها در [DESIGN.md](DESIGN.md) ثبت شده است.

## نمای کلی

ZX یک برنامه‌ی محلی Node است که با سایت‌های چت هوش مصنوعی (ChatGPT، Gemini، Claude، DeepSeek) **از راه مرورگر خود کاربر** کار می‌کند، نه از راه API. همه‌ی منطق در برنامه است و افزونه‌ی مرورگر فقط «دست و چشم» است: در جعبه‌ی پیام سایت می‌نویسد، ارسال را می‌زند و پاسخ را از DOM می‌خواند.

<div dir="ltr">

```
┌──────────────┐  HTTP + SSE   ┌───────────────────────────────────────────┐
│ ui/index.html│◄─────────────►│ Bridge (Node 24)   127.0.0.1:39271         │
│ (tab / side  │               │  src/server/http.ts   one listener         │
│  panel)      │               │  src/app.ts           settings, wiring     │
└──────────────┘               │  src/agent/session.ts the agent loop       │
                               │  src/core/*, src/tools/*  sandboxed tools  │
                               │  src/agent/link.ts    jobs over WebSocket  │
                               └───────────────┬───────────────────────────┘
                                               │ WebSocket /ws (Origin = extension)
                               ┌───────────────▼───────────────────────────┐
                               │ Extension (MV3)                            │
                               │  background.ts  service worker, jobs       │
                               │  page.ts        injected per message       │
                               │  awake.ts       MAIN world, document_start │
                               │  settle.ts      "is the reply finished"    │
                               └───────────────┬───────────────────────────┘
                                               │ chrome.scripting.executeScript
                                       ┌───────▼────────┐
                                       │ chat site tab  │
                                       └────────────────┘

Launcher (host/launcher-core.mjs) 127.0.0.1:39270: starts / stops the bridge for the extension.
```

</div>

## فرایندها

| فرایند | کد | پورت | کار |
|---|---|---|---|
| راه‌انداز (launcher) | `host/launcher-core.mjs` (ورودی توسعه `host/zx-launcher.mjs`، ورودی بسته `src/sea.ts --launcher`) | `39270` | فرایند کوچک ماندگار. سرور را روشن و خاموش می‌کند. فقط به افزونه‌ی ZX و برنامه‌های محلی جواب می‌دهد |
| سرور (bridge) | `src/main.ts` | `39271` | صفحه‌ی UI، API، SSE و WebSocket افزونه؛ حلقه‌ی کار و ابزارها |
| service worker افزونه | `extension/src/background.ts` | — | یک WebSocket ماندگار به سرور؛ انتخاب تب، تزریق اسکریپت، نمونه‌برداری پاسخ |
| اسکریپت صفحه | `extension/src/page.ts` (ISOLATED world) | — | برای هر پیام تزریق می‌شود؛ وضعیتش روی صفحه در `globalThis.__zxState` می‌ماند |
| اسکریپت بیدارباش | `extension/src/awake.ts` (MAIN world) | — | از `document_start` در صفحه‌ی سایت‌های شناخته‌شده؛ قبل از هر پیام هم تزریق می‌شود |

`start.cmd` یا `npm run up` (`scripts/launcher.mjs`) راه‌انداز را اگر نیست اجرا می‌کند و از آن می‌خواهد سرور را روشن کند. در حالت توسعه سرور با `node --import tsx src/main.ts` اجرا می‌شود. در نسخه‌ی بسته، همان `zx-ai.exe --server` است.

## اجزای سرور

| فایل | مسئولیت |
|---|---|
| `src/main.ts` | خط فرمان (`--workspace`، `--port`، `--no-open`، `--version`)، ساخت `App` و سرور، نوشتن `server.json`، خاموش کردن مرتب |
| `src/sea.ts` | ورودی فایل تکی: نصب (بدون آرگومان)، `--launcher`، `--server`، `--version` |
| `src/app.ts` | کلاس `App`: تنظیمات، پوشه‌ی کاری و ابزارها، صف اجازه، لاگ ممیزی، اتصال افزونه، گفتگو. حالت مجوز (`ask/edits/all/readonly`) و اجازه‌های «همیشه در این گفتگو» اینجا تصمیم گرفته می‌شود. `state()` تصویر کامل برای UI است |
| `src/server/http.ts` | تنها listener. مسیرها، SSE با ادغام ۱۰۰ میلی‌ثانیه‌ای، WebSocket افزونه با ping هر ۱۵ ثانیه، قاعده‌ی «یک مرورگر در هر لحظه» |
| `src/server/request-guard.ts` | دو قاعده‌ی دسترسی: `checkUi` (Host و Origin) و `checkExtension` (Origin افزونه) |
| `src/agent/session.ts` | حلقه‌ی کار (پایین‌تر). وضعیت گفتگو (`items`)، شمارنده‌ی ارسال، تلاش دوباره، ارسال دوباره از اول |
| `src/agent/protocol.ts` | قالب متنی با مدل: primer، استخراج بلوک‌های fenced، ترمیم JSON، قالب نتیجه‌ها. توابع خالص |
| `src/agent/link.ts` | `ExtensionLink`: هر درخواست یک job با `jobId` یکتا، مهلت، لغو، resume بعد از قطع، انتظار ۱۰ ثانیه‌ای برای اتصال، پذیرفتن فقط یک مرورگر |
| `src/agent/sites.ts` | انتخابگرهای پیش‌فرض چهار سایت و ادغام با تنظیمات کاربر |
| `src/agent/diff.ts` | diff خطی Myers برای «+n −m» و نمای شبیه git؛ سقف حافظه دارد |
| `src/shared/protocol.ts` | نوع پیام‌های سرور ↔ افزونه، `Site`، `FailCode`، `Phase`، شناسه‌ی افزونه، پورت‌ها. هر دو طرف همین فایل را import می‌کنند |
| `src/shared/version.ts` | تنها منبع شماره‌ی نسخه |

## هسته‌ی امنیتی و ابزارها

| فایل | مسئولیت |
|---|---|
| `src/core/path-guard.ts` | `PathGuard`: هر مسیر را به مسیر واقعی داخل پوشه‌ی کاری تبدیل می‌کند یا رد می‌کند (`..`، مسیر مطلق بیرونی، junction و symlink، نام‌های 8.3، ADS، نام‌های رزرو ویندوز مثل `CON`) |
| `src/core/approval-gate.ts` | `ApprovalGate`: کلاس عملیات (`read/write/destructive/exec`) را تعیین می‌کند و برای غیرخواندنی از prompter اجازه می‌گیرد |
| `src/core/approval-queue.ts` | `ApprovalQueue`: درخواست‌های در انتظار که UI نشان می‌دهد؛ snapshotهای منجمد تا کسی نتواند محتوای در حال تأیید را عوض کند |
| `src/core/audit-log.ts` | `AuditLog` روی `node:sqlite`: هر فراخوانی، موفق یا ناموفق، در جدول `audit` |
| `src/core/tool-registry.ts` | `ToolRegistry`: اعتبارسنجی آرگومان‌ها، منجمد کردن، گذر از gate، اجرا، ثبت ممیزی. `signal` توقف را به ابزار می‌رساند |
| `src/core/text-io.ts`، `src/core/errors.ts` | خواندن و نوشتن متن (encoding، BOM، پایان خط) و `ZxError` با کد |
| `src/tools/*.ts` | شش ابزار: `fs_read`، `fs_list`، `fs_grep`، `fs_write`، `fs_apply_diff`، `exec`. جزئیات و سقف‌ها در [API.md](API.md#ابزارها) |

زنجیره‌ی هر فراخوانی ابزار:

<div dir="ltr">

```
Session.#run → ToolRegistry.call(name, args, {signal})
  → def.parseArgs (validation)          → freeze
  → ApprovalGate.ensureAllowed(opClass) → prompter = App.decide()
        mode (readonly→deny, all→allow, edits+write→allow)
        → allowed-this-chat set → ApprovalQueue.request() (UI card)
  → def.run(frozenArgs, signal)         → PathGuard.resolve() inside
  → AuditLog.record / recordFailure
```

</div>

## اجزای افزونه

| فایل | مسئولیت |
|---|---|
| `extension/manifest.json` | MV3. `key` شناسه را ثابت نگه می‌دارد (`fcpgbikgfnfapkcfgfbkjfdjdemagdkp`). مجوزها: `scripting`، `storage`، `alarms`، `sidePanel` و host برای چهار سایت. `content_scripts` فقط `awake.js` در MAIN world |
| `background.ts` | اتصال WebSocket (یک سوکت، ping هر ۲۰ ثانیه، alarm هر ۳۰ ثانیه)، شناسه‌ی نصب و نام مرورگر در query، عقب‌نشینی ۶۰ ثانیه‌ای وقتی مرورگر دیگری وصل است (کد بستن `4001`)، اجرای `ask/probe/show/resume/cancel/reload/restart-app` |
| `page.ts` | `prepare` (پیدا کردن جعبه‌ی پیام و نوشتن)، `submit` (ارسال با سه روش و اثبات رفتن پیام)، `tick` (نمونه‌برداری پاسخ)، `stop`، `probe`. `extract` پاسخ را به متن با fenceهای کد برمی‌گرداند |
| `settle.ts` | تصمیم «پاسخ تمام شد» از روی نمونه‌ها. بدون DOM، با تست واحد |
| `awake.ts` | در تب پنهان: صفحه را «دیده‌شده» نشان می‌دهد و requestAnimationFrame را با تایمر و رویداد `zx-wake` اجرا می‌کند |
| `panel.ts` + `panel.html` | پنل کناری: فعال‌سازی با شماره‌ی موبایل نویسنده، iframe صفحه‌ی ZX، دکمه‌ی «روشن کردن ZX»، و پیام «در مرورگر دیگری وصل است» با «وصل کردن این مرورگر» |
| `options.ts` + `options.html` | پورت سرور، اجازه‌ی میزبان برای سایت تازه، روشن و خاموش |
| `activation.ts` | مقایسه‌ی SHA-256 نمک‌دار شماره با هش ذخیره‌شده. بازدارنده است، نه امنیت |

## یک دور کار، قدم به قدم

<div dir="ltr">

```
UI  POST /api/send {text}
App.send → Session.send → #loop(text)
  step 1..maxSteps:
    ExtensionLink.ask(site, message, {primer, primedUrl, newChat, signal})
      → WS {type:"ask", jobId, ...}
      background.ask:
        siteTab()          active tab of that site, else most recent, else new background tab
        claim()            storage.session job:<id> = tabId; autoDiscardable=false
        inject()           awake.js (MAIN) + page.js (ISOLATED)
        __zx.prepare()     find composer, type (native setter / paste / insertText), verify
        __zx.submit()      send button → Enter → icon button, each only until proof it left
        follow():          every 700 ms __zx.tick()  (dispatches zx-wake first)
            progress → WS {type:"progress"}      → Session updates the streaming item
            done     → WS {type:"done", text, url}
    Session: parseCalls(reply)
      no calls → done (this reply is the answer)
      calls    → run each through the registry; formatResults → next message
      only bad calls → formatParseErrors → next message (3 in a row = stop)
```

</div>

primer (معرفی ابزارها و قواعد) فقط یک بار در هر گفتگو فرستاده می‌شود. `Session` نشانی گفتگوی primeشده را نگه می‌دارد (`conversationKey(url)`) و افزونه، که تنها جایی است که نشانی فعلی تب را می‌داند، تصمیم می‌گیرد primer لازم است یا نه.

## مدل وضعیت

`App.state()` تمام چیزی است که UI نیاز دارد و با هر تغییر از SSE فرستاده می‌شود (حداکثر هر ۱۰۰ میلی‌ثانیه). قالب دقیق در [API.md](API.md#وضعیت-appstate) است. نکته‌های مهم:

- `items` فهرست مرتب گام‌هاست: `user`، `assistant` (با `streaming`)، `tool` (با `status`، `output` پیش‌نمایش ۴۰۰۰ نویسه‌ای، `change` برای diff) و `notice` (با `retry`). هر item یک `turn` دارد.
- آرگومان‌های بلند ابزار (بیش از ۳۰۰ نویسه، مثل محتوای فایل) در `state()` با «(N characters)» جایگزین می‌شوند تا هر push سنگین نشود. مدل همیشه نسخه‌ی کامل را می‌گیرد.
- `status.phase` یکی از: `idle`، `opening`، `typing`، `sending`، `waiting`، `hidden`، `receiving`، `tool`، `approval`، `retrying`، `done`، `error`، `stopped`. اگر اجازه‌ای در انتظار باشد، phase همیشه `approval` گزارش می‌شود.
- گفتگو فقط در حافظه است. راه‌اندازی دوباره‌ی سرور آن را پاک می‌کند (گفتگوی خود سایت چت سر جایش می‌ماند).

## داده‌های روی دیسک

همه در `%APPDATA%\zx-ai` (در غیر ویندوز `$XDG_STATE_HOME/zx-ai` یا `~/.local/state/zx-ai`):

| فایل | محتوا |
|---|---|
| `settings.json` | `workspace`، `siteId`، `mode`، `maxSteps`، `maxChars`، `sites` (overrideها). خراب باشد، `settings.json.bad` نگه داشته می‌شود و پیش‌فرض‌ها به کار می‌روند |
| `audit.db` | SQLite، جدول `audit` |
| `server.json` | `pid`، `port`، `url`، `startedAt` سرور در حال اجرا |
| `server.log`، `launcher.log` | خروجی سرور و رویدادهای راه‌انداز |

نسخه‌ی نصب‌شده در `%LOCALAPPDATA%\ZX-AI` است: `bin\zx-ai.exe`، `ui\index.html`، `extension\dist\`. سرور مسیر UI و افزونه را نسبت به `import.meta.url` پیدا می‌کند و در بسته، `import.meta.url` همان مسیر exe است.

## مدل امنیتی

| تهدید | دفاع |
|---|---|
| صفحه‌ی وب بیگانه به سرور درخواست بزند | Host باید `127.0.0.1` یا `localhost` روی همان پورت باشد. Origin باید خالی، خود صفحه یا افزونه‌ی ZX باشد. CSP سخت روی صفحه. **توکن نیست** (انتخاب کاربر)، پس برنامه‌های محلی دیگر می‌توانند به سرور وصل شوند |
| افزونه‌ی دیگری خودش را ZX جا بزند | WebSocket فقط با Origin `chrome-extension://fcpgbikgfnfapkcfgfbkjfdjdemagdkp` |
| مدل (یا صفحه‌ی آلوده‌ای که مدل خوانده) بیرون از پوشه دست ببرد | `PathGuard` روی هر مسیر؛ پوشه‌ای که پوشه‌ی تنظیمات ZX را در بر دارد پذیرفته نمی‌شود (پس خانه و ریشه‌ی درایو هم نه) |
| اجرای دلخواه برنامه | `exec` فقط `node` و `git` (فقط زیرفرمان‌های خواندنی) را بدون shell اجرا می‌کند؛ پرچم‌های خطرناک git رد می‌شوند؛ محیط کودک فیلتر می‌شود؛ مهلت و سقف خروجی دارد |
| نوشتن بی‌اجازه | gate با کلاس عملیات؛ کارت اجازه diff را **قبل** از نوشتن نشان می‌دهد؛ snapshot منجمد |
| مسیر شخصی کاربر به سایت برود | primer فقط نام پوشه را دارد |
| فایل اجرایی با یک کلیک اجرا شود | «باز کردن» برای پسوندهای اجرایی فقط در Explorer نشان می‌دهد |

**بدانید:** محتوای هر فایلی که مدل می‌خواند به سایت چت فرستاده می‌شود.

</div>
