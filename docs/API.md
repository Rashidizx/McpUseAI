<div dir="rtl">

# ZX AI — رابط‌ها

همه‌ی قراردادهای بین اجزا: HTTP و SSE صفحه، WebSocket افزونه، راه‌انداز، قالب متنی با مدل، ابزارها و تنظیمات. انواع TypeScript مرجع اصلی‌اند. هر جا این سند با کد فرق کرد، کد درست است و این سند باید اصلاح شود.

## HTTP سرور (`src/server/http.ts`)

نشانی: `http://127.0.0.1:39271`. پیش از هر مسیر `checkUi` اجرا می‌شود:

- Host باید `127.0.0.1:<port>` یا `localhost:<port>` باشد.
- Origin باید یکی از این‌ها باشد: خالی، خود صفحه، یا `chrome-extension://fcpgbikgfnfapkcfgfbkjfdjdemagdkp`.

درخواست‌ها و پاسخ‌ها JSON هستند و بدنه حداکثر ۲ مگابایت است. خطا با `{ "error": "..." }` و کد `400`، `404` یا `409` برمی‌گردد.

### GET

| مسیر | پاسخ |
|---|---|
| `/` | صفحه‌ی `ui/index.html` با CSP سخت و `cache-control: no-store` |
| `/api/events` | SSE. اولین رویداد وضعیت کامل است و بعد از آن با هر تغییر وضعیت کامل دوباره فرستاده می‌شود (ادغام‌شده، حداکثر هر ۱۰۰ میلی‌ثانیه). هر ۱۵ ثانیه یک `: keep-alive`. صفحه‌ای که نمی‌خواند (بیش از ۴ مگابایت در صف) رد می‌شود |
| `/api/state` | همان وضعیت کامل، یک بار |
| `/api/ping` | `{ ok: true, pid, version }` |
| `/api/audit?limit=N` | آخرین N رکورد ممیزی (۱ تا ۵۰۰، پیش‌فرض ۱۰۰) |

### POST

| مسیر | بدنه | کار |
|---|---|---|
| `/api/send` | `{ text }` | شروع یک دور. `409` اگر کاری در جریان است |
| `/api/stop` | — | توقف کار جاری، بستن برنامه‌ی در حال اجرا، رد همه‌ی اجازه‌های در انتظار |
| `/api/retry` | — | فرستادن دوباره‌ی پیامِ شکست‌خورده (یا نتیجه‌های ابزارهایی که پیش از توقف اجرا شدند) |
| `/api/restart` | — | فرستادن دوباره‌ی کل درخواست آخر از اول |
| `/api/new-chat` | — | گفتگوی تازه (در سایت هم) و پاک کردن اجازه‌های «همیشه» |
| `/api/approve` | `{ id, decision }` | `decision`: `approved`، `always` (برای همین ابزار تا آخر گفتگو)، یا هر چیز دیگر یعنی `denied`. پاسخ `{ applied }` |
| `/api/settings` | بخشی از تنظیمات | پایین‌تر را ببینید. وسط کار فقط `mode` پذیرفته می‌شود |
| `/api/workspace` | `{ path }` | تعیین پوشه‌ی کاری. اگر عوض شود، گفتگوی تازه شروع می‌شود |
| `/api/pick-folder` | — | پنجره‌ی انتخاب پوشه‌ی ویندوز (PowerShell، STA). `{ path }` یا `{ path: null }` اگر لغو شد |
| `/api/open-folder` | — | پوشه‌ی کاری در Explorer |
| `/api/open-file` | `{ path, reveal? }` | باز کردن فایل داخل پوشه. پسوندهای اجرایی فقط نشان داده می‌شوند |
| `/api/probe` | `{ needle? }` | «بررسی سایت»: کدام انتخابگر پیدا شد، تعداد پاسخ‌ها، دکمه‌های کنار جعبه‌ی پیام، و اگر `needle` بدهید، مسیر عنصرهایی که آن متن را دارند |
| `/api/show` | — | آوردن تب سایت به جلو (فقط وقتی کاربر بخواهد) |
| `/api/restart-app` | — | راه‌اندازی دوباره‌ی کل ZX از راه افزونه و راه‌انداز |
| `/api/shutdown` | — | خاموش کردن سرور |

### `/api/settings`

