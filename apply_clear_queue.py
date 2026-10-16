cat > apply_clear_queue.py <<'PY' from pathlib 
import Path from datetime import datetime 
import shutil import sys import py_compile 
BASE_DIR = Path(__file__).resolve().parent 
MAIN = BASE_DIR / "main.py" DATABASE = 
BASE_DIR / "database.py" def backup(path: 
Path):
    timestamp = 
    datetime.now().strftime("%Y%m%d_%H%M%S") 
    backup_path = path.with_name(
        f"{path.stem}.backup_{timestamp}{path.suffix}" 
    ) shutil.copy2(path, backup_path) 
    print(f"✅ Backup: {backup_path.name}") 
    return backup_path
def replace_once(text, old, new, name): count 
    = text.count(old) if count == 0:
        print(f"❌ بخش موردنظر پیدا نشد: 
        {name}") return None
    if count > 1: print(f"❌ بخش {name} بیش از 
        یک بار پیدا شد ({count} بار).") return 
        None
    return text.replace(old, new, 1) def 
patch_database():
    print("\n========== database.py 
    ==========") if not DATABASE.exists():
        print("❌ database.py پیدا نشد.") 
        return False
    text = 
    DATABASE.read_text(encoding="utf-8") if 
    "def clear_pending_messages(" in text:
        print("ℹ️ clear_pending_messages از قبل 
        وجود دارد.") return True
    anchor = """ def get_queued_messages( 
        self, limit: int = 100,
    ): """ method = """ def 
    clear_pending_messages(self):
        with self.lock: rows = 
            self.conn.execute(
                \"\"\" SELECT DISTINCT user_id 
                FROM messages WHERE status IN 
                ('pending', 'queued') \"\"\"
            ).fetchall() if not rows: return 
                []
            user_ids = [ int(row["user_id"]) 
                for row in rows
            ] self.conn.execute( \"\"\" UPDATE 
                messages SET
                    status = 'cleared', 
                    admin_id = NULL, shift_id 
                    = NULL
                WHERE status IN ('pending', 
                'queued') \"\"\"
            ) self._commit() return user_ids 
"""
    new_text = replace_once( text, anchor, 
        method + anchor, "محل افزودن 
        clear_pending_messages",
    ) if new_text is None: return False 
    backup(DATABASE) DATABASE.write_text(
        new_text, encoding="utf-8", ) 
    print("✅ clear_pending_messages اضافه 
    شد.") return True
def patch_main(): print("\n========== main.py 
    ==========") if not MAIN.exists():
        print("❌ main.py پیدا نشد.") return 
        False
    text = MAIN.read_text(encoding="utf-8")
    # ------------------------------------------------- 
    # keyboard 
    # -------------------------------------------------
    if "def clear_pending_keyboard(" not in 
    text:
        anchor = """def reject_keyboard( 
    message_id: int,
): """ keyboard = """def 
        clear_pending_keyboard():
    return InlineKeyboardMarkup( 
        inline_keyboard=[
            [ InlineKeyboardButton( text="🗑 
                    پاک‌سازی کل صف", 
                    callback_data="pending:clear_all",
                ) ] ] ) """ new_text = 
        replace_once(
            text, anchor, keyboard + anchor, 
            "محل افزودن 
            clear_pending_keyboard",
        ) if new_text is None: return False 
        text = new_text print("✅ 
        clear_pending_keyboard اضافه شد.")
    else: print("ℹ️ clear_pending_keyboard از 
        قبل وجود دارد.")
    # ------------------------------------------------- 
    # empty queue 
    # -------------------------------------------------
    old_empty = """ if not rows: await 
        message.answer(
            "📥 فعلاً پیام در انتظاری وجود 
            ندارد.", reply_markup=(
                owner_keyboard( 
                    db.is_bot_enabled()
                ) if db.is_owner(user_id) else 
                admin_keyboard()
            ), ) return """ new_empty = """ if 
    not rows:
        await message.answer( "📥 فعلاً پیام در 
            انتظاری وجود ندارد.", 
            reply_markup=(
                clear_pending_keyboard() if 
                db.is_owner(user_id) else None
            ), ) await message.answer( "🏠 پنل 
            اصلی", reply_markup=(
                owner_keyboard( 
                    db.is_bot_enabled()
                ) if db.is_owner(user_id) else 
                admin_keyboard()
            ), ) return """ if old_empty in 
    text:
        text = text.replace( old_empty, 
            new_empty, 1,
        ) print("✅ حالت صف خالی اصلاح شد.") 
    elif new_empty in text:
        print("ℹ️ حالت صف خالی قبلاً اصلاح 
        شده.")
    else: print("❌ بخش صف خالی پیدا نشد.") 
        return False
    # -----
