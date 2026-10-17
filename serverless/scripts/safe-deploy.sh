#!/usr/bin/env bash
# deploy امن: همیشه از منبع (lib/handlers/schema/endpoints) به tgcloud کپی می‌کند
# و جلوی push ناقص (حذف تصادفی ماژول‌ها) را می‌گیرد.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REQUIRED=(
  schema.js
  handlers/message.js
  handlers/callback_query.js
  lib/dbutil.js
  lib/keyboards.js
  lib/config.js
  lib/state.js
  lib/time.js
  lib/validation.js
  lib/users.js
)

echo "==> بررسی فایل‌های ضروری"
for f in "${REQUIRED[@]}"; do
  if [[ ! -s "$f" ]]; then
    echo "ERROR: فایل ضروری خالی یا موجود نیست: $f"
    echo "push متوقف شد تا ماژول‌های ابری پاک نشوند."
    exit 1
  fi
done

MSG_LINES=$(wc -l < handlers/message.js | tr -d ' ')
CB_LINES=$(wc -l < handlers/callback_query.js | tr -d ' ')
if [[ "$MSG_LINES" -lt 500 || "$CB_LINES" -lt 500 ]]; then
  echo "ERROR: هندلر مشکوک کوتاه است (message=$MSG_LINES callback=$CB_LINES)"
  exit 1
fi

echo "==> همگام‌سازی → tgcloud/"
mkdir -p tgcloud/lib tgcloud/handlers tgcloud/endpoints
cp -f schema.js tgcloud/schema.js
cp -f lib/*.js tgcloud/lib/
cp -f handlers/*.js tgcloud/handlers/
if ls endpoints/*.js >/dev/null 2>&1; then
  cp -f endpoints/*.js tgcloud/endpoints/ || true
fi

echo "==> لیست ماژول‌های آماده push"
find tgcloud -name '*.js' | sort

echo "==> tgcloud push"
npx tgcloud push --force "$@"
echo "OK. migrate فقط اگر schema عمداً عوض شده باشد."
