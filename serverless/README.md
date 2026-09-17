# ربات آرال — نسخه Telegram Serverless

پروژه برای اجرای مستقیم روی زیرساخت تلگرام (`tgcloud`).

> **نکته مهم:** Telegram Serverless فقط **JavaScript** است. نسخه قبلی Python/aiogram روی VPS بود؛ این ریپو بازنویسی هستهٔ ربات برای Serverless است (ارسال پیام، وضعیت، فیدبک، پنل مالک ساده).

## ساختار

```
handlers/           # یک فایل به ازای هر نوع آپدیت
  message.js
  callback_query.js
lib/                # کد مشترک
  config.js
  keyboards.js
  validation.js
  users.js
  state.js
schema.js           # جداول دیتابیس داخلی تلگرام
package.json
AGENTS.md
```

## پیش‌نیاز

1. Node.js 18+
2. ربات در @BotFather
3. روشن کردن **Serverless** برای همان ربات در BotFather
4. گرفتن **CLI Access Token** (با Bot API Token فرق دارد — شکل `app…:…`)

Bot API Token جدید شما فقط برای ساخت/مدیریت ربات در BotFather است؛ در کد Serverless قرار نمی‌گیرد.

## دیپلوی (مرحله‌به‌مرحله)

دستورات را در پوشهٔ همین پروژه بزنید — جزئیات کامل در پیام نهایی همین گفتگو.
