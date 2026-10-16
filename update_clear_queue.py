from pathlib import Path
import shutil
import re
import sys


PROJECT = Path(__file__).resolve().parent
MAIN = PROJECT / "main.py"
DATABASE = PROJECT / "database.py"

BACKUP_MAIN = PROJECT / "main.py.backup_clear_queue"
BACKUP_DATABASE = PROJECT / "database.py.backup_clear_queue"


def backup_file(src, backup):
    if not src.exists():
        raise FileNotFoundError(f"فایل پیدا نشد: {src}")

    if not backup.exists():
        shutil.copy2(src, backup)
        print(f"✅ بکاپ ساخته شد: {backup.name}")
    else:
        print(f"ℹ️ بکاپ از قبل وجود دارد: {backup.name}")


def add_database_method():
    text = DATABASE.read_text(encoding="utf-8")

    if "def clear_pending_messages(" in text:
        print("ℹ️ متد clear_pending_messages از قبل وجود دارد.")
        return

    marker = "\n    def get_queued_messages("

    if marker not in text:
        raise RuntimeError(
            "محل مناسب برای اضافه کردن متد در database.py پیدا نشد."
        )

    method = r'''
    def clear_pending_messages(self):
        with self.lock:

            rows = self.conn.execute(
                """
                SELECT DISTINCT user_id
                FROM messages
                WHERE status IN ('pending', 'queued')
                """
            ).fetchall()

            if not rows:
                return []

            user_ids = [
                int(row["user_id"])
                for row in rows
            ]

            self.conn.execute(
                """
                UPDATE messages
                SET
                    status = 'cleared',
                    admin_id = NULL,
                    shift_id = NULL
                WHERE status IN ('pending', 'queued')
                """
            )

            self._commit()

            return user_ids

'''

    text = text.replace(marker, "\n" + method + "    def get_queued_messages(", 1)

    DATABASE.write_text(text, encoding="utf-8")

    print("✅ clear_pending_messages به database.py اضافه شد.")


def add_keyboard():
    text = MAIN.read_text(encoding="utf-8")

    if "callback_data=\"pending:clear_all\"" in text:
        print("ℹ️ دکمه پاک‌سازی از قبل وجود دارد.")
        return

    marker = "\n\ndef reject_keyboard("

    if marker not in text:
        raise RuntimeError(
            "محل مناسب برای اضافه کردن clear_pending_keyboard در main.py پیدا نشد."
        )

    keyboard = r'''

def clear_pending_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🗑 پاک‌سازی کل صف",
                    callback_data="pending:clear_all",
                )
            ]
        ]
    )
'''

    text = text.replace(
        marker,
        keyboard + marker,
        1,
    )

    MAIN.write_text(text, encoding="utf-8")

    print("✅ clear_pending_keyboard به main.py اضافه شد.")


def replace_pending_handler():
    text = MAIN.read_text(encoding="utf-8")

    if "async def clear_all_pending_callback(" in text:
        print("ℹ️ هندلر پاک‌سازی از قبل وجود دارد.")
        return

    start_marker = '@router.message(\n    F.text == "📥 پیام‌های در انتظار",'

    start = text.find(start_marker)

    if start == -1:
        raise RuntimeError(
            "هندلر پیام‌های در انتظار در main.py پیدا نشد."
        )

    end_marker = '\n\n# =========================\n# APPROVE'

    end = text.find(end_marker, start)

    if end == -1:
        # حالت جایگزین برای اختلاف جزئی در کامنت
        possible = text.find(
            '\n@router.callback_query(\n    F.data.startswith("approve:',
            start,
        )

        if possible == -1:
            raise RuntimeError(
                "انتهای هندلر پیام‌های در انتظار پیدا نشد."
            )

        end = possible

    old_handler = text[start:end]

    new_handler = r'''@router.message(
    F.text == "📥 پیام‌های در انتظار",
    F.chat.type == "private",
)
async def pending_messages(
    message: Message,
    bot: Bot,
):

    user_id = message.from_user.id

    if db.is_owner(user_id):

        rows = db.get_all_pending()

    elif db.get_admin(user_id):

        rows = db.get_pending_for_admin(
            user_id
        )

    else:
        return

    if not rows:

        await message.answer(
            "📥 فعلاً پیام در انتظاری وجود ندارد.",
            reply_markup=(
                clear_pending_keyboard()
                if db.is_owner(user_id)
                else admin_keyboard()
            ),
        )

        if db.is_owner(user_id):

            await message.answer(
                "پنل مالک:",
                reply_markup=owner_keyboard(
                    db.is_bot_enabled()
                ),
            )

        return

    sent_count = 0
    failed_count = 0

    for row in rows:

        try:

            await send_review_message(
                bot,
                user_id,
                row,
            )

            sent_count += 1

        except Exception:

            failed_count += 1

            logger.exception(
                "PENDING MESSAGES SEND ERROR | "
                "message_id=%s | to_user=%s",
                row["id"],
                user_id,
            )

            continue

        await asyncio.sleep(0.05)

    summary = f"📥 {sent_count} پیام نمایش داده شد."

    if failed_count:
        summary += (
            f"\n⚠️ {failed_count} پیام ارسال نشد "
            "(محدودیت Telegram یا خطای موقت). "
            "دوباره «📥 پیام‌های در انتظار» را بزن."
        )

    if db.is_owner(user_id):

        await message.answer(
            summary,
            reply_markup=clear_pending_keyboard(),
        )

        await message.answer(
            "پنل مالک:",
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

    else:

        await message.answer(
            summary,
            reply_markup=admin_keyboard(),
        )
'''

    text = text[:start] + new_handler + text[end:]

    MAIN.write_text(text, encoding="utf-8")

    print("✅ هندلر پیام‌های در انتظار به‌روزرسانی شد.")