| کلید | نوع | قاعده |
|---|---|---|
| `mode` | `"ask" \| "edits" \| "all" \| "readonly"` | درخواست‌های در انتظار با حالت تازه تصمیم گرفته می‌شوند |
| `siteId` | `string` | باید در فهرست سایت‌ها باشد. اگر عوض شود، گفتگوی تازه شروع می‌شود |
| `maxSteps` | عدد صحیح ۱ تا ۲۰۰ | سقف گام در هر درخواست (پیش‌فرض ۲۵) |
| `maxChars` | عدد صحیح ۲۰۰۰ تا ۲۰۰۰۰۰ | سقف طول پیام نتیجه به مدل (پیش‌فرض ۳۰۰۰۰) |
| `site` | `{ id, value }` | override یا سایت تازه؛ `value: null` override را حذف می‌کند. `id` با الگوی `^[a-z0-9-]{1,32}$` |

### وضعیت (`AppState`)

نوع کامل در `src/app.ts`:

<div dir="ltr">

```ts
type AppState = {
  version: string;
  workspace: string | null;
  siteId: string;
  sites: Site[];
  extension: {
    connected: boolean; reconnecting: boolean;
    version: string | null; current: boolean;   // current: build on disk == build running
    log: string[];                               // last 30 lines from the extension
    browser: string | null;                      // e.g. "Chrome", "Brave", "Edge"
    rival: string | null;                        // another browser turned away (last 2 min)
  };
  busy: boolean;
  status: { phase: Phase | "idle" | "receiving" | "tool" | "approval" | "retrying" | "done" | "error" | "stopped"; detail: string };
  canRetry: boolean; canRestart: boolean; attempts: number;
  items: Item[];                                 // tool args > 300 chars are replaced by "(N characters)"
  pending: (PendingApproval & { diff?: FileDiff })[];
  settings: { mode: Mode; maxSteps: number; maxChars: number };
  allowed: string[];                             // tools allowed "always" in this chat
};
```

</div>

## WebSocket افزونه (`/ws`)

اتصال فقط با Origin افزونه‌ی ZX پذیرفته می‌شود (`checkExtension`). query:

| پارامتر | معنا |
|---|---|
| `id` | شناسه‌ی ماندگار این نصب (`chrome.storage.local.instance`) |
| `browser` | نام مرورگر از `navigator.userAgentData.brands` |
| `claim=1` | کاربر خواسته ZX به این مرورگر منتقل شود |

قاعده‌ی «یک مرورگر»: اگر نصب دیگری وصل باشد و `claim` نباشد، اتصال تازه با کد `4001` و نام مرورگر وصل بسته می‌شود. افزونه ۶۰ ثانیه عقب می‌نشیند و `busyWith` را در storage می‌نویسد تا پنل کناری نشانش بدهد. با `claim`، مرورگر قبلی با `4001` بسته می‌شود. همان نصب (`id` یکسان) سوکت قدیمی خودش را جایگزین می‌کند. افزونه‌ای که `id` نمی‌فرستد (نسخه‌ی قدیمی) پیش از رد شدن پیام `reload` می‌گیرد.

پیام‌ها JSON هستند و نوع‌ها در `src/shared/protocol.ts` تعریف شده‌اند.

### سرور ← افزونه (`BridgeToExtension`)

| `type` | فیلدها | کار |
|---|---|---|
| `ask` | `jobId, site, text, newChat, primer, primedUrl` | نوشتن و ارسال پیام و دنبال کردن پاسخ |
| `cancel` | `jobId` | لغو کار و زدن stop سایت |
| `probe` | `jobId, site` | گزارش انتخابگرها (`ProbeReport`) |
| `show` | `site` | آوردن تب به جلو |
| `resume` | `jobId, site` | بعد از راه‌اندازی دوباره‌ی worker، دنبال کردن همان پاسخ روی همان تب |
| `ui` | `url` | نشانی صفحه برای پنل کناری |
| `reload` | — | نسخه‌ی روی دیسک تازه‌تر است |
| `restart-app` | — | از راه‌انداز بخواه سرور را دوباره روشن کند |
| `pong` | — | پاسخ ping |

### افزونه ← سرور (`ExtensionToBridge`)

