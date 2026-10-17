# Deploy امن ربات آرال (Telegram Serverless)

## قانون طلایی
- **منبع حقیقت:** `handlers/` ، `lib/` ، `schema.js` ، `endpoints/`
- **خروجی deploy:** فقط پوشه `tgcloud/` (CLI 0.2+)
- همیشه قبل از push با `scripts/safe-deploy.sh` همگام کن
- **هرگز** با پوشه ناقص `push --force` نزن (ماژول‌های غایب از ابر حذف می‌شوند)
- **`push` دیتابیس را تغییر نمی‌دهد**؛ `migrate` جداست و خطرناک است

## دستور پیشنهادی
```bash
cd ~/sedambzan && git fetch origin && git reset --hard origin/main
cd serverless && bash scripts/safe-deploy.sh
```

## چه کارهایی نکن
1. پاک کردن `tgcloud/handlers` و push خالی
2. `migrate` بدون نیاز (به‌خصوص بعد از تغییر نام جدول)
3. `git reset` وسط deploy نیمه‌کاره
4. تغییر ستون `key` در schema بدون برنامه مهاجرت

## باگ‌های قبلی که باید بسته بمانند
- `restoreMistakenlyCancelledShifts` باید disabled بماند
- callback باید اول `data`/`userId` بگیرد بعد handlerها
- ثبت پیام کاربر: ضدتکرار بدنه + سقف حجم ~5MB