def add_callback():
    text = MAIN.read_text(encoding="utf-8")

    if "async def clear_all_pending_callback(" in text:
        print("ℹ️ callback پاک‌سازی از قبل وجود دارد.")
        return

    marker = '\n@router.callback_query(\n    F.data.startswith("approve:'

    if marker not in text:
        raise RuntimeError(
            "محل مناسب برای callback پاک‌سازی پیدا نشد."
        )

    callback = r'''

@router.callback_query(
    F.data == "pending:clear_all"
)
async def clear_all_pending_callback(
    callback: CallbackQuery,
    bot: Bot,
):

    user_id = callback.from_user.id

    if not db.is_owner(user_id):

        await callback.answer(
            "⛔ فقط مالک می‌تواند صف را پاک‌سازی کند.",
            show_alert=True,
        )

        return

    user_ids = db.clear_pending_messages()

    if not user_ids:

        await callback.answer(
            "📥 صف پیام‌ها از قبل خالی است.",
            show_alert=True,
        )

        try:
            await callback.message.edit_text(
                "📥 فعلاً پیام در انتظاری وجود ندارد.",
                reply_markup=None,
            )
        except Exception:
            pass

        return

    notification_text = (
        "⚠️ پیام شما از صف بررسی پاک شد.\n\n"
        "این پیام بررسی نخواهد شد.\n"
        "اگر هنوز می‌خواهید پیام‌تان بررسی شود، "
        "لطفاً آن را دوباره ارسال کنید."
    )

    notified = 0
    failed = 0

    for target_user_id in user_ids:

        try:

            await bot.send_message(
                chat_id=target_user_id,
                text=notification_text,
            )

            notified += 1

        except Exception:

            failed += 1

            logger.exception(
                "CLEAR QUEUE NOTIFICATION ERROR | "
                "user_id=%s",
                target_user_id,
            )

        await asyncio.sleep(0.05)

    await callback.answer(
        "✅ صف با موفقیت پاک‌سازی شد.",
        show_alert=True,
    )

    result_text = (
        "🗑 صف پیام‌های در انتظار پاک‌سازی شد.\n\n"
        f"📨 تعداد کاربران اطلاع‌رسانی‌شده: {notified}"
    )

    if failed:

        result_text += (
            f"\n⚠️ اطلاع‌رسانی ناموفق: {failed}"
        )

    try:

        await callback.message.edit_text(
            result_text,
            reply_markup=None,
        )

    except Exception:

        logger.exception(
            "CLEAR QUEUE EDIT MESSAGE ERROR"
        )

'''

    text = text.replace(
        marker,
        callback + marker,
        1,
    )

    MAIN.write_text(text, encoding="utf-8")

    print("✅ callback پاک‌سازی به main.py اضافه شد.")


def main():
    print("=" * 55)
    print("   UPDATE: CLEAR PENDING QUEUE")
    print("=" * 55)
    print()

    if not MAIN.exists():
        print(f"❌ main.py پیدا نشد: {MAIN}")
        sys.exit(1)

    if not DATABASE.exists():
        print(f"❌ database.py پیدا نشد: {DATABASE}")
        sys.exit(1)

    try:

        backup_file(
            MAIN,
            BACKUP_MAIN,
        )

        backup_file(
            DATABASE,
            BACKUP_DATABASE,
        )

        add_database_method()
        add_keyboard()
        replace_pending_handler()
        add_callback()

    except Exception as e:

        print()
        print("❌ عملیات متوقف شد.")
        print(f"خطا: {e}")
        print()
        print("فایل‌های اصلی دست‌نخورده باقی می‌مانند؛")
        print("اگر تغییری اعمال شده باشد، بکاپ‌ها موجودند.")

        sys.exit(1)

    print()
    print("=" * 55)
    print("✅ تغییرات با موفقیت اعمال شد.")
    print("=" * 55)
    print()
    print("حالا فقط syntax را بررسی کن:")
    print()
    print("python -m py_compile main.py database.py")
    print()


if __name__ == "__main__":
    main()