| `type` | فیلدها | کار |
|---|---|---|
| `hello` | `version, build` | بعد از اتصال. `build` همان `version_name` مانیفست با هش محتواست |
| `status` | `jobId, phase` | `opening`، `typing`، `sending`، `waiting`، `hidden` |
| `progress` | `jobId, text` | متن تا این لحظه |
| `done` | `jobId, text, url` | پاسخ کامل و نشانی گفتگو |
| `failed` | `jobId, code, message, text?` | `FailCode`: `no-tab`، `no-permission`، `no-composer`، `send-failed`، `no-reply`، `timeout`، `cancelled`، `page-lost`، `internal` |
| `probed` | `jobId, report` | نتیجه‌ی probe |
| `log` | `level, message` | خطاهای worker، در «گزارش افزونه» |
| `ping` | — | هر ۲۰ ثانیه |

سرور هم هر ۱۵ ثانیه ping سطح WebSocket می‌فرستد و سوکتی را که جواب ندهد می‌بندد. اگر سوکت وسط یک کار قطع شود، `ExtensionLink` تا ۳۰ ثانیه منتظر می‌ماند و بعد از `hello` تازه برای هر کار باز `resume` می‌فرستد. درخواستی که وقتی افزونه وصل نیست برسد، تا ۱۰ ثانیه منتظر اتصال می‌ماند.

## راه‌انداز (`host/launcher-core.mjs`)

نشانی: `http://127.0.0.1:39270`. فقط درخواست بدون Origin یا با Origin افزونه‌ی ZX پذیرفته می‌شود و CORS فقط برای افزونه است. `start`، `stop` و `restart` پشت هم اجرا می‌شوند، نه هم‌زمان.

| مسیر | پاسخ |
|---|---|
| `GET /status` | `{ ok, running }` |
| `POST /start` | سرور را اگر نیست اجرا می‌کند و تا ۲۵ ثانیه منتظر `/api/ping` می‌ماند |
| `POST /stop` | `/api/shutdown`، و اگر ۶ ثانیه خاموش نشد، kill همان pid که به ping جواب داد |
| `POST /restart` | stop و اگر موفق بود start |
| `POST /quit` | بستن خود راه‌انداز |

متغیرهای محیطی: `ZX_LAUNCHER_PORT` (پیش‌فرض ۳۹۲۷۰) و `ZX_PORT` (پیش‌فرض ۳۹۲۷۱).

## قالب متنی با مدل (`src/agent/protocol.ts`)

مدل ابزار را با یک بلوک fenced با برچسب `zx` صدا می‌زند:

<div dir="ltr">

````
```zx
{"tool": "fs_read", "arguments": {"file_path": "README.md"}}
```
````

</div>

- چند بلوک در یک پیام پشت هم اجرا می‌شوند. یک بلوک می‌تواند آرایه‌ای از فراخوانی‌ها باشد.
- `fs_write` بدون `content`، محتوا را از **بلوک کد بعدی** برمی‌دارد. اگر آن بلوک بسته نشده باشد (پاسخ بریده شده)، فایل نوشته نمی‌شود و خطا به مدل برمی‌گردد. فایلی که خودش ``` دارد باید با ```` (چهار بک‌تیک) fence شود.
- بلوک‌های بدون برچسب یا با برچسب `json` هم پذیرفته می‌شوند، به شرطی که نام یک ابزار ثبت‌شده را داشته باشند. سایت‌ها گاهی برچسب را هنگام رندر حذف می‌کنند. زبان‌های دیگر هیچ‌وقت اجرا نمی‌شوند.
- JSON خراب ترمیم می‌شود (خط واقعی داخل رشته، ویرگول آخر). اگر نشد، فقط برای بلوک `zx` خطا به مدل برمی‌گردد. سه پیام پشت سر هم بدون هیچ فراخوانی سالم یعنی توقف.
- هر متنی بعد از سرتیتر `ZX RESULTS` که خود مدل نوشته باشد نادیده گرفته می‌شود. نتیجه‌ی ساختگی، نتیجه نیست.
- نتیجه‌ها در یک پیام برمی‌گردند که با `ZX RESULTS` شروع می‌شود. هر نتیجه سرتیتر `### n. tool: summary (ok|error)` و یک بلوک fenced دارد. سهم هر نتیجه از `maxChars` تقسیم می‌شود و بخش بریده‌شده گفته می‌شود.
- پیامی بدون هیچ بلوک `zx` پایان کار است و همان پاسخ نهایی است.

primer (`buildPrimer`) شامل این‌هاست: نام پوشه (نه مسیر کامل)، نحوه‌ی فراخوانی، قواعد (منتظر نتیجه بمان، کار را اعلام نکن بدون فراخوانی، به زبان کاربر جواب بده) و فهرست ابزارها از `describe()` هر ابزار.

## ابزارها

| ابزار | کلاس | آرگومان‌ها | سقف‌ها |
|---|---|---|---|
| `fs_read` | read | `file_path, start_line?, line_count?` | پیش‌فرض ۲۰۰۰ خط، فایل حداکثر ۸ مگابایت؛ پایان خط و BOM حفظ می‌شود |
| `fs_list` | read | `dir_path?, depth?, include_hidden?` | ۲۰۰۰ مدخل، عمق ۸؛ `.git`، `node_modules`، `dist`، `build`، `target`، `.next` رد می‌شوند |
| `fs_grep` | read | `pattern, path?, case_sensitive?, extensions?` | ۲۰۰ نتیجه، عمق ۱۲، فایل ۲ مگابایت، خط ۳۰۰ نویسه |
| `fs_write` | write | `file_path, content, create_only?` | پوشه‌های والد را می‌سازد؛ نوشتن اتمی با فایل موقت `.zx-tmp` |
| `fs_apply_diff` | write | `file_path, old_text, new_text, all?` | متن قدیم باید دقیقاً و بدون ابهام پیدا شود، وگرنه فایل دست نمی‌خورد |
| `exec` | exec | `command, args, cwd?, timeout_ms?` | فقط `node` (همان Node سرور) و `git` با زیرفرمان‌های `status`، `log`، `diff`، `show`، `rev-parse`، `ls-files`، `blame`، `describe`، `shortlog`، `cat-file`. بدون shell، حداکثر ۶۴ آرگومان، مهلت پیش‌فرض ۳۰ و حداکثر ۱۲۰ ثانیه، خروجی ۶۴ کیلوبایت. پرچم‌های `-c`، `-C`، `--git-dir`، `--work-tree`، `--exec-path`، `--output`/`-o`، `--ext-diff` و `--textconv` رد می‌شوند. `npm` عمداً غیرفعال است (در ویندوز بدون shell اجرا نمی‌شود) |

## تعریف سایت (`Site`)

<div dir="ltr">

```ts
type Site = {
  id: string;          // ^[a-z0-9-]{1,32}$
  label: string;
  url: string;         // https://, where a fresh conversation starts
  match: string[];     // Chrome match patterns for this site's tabs
  composer: string[];  // textarea or contenteditable
  send: string[];      // send button; Enter is the fallback
  stop: string[];      // visible only while the model writes
  reply: string[];     // every assistant reply; the last is the newest
};
```

</div>

در هر فهرست، اولین انتخابگری که چیزی پیدا کند برنده است. override در `settings.json` → `sites[id]` فقط فیلدهایی را که نام می‌برد جایگزین می‌کند. `id` ناشناخته یعنی سایت تازه و باید کامل باشد (`isCompleteSite`). پیش‌فرض‌ها در `src/agent/sites.ts` هستند.

## تشخیص پایان پاسخ (`extension/src/settle.ts`)

| ثابت | مقدار | معنا |
|---|---|---|
| `QUIET_AFTER_BUSY_MS` | ۱۵۰۰ | سکوت لازم وقتی stop دیده شده و رفته |
| `QUIET_WITHOUT_BUSY_MS` | ۵۰۰۰ | سکوت لازم وقتی stop هیچ‌وقت دیده نشد؛ در تب پنهان حداقل همین |
| `QUIET_INCOMPLETE_MS` | ۳۰۰۰۰ | وقتی آخرین بلوک کد JSON باز است |
| `SEND_GRACE_MS` | ۱۵۰۰۰ | جعبه‌ی پیام هنوز پر است و هیچ نشانه‌ای نیست، یعنی ارسال نشد |
| `REPLY_GRACE_MS` | ۱۲۰۰۰۰ | هیچ پاسخی نیامد |
| `REPLY_GRACE_HIDDEN_MS` | ۳۰۰۰۰۰ | همان، در تب پنهان |

پاسخ تازه با هویت عنصر تشخیص داده می‌شود. اگر عنصر قبلی هنوز در صفحه باشد، عنصر جدید یعنی پاسخ تازه. اگر قبلی حذف شده باشد (لیست‌های مجازی)، مقایسه با متن انجام می‌شود. اگر کاربر وسط پاسخ به گفتگوی دیگری برود، کار با `page-lost` تمام می‌شود. یک بار تغییر نشانی از صفحه‌ی شروع (`/`، `/new`، `/app`) به نشانی گفتگو مجاز است.

</div>
