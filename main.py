from __future__ import annotations

import asyncio
import html
import json
import logging
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo
import socket
import aiohttp

from aiogram.client.session.aiohttp import AiohttpSession
from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    BotCommand,
    BotCommandScopeDefault,
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    MessageEntity,
    ReplyKeyboardMarkup,
    User,
)
import os
import tempfile
from pathlib import Path

from config import (
    BOT_TOKEN,
    TIMEZONE,
    RATE_LIMIT_MAX_MESSAGES,
    RATE_LIMIT_WINDOW_SECONDS,
    BLOCKED_LINK_PATTERNS,
    REJECT_REASONS,
    PENDING_MESSAGES_PAGE_SIZE,
    HELP_MESSAGE,
    WELCOME_MESSAGE,
    ERROR_MESSAGES,
)

from database import Database


# =========================================================
# LOGGING
# =========================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

logger = logging.getLogger(__name__)


# =========================================================
# SETUP
# =========================================================

router = Router()
db = Database()
TZ = ZoneInfo(TIMEZONE)

states: dict[int, dict[str, Any]] = {}
notified_shifts: set[tuple[str, int]] = set()
# یادآوری قبل از شیفت (کلید: تاریخ + shift_id + دقیقه)
notified_shift_reminders: set[tuple] = set()

shift_task: asyncio.Task | None = None
cleanup_task: asyncio.Task | None = None

BOT_USERNAME = ""
BOT_ID = 0

# قفل پردازش برای جلوگیری از دوباره‌کلیک روی تأیید/رد
_processing_message_ids: set[int] = set()


# =========================================================
# NON-BLOCKING DB HELPERS (جلوگیری از بلاک شدن event loop)
# ساختار و نحوه اتصال دیتابیس دست‌نخورده باقی می‌ماند.
# =========================================================

async def db_run(func, *args, **kwargs):
    """اجرای تابع sync دیتابیس در thread جدا تا event loop بلاک نشود."""
    return await asyncio.to_thread(func, *args, **kwargs)


def _sync_execute(query: str, params: tuple = ()):
    return db.conn.execute(query, params)


def _sync_execute_fetchone(query: str, params: tuple = ()):
    return db.conn.execute(query, params).fetchone()


def _sync_execute_fetchall(query: str, params: tuple = ()):
    return db.conn.execute(query, params).fetchall()


def _sync_commit():
    db.conn.commit()


async def db_execute(query: str, params: tuple = ()):
    return await asyncio.to_thread(_sync_execute, query, params)


async def db_fetchone(query: str, params: tuple = ()):
    return await asyncio.to_thread(_sync_execute_fetchone, query, params)


async def db_fetchall(query: str, params: tuple = ()):
    return await asyncio.to_thread(_sync_execute_fetchall, query, params)


async def db_commit():
    await asyncio.to_thread(_sync_commit)


GENERIC_ERROR = (
    "⏳ خطای موقت رخ داد.\n"
    "لطفاً چند ثانیه صبر کنید و دوباره امتحان کنید."
)
GENERIC_ERROR_WAIT = (
    "⏳ سیستم مشغول است یا خطای موقتی رخ داده.\n"
    "لطفاً کمی صبر کنید و دوباره تلاش کنید."
)


async def safe_db(coro_or_func, *args, **kwargs):
    """
    اجرای امن عملیات دیتابیس.
    اگر تابع sync باشد با to_thread اجرا می‌شود تا event loop بلاک نشود.
    """
    try:
        if asyncio.iscoroutinefunction(coro_or_func):
            return await coro_or_func(*args, **kwargs)
        return await asyncio.to_thread(coro_or_func, *args, **kwargs)
    except Exception:
        logger.exception("SAFE_DB ERROR")
        raise

# =========================================================
# MULTI CHANNEL CONFIG (۳ کانال)
# =========================================================

CHANNELS: dict[str, dict[str, Any]] = {
    "sadambazan": {
        "title": "صدام بزن",
        "prefixes": ("صدام بزن",),
        "channel_id": -1003877061735,
        "group_id": -1004444089094,
    },
    "inkarbar": {
        "title": "این کاربر",
        "prefixes": ("این کاربر",),
        "channel_id": -1003764383335,
        "group_id": -1004335935102,
    },
    "zendegi": {
        "title": "تو زندگی بعدی",
        "prefixes": ("تو زندگی بعدی",),
        "channel_id": -1004371148799,
        "group_id": -1003812392984,
    },
}

DEFAULT_CHANNEL_KEY = "sadambazan"

# ساعات کاری / شیفت هر کانال (شروع شامل، پایان غیرشامل به ساعت)
# end_hour=24 یعنی تا ۰۰:۰۰
CHANNEL_HOURS: dict[str, tuple[int, int]] = {
    "sadambazan": (12, 24),   # ۱۲ ظهر تا ۱۲ شب
    "inkarbar": (0, 24),      # کل شبانه‌روز
    "zendegi": (11, 24),      # ۱۱ ظهر تا ۱۲ شب
}


def channel_hours(channel_key: str | None) -> tuple[int, int]:
    key = channel_key or DEFAULT_CHANNEL_KEY
    return CHANNEL_HOURS.get(key, (0, 24))


def channel_hours_label(channel_key: str | None) -> str:
    start_h, end_h = channel_hours(channel_key)
    if start_h == 0 and end_h == 24:
        return "۰۰:۰۰ تا ۲۴:۰۰ (کل شبانه‌روز)"
    end_label = "۰۰:۰۰" if end_h == 24 else f"{end_h:02d}:00"
    return f"{start_h:02d}:00 تا {end_label}"


def is_within_channel_hours(channel_key: str | None, when: datetime | None = None) -> bool:
    """آیا الان داخل ساعات کاری کانال هستیم؟ (برای بازهٔ شبانه end<=start پشتیبانی می‌شود)"""
    now = when or local_now()
    start_h, end_h = channel_hours(channel_key)
    if start_h == 0 and end_h == 24:
        return True
    minutes = now.hour * 60 + now.minute
    start_m = start_h * 60
    end_m = (end_h % 24) * 60 if end_h < 24 else 24 * 60
    if end_m <= start_m:
        # بازه شبانه
        return minutes >= start_m or minutes < end_m
    return start_m <= minutes < end_m


def channel_keys() -> list[str]:
    return list(CHANNELS.keys())


def get_channel_cfg(key: str | None) -> dict[str, Any]:
    if key and key in CHANNELS:
        return CHANNELS[key]
    return CHANNELS[DEFAULT_CHANNEL_KEY]


def channel_key_from_prefix(text: str) -> str | None:
    t = (text or "").lstrip()
    # طولانی‌ترها اول تا اشتباه تشخیص داده نشوند
    ordered = sorted(
        CHANNELS.items(),
        key=lambda kv: max(len(p) for p in kv[1]["prefixes"]),
        reverse=True,
    )
    for key, cfg in ordered:
        for prefix in cfg["prefixes"]:
            if t.startswith(prefix):
                return key
    return None


def channel_key_for_group(chat_id: int) -> str | None:
    for key, cfg in CHANNELS.items():
        if int(cfg["group_id"]) == int(chat_id):
            return key
    return None


def channel_id_for_key(key: str | None) -> int:
    return int(get_channel_cfg(key)["channel_id"])


def is_managed_group(chat_id: int) -> bool:
    return channel_key_for_group(chat_id) is not None


def channels_keyboard(prefix: str) -> InlineKeyboardMarkup:
    """۳ دکمه انتخاب کانال — بدون style تا روی همه کلاینت‌ها مطمئن کار کند."""
    rows = []
    for key, cfg in CHANNELS.items():
        rows.append(
            [
                InlineKeyboardButton(
                    text=f"📺 {cfg['title']}",
                    callback_data=f"{prefix}:{key}",
                )
            ]
        )
    return InlineKeyboardMarkup(inline_keyboard=rows)


# =========================================================
# FIXED IP RESOLVER
# TLS SNI-safe / DNS bypass
# =========================================================

TELEGRAM_IPS = [
    "149.154.166.110",
    "149.154.167.220",
    "149.154.167.99",
    "149.154.175.100",
    "149.154.175.50",
    "95.161.64.90",
]


class TelegramFixedIPResolver(aiohttp.abc.AbstractResolver):
    """
    api.telegram.org را مستقیماً به IPهای مشخص‌شده resolve می‌کند.
    hostname همچنان api.telegram.org باقی می‌ماند تا SNI/TLS درست باشد.
    اگر resolve با IPهای ثابت شکست بخورد یا نتیجه‌ای ندهد، به DNS معمولی
    سیستم fallback می‌کند تا در صورت تغییر IP تلگرام یا بلاک‌شدن یکی از
    IPها، ربات کاملاً از کار نیفتد.
    """

    def __init__(self, ips: list[str]):
        self._ips = ips

    async def resolve(
        self,
        host,
        port=0,
        family=socket.AF_INET,
    ):
        if host != "api.telegram.org":
            loop = asyncio.get_running_loop()

            infos = await loop.getaddrinfo(
                host,
                port,
                type=socket.SOCK_STREAM,
                family=family,
            )

            return [
                {
                    "hostname": host,
                    "host": info[4][0],
                    "port": port,
                    "family": info[0],
                    "proto": info[4][1]
                    if len(info[4]) > 1
                    else 0,
                    "flags": 0,
                }
                for info in infos
            ]

        try:
            return [
                {
                    "hostname": host,
                    "host": ip,
                    "port": port,
                    "family": socket.AF_INET,
                    "proto": 0,
                    "flags": 0,
                }
                for ip in self._ips
            ]
        except Exception:
            logger.exception(
                "FIXED IP RESOLVE ERROR | host=%s | falling back to system DNS",
                host,
            )

            loop = asyncio.get_running_loop()

            infos = await loop.getaddrinfo(
                host,
                port,
                type=socket.SOCK_STREAM,
                family=family,
            )

            return [
                {
                    "hostname": host,
                    "host": info[4][0],
                    "port": port,
                    "family": info[0],
                    "proto": info[4][1]
                    if len(info[4]) > 1
                    else 0,
                    "flags": 0,
                }
                for info in infos
            ]

    async def close(self):
        pass


class PinnedAiohttpSession(AiohttpSession):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self._connector_type = aiohttp.TCPConnector

        self._connector_init = {
            "resolver": TelegramFixedIPResolver(
                TELEGRAM_IPS
            ),
            "family": socket.AF_INET,
            "ssl": True,
            "ttl_dns_cache": 300,
            "limit": 100,
            "enable_cleanup_closed": True,
        }


def build_telegram_session() -> AiohttpSession:
    return PinnedAiohttpSession()


# =========================================================
# DATABASE COMPATIBILITY / MIGRATION
# =========================================================

def ensure_runtime_schema():
    """
    قابلیت‌های جدید را روی دیتابیس قدیمی اضافه می‌کند.
    """

    conn = db.conn

    columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(users)"
        ).fetchall()
    }

    if "started" not in columns:
        conn.execute(
            """
            ALTER TABLE users
            ADD COLUMN started INTEGER NOT NULL DEFAULT 0
            """
        )

    message_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(messages)"
        ).fetchall()
    }

    if "shift_id" not in message_columns:
        conn.execute(
            """
            ALTER TABLE messages
            ADD COLUMN shift_id INTEGER
            """
        )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_users_started
        ON users(started)
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_messages_shift
        ON messages(shift_id)
        """
    )

    # ایندکس برای ضدپیام تکراری (۲۴ ساعته per-user)
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_messages_user_content
        ON messages(user_id, content)
        """
    )

    # جدول اطلاعیه‌ها (پایدار حتی بعد از ری‌استارت)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target TEXT NOT NULL,
            content TEXT NOT NULL,
            entities_json TEXT,
            schedule_type TEXT NOT NULL,
            schedule_date TEXT,
            schedule_time TEXT,
            weekday INTEGER,
            last_sent TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            created_by INTEGER
        )
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_announcements_active
        ON announcements(active, schedule_type)
        """
    )

    # --- multi-channel columns ---
    message_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(messages)"
        ).fetchall()
    }
    if "channel_key" not in message_columns:
        conn.execute(
            "ALTER TABLE messages ADD COLUMN channel_key TEXT"
        )
        conn.execute(
            """
            UPDATE messages
            SET channel_key = ?
            WHERE channel_key IS NULL OR channel_key = ''
            """,
            (DEFAULT_CHANNEL_KEY,),
        )

    if "rejected_by" not in message_columns:
        conn.execute(
            "ALTER TABLE messages ADD COLUMN rejected_by INTEGER"
        )

    admin_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(admins)"
        ).fetchall()
    }
    if "channel_key" not in admin_columns:
        conn.execute(
            "ALTER TABLE admins ADD COLUMN channel_key TEXT"
        )
        conn.execute(
            """
            UPDATE admins
            SET channel_key = ?
            WHERE channel_key IS NULL OR channel_key = ''
            """,
            (DEFAULT_CHANNEL_KEY,),
        )

    shift_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(shifts)"
        ).fetchall()
    }
    if "channel_key" not in shift_columns:
        conn.execute(
            "ALTER TABLE shifts ADD COLUMN channel_key TEXT"
        )
        conn.execute(
            """
            UPDATE shifts
            SET channel_key = ?
            WHERE channel_key IS NULL OR channel_key = ''
            """,
            (DEFAULT_CHANNEL_KEY,),
        )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_messages_channel_status
        ON messages(channel_key, status)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_admins_channel
        ON admins(channel_key)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shifts_channel
        ON shifts(channel_key)
        """
    )

    # جدول انتقادات / پیشنهادات / گزارش مشکل
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            owner_reply TEXT,
            replied_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_feedback_status
        ON user_feedback(status, id)
        """
    )

    conn.commit()


def get_setting(
    key: str,
    default: str | None = None,
):
    row = db.conn.execute(
        """
        SELECT value
        FROM settings
        WHERE key = ?
        """,
        (key,),
    ).fetchone()

    if not row:
        return default

    return row["value"]


def get_int_setting(key: str, default: int) -> int:
    raw = get_setting(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def rate_limit_max() -> int:
    return get_int_setting(
        "rate_limit_max",
        RATE_LIMIT_MAX_MESSAGES,
    )


def rate_limit_window() -> int:
    return get_int_setting(
        "rate_limit_window",
        RATE_LIMIT_WINDOW_SECONDS,
    )


def anti_dupe_hours() -> int:
    return get_int_setting("anti_dupe_hours", 24)


def anti_dupe_enabled() -> bool:
    return get_setting("anti_dupe_enabled", "1") != "0"


def queue_limit() -> int:
    return get_int_setting("queue_limit", 100)


def channel_enabled_key(channel_key: str) -> str:
    return f"channel_enabled_{channel_key}"


def is_channel_enabled(channel_key: str | None) -> bool:
    """اگر کانال خاموش باشد False — پیش‌فرض روشن."""
    key = channel_key or DEFAULT_CHANNEL_KEY
    # اگر کل ربات خاموش باشد همه کانال‌ها هم خاموش
    try:
        if not db.is_bot_enabled():
            return False
    except Exception:
        pass
    return get_setting(channel_enabled_key(key), "1") != "0"


def set_channel_enabled(channel_key: str, enabled: bool):
    set_setting(channel_enabled_key(channel_key), "1" if enabled else "0")


def set_setting(
    key: str,
    value: str,
):
    db.conn.execute(
        """
        INSERT INTO settings(key, value)
        VALUES(?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value
        """,
        (key, str(value)),
    )

    db.conn.commit()


def mark_user_started(user: User):
    db.upsert_user(
        user.id,
        user.username,
        user.first_name,
        user.last_name,
    )

    db.conn.execute(
        """
        UPDATE users
        SET started = 1,
            last_seen = ?
        WHERE user_id = ?
        """,
        (
            db.now(),
            user.id,
        ),
    )

    db.conn.commit()


def touch_user(user: User):
    db.upsert_user(
        user.id,
        user.username,
        user.first_name,
        user.last_name,
    )


def user_started(user_id: int) -> bool:
    row = db.conn.execute(
        """
        SELECT started
        FROM users
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()

    return bool(
        row and row["started"]
    )


def find_user_by_username(username: str):
    username = (
        username
        .strip()
        .lstrip("@")
        .lower()
    )

    return db.conn.execute(
        """
        SELECT *
        FROM users
        WHERE LOWER(username) = ?
        LIMIT 1
        """,
        (username,),
    ).fetchone()


def get_started_users():
    return db.conn.execute(
        """
        SELECT *
        FROM users
        WHERE started = 1
        ORDER BY COALESCE(first_name, username), user_id
        """
    ).fetchall()


def get_user_message_stats(
    limit: int | None = None,
    offset: int = 0,
):
    query = """
        SELECT
            u.user_id,
            u.username,
            u.first_name,
            u.last_name,
            COUNT(m.id) AS message_count
        FROM users u
        LEFT JOIN messages m
            ON m.user_id = u.user_id
        WHERE u.started = 1
        GROUP BY u.user_id
        ORDER BY message_count DESC, u.user_id
    """

    params: tuple = ()

    if limit is not None:
        query += " LIMIT ? OFFSET ?"
        params = (limit, offset)

    return db.conn.execute(
        query,
        params,
    ).fetchall()


def get_user_total_messages(user_id: int) -> int:
    row = db.conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM messages
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()

    return row["total"] if row else 0


def get_user_message_stats_count() -> int:
    row = db.conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM users
        WHERE started = 1
        """
    ).fetchone()

    return row["total"] if row else 0


def get_all_admin_stats():
    return db.conn.execute(
        """
        SELECT
            a.user_id,
            a.name,
            a.active,
            COUNT(
                CASE
                    WHEN m.status = 'approved'
                    THEN 1
                END
            ) AS approved,
            COUNT(
                CASE
                    WHEN m.status = 'rejected'
                    THEN 1
                END
            ) AS rejected,
            COUNT(
                CASE
                    WHEN m.status IN ('approved','rejected')
                    THEN 1
                END
            ) AS reviewed
        FROM admins a
        LEFT JOIN messages m
            ON m.admin_id = a.user_id
        GROUP BY a.user_id
        ORDER BY reviewed DESC, a.user_id
        """
    ).fetchall()


def get_admin_rejected_messages(
    admin_id: int,
    limit: int = 30,
):
    return db.conn.execute(
        """
        SELECT *
        FROM messages
        WHERE admin_id = ?
          AND status = 'rejected'
        ORDER BY id DESC
        LIMIT ?
        """,
        (admin_id, limit),
    ).fetchall()


def _time_to_minutes(value: str) -> int:
    hour, minute = map(int, value.strip().split(":"))
    return hour * 60 + minute


def _shift_range_minutes(start: str, end: str) -> tuple[int, int]:
    """بازه را به دقیقه تبدیل می‌کند؛ اگر شبانه باشد end بزرگ‌تر از ۲۴ساعت می‌شود."""
    start_m = _time_to_minutes(start)
    end_m = _time_to_minutes(end)
    if end_m <= start_m:
        end_m += 24 * 60
    return start_m, end_m


def _ranges_overlap(
    start_a: str,
    end_a: str,
    start_b: str,
    end_b: str,
) -> bool:
    """آیا دو بازه زمانی هم‌پوشانی دارند؟ (مثلاً 12:00-13:00 با 12:30-13:00)"""
    s1, e1 = _shift_range_minutes(start_a, end_a)
    s2, e2 = _shift_range_minutes(start_b, end_b)
    return s1 < e2 and s2 < e1


def get_shift_ranges_for_date(
    for_date: str | None = None,
    channel_key: str | None = None,
) -> list[tuple[str, str]]:
    """لیست (start, end) شیفت‌های ثبت‌شده برای آن تاریخ (+ دائمی) و کانال."""
    target = for_date or today_string()
    ch = channel_key or DEFAULT_CHANNEL_KEY
    rows = db.conn.execute(
        """
        SELECT start_time, end_time, channel_key
        FROM shifts
        WHERE specific_date = ?
           OR (permanent = 1 AND (specific_date IS NULL OR specific_date = ''))
        """,
        (target,),
    ).fetchall()
    result: list[tuple[str, str]] = []
    for row in rows:
        sk = None
        try:
            sk = row["channel_key"]
        except Exception:
            sk = None
        sk = sk or DEFAULT_CHANNEL_KEY
        if sk != ch:
            continue
        start = str(row["start_time"]).strip()
        end = str(row["end_time"]).strip()
        result.append((start, end))
    return result


def get_taken_shift_slots(for_date: str | None = None) -> set[str]:
    """
    برای سازگاری: کلید دقیق بازه‌های ثبت‌شده.
    برای تشخیص اشغال واقعی از is_shift_slot_taken / هم‌پوشانی استفاده کن.
    """
    taken: set[str] = set()
    for start, end in get_shift_ranges_for_date(for_date):
        taken.add(f"{start}-{end}")
    return taken


def get_today_taken_shift_slots() -> set[str]:
    return get_taken_shift_slots(today_string())


def is_shift_slot_taken(
    start_time: str,
    end_time: str,
    specific_date: str | None = None,
    channel_key: str | None = None,
) -> bool:
    """
    اگر همین بازه یا هر بازهٔ هم‌پوشان برای آن تاریخ+کانال ثبت شده باشد True.
    """
    date = specific_date or today_string()
    for existing_start, existing_end in get_shift_ranges_for_date(
        date, channel_key=channel_key
    ):
        if _ranges_overlap(
            start_time,
            end_time,
            existing_start,
            existing_end,
        ):
            return True
    return False


def get_admin_shift_ranges_for_date(
    admin_id: int,
    for_date: str | None = None,
) -> list[tuple[str, str]]:
    """همه شیفت‌های یک ادمین در تاریخ مشخص (در همه کانال‌ها)."""
    target = for_date or today_string()
    rows = db.conn.execute(
        """
        SELECT start_time, end_time
        FROM shifts
        WHERE admin_id = ?
          AND (
                specific_date = ?
                OR (permanent = 1 AND (specific_date IS NULL OR specific_date = ''))
              )
        """,
        (admin_id, target),
    ).fetchall()
    result: list[tuple[str, str]] = []
    for row in rows:
        start = str(row["start_time"]).strip()
        end = str(row["end_time"]).strip()
        result.append((start, end))
    return result


def get_admin_shifts_for_date_channel(
    admin_id: int,
    for_date: str | None = None,
    channel_key: str | None = None,
) -> list:
    """شیفت‌های یک ادمین در تاریخ+کانال مشخص (شامل دائمی)."""
    target = for_date or today_string()
    ch = channel_key or DEFAULT_CHANNEL_KEY
    rows = db.conn.execute(
        """
        SELECT *
        FROM shifts
        WHERE admin_id = ?
          AND (
                specific_date = ?
                OR (permanent = 1 AND (specific_date IS NULL OR specific_date = ''))
              )
        ORDER BY start_time ASC
        """,
        (admin_id, target),
    ).fetchall()
    result = []
    for row in rows:
        try:
            sk = row["channel_key"]
        except Exception:
            sk = None
        sk = sk or DEFAULT_CHANNEL_KEY
        if sk != ch:
            continue
        result.append(row)
    return result


def admin_has_overlapping_shift(
    admin_id: int,
    start_time: str,
    end_time: str,
    specific_date: str | None = None,
) -> bool:
    """
    آیا این ادمین قبلاً شیفتی (در هر کانالی) دارد که با بازه جدید
    حتی یک دقیقه هم‌پوشانی داشته باشد؟
    """
    date = specific_date or today_string()
    for existing_start, existing_end in get_admin_shift_ranges_for_date(
        admin_id, date
    ):
        if _ranges_overlap(
            start_time,
            end_time,
            existing_start,
            existing_end,
        ):
            return True
    return False


def is_duplicate_user_message(
    user_id: int,
    content: str,
    hours: int = 24,
) -> bool:
    """
    ضد پیام تکراری برای همان کاربر + همان متن در بازه زمانی.

    استثنا: اگر تنها سابقهٔ این متن، رد توسط مالک باشد،
    تکراری حساب نمی‌شود و کاربر می‌تواند دوباره بفرستد.
    رد توسط ادمین همچنان مانع است.
    """
    cutoff = (local_now() - timedelta(hours=hours)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    try:
        rows = db.conn.execute(
            """
            SELECT status, rejected_by
            FROM messages
            WHERE user_id = ?
              AND content = ?
              AND submitted_at >= ?
            """,
            (user_id, content, cutoff),
        ).fetchall()
    except Exception:
        # اگر ستون rejected_by هنوز نباشد
        row = db.conn.execute(
            """
            SELECT 1
            FROM messages
            WHERE user_id = ?
              AND content = ?
              AND submitted_at >= ?
            LIMIT 1
            """,
            (user_id, content, cutoff),
        ).fetchone()
        return bool(row)

    if not rows:
        return False

    for r in rows:
        st = r["status"] if not isinstance(r, dict) else r.get("status")
        if st != "rejected":
            return True
        rb = r["rejected_by"] if not isinstance(r, dict) else r.get("rejected_by")
        if rb is None:
            return True
        try:
            if not db.is_owner(int(rb)):
                return True
        except Exception:
            return True
    return False


def create_announcement(
    target: str,
    content: str,
    schedule_type: str,
    created_by: int,
    entities_json: str | None = None,
    schedule_date: str | None = None,
    schedule_time: str | None = None,
    weekday: int | None = None,
) -> int:
    cur = db.conn.execute(
        """
        INSERT INTO announcements (
            target, content, entities_json,
            schedule_type, schedule_date, schedule_time,
            weekday, last_sent, active, created_at, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
        """,
        (
            target,
            content,
            entities_json,
            schedule_type,
            schedule_date,
            schedule_time,
            weekday,
            db.now(),
            created_by,
        ),
    )
    db.conn.commit()
    return int(cur.lastrowid)


def get_active_announcements():
    return db.conn.execute(
        """
        SELECT *
        FROM announcements
        WHERE active = 1
        ORDER BY id ASC
        """
    ).fetchall()


def mark_announcement_sent(ann_id: int):
    db.conn.execute(
        """
        UPDATE announcements
        SET last_sent = ?
        WHERE id = ?
        """,
        (db.now(), ann_id),
    )
    db.conn.commit()


def deactivate_announcement(ann_id: int):
    db.conn.execute(
        """
        UPDATE announcements
        SET active = 0
        WHERE id = ?
        """,
        (ann_id,),
    )
    db.conn.commit()


# =========================================================
# GROUP CONFIGURATION
# =========================================================

def configured_group_id() -> int | None:
    """
    برای سازگاری قدیمی: اولین گروه مدیریت‌شده را برمی‌گرداند.
    ترجیحاً از is_managed_group / channel_key_for_group استفاده کن.
    """
    value = get_setting("admin_group_id")
    if value:
        try:
            return int(value)
        except ValueError:
            pass
    # fallback: گروه کانال پیش‌فرض
    try:
        return int(CHANNELS[DEFAULT_CHANNEL_KEY]["group_id"])
    except Exception:
        return None


def admin_channel_keys(user_id: int) -> list[str]:
    """لیست کانال‌هایی که این کاربر ادمین آن‌هاست (پشتیبانی از چند کانال)."""
    admin = db.get_admin(user_id)
    if not admin:
        return []
    try:
        raw = admin["channel_key"] or ""
    except Exception:
        raw = ""
    if not raw:
        return [DEFAULT_CHANNEL_KEY]
    keys = []
    for part in str(raw).split(","):
        k = part.strip()
        if k and k in CHANNELS and k not in keys:
            keys.append(k)
    return keys or [DEFAULT_CHANNEL_KEY]


def admin_channel_key(user_id: int) -> str | None:
    """اولین/اصلی کانال ادمین (برای سازگاری با کد قبلی)."""
    keys = admin_channel_keys(user_id)
    return keys[0] if keys else None


def set_admin_channel(user_id: int, channel_key: str):
    """افزودن کانال به لیست کانال‌های ادمین (بدون حذف کانال‌های قبلی)."""
    if channel_key not in CHANNELS:
        return
    admin = db.get_admin(user_id)
    if not admin:
        return
    try:
        raw = admin["channel_key"] or ""
    except Exception:
        raw = ""
    existing = [p.strip() for p in str(raw).split(",") if p.strip()]
    if channel_key not in existing:
        existing.append(channel_key)
    new_val = ",".join(existing)
    db.conn.execute(
        """
        UPDATE admins
        SET channel_key = ?
        WHERE user_id = ?
        """,
        (new_val, user_id),
    )
    db.conn.commit()


PENDING_PAGE_SIZE = 50


def get_pending_rows_for_channel(
    channel_key: str,
    admin_id: int | None = None,
    limit: int = PENDING_PAGE_SIZE,
    offset: int = 0,
):
    """
    پیام‌های در انتظار یک کانال — صفحه‌بندی برای سرور ضعیف.
    پیام بدون channel_key فقط در کانال پیش‌فرض (صدام بزن) دیده می‌شود.

    اگر admin_id داده شود یعنی ادمین شیفت فعال است؛ همهٔ pending/queued/processing
    همان کانال را می‌بیند (نه فقط پیام‌هایی که admin_id قبلی‌شان خودش است).
    """
    key = channel_key or DEFAULT_CHANNEL_KEY
    ch_sql = """
        (
            channel_key = ?
            OR (
                ? = ?
                AND (channel_key IS NULL OR channel_key = '')
            )
        )
    """
    try:
        # مالک و ادمین شیفت: همه پیام‌های باز همان کانال
        return db.conn.execute(
            f"""
            SELECT *
            FROM messages
            WHERE status IN ('pending', 'queued', 'processing')
              AND {ch_sql}
            ORDER BY
                CASE status
                    WHEN 'pending' THEN 0
                    WHEN 'processing' THEN 1
                    WHEN 'queued' THEN 2
                    ELSE 3
                END,
                id ASC
            LIMIT ? OFFSET ?
            """,
            (key, key, DEFAULT_CHANNEL_KEY, limit, offset),
        ).fetchall()
    except Exception:
        logger.exception(
            "GET PENDING FOR CHANNEL ERROR | channel=%s admin=%s",
            key,
            admin_id,
        )
        return []


def count_pending_for_channel(
    channel_key: str,
    admin_id: int | None = None,
) -> int:
    key = channel_key or DEFAULT_CHANNEL_KEY
    ch_sql = """
        (
            channel_key = ?
            OR (
                ? = ?
                AND (channel_key IS NULL OR channel_key = '')
            )
        )
    """
    try:
        row = db.conn.execute(
            f"""
            SELECT COUNT(*) AS c FROM messages
            WHERE status IN ('pending', 'queued', 'processing')
              AND {ch_sql}
            """,
            (key, key, DEFAULT_CHANNEL_KEY),
        ).fetchone()
        return int(row["c"] or 0) if row else 0
    except Exception:
        return 0


def pending_group_id() -> int | None:
    value = get_setting(
        "pending_admin_group_id"
    )

    if not value:
        return None

    try:
        return int(value)
    except ValueError:
        return None


def set_pending_group(chat_id: int):
    set_setting(
        "pending_admin_group_id",
        str(chat_id),
    )


def clear_pending_group():
    db.conn.execute(
        """
        DELETE FROM settings
        WHERE key = 'pending_admin_group_id'
        """
    )

    db.conn.commit()


def set_configured_group(chat_id: int):
    set_setting(
        "admin_group_id",
        str(chat_id),
    )


def bot_matches_text(text: str) -> bool:
    if not text:
        return False

    value = text.strip()

    if BOT_USERNAME:
        username = (
            BOT_USERNAME
            .lower()
            .lstrip("@")
        )

        if value.lower() in {
            f"@{username}",
            username,
        }:
            return True

    if BOT_ID and value == str(BOT_ID):
        return True

    return False


# =========================================================
# STATE
# =========================================================

def set_state(
    user_id: int,
    kind: str,
    **data,
):
    states[user_id] = {
        "kind": kind,
        **data,
    }


def get_state(user_id: int):
    return states.get(user_id)


def clear_state(user_id: int):
    states.pop(user_id, None)


# =========================================================
# HELPERS
# =========================================================

def local_now() -> datetime:
    return datetime.now(TZ)


def today_string() -> str:
    return local_now().strftime(
        "%Y-%m-%d"
    )


def current_time_string() -> str:
    return local_now().strftime(
        "%H:%M"
    )


_JALALI_MONTHS = (
    "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
    "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
)


def _gregorian_to_jalali(gy: int, gm: int, gd: int) -> tuple[int, int, int]:
    """تبدیل میلادی به شمسی بدون وابستگی خارجی."""
    g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    if gy > 1600:
        jy = 979
        gy -= 1600
    else:
        jy = 0
        gy -= 621
    gy2 = gy + 1 if gm > 2 else gy
    days = (
        365 * gy
        + (gy2 + 3) // 4
        - (gy2 + 99) // 100
        + (gy2 + 399) // 400
        - 80
        + gd
        + g_d_m[gm - 1]
    )
    jy += 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm = 1 + days // 31
        jd = 1 + days % 31
    else:
        jm = 7 + (days - 186) // 30
        jd = 1 + (days - 186) % 30
    return jy, jm, jd


def format_dt_fa(value) -> str:
    """
    هر تاریخ/زمانی را مرتب و شمسی می‌کند.
    ورودی: datetime یا رشته ISO مثل 2026-09-12T20:24:32
    خروجی نمونه: ۱ شهریور ۱۴۰۵ — ۲۰:۲۴
    """
    if value is None or value == "":
        return "—"
    dt = None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip().replace("T", " ").replace("Z", "")
        s = s.split(".")[0]
        for fmt in (
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d",
            "%Y/%m/%d %H:%M:%S",
            "%Y/%m/%d",
        ):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except Exception:
                continue
    if dt is None:
        return str(value)
    jy, jm, jd = _gregorian_to_jalali(dt.year, dt.month, dt.day)
    month = _JALALI_MONTHS[jm - 1]
    # ارقام فارسی اختیاری نیست؛ خوانا با اعداد معمول
    if dt.hour or dt.minute or dt.second or (" " in str(value) or "T" in str(value)):
        return f"{jd} {month} {jy} — {dt.hour:02d}:{dt.minute:02d}"
    return f"{jd} {month} {jy}"


def full_name(user: User) -> str:
    name = " ".join(
        x
        for x in (
            user.first_name,
            user.last_name,
        )
        if x
    ).strip()

    if name:
        return name

    if user.username:
        return f"@{user.username}"

    return str(user.id)


def escape(value: Any) -> str:
    return html.escape(
        str(value or "")
    )


def utf16_length(text: str) -> int:
    return len(
        text.encode("utf-16-le")
    ) // 2


def entity_type(entity) -> str:
    value = getattr(
        entity,
        "type",
        "",
    )

    return getattr(
        value,
        "value",
        str(value),
    )


def serialize_entities(entities):
    if not entities:
        return []

    result = []

    for entity in entities:
        data = {
            "type": entity_type(entity),
            "offset": entity.offset,
            "length": entity.length,
        }

        for field in (
            "url",
            "language",
            "custom_emoji_id",
        ):
            value = getattr(
                entity,
                field,
                None,
            )

            if value is not None:
                data[field] = value

        result.append(data)

    return result


def entity_from_dict(data):
    return MessageEntity(
        type=data.get("type"),
        offset=int(
            data.get("offset", 0)
        ),
        length=int(
            data.get("length", 0)
        ),
        **{
            key: data[key]
            for key in (
                "url",
                "language",
                "custom_emoji_id",
            )
            if data.get(key) is not None
        },
    )


def deserialize_entities(entities):
    if not entities:
        return []

    if isinstance(entities, str):
        try:
            entities = json.loads(entities)
        except Exception:
            logger.exception(
                "ENTITY JSON DECODE ERROR"
            )
            return []

    result = []

    for entity in entities:
        try:
            result.append(
                entity_from_dict(entity)
            )
        except Exception:
            logger.exception(
                "ENTITY DESERIALIZATION ERROR | entity=%r",
                entity,
            )

    return result

def shift_entities(
    entities,
    prefix: str,
):
    shift = utf16_length(prefix)
    result = []

    for entity in entities:
        try:
            result.append(
                MessageEntity(
                    type=entity_type(entity),
                    offset=entity.offset + shift,
                    length=entity.length,
                    **{
                        key: getattr(
                            entity,
                            key,
                        )
                        for key in (
                            "url",
                            "language",
                            "custom_emoji_id",
                        )
                        if getattr(
                            entity,
                            key,
                            None,
                        ) is not None
                    },
                )
            )
        except Exception:
            pass

    return result


def get_message_entities(row) -> list:
    """
    مقدار entities یک ردیف پیام را با فرمت یکسان برمی‌گرداند،
    صرف‌نظر از اینکه ستون در دیتابیس entities باشد یا entities_json.
    این تابع نقطه‌ی واحد خواندن entities است تا تناقض بین بخش‌های
    مختلف کد (مثل send_review_message و approve_callback) از بین برود.
    """

    if isinstance(row, dict):
        raw = row.get("entities_json", row.get("entities"))
    else:
        keys = row.keys() if hasattr(row, "keys") else []

        if "entities_json" in keys:
            raw = row["entities_json"]
        elif "entities" in keys:
            raw = row["entities"]
        else:
            raw = None

    return deserialize_entities(raw)


# =========================================================
# USER PROFILE
# =========================================================

profile_cache: dict[
    int,
    tuple[float, str],
] = {}


async def get_profile_name(
    bot: Bot,
    user_id: int,
    fallback: str | None = None,
) -> str:

    now = (
        asyncio
        .get_running_loop()
        .time()
    )

    cached = profile_cache.get(
        user_id
    )

    if cached:
        timestamp, name = cached

        if now - timestamp < 300:
            return name

    admin = db.get_admin(
        user_id
    )

    if admin and admin["name"]:
        name = str(
            admin["name"]
        )

        if not name.isdigit():
            profile_cache[user_id] = (
                now,
                name,
            )

            return name

    try:
        chat = await bot.get_chat(
            user_id
        )

        name = (
            getattr(
                chat,
                "full_name",
                None,
            )
            or getattr(
                chat,
                "title",
                None,
            )
            or (
                f"@{chat.username}"
                if getattr(
                    chat,
                    "username",
                    None,
                )
                else None
            )
        )

        if name:
            profile_cache[user_id] = (
                now,
                name,
            )

            return name

    except Exception:
        pass

    row = db.get_user(
        user_id
    )

    if row:
        name = " ".join(
            x
            for x in (
                row["first_name"],
                row["last_name"],
            )
            if x
        ).strip()

        if name:
            return name

        if row["username"]:
            return f"@{row['username']}"

    return fallback or "کاربر"


async def mention_user(
    bot: Bot,
    user_id: int,
    fallback: str | None = None,
):
    name = await get_profile_name(
        bot,
        user_id,
        fallback,
    )

    return (
        f'<a href="tg://user?id={user_id}">'
        f"{escape(name)}"
        f"</a>"
    )


# =========================================================
# PROFANITY FILTER
# =========================================================

BLOCKED_WORDS = (
    "کیر",
    "کص",
    "کصکش",
    "کسکش",
    "کس",
    "جنده",
    "هرزه",
    "فاحشه",
)


def normalize_persian(
    text: str,
) -> str:

    text = text.lower()

    replacements = {
        "ي": "ی",
        "ى": "ی",
        "ك": "ک",
        "ۀ": "ه",
        "ة": "ه",
        "ؤ": "و",
        "إ": "ا",
        "أ": "ا",
        "ٱ": "ا",
    }

    for old, new in replacements.items():
        text = text.replace(
            old,
            new,
        )

    text = re.sub(
        r"[\u064B-\u065F\u0670]",
        "",
        text,
    )

    text = text.replace(
        "\u200c",
        "",
    )

    text = text.replace(
        "ـ",
        "",
    )

    return text


def contains_blocked_word(
    text: str,
) -> bool:

    normalized = normalize_persian(
        text
    )

    compact = re.sub(
        r"[^\u0600-\u06FFa-zA-Z0-9]+",
        "",
        normalized,
    )

    for word in BLOCKED_WORDS:

        if word == "کس":

            if re.search(
                rf"(?<![\u0600-\u06FF])"
                rf"{word}"
                rf"(?![\u0600-\u06FF])",
                compact,
            ):
                return True

            if compact == word:
                return True

            continue

        if word in compact:
            return True

    return False


def contains_emoji(text: str) -> bool:
    """تشخیص هرگونه ایموجی در متن پیام کاربر."""
    if not text:
        return False

    for ch in text:
        code = ord(ch)
        if (
            0x1F300 <= code <= 0x1FAFF
            or 0x2600 <= code <= 0x27BF
            or 0x2300 <= code <= 0x23FF
            or 0x2B00 <= code <= 0x2BFF
            or 0x1F000 <= code <= 0x1F02F
            or 0x1F0A0 <= code <= 0x1F0FF
            or code in (0x200D, 0xFE0F, 0x3030, 0x303D, 0x3297, 0x3299)
        ):
            return True
    return False


# =========================================================
# VALIDATION
# =========================================================

def is_fully_bold(
    text,
    entities,
):
    if not text or not entities:
        return False

    total = utf16_length(
        text
    )

    intervals = []

    for entity in entities:

        if entity_type(entity) == "bold":
            intervals.append(
                (
                    entity.offset,
                    entity.offset + entity.length,
                )
            )

    if not intervals:
        return False

    intervals.sort()

    covered = 0

    for start, end in intervals:

        if start > covered:
            return False

        covered = max(
            covered,
            end,
        )

    return covered >= total


def contains_link(
    text,
    entities,
):
    for entity in entities or []:

        if entity_type(entity) in {
            "url",
            "text_link",
        }:
            return True

    lower = text.lower()

    return any(
        pattern.lower() in lower
        for pattern in BLOCKED_LINK_PATTERNS
    )


def validate_submission(
    message: Message,
):
    """
    همهٔ خطاها را یک‌جا جمع می‌کند تا کاربر با یک پیام
    بفهمد دقیقاً چه چیزهایی را باید درست کند.
    """
    text = message.text or ""
    entities = message.entities or []
    errors: list[str] = []

    if contains_blocked_word(text):
        errors.append(
            "کلمات غیرمجاز در متن استفاده شده است."
        )

    has_emoji = contains_emoji(text)
    if not has_emoji:
        for entity in entities:
            if entity_type(entity) in {
                "custom_emoji",
                "emoji",
            }:
                has_emoji = True
                break
    if has_emoji:
        errors.append(
            "ارسال هرگونه ایموجی مجاز نیست.\n"
            "متن را بدون ایموجی بفرست."
        )

    if channel_key_from_prefix(text) is None:
        errors.append(
            "پیام باید با یکی از این‌ها شروع شود:\n"
            "• صدام بزن\n"
            "• این کاربر\n"
            "• تو زندگی بعدی\n\n"
            "مثال: صدام بزن سلام به همگی ."
        )

    if not is_fully_bold(text, entities):
        errors.append(
            "کل پیام باید Bold باشد.\n"
            "در تلگرام کل متن را انتخاب کن و Bold بزن.\n"
            "مثال: کل جمله از «صدام بزن» تا آخر باید پررنگ باشد."
        )

    if not text.endswith(" ."):
        errors.append(
            "پیام باید با فاصله و نقطه تمام شود: « .»\n"
            "مثال درست در پایان پیام:  ."
        )

    if contains_link(text, entities):
        errors.append(
            "لینک یا آدرس وب در پیام مجاز نیست.\n"
            "هر لینک، یوزرنیم لینک‌شده یا text_link را حذف کن."
        )

    if errors:
        body = "\n\n".join(
            f"❌ {i}. {err}"
            for i, err in enumerate(errors, 1)
        )
        return (
            False,
            (
                "🚫 پیام قابل ارسال نیست.\n"
                "لطفاً همهٔ موارد زیر را یک‌جا اصلاح کن:\n\n"
                f"{body}"
            ),
        )

    return True, None


# =========================================================
# KEYBOARDS
# =========================================================

def back_keyboard():
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="🔙 بازگشت"
                )
            ]
        ],
        resize_keyboard=True,
    )


def user_keyboard():
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="📝 ارسال پیام"
                ),
                KeyboardButton(
                    text="📊 وضعیت پیام من"
                ),
            ],
            [
                KeyboardButton(
                    text="💬 انتقادات، پیشنهادات، گزارش مشکل"
                ),
            ],
            [
                KeyboardButton(
                    text="📖 راهنما"
                ),
            ],
        ],
        resize_keyboard=True,
    )


def admin_keyboard():
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="📝 ارسال پیام به صورت کاربر عادی"
                ),
            ],
            [
                KeyboardButton(
                    text="📥 پیام‌های در انتظار"
                ),
                KeyboardButton(
                    text="⏰ شیفت من"
                ),
            ],
            [
                KeyboardButton(
                    text="📊 عملکرد من"
                ),
                KeyboardButton(
                    text="🔔 اعلان‌ها"
                ),
            ],
            [
                KeyboardButton(
                    text="🔄 درخواست تغییر شیفت"
                ),
                KeyboardButton(
                    text="❓ راهنما"
                ),
            ],
        ],
        resize_keyboard=True,
    )


def role_keyboard(user_id: int):
    """کیبورد مناسب نقش کاربر (مالک / ادمین / کاربر عادی)."""
    try:
        if db.is_owner(user_id):
            return owner_keyboard(db.is_bot_enabled())
        if db.get_admin(user_id):
            return admin_keyboard()
    except Exception:
        pass
    return user_keyboard()


def owner_keyboard(
    enabled: bool,
):
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="📥 پیام‌های در انتظار"
                ),
                KeyboardButton(
                    text="👥 ادمین‌ها"
                ),
            ],
            [
                KeyboardButton(
                    text="⏰ شیفت‌ها"
                ),
                KeyboardButton(
                    text="📊 آمار و گزارش‌ها"
                ),
            ],
            [
                KeyboardButton(
                    text="📢 اطلاعیه‌ها"
                ),
                KeyboardButton(
                    text="📬 پیام کاربران"
                ),
            ],
            [
                KeyboardButton(
                    text="🔍 جستجو"
                ),
                KeyboardButton(
                    text="⚙️ مدیریت سیستم"
                ),
            ],
            [
                KeyboardButton(
                    text="❓ راهنما"
                ),
            ],
        ],
        resize_keyboard=True,
    )


# دلایل رد کوتاه و واضح برای ادمین
ADMIN_REJECT_REASONS = {
    "inappropriate": "نامناسب",
    "profanity": "حاوی کلمات ناسزا",
    "duplicate": "تکراری",
    "rules": "عدم رعایت قوانین ارسال",
    "quality": "کیفیت پایین / نامفهوم",
}


def _btn(text: str, callback_data: str, style: str | None = None) -> InlineKeyboardButton:
    """دکمه اینلاین؛ در صورت پشتیبانی aiogram از style رنگی استفاده می‌کند."""
    kwargs = {
        "text": text,
        "callback_data": callback_data,
    }
    if style:
        kwargs["style"] = style
    try:
        return InlineKeyboardButton(**kwargs)
    except TypeError:
        kwargs.pop("style", None)
        return InlineKeyboardButton(**kwargs)


def review_keyboard(
    message_id: int,
):
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    "🟢 تأیید و ارسال",
                    f"approve:{message_id}",
                    style="success",
                ),
                _btn(
                    "🔴 رد",
                    f"reject:{message_id}",
                    style="danger",
                ),
            ]
        ]
    )


def clear_pending_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    "🗑 پاک‌سازی کل صف",
                    "pending:clear_all",
                    style="danger",
                )
            ]
        ]
    )


def reject_keyboard(
    message_id: int,
):
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    title,
                    f"reject_reason:{message_id}:{key}",
                    style="danger",
                )
            ]
            for key, title
            in ADMIN_REJECT_REASONS.items()
        ]
    )


# =========================================================
# HOME
# =========================================================

async def show_home(
    message: Message,
    bot: Bot,
):
    user_id = message.from_user.id

    try:
        is_owner = await asyncio.to_thread(db.is_owner, user_id)
    except Exception:
        logger.exception("SHOW_HOME IS_OWNER ERROR")
        is_owner = False

    if is_owner:
        try:
            _register_log_recipient(user_id)
        except Exception:
            pass
        try:
            enabled = await asyncio.to_thread(db.is_bot_enabled)
            admins_n = await asyncio.to_thread(db.count_admins)
            pending_n = await asyncio.to_thread(db.count_pending)
        except Exception:
            logger.exception("SHOW_HOME OWNER STATS ERROR")
            enabled, admins_n, pending_n = True, 0, 0

        await message.answer(
            (
                "👑 سلام مالک عزیز\n\n"
                "به مرکز کنترل ربات چندکاناله خوش آمدی.\n\n"
                f"🟢 وضعیت ربات: "
                f"{'فعال' if enabled else 'غیرفعال'}\n"
                f"👥 ادمین‌ها: "
                f"{admins_n}\n"
                f"📥 پیام‌های در انتظار: "
                f"{pending_n}"
            ),
            reply_markup=owner_keyboard(enabled),
        )
        return

    try:
        admin = await asyncio.to_thread(db.get_admin, user_id)
    except Exception:
        logger.exception("SHOW_HOME GET_ADMIN ERROR")
        admin = None

    if admin:
        try:
            name = await get_profile_name(bot, user_id, admin["name"])
        except Exception:
            name = admin["name"] or "ادمین"
        await message.answer(
            (
                f"👋 سلام "
                f"{escape(name)}\n\n"
                "شما ادمین ربات هستید."
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=admin_keyboard(),
        )
        return

    await message.answer(
        (
            "سلام!\n\n"
            "به ربات هوشمند آرال خوش آمدید .\n\n"
            "پیامت رو بفرست تا بررسی بشه و در صورت تأیید در کانال منتشر بشه.\n\n"
            "و حتما قوانین رو رعایت کن 🌹"
        ),
        reply_markup=user_keyboard(),
    )


# =========================================================
# START / GROUP ROUTER
# =========================================================

@router.message(
    F.chat.type.in_({
        "group",
        "supergroup",
    })
)
async def group_router(
    message: Message,
    bot: Bot,
):

    text = message.text or ""
    user = message.from_user

    if not user:
        return

    # گروه‌های ثابت سه کانال — مدیریت شیفت مستقیم
    group_ch = channel_key_for_group(message.chat.id)
    if group_ch and bot_matches_text(text):
        admin = db.get_admin(user.id)
        if not admin and not db.is_owner(user.id):
            await message.answer("⛔ شما ادمین ربات نیستید.")
            return
        if admin and not db.is_owner(user.id):
            a_chs = admin_channel_keys(user.id)
            if a_chs and group_ch not in a_chs:
                await message.answer(
                    "⛔ این گروه مربوط به کانال شما نیست."
                )
                return
        if not user_started(user.id) and not db.is_owner(user.id):
            link = (
                f"https://t.me/{BOT_USERNAME}"
                if BOT_USERNAME
                else ""
            )
            await message.answer(
                (
                    "⚠️ برای مدیریت شیفت ابتدا باید ربات را در PV "
                    "استارت کنی.\n\n"
                    f"🔗 {link}"
                )
            )
            return

        now = local_now()
        title = CHANNELS[group_ch]["title"]
        hours_label = channel_hours_label(group_ch)

        # اگر ادمین از قبل شیفت امروز (یا فردا در صورت مجاز) دارد → نمایش + لغو
        if admin and not db.is_owner(user.id):
            today = today_string()
            my_shifts = get_admin_shifts_for_date_channel(
                user.id, today, group_ch
            )
            tomorrow = (now.date() + timedelta(days=1)).strftime("%Y-%m-%d")
            my_shifts_tmr = []
            if now.hour >= 22:
                my_shifts_tmr = get_admin_shifts_for_date_channel(
                    user.id, tomorrow, group_ch
                )

            if my_shifts or my_shifts_tmr:
                admin_name = (
                    (admin["name"] if admin else None)
                    or user.full_name
                    or str(user.id)
                )
                lines = [
                    f"👨‍💼 <b>{escape(admin_name)}</b>",
                    f"📺 کانال: <b>{title}</b>\n",
                ]
                cancel_buttons = []
                if my_shifts:
                    lines.append("📅 <b>شیفت‌های امروز:</b>")
                    for s in my_shifts:
                        lines.append(
                            f"⏰ {s['start_time']} تا {s['end_time']}"
                        )
                        cancel_buttons.append(
                            [
                                _btn(
                                    f"🗑 لغو {s['start_time']}–{s['end_time']}",
                                    f"group_shift_cancel:{s['id']}",
                                    style="danger",
                                )
                            ]
                        )
                if my_shifts_tmr:
                    lines.append("\n📆 <b>شیفت‌های فردا:</b>")
                    for s in my_shifts_tmr:
                        lines.append(
                            f"⏰ {s['start_time']} تا {s['end_time']}"
                        )
                        cancel_buttons.append(
                            [
                                _btn(
                                    f"🗑 لغو فردا {s['start_time']}–{s['end_time']}",
                                    f"group_shift_cancel:{s['id']}",
                                    style="danger",
                                )
                            ]
                        )
                cancel_buttons.append(
                    [
                        _btn(
                            "➕ افزودن شیفت جدید",
                            "group_shift:today",
                            style="primary",
                        )
                    ]
                )
                if now.hour >= 22:
                    cancel_buttons.append(
                        [
                            _btn(
                                "📆 شیفت فردا",
                                "group_shift:tomorrow",
                                style="success",
                            )
                        ]
                    )
                await message.answer(
                    "\n".join(lines),
                    parse_mode=ParseMode.HTML,
                    reply_markup=InlineKeyboardMarkup(
                        inline_keyboard=cancel_buttons
                    ),
                )
                return

        can_pick_tomorrow = now.hour >= 22
        if can_pick_tomorrow:
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        _btn(
                            "📅 شیفت امروز (ساعات باقی‌مانده)",
                            "group_shift:today",
                            style="primary",
                        )
                    ],
                    [
                        _btn(
                            "📆 شیفت فردا",
                            "group_shift:tomorrow",
                            style="success",
                        )
                    ],
                ]
            )
            text_out = (
                f"👨‍💼 مدیریت شیفت — <b>{title}</b>\n\n"
                "الان بین <b>۲۲ تا ۰۰</b> هستید.\n"
                "می‌توانید شیفت <b>امروز</b> یا <b>فردا</b> را تنظیم کنید.\n\n"
                f"⏱ بازه‌های مجاز: <b>{hours_label}</b>"
            )
        else:
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        _btn(
                            "📅 تعیین شیفت امروز",
                            "group_shift:today",
                            style="primary",
                        )
                    ]
                ]
            )
            text_out = (
                f"👨‍💼 مدیریت شیفت — <b>{title}</b>\n\n"
                "شیفت فقط برای <b>امروز</b> قابل تعیین است.\n\n"
                f"⏱ بازه‌های مجاز: <b>{hours_label}</b>"
            )
        await message.answer(
            text_out,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
        )
        return

    configured = configured_group_id()

    if configured is None:

        if (
            db.is_owner(user.id)
            and bot_matches_text(text)
        ):

            set_pending_group(
                message.chat.id
            )

            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="✅ تأیید این گروه",
                            callback_data="group:confirm",
                        ),
                        InlineKeyboardButton(
                            text="❌ لغو",
                            callback_data="group:cancel",
                        ),
                    ]
                ]
            )

            await message.answer(
                (
                    "🔐 درخواست تعیین گروه مدیریت شیفت\n\n"
                    f"🏷 گروه: "
                    f"<b>{escape(message.chat.title or 'بدون نام')}</b>\n\n"
                    "آیا این گروه به‌عنوان گروه مدیریت شیفت انتخاب شود؟"
                ),
                parse_mode=ParseMode.HTML,
                reply_markup=keyboard,
            )

        return

    if message.chat.id != configured:
        return

    if not bot_matches_text(text):
        return

    if db.is_owner(user.id):

        await message.answer(
            (
                "👑 این گروه در حال حاضر گروه مدیریت شیفت است.\n\n"
                "مدیریت شیفت ادمین‌ها از همین گروه انجام می‌شود."
            )
        )

        return

    admin = db.get_admin(
        user.id
    )

    if not admin:

        await message.answer(
            WELCOME_MESSAGE
        )

        return

    if not user_started(user.id):

        link = (
            f"https://t.me/{BOT_USERNAME}"
            if BOT_USERNAME
            else ""
        )

        await message.answer(
            (
                "⚠️ برای مدیریت شیفت ابتدا باید ربات را در PV "
                "استارت کنی.\n\n"
                f"🔗 {link}\n\n"
                "بعد از Start دوباره ID ربات را داخل این گروه بفرست."
            )
        )

        return

    # =====================================================
    # شیفت: فقط ۱۲ ظهر تا ۱۲ شب
    # بین ۲۲ تا ۰۰ می‌تواند امروز یا فردا را انتخاب کند
    # =====================================================

    now = local_now()
    can_pick_tomorrow = now.hour >= 22

    if can_pick_tomorrow:
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    _btn(
                        "📅 شیفت امروز (ساعات باقی‌مانده)",
                        "group_shift:today",
                        style="primary",
                    )
                ],
                [
                    _btn(
                        "📆 شیفت فردا",
                        "group_shift:tomorrow",
                        style="success",
                    )
                ],
            ]
        )
        text = (
            "👨‍💼 مدیریت شیفت\n\n"
            "الان بین <b>۲۲ تا ۰۰</b> هستید.\n"
            "می‌توانید شیفت <b>امروز</b> یا <b>فردا</b> را تنظیم کنید.\n\n"
            "⏱ بازه‌های مجاز: فقط از <b>۱۲:۰۰ تا ۰۰:۰۰</b>"
        )
    else:
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    _btn(
                        "📅 تعیین شیفت امروز",
                        "group_shift:today",
                        style="primary",
                    )
                ]
            ]
        )
        text = (
            "👨‍💼 مدیریت شیفت\n\n"
            "شیفت فقط برای <b>امروز</b> قابل تعیین است.\n\n"
            "⏱ بازه‌های مجاز: فقط از <b>۱۲:۰۰ تا ۰۰:۰۰</b>"
        )

    await message.answer(
        text,
        parse_mode=ParseMode.HTML,
        reply_markup=keyboard,
    )


@router.message(
    CommandStart(),
    F.chat.type == "private",
)
async def start_handler(
    message: Message,
    bot: Bot,
):
    # پاسخ سریع اول — جلوگیری از «اولی کار نمی‌کند»
    clear_state(message.from_user.id)

    try:
        await show_home(message, bot)
    except Exception:
        logger.exception("START HANDLER SHOW_HOME ERROR")
        try:
            await message.answer(
                "به ربات هوشمند آرال خوش آمدید .",
                reply_markup=user_keyboard(),
            )
        except Exception:
            pass

    # کارهای دیتابیس بعد از پاسخ (non-blocking)
    try:
        await asyncio.to_thread(mark_user_started, message.from_user)
    except Exception:
        logger.exception("START HANDLER MARK STARTED ERROR")


@router.message(
    Command("help"),
    F.chat.type == "private",
)
async def help_command(
    message: Message,
):
    clear_state(
        message.from_user.id
    )

    user_id = message.from_user.id

    if db.is_owner(user_id):

        text = (
            "👑 راهنمای مالک\n\n"
            "از این پنل کل ربات را کنترل می‌کنی:\n\n"
            "📥 صف هر کانال را باز کن و پیام‌ها را تأیید یا رد کن\n"
            "👥 ادمین جدید اضافه کن یا ادمین فعلی را حذف کن\n"
            "⏰ شیفت‌ها را ببین، بساز یا لغو کن\n"
            "📊 آمار امروز و عملکرد کل سیستم را چک کن\n"
            "📬 به انتقاد و پیشنهاد کاربران جواب بده\n"
            "🔍 با آیدی پیام یا کاربر، جزئیات کامل را پیدا کن\n"
            "⚙️ از «مدیریت سیستم» کانال‌ها، تنظیمات و تست‌ها را ببین\n"
            "📋 لاگ خودکار ۱۲ ساعته و گزارش شبانه شیفت‌ها فعال است"
        )

        keyboard = owner_keyboard(
            db.is_bot_enabled()
        )

    elif db.get_admin(user_id):

        text = (
            "👨‍💼 راهنمای ادمین\n\n"
            "پیام‌ها، شیفت‌ها و عملکرد خودت را مدیریت کن."
        )

        keyboard = admin_keyboard()

    else:

        text = HELP_MESSAGE
        keyboard = user_keyboard()

    await message.answer(
        text,
        reply_markup=keyboard,
    )


# =========================================================
# GROUP CALLBACKS
# =========================================================

@router.callback_query(
    F.data == "group:confirm"
)
async def confirm_group(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ فقط Owner اجازه این کار را دارد.",
            show_alert=True,
        )

        return

    group_id = pending_group_id()

    if (
        not group_id
        or not callback.message
        or callback.message.chat.id != group_id
    ):

        await callback.answer(
            "❌ این درخواست دیگر معتبر نیست.",
            show_alert=True,
        )

        return

    set_configured_group(
        group_id
    )

    clear_pending_group()

    await callback.answer(
        "گروه با موفقیت انتخاب شد."
    )

    await callback.message.edit_text(
        (
            "✅ گروه مدیریت شیفت با موفقیت فعال شد.\n\n"
            "از این به بعد فقط همین گروه پاسخ مدیریتی دریافت می‌کند."
        )
    )


@router.callback_query(
    F.data == "group:cancel"
)
async def cancel_group(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ فقط Owner اجازه این کار را دارد.",
            show_alert=True,
        )

        return

    clear_pending_group()

    await callback.answer(
        "لغو شد."
    )

    await callback.message.edit_text(
        "❌ انتخاب گروه لغو شد."
    )


# =========================================================
# USER SEND
# =========================================================

@router.message(
    F.text.in_({
        "📝 ارسال پیام",
        "📝 ارسال پیام به صورت کاربر عادی",
    }),
    F.chat.type == "private",
)
async def user_send_start(
    message: Message,
):
    # پاسخ سریع اول — جلوگیری از «اولی کار نمی‌کند»
    set_state(
        message.from_user.id,
        "user_send",
    )

    try:
        await message.answer(
            (
                "📝 پیام خودت را بفرست.\n\n"
                "• با «صدام بزن / این کاربر / تو زندگی بعدی  » شروع شود .\n"
                "• کل پیام Bold باشد .\n"
                "• با « .» تمام شود .\n"
                "• لینک نداشته باشد .\n"
                "• فاقد هر گونه ایموجی باشد ."
            ),
            reply_markup=back_keyboard(),
        )
    except Exception:
        logger.exception("USER SEND START ANSWER ERROR")
        return

    if db.is_blocked(message.from_user.id):
        clear_state(message.from_user.id)
        await message.answer(ERROR_MESSAGES["blocked"])
        return

    if not db.is_bot_enabled():
        clear_state(message.from_user.id)
        await message.answer(
            "🔴 ربات در حال حاضر غیرفعال است.\n\n"
            "لطفاً بعداً دوباره امتحان کنید."
        )
        return


# =========================================================
# USER FEEDBACK (انتقادات / پیشنهادات / گزارش مشکل)
# =========================================================

@router.message(
    F.text == "💬 انتقادات، پیشنهادات، گزارش مشکل",
    F.chat.type == "private",
)
async def user_feedback_start(
    message: Message,
):
    set_state(message.from_user.id, "user_feedback")
    await message.answer(
        (
            "💬 انتقادات، پیشنهادات یا گزارش مشکل\n\n"
            "پیامت را بنویس و بفرست.\n"
            "مستقیماً برای مالک ارسال می‌شود."
        ),
        reply_markup=back_keyboard(),
    )


@router.message(
    F.text.in_({"📬 مشاهده پیام کاربران", "📬 پیام کاربران"}),
    F.chat.type == "private",
)
async def owner_view_feedback(
    message: Message,
    bot: Bot,
):
    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return

    try:
        rows = await db_fetchall(
            """
            SELECT *
            FROM user_feedback
            WHERE status = 'open'
            ORDER BY id ASC
            LIMIT 30
            """
        )
    except Exception:
        logger.exception("OWNER FEEDBACK LIST ERROR")
        await message.answer(GENERIC_ERROR)
        return

    if not rows:
        await message.answer(
            "📬 پیام باز از کاربران وجود ندارد.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return

    await message.answer(f"📬 {len(rows)} پیام باز:")

    for row in rows:
        try:
            mention = await mention_user(bot, row["user_id"])
        except Exception:
            mention = str(row["user_id"])
        text = (
            f"#{row['id']} — {mention}\n"
            f"🕐 {escape(row['created_at'] or '')}\n\n"
            f"{escape(row['content'] or '')}"
        )
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="💬 پاسخ",
                        callback_data=f"fb_reply:{row['id']}",
                    ),
                    InlineKeyboardButton(
                        text="✅ بسته‌شد",
                        callback_data=f"fb_close:{row['id']}",
                    ),
                ]
            ]
        )
        try:
            await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=kb)
        except Exception:
            logger.exception("OWNER FEEDBACK SEND ERROR | id=%s", row["id"])
        await asyncio.sleep(0.05)


@router.callback_query(F.data.startswith("fb_reply:"))
async def owner_feedback_reply_start(
    callback: CallbackQuery,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    try:
        fb_id = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer()
        return
    set_state(
        callback.from_user.id,
        "owner_feedback_reply",
        feedback_id=fb_id,
    )
    await callback.answer()
    await callback.message.answer(
        f"💬 پاسخ برای پیام #{fb_id} را بنویس:",
        reply_markup=back_keyboard(),
    )


@router.callback_query(F.data.startswith("fb_close:"))
async def owner_feedback_close(
    callback: CallbackQuery,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    try:
        fb_id = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer()
        return
    try:
        await db_execute(
            """
            UPDATE user_feedback
            SET status = 'closed'
            WHERE id = ?
            """,
            (fb_id,),
        )
        await db_commit()
    except Exception:
        logger.exception("FEEDBACK CLOSE ERROR | id=%s", fb_id)
        await callback.answer(GENERIC_ERROR, show_alert=True)
        return
    await callback.answer("✅ بسته شد.")
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass


# =========================================================
# USER STATUS
# =========================================================

@router.message(
    F.text == "📊 وضعیت پیام من",
    F.chat.type == "private",
)
async def user_status(
    message: Message,
):

    rows = db.get_user_messages(
        message.from_user.id,
        3,
    )

    if not rows:

        await message.answer(
            "📊 هنوز پیامی ارسال نکرده‌ای.",
            reply_markup=user_keyboard(),
        )

        return

    status_map = {
        "queued": "🔵 صف شیفت",
        "pending": "🟡 در انتظار",
        "processing": "🟠 در بررسی",
        "approved": "🟢 منتشر شد",
        "rejected": "🔴 رد شد",
    }

    lines = ["📊 ۳ پیام اخیر"]

    for row in rows:

        status = status_map.get(
            row["status"],
            row["status"],
        )

        lines.append("────────────")
        lines.append(f"#{row['id']} | {status}")

        content = (row["content"] or "").strip()
        if content:
            preview = content if len(content) <= 120 else content[:120] + "…"
            lines.append(preview)

        if (
            row["status"] == "rejected"
            and row["reject_reason"]
        ):
            lines.append(f"دلیل: {row['reject_reason']}")

        if row["submitted_at"]:
            lines.append(f"🕐 {format_dt_fa(row['submitted_at'])}")

    await message.answer(
        "\n".join(lines),
        reply_markup=user_keyboard(),
    )


# =========================================================
# REVIEW
# =========================================================

async def send_review_message(
    bot: Bot,
    chat_id: int,
    row,
):

    message_id = row["id"]

    sender = await get_profile_name(
        bot,
        row["user_id"],
    )

    try:
        ch_key = row["channel_key"]
    except Exception:
        ch_key = None
    ch_key = ch_key or DEFAULT_CHANNEL_KEY
    ch_title = get_channel_cfg(ch_key)["title"]

    prefix = (
        f"📨 پیام جدید #{message_id}\n"
        f"📺 کانال: {ch_title}\n"
        f"👤 ارسال‌کننده: {sender}\n\n"
    )

    original_entities = get_message_entities(row)

    entities = shift_entities(
        original_entities,
        prefix,
    )

    return await bot.send_message(
        chat_id=chat_id,
        text=prefix + row["content"],
        entities=entities,
        reply_markup=review_keyboard(
            message_id
        ),
    )


async def build_channel_post_link(
    bot: Bot,
    channel_id: int,
    message_id: int,
) -> str | None:
    """لینک عمومی یا خصوصی پست کانال را می‌سازد."""
    try:
        chat = await bot.get_chat(channel_id)
        username = getattr(chat, "username", None)
        if username:
            return f"https://t.me/{username}/{message_id}"

        raw = str(channel_id)
        if raw.startswith("-100"):
            internal = raw[4:]
            return f"https://t.me/c/{internal}/{message_id}"
    except Exception:
        logger.exception(
            "BUILD CHANNEL POST LINK ERROR | channel_id=%s",
            channel_id,
        )
    return None


async def can_review(user_id: int, row) -> bool:
    """
    مالک همیشه می‌تواند بررسی کند.
    ادمین شیفت فعال همان کانال می‌تواند همه پیام‌های در انتظار همان کانال را بررسی کند
    (حتی اگر admin_id قبلی روی پیام مانده باشد).
    """
    if db.is_owner(user_id):
        return True

    admin = db.get_admin(user_id)
    if not admin:
        return False

    try:
        msg_ch = row["channel_key"] if not isinstance(row, dict) else row.get("channel_key")
    except Exception:
        msg_ch = None
    msg_ch = msg_ch or DEFAULT_CHANNEL_KEY

    admin_chs = admin_channel_keys(user_id)
    if msg_ch not in admin_chs:
        return False

    current = await get_current_shift_safe_async(channel_key=msg_ch)
    if not current:
        return False

    return int(current[0]["admin_id"]) == int(user_id)


async def edit_original_admin_message(
    bot: Bot,
    row,
    text: str,
):
    """آپدیت پیام بررسی قبلی ادمین با وضعیت جدید."""
    try:
        if isinstance(row, dict):
            admin_message_id = row.get("admin_message_id")
            admin_id = row.get("admin_id")
            msg_id = row.get("id")
        else:
            keys = row.keys() if hasattr(row, "keys") else []
            admin_message_id = row["admin_message_id"] if "admin_message_id" in keys else None
            admin_id = row["admin_id"] if "admin_id" in keys else None
            msg_id = row["id"] if "id" in keys else None
    except Exception:
        return

    if not admin_message_id or not admin_id:
        return

    try:
        await bot.edit_message_text(
            chat_id=admin_id,
            message_id=admin_message_id,
            text=text,
            reply_markup=None,
        )
    except Exception:
        logger.exception(
            "EDIT ORIGINAL ADMIN MESSAGE ERROR | message_id=%s | admin_id=%s",
            msg_id,
            admin_id,
        )


async def deliver_pending_rows(
    bot: Bot,
    user_id: int,
    rows,
    is_owner: bool = False,
    total: int | None = None,
    channel_key: str | None = None,
    offset: int = 0,
):
    if not rows:
        await bot.send_message(
            chat_id=user_id,
            text="📥 فعلاً پیام در انتظاری وجود ندارد.",
            reply_markup=(
                clear_pending_keyboard()
                if is_owner
                else admin_keyboard()
            ),
        )
        if is_owner:
            await bot.send_message(
                chat_id=user_id,
                text="پنل مالک:",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
        return

    sent_count = 0
    failed_count = 0
    for row in rows:
        try:
            await send_review_message(bot, user_id, row)
            sent_count += 1
        except Exception:
            failed_count += 1
            logger.exception(
                "PENDING MESSAGES SEND ERROR | message_id=%s | to_user=%s",
                row["id"],
                user_id,
            )
            continue
        await asyncio.sleep(0.03)

    shown_to = offset + sent_count
    total_n = total if total is not None else shown_to
    summary = f"📥 {sent_count} پیام نمایش داده شد."
    if total_n > shown_to:
        summary += f"\n📄 نمایش {offset + 1} تا {shown_to} از {total_n}"
    if failed_count:
        summary += (
            f"\n⚠️ {failed_count} پیام ارسال نشد "
            "(محدودیت Telegram یا خطای موقت)."
        )

    markup = (
        owner_keyboard(db.is_bot_enabled())
        if is_owner
        else admin_keyboard()
    )
    # دکمه‌های صفحه بعد + پاک‌سازی کل صف (مالک)
    inline_rows = []
    if total_n > shown_to and channel_key:
        next_offset = offset + PENDING_PAGE_SIZE
        inline_rows.append(
            [
                _btn(
                    f"📄 صفحه بعد ({shown_to + 1}…)",
                    f"pending_more:{channel_key}:{next_offset}:{'1' if is_owner else '0'}",
                    style="primary",
                )
            ]
        )
    if is_owner:
        inline_rows.append(
            [
                _btn(
                    "🗑 پاک‌سازی کل صف",
                    "pending:clear_all",
                    style="danger",
                )
            ]
        )
    if inline_rows:
        await bot.send_message(
            chat_id=user_id,
            text=summary,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=inline_rows),
        )
        await bot.send_message(
            chat_id=user_id,
            text="منو:",
            reply_markup=markup,
        )
    else:
        await bot.send_message(
            chat_id=user_id,
            text=summary,
            reply_markup=markup,
        )


@router.message(
    F.text == "📥 پیام‌های در انتظار",
    F.chat.type == "private",
)
async def pending_messages(
    message: Message,
    bot: Bot,
):

    user_id = message.from_user.id

    if db.is_owner(user_id):
        # مالک اول کانال را انتخاب می‌کند
        await message.answer(
            "📥 پیام‌های در انتظار کدام کانال؟",
            reply_markup=channels_keyboard("pending_ch"),
        )
        return

    elif db.get_admin(user_id):

        # ادمین فقط وقتی داخل شیفت خودش است (در هر کانالی که عضو آن است)
        admin_chs = admin_channel_keys(user_id)
        current = None
        ch_key = None
        for ck in admin_chs:
            cur = await get_current_shift_safe_async(channel_key=ck)
            if cur and int(cur[0]["admin_id"]) == int(user_id):
                current = cur
                ch_key = ck
                break
        # fallback: شیفت فعال بدون فیلتر کانال (شیفت‌های قدیمی بدون channel_key)
        if not current:
            cur = await get_current_shift_safe_async(channel_key=None)
            if cur and int(cur[0]["admin_id"]) == int(user_id):
                current = cur
                try:
                    sk = cur[0]["channel_key"]
                except Exception:
                    sk = None
                ch_key = sk or (admin_chs[0] if admin_chs else DEFAULT_CHANNEL_KEY)
        if not current or not ch_key:
            await message.answer(
                (
                    "⛔ شما در حال حاضر در شیفت نیستید.\n\n"
                    "فقط در زمان شیفت خودتان می‌توانید "
                    "پیام‌های در انتظار را مشاهده و بررسی کنید."
                ),
                reply_markup=admin_keyboard(),
            )
            return

        try:
            total = await asyncio.to_thread(
                count_pending_for_channel, ch_key, user_id
            )
            rows = await asyncio.to_thread(
                get_pending_rows_for_channel,
                ch_key, user_id, PENDING_PAGE_SIZE, 0,
            )
        except Exception:
            logger.exception("PENDING LOAD ERROR | admin=%s", user_id)
            await message.answer(GENERIC_ERROR, reply_markup=admin_keyboard())
            return
        await deliver_pending_rows(
            bot,
            user_id,
            rows,
            is_owner=False,
            total=total,
            channel_key=ch_key,
            offset=0,
        )
        return

    else:
        return


@router.callback_query(
    F.data.startswith("pending_ch:")
)
async def pending_channel_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    key = callback.data.split(":", 1)[1]
    if key not in CHANNELS:
        await callback.answer("کانال نامعتبر.", show_alert=True)
        return

    await callback.answer()
    title = CHANNELS[key]["title"]
    try:
        await callback.message.edit_text(
            f"📥 در حال بارگذاری پیام‌های «{title}»..."
        )
    except Exception:
        pass

    try:
        total = await asyncio.to_thread(count_pending_for_channel, key, None)
        rows = await asyncio.to_thread(
            get_pending_rows_for_channel, key, None, PENDING_PAGE_SIZE, 0
        )
    except Exception:
        logger.exception("OWNER PENDING LOAD ERROR | channel=%s", key)
        await callback.message.answer(GENERIC_ERROR)
        return
    await deliver_pending_rows(
        bot,
        callback.from_user.id,
        rows,
        is_owner=True,
        total=total,
        channel_key=key,
        offset=0,
    )


@router.callback_query(
    F.data.startswith("pending_more:")
)
async def pending_more_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    parts = callback.data.split(":")
    if len(parts) < 4:
        await callback.answer()
        return
    key = parts[1]
    try:
        offset = int(parts[2])
        is_owner = parts[3] == "1"
    except Exception:
        await callback.answer()
        return

    uid = callback.from_user.id
    if is_owner and not db.is_owner(uid):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    if not is_owner and not db.get_admin(uid):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    await callback.answer("⏳ صفحه بعد...")
    admin_id = None if is_owner else uid
    try:
        total = await asyncio.to_thread(
            count_pending_for_channel, key, admin_id
        )
        rows = await asyncio.to_thread(
            get_pending_rows_for_channel,
            key, admin_id, PENDING_PAGE_SIZE, offset,
        )
    except Exception:
        logger.exception("PENDING MORE LOAD ERROR")
        await callback.message.answer(GENERIC_ERROR)
        return
    await deliver_pending_rows(
        bot,
        uid,
        rows,
        is_owner=is_owner,
        total=total,
        channel_key=key,
        offset=offset,
    )


def _progress_bar(percent: int) -> str:
    """نوار پیشرفت متنی — درصد ۰ تا ۱۰۰، گام‌های ۱۰٪."""
    p = max(0, min(100, int(percent)))
    filled = p // 10
    empty = 10 - filled
    return "▓" * filled + "░" * empty + f" {p}%"


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

    await callback.answer("⏳ شروع پاک‌سازی...")

    progress_msg = None
    try:
        progress_msg = await callback.message.answer(
            f"🗑 پاک‌سازی صف...\n{_progress_bar(0)}"
        )
    except Exception:
        pass

    def _set_progress(pct: int, extra: str = ""):
        async def _do():
            if not progress_msg:
                return
            text = f"🗑 پاک‌سازی صف...\n{_progress_bar(pct)}"
            if extra:
                text += f"\n{extra}"
            try:
                await progress_msg.edit_text(text)
            except Exception:
                pass
        return _do()

    await _set_progress(10, "در حال خواندن صف...")

    try:
        user_ids = await asyncio.to_thread(db.clear_pending_messages)
    except Exception:
        logger.exception("CLEAR PENDING ERROR")
        await _set_progress(0, "❌ خطا در پاک‌سازی دیتابیس")
        await callback.message.answer(GENERIC_ERROR)
        return

    await _set_progress(20, "صف از دیتابیس پاک شد.")

    if not user_ids:
        await _set_progress(100, "صف از قبل خالی بود.")
        try:
            await callback.message.edit_text(
                "📥 فعلاً پیام در انتظاری وجود ندارد.",
                reply_markup=None,
            )
        except Exception:
            pass
        await callback.message.answer(
            "📥 صف از قبل خالی بود.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return

    notification_text = (
        "⚠️ پیام شما از صف بررسی پاک شد.\n\n"
        "این پیام بررسی نخواهد شد.\n"
        "اگر هنوز می‌خواهید پیام‌تان بررسی شود، "
        "لطفاً آن را دوباره ارسال کنید."
    )

    notified = 0
    failed = 0
    total = len(user_ids)
    last_pct_shown = 20

    for i, target_user_id in enumerate(user_ids, 1):
        try:
            await bot.send_message(
                chat_id=target_user_id,
                text=notification_text,
            )
            notified += 1
        except Exception:
            failed += 1
            logger.exception(
                "CLEAR QUEUE NOTIFICATION ERROR | user_id=%s",
                target_user_id,
            )

        # پیشرفت ۲۰٪ تا ۹۰٪ برای اطلاع‌رسانی
        pct = 20 + int(70 * i / max(total, 1))
        # فقط هر ۱۰٪ یک‌بار آپدیت
        step = (pct // 10) * 10
        if step > last_pct_shown:
            last_pct_shown = step
            await _set_progress(
                step,
                f"اطلاع‌رسانی به کاربران... ({i}/{total})",
            )

        await asyncio.sleep(0.05)

    await _set_progress(100, "تمام شد.")

    result_text = (
        "🗑 صف پیام‌های در انتظار پاک‌سازی شد.\n\n"
        f"{_progress_bar(100)}\n\n"
        f"📨 کاربران اطلاع‌رسانی‌شده: {notified}"
    )

    if failed:
        result_text += f"\n⚠️ اطلاع‌رسانی ناموفق: {failed}"

    try:
        if progress_msg:
            await progress_msg.edit_text(result_text)
        else:
            await callback.message.answer(result_text)
    except Exception:
        await callback.message.answer(result_text)

    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass

    await callback.message.answer(
        "پنل مالک:",
        reply_markup=owner_keyboard(db.is_bot_enabled()),
    )


@router.callback_query(
    F.data.startswith("approve:")
)
async def approve_callback(
    callback: CallbackQuery,
    bot: Bot,
):

    try:

        message_id = int(
            callback.data.split(":")[1]
        )

    except Exception:

        await callback.answer()
        return

    # پاسخ فوری برای حس سرعت و جلوگیری از دوباره‌کلیک
    if message_id in _processing_message_ids:
        await callback.answer("در حال پردازش...", show_alert=False)
        return

    row = db.get_message(
        message_id
    )

    if not row:

        await callback.answer(
            "پیام پیدا نشد.",
            show_alert=True,
        )

        return

    if row["status"] not in ("pending", "queued", "processing"):

        await callback.answer(
            "این پیام قبلاً بررسی شده.",
            show_alert=True,
        )

        return

    if not await can_review(
        callback.from_user.id,
        row,
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    _processing_message_ids.add(message_id)
    try:
        await callback.answer("⏳ در حال ارسال...")
    except Exception:
        pass

    try:

        # اگر در صف بوده، برای claim به pending برگردان
        if row["status"] == "queued":
            try:
                await db_execute(
                    """
                    UPDATE messages
                    SET status = 'pending'
                    WHERE id = ? AND status = 'queued'
                    """,
                    (message_id,),
                )
                await db_commit()
            except Exception:
                logger.exception(
                    "QUEUE TO PENDING ERROR | message_id=%s",
                    message_id,
                )

        if not db.claim_message(
            message_id
        ):

            try:
                await callback.message.edit_text(
                    "این پیام قبلاً بررسی شده.",
                    reply_markup=None,
                )
            except Exception:
                pass
            return

        # کانال بر اساس channel_key پیام
        try:
            msg_ch = row["channel_key"]
        except Exception:
            msg_ch = None
        channel_id = channel_id_for_key(msg_ch)

        try:
            logger.info(
                "Publishing message #%s to channel %s",
                message_id,
                channel_id,
            )
            sent = await bot.send_message(
                chat_id=channel_id,
                text=row["content"],
                entities=get_message_entities(row),
            )
        except Exception as e:
            logger.exception(
                "CHANNEL PUBLISH ERROR | message_id=%s | channel_id=%s | error=%s",
                message_id,
                channel_id,
                e,
            )
            db.restore_pending(message_id)
            error_text = str(e).strip() or "خطای نامشخص Telegram"
            try:
                await callback.message.edit_text(
                    f"❌ انتشار ناموفق:\n{error_text[:180]}",
                    reply_markup=None,
                )
            except Exception:
                pass
            return

        db.set_channel_message_id(message_id, sent.message_id)
        db.set_message_status(message_id, "approved")

        try:
            await callback.message.edit_text(
                "🟢 ارسال شد",
                reply_markup=None,
            )
        except Exception:
            pass

        await edit_original_admin_message(
            bot,
            row,
            "🟢 ارسال شد",
        )

        # اعلان به کاربر + لینک پست کانال
        try:
            post_link = await build_channel_post_link(
                bot,
                channel_id,
                sent.message_id,
            )
            user_text = "✅ پیام شما تأیید و در کانال منتشر شد."
            if post_link:
                user_text += f"\n\n🔗 مشاهده در کانال:\n{post_link}"
            await bot.send_message(
                chat_id=row["user_id"],
                text=user_text,
            )
        except Exception:
            logger.exception(
                "USER PUBLISH NOTIFY ERROR | message_id=%s | user_id=%s",
                message_id,
                row["user_id"],
            )
    finally:
        _processing_message_ids.discard(message_id)


# =========================================================
# REJECT
# =========================================================

@router.callback_query(
    F.data.startswith("reject:")
)
async def reject_callback(
    callback: CallbackQuery,
):

    try:

        message_id = int(
            callback.data.split(":")[1]
        )

    except Exception:

        await callback.answer()
        return

    row = db.get_message(
        message_id
    )

    if not row:

        await callback.answer(
            "پیام پیدا نشد.",
            show_alert=True,
        )

        return

    if row["status"] not in ("pending", "queued", "processing"):

        await callback.answer(
            "این پیام قبلاً بررسی شده.",
            show_alert=True,
        )

        return

    if not await can_review(
        callback.from_user.id,
        row,
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    await callback.answer()

    await callback.message.edit_reply_markup(
        reply_markup=reject_keyboard(
            message_id
        )
    )


@router.callback_query(
    F.data.startswith("reject_reason:")
)
async def reject_reason_callback(
    callback: CallbackQuery,
    bot: Bot,
):

    parts = callback.data.split(
        ":",
        2,
    )

    if len(parts) != 3:

        await callback.answer()
        return

    try:

        message_id = int(
            parts[1]
        )

    except Exception:

        await callback.answer()
        return

    reason = ADMIN_REJECT_REASONS.get(
        parts[2],
        "رد شده",
    )

    row = db.get_message(
        message_id
    )

    if not row:

        await callback.answer(
            "پیام پیدا نشد.",
            show_alert=True,
        )

        return

    if row["status"] not in ("pending", "queued", "processing"):

        await callback.answer(
            "این پیام قبلاً بررسی شده.",
            show_alert=True,
        )

        return

    if not await can_review(
        callback.from_user.id,
        row,
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    if row["status"] == "queued":
        try:
            await db_execute(
                """
                UPDATE messages
                SET status = 'pending'
                WHERE id = ? AND status = 'queued'
                """,
                (message_id,),
            )
            await db_commit()
        except Exception:
            logger.exception(
                "QUEUE TO PENDING REJECT ERROR | message_id=%s",
                message_id,
            )

    if not db.claim_message(
        message_id
    ):

        await callback.answer(
            "این پیام قبلاً بررسی شده.",
            show_alert=True,
        )

        return

    db.set_message_status(
        message_id,
        "rejected",
        reason,
    )

    # ثبت ردکننده برای منطق ضدتکرار (فقط رد مالک اجازه ارسال مجدد می‌دهد)
    try:
        await db_execute(
            "UPDATE messages SET rejected_by = ? WHERE id = ?",
            (callback.from_user.id, message_id),
        )
        await db_commit()
    except Exception:
        logger.exception(
            "SET REJECTED_BY ERROR | message_id=%s", message_id
        )

    await callback.answer(
        "پیام رد شد."
    )

    text = (
        "🔴 رد شد\n\n"
        f"دلیل: {reason}"
    )

    await callback.message.edit_text(
        text,
        reply_markup=None,
    )

    await edit_original_admin_message(
        bot,
        row,
        text,
    )

    # اطلاع‌رسانی رد به کاربر با دلیل
    try:
        await bot.send_message(
            chat_id=row["user_id"],
            text=(
                "🔴 پیام شما رد شد.\n\n"
                f"دلیل: {reason}\n\n"
                "می‌توانید با رعایت قوانین دوباره ارسال کنید."
            ),
        )
    except Exception:
        logger.exception(
            "USER REJECT NOTIFY ERROR | message_id=%s | user_id=%s",
            message_id,
            row["user_id"],
        )


# =========================================================
# ADMIN
# =========================================================

@router.message(
    F.text == "⏰ شیفت من",
    F.chat.type == "private",
)
async def admin_current_shift(
    message: Message,
):

    user_id = message.from_user.id

    if not db.get_admin(user_id):
        return

    shifts = db.get_admin_today_shifts(
        user_id,
        today_string(),
    )

    if not shifts:

        await message.answer(
            "⏰ امروز شیفتی برای شما ثبت نشده.",
            reply_markup=admin_keyboard(),
        )

        return

    lines = [
        "⏰ شیفت‌های امروز شما\n"
    ]

    for shift in shifts:

        lines.append(
            f"⏰ {shift['start_time']} تا "
            f"{shift['end_time']}"
        )

    await message.answer(
        "\n".join(lines),
        reply_markup=admin_keyboard(),
    )


# برنامه من حذف شد — فقط «شیفت من» در پنل ادمین باقی مانده


@router.message(
    F.text == "📊 عملکرد من",
    F.chat.type == "private",
)
async def admin_stats(
    message: Message,
):

    user_id = message.from_user.id

    if not db.get_admin(user_id):
        return

    # محاسبه مستقیم از دیتابیس (بدون وابستگی به متد ناقص)
    row = db.conn.execute(
        """
        SELECT
            COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved,
            COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected,
            COUNT(CASE WHEN status IN ('approved','rejected') THEN 1 END) AS reviewed,
            AVG(
                CASE
                    WHEN status IN ('approved','rejected')
                     AND reviewed_at IS NOT NULL
                     AND submitted_at IS NOT NULL
                    THEN (
                        CAST(strftime('%s', reviewed_at) AS REAL)
                        - CAST(strftime('%s', submitted_at) AS REAL)
                    )
                END
            ) AS avg_seconds
        FROM messages
        WHERE admin_id = ?
        """,
        (user_id,),
    ).fetchone()

    approved = int(row["approved"] or 0) if row else 0
    rejected = int(row["rejected"] or 0) if row else 0
    reviewed = int(row["reviewed"] or 0) if row else 0
    avg_seconds = float(row["avg_seconds"] or 0) if row else 0.0
    avg_minutes = (avg_seconds / 60.0) if reviewed else 0.0

    await message.answer(
        (
            "📊 عملکرد من\n\n"
            f"📨 بررسی‌شده: {reviewed}\n"
            f"🟢 تأییدشده: {approved}\n"
            f"🔴 ردشده: {rejected}\n"
            f"⏱ میانگین بررسی: {avg_minutes:.1f} دقیقه"
        ),
        reply_markup=admin_keyboard(),
    )


# =========================================================
# ADMIN ADD
# =========================================================

@router.message(
    F.text == "👥 ادمین‌ها",
    F.chat.type == "private",
)
async def owner_admins(
    message: Message,
    bot: Bot,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    await message.answer(
        "👥 ادمین‌های کدام کانال را می‌خواهی ببینی؟",
        reply_markup=channels_keyboard("admins_ch"),
    )


@router.callback_query(
    F.data.startswith("admins_ch:")
)
async def owner_admins_channel_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    key = callback.data.split(":", 1)[1]

    # برگشت به منوی ۳ کانال
    if key == "back":
        await callback.answer()
        try:
            await callback.message.edit_text(
                "👥 ادمین‌های کدام کانال را می‌خواهی ببینی؟",
                reply_markup=channels_keyboard("admins_ch"),
            )
        except Exception:
            await callback.message.answer(
                "👥 ادمین‌های کدام کانال را می‌خواهی ببینی؟",
                reply_markup=channels_keyboard("admins_ch"),
            )
        return

    if key not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return

    await callback.answer()
    title = CHANNELS[key]["title"]

    # ادمین‌های همان کانال (پشتیبانی از چندکاناله با channel_key جداشده با کاما)
    try:
        if key == DEFAULT_CHANNEL_KEY:
            admins = db.conn.execute(
                """
                SELECT *
                FROM admins
                WHERE active = 1
                  AND (
                        channel_key = ?
                        OR channel_key IS NULL
                        OR channel_key = ''
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                      )
                ORDER BY user_id
                """,
                (key, key + ",%", "%," + key, "%," + key + ",%"),
            ).fetchall()
        else:
            admins = db.conn.execute(
                """
                SELECT *
                FROM admins
                WHERE active = 1
                  AND (
                        channel_key = ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                      )
                ORDER BY user_id
                """,
                (key, key + ",%", "%," + key, "%," + key + ",%"),
            ).fetchall()
    except Exception:
        logger.exception("OWNER ADMINS LIST ERROR | channel=%s", key)
        admins = []

    lines = [f"👥 ادمین‌های «{title}»\n"]

    if not admins:
        lines.append("هیچ ادمینی برای این کانال ثبت نشده.")
    else:
        for admin in admins:
            mention = await mention_user(
                bot,
                admin["user_id"],
                admin["name"],
            )
            lines.append(f"• {mention}")

    buttons = [
        [
            InlineKeyboardButton(
                text="➕ افزودن ادمین",
                callback_data=f"admin:add:{key}",
            )
        ],
        [
            InlineKeyboardButton(
                text="🗑 حذف ادمین",
                callback_data=f"admin:delete:{key}",
            )
        ],
        [
            InlineKeyboardButton(
                text="↩️ برگشت به انتخاب کانال",
                callback_data="admins_ch:back",
            )
        ],
    ]

    try:
        await callback.message.edit_text(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
        )
    except Exception:
        await callback.message.answer(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
        )


@router.callback_query(
    F.data.regexp(r"^admin:delete(?::[a-z_]+)?$")
)
async def owner_delete_admin_start(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    # فقط admin:delete یا admin:delete:channel_key
    parts = callback.data.split(":")
    ch_key = parts[2] if len(parts) >= 3 else DEFAULT_CHANNEL_KEY
    if ch_key not in CHANNELS:
        ch_key = DEFAULT_CHANNEL_KEY

    try:
        if ch_key == DEFAULT_CHANNEL_KEY:
            admins = db.conn.execute(
                """
                SELECT * FROM admins
                WHERE active = 1
                  AND (
                        channel_key = ?
                        OR channel_key IS NULL
                        OR channel_key = ''
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                      )
                ORDER BY user_id
                """,
                (ch_key, ch_key + ",%", "%," + ch_key, "%," + ch_key + ",%"),
            ).fetchall()
        else:
            admins = db.conn.execute(
                """
                SELECT * FROM admins
                WHERE active = 1
                  AND (
                        channel_key = ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                        OR channel_key LIKE ?
                      )
                ORDER BY user_id
                """,
                (ch_key, ch_key + ",%", "%," + ch_key, "%," + ch_key + ",%"),
            ).fetchall()
    except Exception:
        admins = db.get_admins()

    if not admins:
        await callback.answer(
            "⚠️ هیچ ادمینی برای این کانال ثبت نشده است.",
            show_alert=True,
        )
        return

    buttons = []
    for admin in admins:
        name = admin["name"] or str(admin["user_id"])
        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"🗑 {name}",
                    callback_data=f"admin:delete_select:{admin['user_id']}",
                )
            ]
        )
    buttons.append(
        [
            InlineKeyboardButton(
                text="❌ انصراف",
                callback_data="admin:delete_cancel",
            )
        ]
    )

    await callback.answer()
    title = CHANNELS[ch_key]["title"]
    await callback.message.answer(
        f"🗑 <b>حذف ادمین — {title}</b>\n\n"
        "ادمینی که می‌خواهی حذف شود را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )


@router.callback_query(
    F.data.startswith("admin:delete_select:")
)
async def owner_delete_admin_select(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    try:
        admin_id = int(callback.data.split(":")[-1])
    except ValueError:
        await callback.answer("❌ ادمین نامعتبر است.", show_alert=True)
        return

    admin = db.get_admin(admin_id)

    if not admin:
        await callback.answer(
            "⚠️ این ادمین وجود ندارد.",
            show_alert=True,
        )
        return

    name = admin["name"] or str(admin_id)

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(
                text="✅ بله، حذف شود",
                callback_data=f"admin:delete_confirm:{admin_id}",
            )],
            [InlineKeyboardButton(
                text="❌ انصراف",
                callback_data="admin:delete_cancel",
            )],
        ]
    )

    await callback.answer()

    await callback.message.answer(
        "⚠️ <b>تأیید حذف ادمین</b>\n\n"
        f"👤 ادمین: <b>{name}</b>\n"
        f"🆔 <code>{admin_id}</code>\n\n"
        "آیا مطمئنی که می‌خواهی این ادمین حذف شود؟",
        parse_mode=ParseMode.HTML,
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data.startswith("admin:delete_confirm:")
)
async def owner_delete_admin_confirm(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )
        return

    try:
        admin_id = int(callback.data.split(":")[-1])
    except ValueError:
        await callback.answer(
            "❌ ادمین نامعتبر است.",
            show_alert=True,
        )
        return

    admin = db.get_admin(admin_id)

    if not admin:
        await callback.answer(
            "⚠️ این ادمین قبلاً حذف شده است.",
            show_alert=True,
        )
        return

    name = admin["name"] or str(admin_id)

    try:
        db.delete_admin(admin_id)
    except Exception:
        logger.exception(
            "ADMIN DELETE ERROR | admin_id=%s",
            admin_id,
        )

        await callback.answer(
            "❌ حذف ادمین انجام نشد؛ رکوردهای وابسته وجود دارد.",
            show_alert=True,
        )
        return

    await callback.answer(
        "✅ ادمین حذف شد.",
        show_alert=True,
    )

    await callback.message.answer(
        "✅ <b>ادمین با موفقیت حذف شد.</b>\n\n"
        f"👤 {name}\n"
        f"🆔 <code>{admin_id}</code>",
        parse_mode=ParseMode.HTML,
    )


@router.callback_query(
    F.data == "admin:delete_cancel"
)
async def owner_delete_admin_cancel(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )
        return

    await callback.answer("❌ عملیات لغو شد.")

    await callback.message.answer(
        "عملیات حذف ادمین لغو شد."
    )


@router.callback_query(
    F.data.startswith("admin:add")
)
async def owner_add_admin_start(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    parts = callback.data.split(":")
    ch_key = parts[2] if len(parts) >= 3 else DEFAULT_CHANNEL_KEY
    if ch_key not in CHANNELS:
        ch_key = DEFAULT_CHANNEL_KEY

    await callback.answer()

    set_state(
        callback.from_user.id,
        "add_admin",
        channel_key=ch_key,
    )

    title = CHANNELS[ch_key]["title"]
    await callback.message.answer(
        (
            f"➕ افزودن ادمین برای «{title}»\n\n"
            "آیدی عددی یا username را بفرست.\n\n"
            "می‌توانی چند آیدی عددی را یکجا بفرستی "
            "(با فاصله، ویرگول یا خط جدید جدا کن).\n\n"
            "مثال تکی:\n"
            "123456789\n"
            "@sixiren\n\n"
            "مثال دسته‌جمعی:\n"
            "123456789 987654321 111222333\n"
            "یا\n"
            "123456789,987654321,111222333\n\n"
            "برای username، کاربر باید قبلاً ربات را Start کرده باشد."
        ),
        reply_markup=back_keyboard(),
    )


# =========================================================
# OWNER SHIFTS
# =========================================================

@router.message(
    F.text == "⏰ شیفت‌ها",
    F.chat.type == "private",
)
async def owner_shifts(
    message: Message,
    bot: Bot,
):

    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return

    await message.answer(
        "⏰ شیفت‌های کدام کانال را می‌خواهی ببینی؟",
        reply_markup=channels_keyboard("shifts_ch"),
    )


@router.callback_query(
    F.data.startswith("shifts_ch:")
)
async def owner_shifts_channel_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    key = callback.data.split(":", 1)[1]
    if key == "back":
        await callback.answer()
        try:
            await callback.message.edit_text(
                "⏰ شیفت‌های کدام کانال را می‌خواهی ببینی؟",
                reply_markup=channels_keyboard("shifts_ch"),
            )
        except Exception:
            await callback.message.answer(
                "⏰ شیفت‌های کدام کانال را می‌خواهی ببینی؟",
                reply_markup=channels_keyboard("shifts_ch"),
            )
        return

    if key not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return

    await callback.answer()
    title = CHANNELS[key]["title"]

    try:
        shifts = await asyncio.to_thread(db.get_all_shifts)
    except Exception:
        logger.exception("OWNER SHIFTS LOAD ERROR")
        await callback.message.answer(GENERIC_ERROR)
        return

    today = today_string()
    lines = [f"⏰ مدیریت شیفت‌ها — «{title}»\n"]
    buttons = []
    shown = 0

    for shift in shifts:
        # فیلتر کانال
        try:
            sk = shift["channel_key"]
        except Exception:
            sk = None
        sk = sk or DEFAULT_CHANNEL_KEY
        if sk != key:
            continue

        if not shift["permanent"]:
            specific = shift["specific_date"] or ""
            if specific and specific < today:
                continue

        admin_name = (
            shift["admin_name"]
            or await get_profile_name(bot, shift["admin_id"])
        )

        date_text = (
            "🔁 دائمی"
            if shift["permanent"]
            else f"📅 {shift['specific_date']}"
        )

        lines.append("────────────")
        lines.append(f"🆔 شیفت #{shift['id']}")
        lines.append(f"{date_text}")
        lines.append(f"👤 ادمین: {escape(admin_name)}")
        lines.append(f"⏰ ساعت: {shift['start_time']} تا {shift['end_time']}")
        lines.append("")

        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"🗑 حذف #{shift['id']}",
                    callback_data=f"delete_shift:{shift['id']}",
                )
            ]
        )
        shown += 1

    if shown == 0:
        lines.append("هیچ شیفت فعالی برای این کانال ثبت نشده.")

    buttons.append(
        [
            InlineKeyboardButton(
                text="➕ ایجاد شیفت",
                callback_data=f"shift:add:{key}",
            )
        ]
    )
    buttons.append(
        [
            InlineKeyboardButton(
                text="↩️ برگشت به انتخاب کانال",
                callback_data="shifts_ch:back",
            )
        ]
    )

    try:
        await callback.message.edit_text(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
        )
    except Exception:
        await callback.message.answer(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
        )


@router.callback_query(
    F.data.startswith("delete_shift:")
)
async def delete_shift_callback(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    try:

        shift_id = int(
            callback.data.split(":")[1]
        )

    except Exception:

        await callback.answer()
        return

    shift = db.get_shift(
        shift_id
    )

    if not shift:

        await callback.answer(
            "شیفت پیدا نشد.",
            show_alert=True,
        )

        return

    db.delete_shift(
        shift_id
    )

    await callback.answer(
        "شیفت حذف شد."
    )

    await callback.message.answer(
        f"✅ شیفت #{shift_id} حذف شد."
    )


@router.callback_query(
    F.data.startswith("shift:add")
)
async def shift_add_start(
    callback: CallbackQuery,
):

    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )
        return

    parts = callback.data.split(":")
    ch_key = parts[2] if len(parts) >= 3 else DEFAULT_CHANNEL_KEY
    if ch_key not in CHANNELS:
        ch_key = DEFAULT_CHANNEL_KEY

    set_state(
        callback.from_user.id,
        "create_shift_pre",
        channel_key=ch_key,
    )

    await callback.answer()

    title = CHANNELS[ch_key]["title"]
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🔁 دائمی",
                    callback_data="shift_type:permanent",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📅 تاریخ مشخص",
                    callback_data="shift_type:date",
                )
            ],
        ]
    )

    await callback.message.answer(
        f"⏰ نوع شیفت برای «{title}» را انتخاب کن.",
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data.startswith("shift_type:")
)
async def shift_type_callback(
    callback: CallbackQuery,
    bot: Bot,
):

    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )
        return

    shift_type = callback.data.split(":", 1)[1]

    # کانال از state قبلی (اگر از منوی شیفت‌ها آمده)
    prev = get_state(callback.from_user.id) or {}
    ch_key = prev.get("channel_key") or DEFAULT_CHANNEL_KEY

    try:
        admins = await asyncio.to_thread(
            lambda: db.get_admins(active_only=True)
        )
    except Exception:
        admins = []

    # فقط ادمین‌های همان کانال (پشتیبانی چندکاناله)
    filtered = []
    for admin in admins or []:
        keys = admin_channel_keys(admin["user_id"])
        if ch_key in keys:
            filtered.append(admin)

    if not filtered:
        await callback.answer(
            "ابتدا یک ادمین برای این کانال اضافه کن.",
            show_alert=True,
        )
        return

    set_state(
        callback.from_user.id,
        "create_shift",
        permanent=(shift_type == "permanent"),
        channel_key=ch_key,
    )

    buttons = []

    for admin in filtered:

        name = (
            admin["name"]
            or await get_profile_name(
                bot,
                admin["user_id"],
            )
        )

        buttons.append(
            [
                InlineKeyboardButton(
                    text=name,
                    callback_data=(
                        f"select_shift_admin:"
                        f"{admin['user_id']}"
                    ),
                )
            ]
        )

    await callback.answer()

    await callback.message.answer(
        "👤 ادمین شیفت را انتخاب کن:",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        ),
    )


@router.callback_query(
    F.data.startswith("select_shift_admin:")
)
async def select_shift_admin(
    callback: CallbackQuery,
    bot: Bot,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    state = get_state(
        callback.from_user.id
    )

    if not state:

        await callback.answer()
        return

    admin_id = int(
        callback.data.split(":")[1]
    )

    admin = db.get_admin(
        admin_id
    )

    if not admin:

        await callback.answer(
            "ادمین پیدا نشد.",
            show_alert=True,
        )

        return

    state["admin_id"] = admin_id

    if state["permanent"]:

        state["step"] = "time"

        await callback.message.answer(
            (
                "⏰ بازه شیفت را بفرست.\n\n"
                "مثال:\n"
                "09:00-17:00\n\n"
                "شیفت شب هم مجاز است:\n"
                "23:00-02:00"
            ),
            reply_markup=back_keyboard(),
        )

    else:

        state["step"] = "date"

        await callback.message.answer(
            (
                "📅 تاریخ را بفرست.\n\n"
                "مثال:\n"
                "2026-09-08"
            ),
            reply_markup=back_keyboard(),
        )

    await callback.answer()


# =========================================================
# GROUP SHIFT HOURLY KEYBOARD
# =========================================================

def group_shift_hourly_keyboard(
    for_date: str | None = None,
    for_tomorrow: bool = False,
    channel_key: str | None = None,
):
    """
    بازه‌های یک‌ساعته بر اساس CHANNEL_HOURS هر کانال.
    """
    now = local_now()
    target_date = for_date or today_string()
    ch = channel_key or DEFAULT_CHANNEL_KEY
    existing_ranges = get_shift_ranges_for_date(target_date, channel_key=ch)

    buttons = []

    def make_button(start: str, end: str):
        blocked = any(
            _ranges_overlap(start, end, es, ee)
            for es, ee in existing_ranges
        )
        if blocked:
            return [
                _btn(
                    f"🔴 {start}–{end}",
                    f"group_shift_taken:{start}-{end}",
                    style="danger",
                )
            ]
        return [
            _btn(
                f"🟢 {start}–{end}",
                f"group_shift_time:{start}-{end}",
                style="success",
            )
        ]

    SHIFT_START_HOUR, SHIFT_END_HOUR = channel_hours(ch)

    if for_tomorrow:
        first_hour = SHIFT_START_HOUR
        for hour in range(first_hour, SHIFT_END_HOUR):
            start_time = f"{hour:02d}:00"
            end_hour = (hour + 1) % 24
            end_time = f"{end_hour:02d}:00"
            buttons.append(make_button(start_time, end_time))
    else:
        if now.hour < SHIFT_START_HOUR:
            first_hour = SHIFT_START_HOUR
            for hour in range(first_hour, SHIFT_END_HOUR):
                start_time = f"{hour:02d}:00"
                end_hour = (hour + 1) % 24
                end_time = f"{end_hour:02d}:00"
                buttons.append(make_button(start_time, end_time))
        else:
            if now.minute > 0 or now.second > 0 or now.microsecond > 0:
                next_hour = now.hour + 1
                if next_hour <= SHIFT_END_HOUR or (
                    SHIFT_END_HOUR == 24 and next_hour == 24
                ):
                    end = f"{next_hour % 24:02d}:00"
                    start_now = now.strftime("%H:%M")
                    if now.hour >= SHIFT_START_HOUR and now.hour < SHIFT_END_HOUR:
                        buttons.append(make_button(start_now, end))
                first_hour = now.hour + 1
            else:
                first_hour = now.hour

            first_hour = max(first_hour, SHIFT_START_HOUR)
            for hour in range(first_hour, SHIFT_END_HOUR):
                start_time = f"{hour:02d}:00"
                end_hour = (hour + 1) % 24
                end_time = f"{end_hour:02d}:00"
                buttons.append(make_button(start_time, end_time))

    if not buttons:
        buttons.append(
            [
                InlineKeyboardButton(
                    text="⛔ بازهٔ مجازی باقی نمانده",
                    callback_data="group_shift_taken:none",
                )
            ]
        )

    return InlineKeyboardMarkup(
        inline_keyboard=buttons
    )

# =========================================================
# GROUP SHIFT
# فقط امروز
# =========================================================

def valid_time(
    value: str,
) -> bool:

    return bool(
        re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d",
            value.strip(),
        )
    )


def parse_time_range(
    text: str,
):

    value = text.strip()

    value = re.sub(
        r"\s*(?:تا|-|–|—)\s*",
        "-",
        value,
    )

    parts = value.split("-")

    if len(parts) != 2:
        return None

    start = parts[0].strip()
    end = parts[1].strip()

    if not valid_time(start):
        return None

    if not valid_time(end):
        return None

    if start == end:
        return None

    return start, end


def valid_date(
    value: str,
) -> bool:

    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}",
        value.strip(),
    ):
        return False

    try:

        datetime.strptime(
            value.strip(),
            "%Y-%m-%d",
        )

        return True

    except ValueError:

        return False


@router.callback_query(
    F.data.startswith("group_shift:")
)
async def group_shift_callback(
    callback: CallbackQuery,
):

    if (
        not callback.message
        or not is_managed_group(callback.message.chat.id)
    ):

        await callback.answer(
            "این گروه مجاز نیست.",
            show_alert=True,
        )

        return

    group_id = callback.message.chat.id
    group_channel = channel_key_for_group(group_id)

    admin = db.get_admin(
        callback.from_user.id
    )

    if not admin:

        await callback.answer(
            "⛔ شما ادمین ربات نیستید.",
            show_alert=True,
        )

        return

    # ادمین فقط در گروه کانال‌هایی که عضو آن‌هاست
    admin_chs = admin_channel_keys(callback.from_user.id)
    if (
        group_channel
        and admin_chs
        and group_channel not in admin_chs
        and not db.is_owner(callback.from_user.id)
    ):
        await callback.answer(
            "⛔ این گروه مربوط به کانال شما نیست.",
            show_alert=True,
        )
        return

    if not user_started(
        callback.from_user.id
    ):

        await callback.answer(
            "ابتدا ربات را Start کن.",
            show_alert=True,
        )

        return

    mode = callback.data.split(
        ":",
        1,
    )[1]

    now = local_now()
    is_tomorrow = mode == "tomorrow"

    if is_tomorrow and now.hour < 22:
        await callback.answer(
            "⛔ انتخاب شیفت فردا فقط بین ۲۲ تا ۰۰ مجاز است.",
            show_alert=True,
        )
        return

    if mode not in {"today", "tomorrow"}:
        await callback.answer(
            "⛔ گزینه نامعتبر است.",
            show_alert=True,
        )
        return

    if is_tomorrow:
        target_date = (now.date() + timedelta(days=1)).strftime("%Y-%m-%d")
        title = "شیفت فردا"
    else:
        target_date = today_string()
        title = "شیفت امروز"

    ch_for_group = group_channel or DEFAULT_CHANNEL_KEY

    set_state(
        callback.from_user.id,
        "group_shift",
        chat_id=group_id,
        mode=mode,
        step="time",
        date=target_date,
        for_tomorrow=is_tomorrow,
        channel_key=ch_for_group,
    )

    logger.info(
        "GROUP SHIFT MENU | user_id=%s | group_id=%s | date=%s | mode=%s | ch=%s",
        callback.from_user.id,
        group_id,
        target_date,
        mode,
        ch_for_group,
    )

    await callback.answer()

    range_hint = channel_hours_label(ch_for_group)

    await callback.message.answer(
        (
            f"📅 <b>{title}</b>\n"
            f"📺 کانال: <b>{CHANNELS[ch_for_group]['title']}</b>\n"
            f"📆 تاریخ: <b>{target_date}</b>\n\n"
            f"⏰ یکی از بازه‌های یک‌ساعته ({range_hint}) را انتخاب کن:"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=group_shift_hourly_keyboard(
            for_date=target_date,
            for_tomorrow=is_tomorrow,
            channel_key=ch_for_group,
        ),
    )


# =========================================================
# GROUP SHIFT HOURLY CALLBACK
# =========================================================

@router.callback_query(
    F.data.startswith("group_shift_taken:")
)
async def group_shift_taken_callback(
    callback: CallbackQuery,
):
    await callback.answer(
        "⛔ این بازه قبلاً انتخاب شده و قابل انتخاب مجدد نیست.",
        show_alert=True,
    )


@router.callback_query(
    F.data.startswith("group_shift_cancel:")
)
async def group_shift_cancel_callback(
    callback: CallbackQuery,
):
    """لغو شیفت توسط خود ادمین (دکمه قرمز)."""
    user_id = callback.from_user.id
    try:
        shift_id = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer("❌ نامعتبر", show_alert=True)
        return

    try:
        shift = await asyncio.to_thread(db.get_shift, shift_id)
    except Exception:
        shift = None

    if not shift:
        await callback.answer("شیفت پیدا نشد.", show_alert=True)
        return

    if int(shift["admin_id"]) != int(user_id) and not db.is_owner(user_id):
        await callback.answer("⛔ فقط صاحب شیفت می‌تواند لغو کند.", show_alert=True)
        return

    try:
        await asyncio.to_thread(db.delete_shift, shift_id)
    except Exception:
        logger.exception("GROUP SHIFT CANCEL ERROR | shift_id=%s", shift_id)
        await callback.answer(GENERIC_ERROR, show_alert=True)
        return

    await callback.answer("✅ شیفت لغو شد.", show_alert=True)
    try:
        await callback.message.answer(
            f"✅ شیفت #{shift_id} "
            f"({shift['start_time']} تا {shift['end_time']}) لغو شد."
        )
    except Exception:
        pass
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass


@router.callback_query(
    F.data.startswith("group_shift_time:")
)
async def group_shift_hourly_callback(
    callback: CallbackQuery,
):

    user_id = callback.from_user.id

    try:

        logger.info(
            "GROUP SHIFT BUTTON CLICK | user_id=%s | data=%s",
            user_id,
            callback.data,
        )

        if not callback.message:

            logger.error(
                "GROUP SHIFT ERROR | callback.message is None | user_id=%s",
                user_id,
            )

            await callback.answer(
                "❌ پیام گروه پیدا نشد.",
                show_alert=True,
            )

            return

        group_id = callback.message.chat.id
        if not is_managed_group(group_id):

            logger.warning(
                "GROUP SHIFT WRONG GROUP | user_id=%s | chat_id=%s",
                user_id,
                group_id,
            )

            await callback.answer(
                "⛔ این گروه مجاز نیست.",
                show_alert=True,
            )

            return

        admin = db.get_admin(user_id)

        if not admin:

            logger.warning(
                "GROUP SHIFT NOT ADMIN | user_id=%s | group_id=%s",
                user_id,
                group_id,
            )

            await callback.answer(
                "⛔ شما به عنوان ادمین ثبت نشده‌اید.",
                show_alert=True,
            )

            return

        if not user_started(user_id):

            logger.warning(
                "GROUP SHIFT NOT STARTED | user_id=%s",
                user_id,
            )

            await callback.answer(
                "⚠️ ابتدا ربات را در پیوی Start کن.",
                show_alert=True,
            )

            return

        value = callback.data.split(
            ":",
            1,
        )[1]

        parsed = parse_time_range(value)

        if not parsed:

            logger.error(
                "GROUP SHIFT INVALID TIME | user_id=%s | value=%s",
                user_id,
                value,
            )

            await callback.answer(
                "❌ بازه زمانی نامعتبر است.",
                show_alert=True,
            )

            return

        start, end = parsed

        # تاریخ هدف از state (امروز یا فردا)
        state = get_state(user_id) or {}
        specific_date = state.get("date") or today_string()
        is_tomorrow = bool(state.get("for_tomorrow"))

        # فقط بازه ۱۲–۲۴ مجاز
        ch_key = (
            (get_state(user_id) or {}).get("channel_key")
            or channel_key_for_group(callback.message.chat.id if callback.message else 0)
            or DEFAULT_CHANNEL_KEY
        )
        try:
            sh = int(start.split(":")[0])
        except Exception:
            sh = -1
        # فقط صدام بزن: محدودیت ۱۲–۲۴
        start_h, end_h = channel_hours(ch_key)
        if not (start_h == 0 and end_h == 24):
            if sh < start_h or (end_h < 24 and sh >= end_h):
                await callback.answer(
                    f"⛔ در این کانال فقط بازه‌های {channel_hours_label(ch_key)} مجاز است.",
                    show_alert=True,
                )
                return

        # جلوگیری از شیفت تکراری یا هم‌پوشان در همان کانال
        taken = await asyncio.to_thread(
            is_shift_slot_taken, start, end, specific_date, ch_key
        )
        if taken:
            logger.warning(
                "GROUP SHIFT OVERLAP/DUPLICATE | user_id=%s | start=%s | end=%s | date=%s | ch=%s",
                user_id,
                start,
                end,
                specific_date,
                ch_key,
            )
            await callback.answer(
                "⛔ این بازه با شیفت ثبت‌شدهٔ دیگری هم‌پوشانی دارد و قابل انتخاب نیست.",
                show_alert=True,
            )
            return

        # جلوگیری از هم‌پوشانی شیفت‌های خود ادمین در همه کانال‌ها
        self_overlap = await asyncio.to_thread(
            admin_has_overlapping_shift, user_id, start, end, specific_date
        )
        if self_overlap:
            logger.warning(
                "GROUP SHIFT ADMIN SELF-OVERLAP | user_id=%s | start=%s | end=%s | date=%s",
                user_id,
                start,
                end,
                specific_date,
            )
            await callback.answer(
                "⛔ شما قبلاً شیفتی در این بازه (یا هم‌پوشان با آن) در یکی از کانال‌ها دارید.\n"
                "انتخاب دو شیفت یکسان یا هم‌پوشان برای یک ادمین مجاز نیست.",
                show_alert=True,
            )
            return

        logger.info(
            "GROUP SHIFT LIMIT CHECK | user_id=%s | start=%s | end=%s | date=%s",
            user_id,
            start,
            end,
            specific_date,
        )

        try:
            allowed, reason = await asyncio.to_thread(
                lambda: db.check_admin_shift_limit(
                    admin_id=user_id,
                    start_time=start,
                    end_time=end,
                    specific_date=specific_date,
                )
            )
        except Exception:
            logger.exception("GROUP SHIFT LIMIT CHECK ERROR")
            await callback.answer(GENERIC_ERROR, show_alert=True)
            return

        if not allowed:

            logger.warning(
                "GROUP SHIFT LIMIT REJECTED | user_id=%s | start=%s | end=%s | date=%s | reason=%s",
                user_id,
                start,
                end,
                specific_date,
                reason,
            )

            await callback.answer(
                reason,
                show_alert=True,
            )

            return

        logger.info(
            "GROUP SHIFT CREATE START | user_id=%s | start=%s | end=%s | date=%s",
            user_id,
            start,
            end,
            specific_date,
        )

        try:

            shift_id = await asyncio.to_thread(
                lambda: db.create_shift(
                    start_time=start,
                    end_time=end,
                    admin_id=user_id,
                    permanent=False,
                    specific_date=specific_date,
                )
            )
            # اتصال شیفت به کانال گروه
            ch = channel_key_for_group(group_id) or admin_channel_key(user_id) or DEFAULT_CHANNEL_KEY
            try:
                await db_execute(
                    "UPDATE shifts SET channel_key = ? WHERE id = ?",
                    (ch, shift_id),
                )
                await db_commit()
            except Exception:
                logger.exception("SET SHIFT CHANNEL ERROR | shift_id=%s", shift_id)

        except Exception:

            logger.exception(
                "GROUP SHIFT DATABASE ERROR | user_id=%s | start=%s | end=%s | date=%s",
                user_id,
                start,
                end,
                specific_date,
            )

            await callback.answer(
                GENERIC_ERROR,
                show_alert=True,
            )

            await callback.message.answer(
                "❌ ثبت شیفت انجام نشد.\n"
                "لطفاً چند ثانیه صبر کنید و دوباره امتحان کنید."
            )

            return

        clear_state(user_id)

        admin_row = db.get_admin(user_id)
        admin_name = (
            (admin_row["name"] if admin_row else None)
            or callback.from_user.full_name
            or str(user_id)
        )

        logger.info(
            "GROUP SHIFT SUCCESS | shift_id=%s | user_id=%s | group_id=%s | date=%s | start=%s | end=%s",
            shift_id,
            user_id,
            group_id,
            specific_date,
            start,
            end,
        )

        await callback.answer(
            "✅ شیفت ثبت شد.",
            show_alert=True,
        )

        # همان لحظه پنل ساعت‌ها را قرمز/به‌روز کن
        try:
            await callback.message.edit_reply_markup(
                reply_markup=group_shift_hourly_keyboard(
                    for_date=specific_date,
                    for_tomorrow=is_tomorrow,
                    channel_key=ch_key,
                )
            )
        except Exception:
            logger.exception("GROUP SHIFT REFRESH KEYBOARD ERROR")

        day_label = "فردا" if is_tomorrow else "امروز"
        await callback.message.answer(
            (
                "✅ <b>شیفت با موفقیت ثبت شد.</b>\n\n"
                f"👤 ادمین: <b>{escape(admin_name)}</b>\n"
                f"📅 تاریخ: <b>{specific_date}</b> ({day_label})\n"
                f"⏰ ساعت: <b>{start} تا {end}</b>"
            ),
            parse_mode=ParseMode.HTML,
        )

    except Exception:

        logger.exception(
            "GROUP SHIFT CALLBACK UNEXPECTED ERROR | user_id=%s | data=%s",
            user_id,
            getattr(callback, "data", None),
        )

        try:
            await callback.answer(
                "❌ یک خطای غیرمنتظره رخ داد. لاگ ثبت شد.",
                show_alert=True,
            )
        except Exception:
            pass


# =========================================================
# NOTIFICATIONS
# =========================================================

@router.message(
    F.text == "🔔 اعلان‌ها",
    F.chat.type == "private",
)
async def admin_notifications(
    message: Message,
):

    admin = db.get_admin(
        message.from_user.id
    )

    if not admin:
        return

    enabled = bool(
        admin["notifications_enabled"]
    )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=(
                        "🔴 خاموش کردن"
                        if enabled
                        else "🟢 روشن کردن"
                    ),
                    callback_data=(
                        "notif:off"
                        if enabled
                        else "notif:on"
                    ),
                )
            ]
        ]
    )

    await message.answer(
        (
            "🔔 اعلان‌های شروع شیفت\n\n"
            f"وضعیت فعلی: "
            f"{'🟢 فعال' if enabled else '🔴 غیرفعال'}"
        ),
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data.in_({
        "notif:on",
        "notif:off",
    })
)
async def notification_callback(
    callback: CallbackQuery,
):

    admin = db.get_admin(
        callback.from_user.id
    )

    if not admin:

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    enabled = (
        callback.data == "notif:on"
    )

    db.set_admin_notifications(
        callback.from_user.id,
        enabled,
    )

    await callback.answer()

    await callback.message.edit_text(
        (
            "🔔 اعلان‌های شروع شیفت\n\n"
            f"وضعیت جدید: "
            f"{'🟢 فعال' if enabled else '🔴 غیرفعال'}"
        )
    )


# =========================================================
# SHIFT REQUEST
# =========================================================

@router.message(
    F.text == "🔄 درخواست تغییر شیفت",
    F.chat.type == "private",
)
async def shift_request_start(
    message: Message,
):

    if not db.get_admin(
        message.from_user.id
    ):
        return

    set_state(
        message.from_user.id,
        "shift_request",
    )

    await message.answer(
        "🔄 توضیح درخواست تغییر شیفت را بنویس.",
        reply_markup=back_keyboard(),
    )


# =========================================================
# OWNER STATS MENU
# =========================================================

def owner_stats_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_btn("📊 آمار کل", "stats:overall", style="primary")],
            [_btn("📋 لاگ", "stats:log", style="primary")],
            [_btn("👤 آمار کاربران", "stats:users", style="primary")],
            [_btn("🛡 آمار ادمین‌ها", "stats:admins", style="primary")],
        ]
    )


def owner_system_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_btn("📢 کانال‌ها", "sys:channels", style="primary")],
            [_btn("⚙️ تنظیمات", "sys:settings", style="primary")],
            [_btn("🧪 تست سیستم", "sys:tests", style="primary")],
            [_btn("📤 ارسال به کانال‌ها", "sys:broadcast_menu", style="primary")],
        ]
    )


def owner_tests_keyboard():
    """تست‌های واحد — بدون تکرار با تست کانال‌های تنظیمات."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_btn("🔌 اتصال ربات", "test:bot", style="primary")],
            [_btn("📺 اتصال هر ۳ کانال", "test:all_channels", style="primary")],
            [_btn("📨 ارسال پیوی", "test:send", style="primary")],
            [_btn("📥 صف پیام‌ها", "test:queue", style="primary")],
            [_btn("⏰ شیفت فعال", "test:shift", style="primary")],
            [_btn("🗄 دیتابیس", "test:db", style="primary")],
            [_btn("🔙 بازگشت", "sys:menu", style="danger")],
        ]
    )


def _count_messages(where_sql: str = "", params: tuple = ()) -> dict:
    try:
        row = db.conn.execute(
            f"""
            SELECT
                COUNT(*) AS total,
                COUNT(CASE WHEN status IN ('pending','queued','processing') THEN 1 END) AS waiting,
                COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved,
                COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected
            FROM messages
            {where_sql}
            """,
            params,
        ).fetchone()
        return {
            "total": int(row["total"] or 0) if row else 0,
            "waiting": int(row["waiting"] or 0) if row else 0,
            "approved": int(row["approved"] or 0) if row else 0,
            "rejected": int(row["rejected"] or 0) if row else 0,
        }
    except Exception:
        logger.exception("COUNT MESSAGES ERROR | where=%s", where_sql)
        return {
            "total": 0,
            "waiting": 0,
            "approved": 0,
            "rejected": 0,
        }


def get_owner_pending_rows():
    """
    مالک باید هم pending و هم queued و processing را ببیند.
    """
    try:
        return db.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE status IN ('pending', 'queued', 'processing')
            ORDER BY
                CASE status
                    WHEN 'pending' THEN 0
                    WHEN 'processing' THEN 1
                    WHEN 'queued' THEN 2
                    ELSE 3
                END,
                id ASC
            """
        ).fetchall()
    except Exception:
        logger.exception("GET OWNER PENDING ERROR")
        try:
            return db.get_all_pending()
        except Exception:
            return []


@router.message(
    F.text == "👥 کاربران",
    F.chat.type == "private",
)
async def owner_users_panel(
    message: Message,
    bot: Bot,
):
    if not db.is_owner(message.from_user.id):
        return

    try:
        total = get_user_message_stats_count()
        today = today_string()

        try:
            active_today = db.conn.execute(
                """
                SELECT COUNT(DISTINCT user_id) AS c
                FROM messages
                WHERE submitted_at LIKE ?
                """,
                (f"{today}%",),
            ).fetchone()
        except Exception:
            active_today = {"c": 0}

        try:
            active_week = db.conn.execute(
                """
                SELECT COUNT(DISTINCT user_id) AS c
                FROM messages
                WHERE submitted_at >= datetime('now', '-7 days')
                """
            ).fetchone()
        except Exception:
            active_week = {"c": 0}

        top_rows = get_user_message_stats(limit=10, offset=0) or []

        lines = [
            "👥 <b>کاربران</b>\n",
            f"کل کاربران: <b>{total}</b>",
            f"فعال امروز: <b>{int((active_today['c'] if active_today else 0) or 0)}</b>",
            f"فعال این هفته: <b>{int((active_week['c'] if active_week else 0) or 0)}</b>\n",
            "🏆 <b>بیشترین ارسال</b>:",
        ]

        buttons = []
        if not top_rows:
            lines.append("هنوز پیامی ثبت نشده.")
        else:
            for i, row in enumerate(top_rows, 1):
                label = (
                    " ".join(
                        x for x in (row["first_name"], row["last_name"]) if x
                    ).strip()
                    or (
                        f"@{row['username']}"
                        if row["username"]
                        else str(row["user_id"])
                    )
                )
                lines.append(
                    f"{i}. {escape(label)} — {row['message_count']} پیام"
                    f"\n   <code>{row['user_id']}</code>"
                )
                # لینک مستقیم فقط اگر username عمومی باشد؛ وگرنه دکمه جزئیات
                uname = row["username"] if row["username"] else None
                if uname:
                    buttons.append(
                        [
                            InlineKeyboardButton(
                                text=f"{i}. @{uname}",
                                url=f"https://t.me/{uname}",
                            )
                        ]
                    )
                else:
                    buttons.append(
                        [
                            InlineKeyboardButton(
                                text=f"{i}. {label[:24]}",
                                callback_data=f"user_peek:{row['user_id']}",
                            )
                        ]
                    )

        await message.answer(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons)
            if buttons
            else owner_keyboard(db.is_bot_enabled()),
        )
    except Exception:
        logger.exception("OWNER USERS PANEL ERROR")
        await message.answer(
            "❌ خطا در بارگذاری آمار کاربران. لاگ ثبت شد.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )


@router.message(
    F.text == "📊 آمار و گزارش‌ها",
    F.chat.type == "private",
)
async def owner_stats_menu(
    message: Message,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    await message.answer(
        "📊 <b>آمار و گزارش‌ها</b>\n\nیکی از بخش‌ها را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=owner_stats_keyboard(),
    )


@router.callback_query(F.data.in_({"stats:today", "stats:overall"}))
async def stats_overall_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    try:
        overall = _count_messages()
        today = today_string()
        today_stats = _count_messages(
            "WHERE submitted_at LIKE ?",
            (f"{today}%",),
        )
        week_from = (local_now() - timedelta(days=7)).strftime("%Y-%m-%d")
        month_from = (local_now() - timedelta(days=30)).strftime("%Y-%m-%d")
        week_stats = _count_messages(
            "WHERE submitted_at >= ?",
            (week_from,),
        )
        month_stats = _count_messages(
            "WHERE submitted_at >= ?",
            (month_from,),
        )
        users_total = get_user_message_stats_count()
        try:
            admins_total = db.count_admins()
        except Exception:
            admins_total = 0

        text = (
            "📊 <b>داشبورد آماری</b>\n\n"
            f"📨 کل پیام‌ها: <b>{overall['total']}</b>\n"
            f"🟡 در انتظار: <b>{overall['waiting']}</b>\n"
            f"🟢 تأیید شده: <b>{overall['approved']}</b>\n"
            f"🔴 رد شده: <b>{overall['rejected']}</b>\n\n"
            f"👥 کاربران: <b>{users_total}</b>\n"
            f"👮 ادمین‌ها: <b>{admins_total}</b>\n\n"
            f"📅 <b>امروز</b> ({format_dt_fa(today)})\n"
            f"📨 جدید: {today_stats['total']} | "
            f"🟢 {today_stats['approved']} | "
            f"🔴 {today_stats['rejected']}\n\n"
            f"📅 <b>۷ روز اخیر</b>\n"
            f"📨 {week_stats['total']} | "
            f"🟢 {week_stats['approved']} | "
            f"🔴 {week_stats['rejected']}\n\n"
            f"📅 <b>۳۰ روز اخیر</b>\n"
            f"📨 {month_stats['total']} | "
            f"🟢 {month_stats['approved']} | "
            f"🔴 {month_stats['rejected']}"
        )
        # فقط دکمه بازگشت به منوی آمار — بدون دکمه‌های چسبیده شیشه‌ای
        back_kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [_btn("🔙 منوی آمار", "stats:menu", style="primary")]
            ]
        )
        await callback.message.answer(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=back_kb,
        )
    except Exception:
        logger.exception("STATS OVERALL ERROR")
        await callback.message.answer(GENERIC_ERROR)


@router.callback_query(F.data == "stats:menu")
async def stats_menu_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    await callback.message.answer(
        "📊 <b>آمار و گزارش‌ها</b>\n\nیکی از بخش‌ها را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=owner_stats_keyboard(),
    )


@router.callback_query(F.data == "stats:log")
async def stats_log_callback(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    # لاگ در لحظه
    class _Msg:
        pass
    # فراخوانی مستقیم
    from aiogram.types import Message as _Message  # noqa: F401
    # استفاده از owner_instant_log با message جعلی سخت است؛ مستقیم:
    uid = callback.from_user.id
    _register_log_recipient(uid)
    if uid in _log_in_progress:
        await callback.message.answer("⏳ لاگ در حال آماده‌سازی است.")
        return
    _log_in_progress.add(uid)
    try:
        await generate_and_send_log(bot, recipients=[uid], progress_to=uid)
    finally:
        _log_in_progress.discard(uid)


@router.callback_query(F.data == "stats:reports")
async def stats_reports_callback(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    # فیدبک کاربران + میانبر آمار
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    "📬 پیام‌های انتقاد/پیشنهاد",
                    "stats:feedback",
                    style="primary",
                )
            ],
            [
                InlineKeyboardButton(
                    text="👤 آمار پیام کاربران",
                    callback_data="stats:users",
                )
            ],
            [
                InlineKeyboardButton(
                    text="🛡 آمار ادمین‌ها",
                    callback_data="stats:admins",
                )
            ],
        ]
    )
    await callback.message.answer(
        "📁 <b>گزارش‌ها و پیام کاربران</b>\n\nیکی را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=kb,
    )


@router.callback_query(F.data == "stats:feedback")
async def stats_feedback_callback(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    # همان owner_view_feedback
    try:
        rows = await db_fetchall(
            """
            SELECT *
            FROM user_feedback
            WHERE status = 'open'
            ORDER BY id ASC
            LIMIT 30
            """
        )
    except Exception:
        logger.exception("STATS FEEDBACK ERROR")
        await callback.message.answer(GENERIC_ERROR)
        return
    if not rows:
        await callback.message.answer("📬 پیام باز از کاربران وجود ندارد.")
        return
    await callback.message.answer(f"📬 {len(rows)} پیام باز:")
    for row in rows:
        try:
            mention = await mention_user(bot, row["user_id"])
        except Exception:
            mention = str(row["user_id"])
        text = (
            f"#{row['id']} — {mention}\n"
            f"🕐 {escape(row['created_at'] or '')}\n\n"
            f"{escape(row['content'] or '')}"
        )
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="💬 پاسخ",
                        callback_data=f"fb_reply:{row['id']}",
                    ),
                    InlineKeyboardButton(
                        text="✅ بسته‌شد",
                        callback_data=f"fb_close:{row['id']}",
                    ),
                ]
            ]
        )
        try:
            await callback.message.answer(
                text, parse_mode=ParseMode.HTML, reply_markup=kb
            )
        except Exception:
            pass
        await asyncio.sleep(0.05)


@router.message(
    F.text == "⚙️ مدیریت سیستم",
    F.chat.type == "private",
)
async def owner_system_menu(message: Message):
    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return
    await message.answer(
        "⚙️ <b>مدیریت سیستم</b>\n\nیکی از بخش‌ها را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=owner_system_keyboard(),
    )


@router.callback_query(F.data == "sys:menu")
async def sys_menu_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    try:
        await callback.message.edit_text(
            "⚙️ <b>مدیریت سیستم</b>\n\nیکی از بخش‌ها را انتخاب کن:",
            parse_mode=ParseMode.HTML,
            reply_markup=owner_system_keyboard(),
        )
    except Exception:
        await callback.message.answer(
            "⚙️ مدیریت سیستم:",
            reply_markup=owner_system_keyboard(),
        )


@router.callback_query(F.data == "sys:channels")
async def sys_channels_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    await callback.message.answer(
        "📢 وضعیت کدام کانال را می‌خواهی ببینی؟",
        reply_markup=channels_keyboard("channel_ch"),
    )


@router.callback_query(F.data == "sys:settings")
async def sys_settings_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    group_id = configured_group_id()
    await callback.message.answer(
        (
            "⚙️ <b>تنظیمات قابل تغییر</b>\n\n"
            f"🌐 منطقه زمانی: <code>{TIMEZONE}</code>\n"
            f"👥 گروه شیفت: "
            f"{'تنظیم شده' if group_id else 'تنظیم نشده'}\n\n"
            "برای تغییر هر مورد روی دکمه بزن:"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_runtime_settings_keyboard(),
    )


@router.callback_query(F.data == "sys:broadcast_menu")
async def sys_broadcast_menu(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    rows = []
    for key, cfg in CHANNELS.items():
        rows.append(
            [
                _btn(
                    f"📤 {cfg['title']}",
                    f"sys:sendch:{key}",
                    style="primary",
                )
            ]
        )
    rows.append([_btn("🔙 بازگشت", "sys:menu", style="danger")])
    await callback.message.answer(
        "📤 ارسال مستقیم به کدام کانال؟",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


@router.callback_query(F.data.startswith("sys:sendch:"))
async def sys_send_channel_start(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    key = callback.data.split(":")[-1]
    if key not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return
    set_state(
        callback.from_user.id,
        "owner_send_channel",
        channel_key=key,
    )
    await callback.answer()
    title = CHANNELS[key]["title"]
    await callback.message.answer(
        f"📤 ارسال مستقیم به «{title}»\n\n"
        "متن پیام را بفرست.\n"
        "بعد از ارسال، در کانال منتشر می‌شود.",
        reply_markup=back_keyboard(),
    )


@router.callback_query(F.data == "sys:tests")
async def sys_tests_callback(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    try:
        await callback.message.edit_text(
            "🧪 <b>تست سیستم</b>\n\nیکی از تست‌ها را اجرا کن:",
            parse_mode=ParseMode.HTML,
            reply_markup=owner_tests_keyboard(),
        )
    except Exception:
        await callback.message.answer(
            "🧪 تست سیستم:",
            reply_markup=owner_tests_keyboard(),
        )


@router.callback_query(F.data.startswith("test:"))
async def owner_run_test(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    action = callback.data.split(":", 1)[1]
    await callback.answer("⏳ در حال تست...")

    results: list[str] = []

    try:
        if action == "bot":
            me = await bot.get_me()
            results.append(
                f"✅ اتصال ربات OK\n@{me.username} | id={me.id}"
            )

        elif action == "all_channels":
            for key, cfg in CHANNELS.items():
                try:
                    chat = await bot.get_chat(int(cfg["channel_id"]))
                    results.append(
                        f"✅ {cfg['title']}: OK "
                        f"({getattr(chat, 'title', '-')})"
                    )
                except Exception as e:
                    results.append(f"❌ {cfg['title']}: {str(e)[:100]}")

        elif action.startswith("channel:"):
            key = action.split(":", 1)[1]
            if key not in CHANNELS:
                results.append("❌ کانال نامعتبر")
            else:
                cfg = CHANNELS[key]
                try:
                    chat = await bot.get_chat(int(cfg["channel_id"]))
                    results.append(
                        f"✅ کانال «{cfg['title']}» در دسترس\n"
                        f"title={getattr(chat, 'title', '-')}"
                    )
                    try:
                        await bot.send_message(
                            int(cfg["channel_id"]),
                            "🧪 تست سیستم — این پیام را می‌توانید حذف کنید.",
                        )
                        results.append("✅ ارسال تست به کانال موفق")
                    except Exception as e:
                        results.append(f"❌ ارسال به کانال: {str(e)[:120]}")
                except Exception as e:
                    results.append(f"❌ دسترسی کانال: {str(e)[:120]}")

        elif action == "send":
            try:
                m = await bot.send_message(
                    callback.from_user.id,
                    "🧪 تست ارسال پیام به مالک — موفق",
                )
                results.append(f"✅ ارسال پیوی OK (msg_id={m.message_id})")
            except Exception as e:
                results.append(f"❌ ارسال پیوی: {str(e)[:120]}")

        elif action == "queue":
            try:
                n = count_pending_for_channel(DEFAULT_CHANNEL_KEY)
                total = 0
                for ck in channel_keys():
                    total += count_pending_for_channel(ck)
                results.append(
                    f"✅ خواندن صف OK\n"
                    f"صف کل کانال‌ها: {total}\n"
                    f"صف پیش‌فرض: {n}"
                )
            except Exception as e:
                results.append(f"❌ تست صف: {str(e)[:120]}")

        elif action == "shift":
            try:
                lines = ["✅ تست شیفت:"]
                for ck in channel_keys():
                    cur = await get_current_shift_safe_async(channel_key=ck)
                    title = CHANNELS[ck]["title"]
                    if cur:
                        s = cur[0]
                        lines.append(
                            f"• {title}: فعال — admin={s['admin_id']} "
                            f"{s['start_time']}-{s['end_time']}"
                        )
                    else:
                        lines.append(f"• {title}: بدون شیفت فعال")
                results.append("\n".join(lines))
            except Exception as e:
                results.append(f"❌ تست شیفت: {str(e)[:120]}")

        elif action == "db":
            try:
                row = await db_fetchone("SELECT COUNT(*) AS c FROM messages")
                users = await db_fetchone("SELECT COUNT(*) AS c FROM users")
                admins = await db_fetchone(
                    "SELECT COUNT(*) AS c FROM admins WHERE active = 1"
                )
                results.append(
                    "✅ دیتابیس OK\n"
                    f"messages={row['c'] if row else 0}\n"
                    f"users={users['c'] if users else 0}\n"
                    f"active_admins={admins['c'] if admins else 0}"
                )
            except Exception as e:
                results.append(f"❌ دیتابیس: {str(e)[:120]}")

        else:
            results.append("❌ تست ناشناخته")

    except Exception:
        logger.exception("OWNER TEST ERROR | %s", action)
        results.append("❌ خطای غیرمنتظره — لاگ ثبت شد")

    await callback.message.answer(
        "🧪 نتیجه تست\n\n" + "\n".join(results),
        reply_markup=owner_tests_keyboard(),
    )


USER_STATS_PAGE_SIZE = 50


@router.callback_query(
    F.data.startswith("stats:users")
)
async def stats_users(
    callback: CallbackQuery,
    bot: Bot,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    parts = callback.data.split(":")

    try:
        page = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        page = 0

    if page < 0:
        page = 0

    # جواب سریع به Telegram تا کوئری callback منقضی نشود؛
    # واکشی mention برای ۵۰ کاربر ممکن است چند ثانیه طول بکشد.
    await callback.answer()

    total = get_user_message_stats_count()

    rows = get_user_message_stats(
        limit=USER_STATS_PAGE_SIZE,
        offset=page * USER_STATS_PAGE_SIZE,
    )

    total_pages = max(
        1,
        (total + USER_STATS_PAGE_SIZE - 1) // USER_STATS_PAGE_SIZE,
    )

    lines = [
        f"👤 آمار پیام کاربران "
        f"(صفحه {page + 1} از {total_pages} — "
        f"{total} کاربر)\n",
        "برای دیدن جزئیات هر کاربر، روی نامش بزن:",
    ]

    if not rows:

        lines.append(
            "\nهنوز کاربری پیامی ارسال نکرده."
        )

    buttons = []

    for row in rows:

        label = (
            " ".join(
                x
                for x in (
                    row["first_name"],
                    row["last_name"],
                )
                if x
            ).strip()
            or (
                f"@{row['username']}"
                if row["username"]
                else str(row["user_id"])
            )
        )

        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"{label} — {row['message_count']} پیام",
                    callback_data=(
                        f"user_info:{row['user_id']}:{page}"
                    ),
                )
            ]
        )

    nav_row = []

    if page > 0:
        nav_row.append(
            InlineKeyboardButton(
                text="◀️ صفحه قبل",
                callback_data=f"stats:users:{page - 1}",
            )
        )

    if (page + 1) * USER_STATS_PAGE_SIZE < total:
        nav_row.append(
            InlineKeyboardButton(
                text="▶️ صفحه بعد",
                callback_data=f"stats:users:{page + 1}",
            )
        )

    if nav_row:
        buttons.append(nav_row)

    buttons.append(
        [
            InlineKeyboardButton(
                text="🔙 بازگشت",
                callback_data="stats:menu",
            )
        ]
    )

    try:

        await callback.message.edit_text(
            "\n".join(lines),
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=buttons
            ),
        )

    except Exception:

        logger.exception(
            "STATS USERS EDIT ERROR | page=%s",
            page,
        )

        try:

            await callback.message.answer(
                "\n".join(lines),
                parse_mode=ParseMode.HTML,
                reply_markup=InlineKeyboardMarkup(
                    inline_keyboard=buttons
                ),
            )

        except Exception:

            logger.exception(
                "STATS USERS ANSWER ERROR | page=%s",
                page,
            )


@router.callback_query(
    F.data.startswith("user_info:")
)
async def user_info_callback(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    parts = callback.data.split(":")

    try:
        target_id = int(parts[1])
    except (IndexError, ValueError):
        await callback.answer()
        return

    try:
        back_page = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        back_page = 0

    await callback.answer()

    row = db.get_user(target_id)

    name = (
        " ".join(
            x
            for x in (
                row["first_name"],
                row["last_name"],
            )
            if x
        ).strip()
        if row
        else ""
    ) or "نامشخص"

    username = (
        f"@{escape(row['username'])}"
        if row and row["username"]
        else "ندارد"
    )

    message_count = get_user_total_messages(
        target_id
    )

    text = (
        "◂ نام کاربر : "
        f"{escape(name)}\n"
        "◂ آیدی عددی : "
        f"<code>{target_id}</code>\n"
        "◂ یوزرنیم : "
        f"{username}\n"
        "◂ تعداد پیام‌های ارسال‌شده : "
        f"{message_count}"
    )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🔓 باز کردن پیوی",
                    url=f"tg://user?id={target_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="🔙 بازگشت به لیست",
                    callback_data=f"stats:users:{back_page}",
                )
            ],
        ]
    )

    try:

        await callback.message.edit_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
        )

    except Exception:

        logger.exception(
            "USER INFO EDIT ERROR | target_id=%s",
            target_id,
        )

        try:

            await callback.message.answer(
                text,
                parse_mode=ParseMode.HTML,
                reply_markup=keyboard,
            )

        except Exception:

            logger.exception(
                "USER INFO ANSWER ERROR | target_id=%s",
                target_id,
            )


@router.callback_query(
    F.data == "stats:admins"
)
async def stats_admins(
    callback: CallbackQuery,
    bot: Bot,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    rows = get_all_admin_stats()

    lines = [
        "🛡 آمار ادمین‌ها\n"
    ]

    buttons = []

    for row in rows:

        mention = await mention_user(
            bot,
            row["user_id"],
            row["name"],
        )

        lines.append(
            f"• {mention}\n"
            f"  🟢 قبول: {row['approved']}\n"
            f"  🔴 رد: {row['rejected']}"
        )

        buttons.append(
            [
                InlineKeyboardButton(
                    text=(
                        f"🔴 پیام‌های ردشده "
                        f"{row['name'] or row['user_id']}"
                    ),
                    callback_data=(
                        f"stats:rejected:"
                        f"{row['user_id']}"
                    ),
                )
            ]
        )

    buttons.append(
        [
            InlineKeyboardButton(
                text="🔙 بازگشت",
                callback_data="stats:menu",
            )
        ]
    )

    await callback.answer()

    await callback.message.edit_text(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        ),
    )


@router.callback_query(
    F.data.startswith("stats:rejected:")
)
async def stats_rejected(
    callback: CallbackQuery,
    bot: Bot,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    try:

        admin_id = int(
            callback.data.split(":")[2]
        )

    except Exception:

        await callback.answer()
        return

    rows = get_admin_rejected_messages(
        admin_id
    )

    admin = db.get_admin(
        admin_id
    )

    lines = [
        f"🔴 پیام‌های ردشده "
        f"{admin['name'] if admin else admin_id}\n"
    ]

    if not rows:

        lines.append(
            "این ادمین هنوز پیامی را رد نکرده."
        )

    for row in rows:

        sender = await mention_user(
            bot,
            row["user_id"],
        )

        content = (
            row["content"]
            .replace("\n", " ")
        )

        if len(content) > 100:
            content = (
                content[:100]
                + "..."
            )

        lines.append(
            f"#{row['id']} — {sender}\n"
            f"📝 {escape(content)}\n"
            f"❌ دلیل: "
            f"{escape(row['reject_reason'] or 'نامشخص')}\n"
        )

    await callback.answer()

    await callback.message.edit_text(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="🔙 بازگشت",
                        callback_data="stats:admins",
                    )
                ]
            ]
        ),
    )


@router.callback_query(
    F.data == "stats:menu"
)
async def stats_menu_callback(
    callback: CallbackQuery,
):

    if not db.is_owner(
        callback.from_user.id
    ):

        await callback.answer(
            "⛔ دسترسی ندارید.",
            show_alert=True,
        )

        return

    await callback.answer()

    await callback.message.edit_text(
        "📊 آمار و گزارش‌ها\n\nبخش موردنظر را انتخاب کن:",
        reply_markup=owner_stats_keyboard(),
    )


# =========================================================
# SECURITY
# =========================================================

@router.message(
    F.text == "🛡️ امنیت و دسترسی",
    F.chat.type == "private",
)
async def owner_security(
    message: Message,
    bot: Bot,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    admins = db.get_admins()
    started_users = get_started_users()

    lines = [
        "🛡️ امنیت و دسترسی\n",
        "👥 Adminها:",
    ]

    if admins:

        for admin in admins:

            mention = await mention_user(
                bot,
                admin["user_id"],
                admin["name"],
            )

            lines.append(
                f"• {mention}"
            )

    else:

        lines.append(
            "• هیچ ادمینی ثبت نشده."
        )

    lines.append(
        "\n🚀 کاربرانی که ربات را Start کرده‌اند:"
    )

    if started_users:

        for user in started_users:

            mention = await mention_user(
                bot,
                user["user_id"],
            )

            lines.append(
                f"• {mention}"
            )

    else:

        lines.append(
            "• هنوز کاربری Start نکرده."
        )

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


# =========================================================
# CHANNEL / SETTINGS
# =========================================================

@router.callback_query(
    F.data == "channel:change"
)
async def change_channel(
    callback: CallbackQuery,
):
    if not db.is_owner(
        callback.from_user.id
    ):
        await callback.answer(
            "⛔ فقط Owner اجازه این کار را دارد.",
            show_alert=True,
        )
        return

    set_state(
        callback.from_user.id,
        "channel_change",
    )

    await callback.answer()

    await callback.message.answer(
        (
            "🔄 تغییر کانال\n\n"
            "برای انتخاب کانال جدید، یک پست از "
            "کانال موردنظر را همینجا برای من فوروارد کن.\n\n"
            "⚠️ قبل از این کار مطمئن شو ربات در کانال جدید "
            "ادمین و دارای اجازه ارسال پیام است.\n\n"
            "❌ برای لغو، /start را بزن."
        )
    )


@router.message(
    F.text == "📢 کانال",
    F.chat.type == "private",
)
async def owner_channel(
    message: Message,
    bot: Bot,
):

    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return

    await message.answer(
        "📢 وضعیت کدام کانال را می‌خواهی ببینی؟",
        reply_markup=channels_keyboard("channel_ch"),
    )


@router.callback_query(
    F.data.startswith("channel_ch:")
)
async def owner_channel_info_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    key = callback.data.split(":", 1)[1]
    if key not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return

    await callback.answer()
    cfg = CHANNELS[key]
    channel_id = int(cfg["channel_id"])
    title_cfg = cfg["title"]

    try:
        chat = await bot.get_chat(channel_id)
        title = (
            getattr(chat, "title", None)
            or getattr(chat, "full_name", None)
            or title_cfg
        )
        username = getattr(chat, "username", None)
        public = (
            f"🔗 @{escape(username)}"
            if username
            else "🔒 کانال خصوصی"
        )
        connection = "🟢 اتصال Telegram موفق"
    except Exception as e:
        logger.exception(
            "CHANNEL GET_CHAT ERROR | channel_id=%s | error=%s",
            channel_id,
            e,
        )
        title = title_cfg
        public = "❌ اتصال کانال ناموفق"
        connection = f"🔴 خطا: {str(e)[:180]}"

    text = (
        f"📢 تنظیمات کانال — <b>{escape(title_cfg)}</b>\n\n"
        f"🏷 نام: <b>{escape(title)}</b>\n"
        f"{public}\n"
        f"🆔 <code>{channel_id}</code>\n\n"
        f"{connection}\n\n"
        "⚠️ برای انتشار پیام، ربات باید در این کانال "
        "ادمین و دارای اجازه ارسال پیام باشد."
    )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🧪 تست ارسال",
                    callback_data=f"channel_test:{key}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="↩️ برگشت",
                    callback_data="channel_ch_back",
                )
            ],
        ]
    )

    try:
        await callback.message.edit_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
        )
    except Exception:
        await callback.message.answer(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
        )


@router.callback_query(F.data == "channel_ch_back")
async def owner_channel_back(
    callback: CallbackQuery,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    await callback.answer()
    try:
        await callback.message.edit_text(
            "📢 وضعیت کدام کانال را می‌خواهی ببینی؟",
            reply_markup=channels_keyboard("channel_ch"),
        )
    except Exception:
        await callback.message.answer(
            "📢 وضعیت کدام کانال را می‌خواهی ببینی؟",
            reply_markup=channels_keyboard("channel_ch"),
        )


@router.callback_query(F.data.startswith("channel_test:"))
async def owner_channel_test(
    callback: CallbackQuery,
    bot: Bot,
):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    key = callback.data.split(":", 1)[1]
    if key not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return

    await callback.answer("⏳ در حال تست...")
    cfg = CHANNELS[key]
    try:
        await bot.send_message(
            chat_id=int(cfg["channel_id"]),
            text="test",
        )
        await callback.message.answer(f"✅ تست «{cfg['title']}» موفق بود.")
    except Exception as e:
        logger.exception("CHANNEL TEST ERROR | %s", key)
        await callback.message.answer(
            f"❌ تست «{cfg['title']}» ناموفق:\n{str(e)[:150]}"
        )


def owner_runtime_settings_keyboard():
    dupe_on = anti_dupe_enabled()
    rows = [
        [
            _btn(
                f"🔢 محدودیت پیام: {rate_limit_max()}",
                "cfg:rate_max",
                style="primary",
            )
        ],
        [
            _btn(
                f"⏱️ بازه محدودیت: {rate_limit_window() // 60} دقیقه",
                "cfg:rate_window",
                style="primary",
            )
        ],
        [
            _btn(
                f"🔄 ضدتکرار: {'فعال' if dupe_on else 'غیرفعال'}",
                "cfg:dupe_toggle",
                style="success" if dupe_on else "danger",
            )
        ],
        [
            _btn(
                f"⏳ مدت ضدتکرار: {anti_dupe_hours()} ساعت",
                "cfg:dupe_hours",
                style="primary",
            )
        ],
        [
            _btn(
                f"📨 سقف صف: {queue_limit()}",
                "cfg:queue_limit",
                style="primary",
            )
        ],
        [
            _btn(
                f"🤖 کل ربات: {'روشن' if db.is_bot_enabled() else 'خاموش'}",
                "cfg:bot_toggle",
                style="success" if db.is_bot_enabled() else "danger",
            )
        ],
    ]
    # روشن/خاموش جدا برای هر کانال
    for key, cfg in CHANNELS.items():
        on = is_channel_enabled(key) if db.is_bot_enabled() else False
        # وقتی کل ربات خاموش است، کانال‌ها هم خاموش نمایش داده می‌شوند
        # ولی وضعیت ذخیره‌شده کانال جداست؛ برای نمایش واقعی بدون اثر bot_enabled:
        raw_on = get_setting(channel_enabled_key(key), "1") != "0"
        label = f"{'🟢' if raw_on else '🔴'} {cfg['title']}: {'روشن' if raw_on else 'خاموش'}"
        rows.append(
            [
                _btn(
                    label,
                    f"cfg:ch_toggle:{key}",
                    style="success" if raw_on else "danger",
                )
            ]
        )
    rows.append(
        [
            _btn(
                "🧪 تست هر ۳ کانال",
                "cfg:test_channels",
                style="primary",
            )
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


@router.message(
    F.text.in_({"⚙️ تنظیمات", "⚙️ تنظیمات ربات"}),
    F.chat.type == "private",
)
async def owner_settings(
    message: Message,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    group_id = configured_group_id()

    await message.answer(
        (
            "⚙️ <b>تنظیمات قابل تغییر</b>\n\n"
            f"🌐 منطقه زمانی: <code>{TIMEZONE}</code>\n"
            f"👥 گروه شیفت: "
            f"{'تنظیم شده' if group_id else 'تنظیم نشده'}\n\n"
            "برای تغییر هر مورد روی دکمه بزن:"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_runtime_settings_keyboard(),
    )


@router.callback_query(F.data.startswith("cfg:"))
async def owner_cfg_callback(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return

    action = callback.data.split(":", 1)[1]

    if action == "bot_toggle":
        new_val = not db.is_bot_enabled()
        db.set_bot_enabled(new_val)
        await callback.answer(
            "روشن شد" if new_val else "خاموش شد"
        )
        await callback.message.edit_reply_markup(
            reply_markup=owner_runtime_settings_keyboard()
        )
        return

    # روشن/خاموش جداگانه هر کانال: cfg:ch_toggle:sadambazan
    if action.startswith("ch_toggle:"):
        ch = action.split(":", 1)[1]
        if ch not in CHANNELS:
            await callback.answer("نامعتبر", show_alert=True)
            return
        currently = get_setting(channel_enabled_key(ch), "1") != "0"
        set_channel_enabled(ch, not currently)
        title = CHANNELS[ch]["title"]
        await callback.answer(
            f"«{title}» {'روشن' if not currently else 'خاموش'} شد"
        )
        try:
            await callback.message.edit_reply_markup(
                reply_markup=owner_runtime_settings_keyboard()
            )
        except Exception:
            pass
        return

    if action == "dupe_toggle":
        new_val = "0" if anti_dupe_enabled() else "1"
        set_setting("anti_dupe_enabled", new_val)
        await callback.answer("ذخیره شد")
        await callback.message.edit_reply_markup(
            reply_markup=owner_runtime_settings_keyboard()
        )
        return

    if action == "test_channels":
        await callback.answer("⏳ در حال ارسال تست...")
        results = []
        for key, cfg in CHANNELS.items():
            try:
                await callback.bot.send_message(
                    chat_id=int(cfg["channel_id"]),
                    text="test",
                )
                results.append(f"✅ {cfg['title']}")
            except Exception as e:
                logger.exception("TEST CHANNEL SEND | %s", key)
                results.append(f"❌ {cfg['title']}: {str(e)[:80]}")
            await asyncio.sleep(0.2)
        try:
            await callback.message.answer(
                "🧪 نتیجه تست کانال‌ها:\n\n" + "\n".join(results)
            )
        except Exception:
            pass
        return

    # مقادیر عددی: ورود به state
    prompts = {
        "rate_max": ("rate_limit_max", "عدد محدودیت پیام در بازه را بفرست (مثلاً 10)"),
        "rate_window": ("rate_limit_window_min", "بازه محدودیت را به دقیقه بفرست (مثلاً 5)"),
        "dupe_hours": ("anti_dupe_hours", "مدت ضدتکرار را به ساعت بفرست (مثلاً 24)"),
        "queue_limit": ("queue_limit", "سقف صف را بفرست (مثلاً 100)"),
    }
    if action not in prompts:
        await callback.answer()
        return

    setting_key, prompt = prompts[action]
    set_state(
        callback.from_user.id,
        "edit_setting",
        setting_key=setting_key,
    )
    await callback.answer()
    await callback.message.answer(
        f"✏️ {prompt}",
        reply_markup=back_keyboard(),
    )


# =========================================================
# ANNOUNCEMENTS (اطلاعیه‌ها)
# =========================================================

def announcements_menu_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    "📨 ارسال اطلاعیه برای ادمین‌ها",
                    "ann:target:admins",
                    style="primary",
                )
            ],
            [
                _btn(
                    "👥 ارسال اطلاعیه برای کلیه کاربران",
                    "ann:target:users",
                    style="primary",
                )
            ],
            [
                _btn(
                    "📢 ارسال پیام در کانال",
                    "ann:target:channel",
                    style="success",
                )
            ],
            [
                _btn(
                    "📋 لیست اطلاعیه‌های فعال",
                    "ann:list",
                )
            ],
        ]
    )


def announcement_schedule_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn(
                    "⚡ ارسال فوری",
                    "ann:sched:immediate",
                    style="success",
                )
            ],
            [
                _btn(
                    "🕐 یک‌باره در تاریخ و ساعت مشخص",
                    "ann:sched:once",
                    style="primary",
                )
            ],
            [
                _btn(
                    "🔄 روزانه در ساعت مشخص",
                    "ann:sched:daily",
                    style="primary",
                )
            ],
            [
                _btn(
                    "📅 هفتگی در روز و ساعت مشخص",
                    "ann:sched:weekly",
                    style="primary",
                )
            ],
            [
                _btn(
                    "❌ انصراف",
                    "ann:cancel",
                    style="danger",
                )
            ],
        ]
    )


@router.message(
    F.text == "📢 اطلاعیه‌ها",
    F.chat.type == "private",
)
async def owner_announcements_menu(
    message: Message,
):
    if not db.is_owner(message.from_user.id):
        return

    await message.answer(
        (
            "📢 <b>سیستم اطلاعیه‌ها</b>\n\n"
            "مقصد ارسال را انتخاب کن:"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=announcements_menu_keyboard(),
    )


@router.callback_query(
    F.data.startswith("ann:target:")
)
async def ann_target_callback(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    target = callback.data.split(":")[-1]
    if target not in {"admins", "users", "channel"}:
        await callback.answer()
        return

    set_state(
        callback.from_user.id,
        "announcement",
        target=target,
        step="content",
    )

    await callback.answer()
    await callback.message.answer(
        (
            "📝 متن اطلاعیه را بفرست.\n\n"
            "می‌توانی از فرمت‌بندی معمولی تلگرام (Bold و ...) استفاده کنی."
        ),
        reply_markup=back_keyboard(),
    )


@router.callback_query(F.data == "ann:cancel")
async def ann_cancel_callback(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return
    clear_state(callback.from_user.id)
    await callback.answer("لغو شد.")
    await callback.message.answer(
        "عملیات اطلاعیه لغو شد.",
        reply_markup=owner_keyboard(db.is_bot_enabled()),
    )


@router.callback_query(
    F.data.startswith("ann:sched:")
)
async def ann_schedule_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    state = get_state(callback.from_user.id)
    if not state or state.get("kind") != "announcement":
        await callback.answer("نشست منقضی شده.", show_alert=True)
        return

    sched = callback.data.split(":")[-1]
    if sched not in {"immediate", "once", "daily", "weekly"}:
        await callback.answer()
        return

    state["schedule_type"] = sched

    if sched == "immediate":
        # پاسخ فوری تا مالک فکر نکند دکمه کار نکرده
        await callback.answer("⏳ در حال ارسال...")
        try:
            await callback.message.answer(
                "⏳ <b>شروع ارسال اطلاعیه...</b>\n"
                "لطفاً صبر کنید؛ پس از اتمام نتیجه اعلام می‌شود.",
                parse_mode=ParseMode.HTML,
            )
        except Exception:
            pass
        await send_announcement_now(bot, state, callback.from_user.id)
        clear_state(callback.from_user.id)
        return

    if sched == "once":
        state["step"] = "once_datetime"
        await callback.answer()
        await callback.message.answer(
            (
                "🕐 تاریخ و ساعت ارسال را بفرست.\n\n"
                "فرمت:\n"
                "2026-09-10 18:30"
            ),
            reply_markup=back_keyboard(),
        )
        return

    if sched == "daily":
        state["step"] = "daily_time"
        await callback.answer()
        await callback.message.answer(
            (
                "🔄 ساعت ارسال روزانه را بفرست.\n\n"
                "فرمت:\n"
                "09:00"
            ),
            reply_markup=back_keyboard(),
        )
        return

    if sched == "weekly":
        state["step"] = "weekly_day"
        await callback.answer()
        await callback.message.answer(
            (
                "📅 شماره روز هفته را بفرست (۰=دوشنبه ... ۶=یکشنبه).\n\n"
                "سپس ساعت را می‌گیریم.\n"
                "مثال روز: 0"
            ),
            reply_markup=back_keyboard(),
        )
        return


@router.callback_query(F.data == "ann:list")
async def ann_list_callback(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    rows = get_active_announcements()
    lines = ["📋 <b>اطلاعیه‌های فعال</b>\n"]

    if not rows:
        lines.append("هیچ اطلاعیه فعالی وجود ندارد.")
    else:
        for row in rows:
            preview = (row["content"] or "")[:60].replace("\n", " ")
            lines.append(
                f"#{row['id']} — {escape(row['target'])} | "
                f"{escape(row['schedule_type'])}\n"
                f"📝 {escape(preview)}\n"
            )

    buttons = []
    for row in rows:
        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"🗑 غیرفعال #{row['id']}",
                    callback_data=f"ann:deactivate:{row['id']}",
                )
            ]
        )

    await callback.answer()
    await callback.message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons)
        if buttons
        else None,
    )


@router.callback_query(
    F.data.startswith("ann:deactivate:")
)
async def ann_deactivate_callback(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return
    try:
        ann_id = int(callback.data.split(":")[-1])
    except ValueError:
        await callback.answer()
        return
    deactivate_announcement(ann_id)
    await callback.answer("✅ غیرفعال شد.", show_alert=True)


async def send_announcement_now(
    bot: Bot,
    state: dict,
    owner_id: int,
):
    target = state.get("target")
    content = state.get("content") or ""
    entities = deserialize_entities(state.get("entities"))

    sent = 0
    failed = 0

    # ارسال موازی‌تر و با تأخیر کمتر برای سرعت بیشتر
    async def _send_one(chat_id: int) -> bool:
        try:
            await bot.send_message(
                chat_id=chat_id,
                text=content,
                entities=entities or None,
            )
            return True
        except Exception:
            return False

    if target == "channel":
        channel_id = db.get_channel_id()
        if await _send_one(channel_id):
            sent = 1
        else:
            failed = 1
            logger.exception("ANN CHANNEL SEND ERROR")

    elif target == "admins":
        # همه ادمین‌های فعال (در همه کانال‌ها) — بدون تکرار
        try:
            admin_rows = await db_fetchall(
                """
                SELECT DISTINCT user_id
                FROM admins
                WHERE active = 1
                """
            )
        except Exception:
            logger.exception("ANN GET ALL ADMINS ERROR")
            admin_rows = []
        tasks = []
        for admin in admin_rows:
            tasks.append(_send_one(admin["user_id"]))
        # دسته‌ای برای جلوگیری از flood
        batch_size = 15
        for i in range(0, len(tasks), batch_size):
            results = await asyncio.gather(*tasks[i:i + batch_size])
            sent += sum(1 for ok in results if ok)
            failed += sum(1 for ok in results if not ok)
            if i + batch_size < len(tasks):
                await asyncio.sleep(0.15)

    elif target == "users":
        users = get_started_users()
        batch_size = 20
        for i in range(0, len(users), batch_size):
            batch = users[i:i + batch_size]
            results = await asyncio.gather(
                *[_send_one(u["user_id"]) for u in batch]
            )
            sent += sum(1 for ok in results if ok)
            failed += sum(1 for ok in results if not ok)
            if i + batch_size < len(users):
                await asyncio.sleep(0.12)

    create_announcement(
        target=target,
        content=content,
        schedule_type="immediate",
        created_by=owner_id,
        entities_json=json.dumps(state.get("entities") or [], ensure_ascii=False),
    )

    text = (
        f"✅ اطلاعیه ارسال شد.\n\n"
        f"📨 موفق: {sent}"
    )
    if failed:
        text += f"\n⚠️ ناموفق: {failed}"

    try:
        await bot.send_message(
            chat_id=owner_id,
            text=text,
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
    except Exception:
        pass


async def process_scheduled_announcements(bot: Bot):
    now = local_now()
    rows = get_active_announcements()

    for row in rows:
        stype = row["schedule_type"]
        if stype == "immediate":
            continue

        should_send = False

        if stype == "once":
            if not row["schedule_date"] or not row["schedule_time"]:
                continue
            try:
                target_dt = datetime.strptime(
                    f"{row['schedule_date']} {row['schedule_time']}",
                    "%Y-%m-%d %H:%M",
                ).replace(tzinfo=TZ)
            except ValueError:
                continue
            if now >= target_dt:
                # فقط یک‌بار
                if not row["last_sent"]:
                    should_send = True

        elif stype == "daily":
            if not row["schedule_time"]:
                continue
            try:
                th, tm = map(int, row["schedule_time"].split(":"))
            except Exception:
                continue
            if now.hour == th and now.minute == tm:
                last = row["last_sent"]
                if not last or last[:10] != today_string():
                    should_send = True

        elif stype == "weekly":
            if row["weekday"] is None or not row["schedule_time"]:
                continue
            try:
                th, tm = map(int, row["schedule_time"].split(":"))
            except Exception:
                continue
            if (
                now.weekday() == int(row["weekday"])
                and now.hour == th
                and now.minute == tm
            ):
                last = row["last_sent"]
                if not last or last[:10] != today_string():
                    should_send = True

        if not should_send:
            continue

        content = row["content"]
        entities = deserialize_entities(row["entities_json"])
        target = row["target"]
        sent_ok = False

        try:
            if target == "channel":
                channel_id = db.get_channel_id()
                await bot.send_message(
                    chat_id=channel_id,
                    text=content,
                    entities=entities or None,
                )
                sent_ok = True
            elif target == "admins":
                # همه ادمین‌های فعال در همه کانال‌ها (بدون تکرار)
                try:
                    admin_rows = await db_fetchall(
                        """
                        SELECT DISTINCT user_id
                        FROM admins
                        WHERE active = 1
                        """
                    )
                except Exception:
                    logger.exception("SCHEDULED ANN GET ADMINS ERROR")
                    admin_rows = []
                for admin in admin_rows:
                    try:
                        await bot.send_message(
                            chat_id=admin["user_id"],
                            text=content,
                            entities=entities or None,
                        )
                    except Exception:
                        pass
                    await asyncio.sleep(0.05)
                sent_ok = True
            elif target == "users":
                for user in get_started_users():
                    try:
                        await bot.send_message(
                            chat_id=user["user_id"],
                            text=content,
                            entities=entities or None,
                        )
                    except Exception:
                        pass
                    await asyncio.sleep(0.03)
                sent_ok = True
        except Exception:
            logger.exception(
                "SCHEDULED ANN SEND ERROR | id=%s",
                row["id"],
            )

        if sent_ok:
            mark_announcement_sent(row["id"])
            if stype == "once":
                deactivate_announcement(row["id"])


# =========================================================
# OWNER TOGGLE
# =========================================================

@router.message(
    F.text.in_({
        "🔴 خاموش کردن",
        "🟢 روشن کردن",
    }),
    F.chat.type == "private",
)
async def owner_toggle_bot(
    message: Message,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    enabled = (
        message.text == "🟢 روشن کردن"
    )

    db.set_bot_enabled(
        enabled
    )

    await message.answer(
        (
            "🟢 ربات روشن شد."
            if enabled
            else "🔴 ربات خاموش شد."
        ),
        reply_markup=owner_keyboard(
            enabled
        ),
    )


# =========================================================
# STATE HANDLER
# =========================================================

async def handle_state(
    message: Message,
    bot: Bot,
) -> bool:

    user_id = message.from_user.id

    state = get_state(
        user_id
    )

    if not state:
        return False

    kind = state["kind"]
    text = message.text or ""

    # =====================================================
    # OWNER EDIT SETTING
    # =====================================================

    if kind == "edit_setting":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        raw = (text or "").strip()
        if not raw.isdigit():
            await message.answer("❌ فقط عدد بفرست.")
            return True
        value = int(raw)
        if value < 0:
            await message.answer("❌ عدد نامعتبر است.")
            return True

        key = state.get("setting_key")
        if key == "rate_limit_window_min":
            set_setting("rate_limit_window", str(value * 60))
        elif key == "rate_limit_max":
            set_setting("rate_limit_max", str(value))
        elif key == "anti_dupe_hours":
            set_setting("anti_dupe_hours", str(max(1, value)))
        elif key == "queue_limit":
            set_setting("queue_limit", str(value))
        else:
            await message.answer("❌ تنظیم ناشناخته.")
            clear_state(user_id)
            return True

        clear_state(user_id)
        await message.answer(
            "✅ تنظیم ذخیره شد.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        await message.answer(
            "⚙️ تنظیمات فعلی:",
            reply_markup=owner_runtime_settings_keyboard(),
        )
        return True

    # =====================================================
    # USER FEEDBACK
    # =====================================================

    if kind == "user_feedback":
        content = (text or "").strip()
        if not content:
            await message.answer("❌ متن خالی است. دوباره بنویس.")
            return True
        try:
            await db_execute(
                """
                INSERT INTO user_feedback (user_id, content, created_at, status)
                VALUES (?, ?, ?, 'open')
                """,
                (user_id, content, db.now()),
            )
            await db_commit()
        except Exception:
            logger.exception("USER FEEDBACK SAVE ERROR | user_id=%s", user_id)
            await message.answer(GENERIC_ERROR)
            return True
        clear_state(user_id)
        await message.answer(
            "✅ پیام شما برای مالک ارسال شد.\nدر صورت نیاز پاسخ دریافت می‌کنید.",
            reply_markup=role_keyboard(user_id),
        )
        # اطلاع به مالک
        try:
            owners = []
            # مالک از طریق is_owner روی خود message نیست؛ از settings یا همه ادمین‌ها نه —
            # فقط به کسی که الان پیام را می‌بیند در پنل می‌رسد. اگر OWNER_ID در db باشد:
            if hasattr(db, "owner_id"):
                owners = [db.owner_id]
            else:
                # fallback: اگر متد get_owner وجود داشته باشد
                try:
                    oid = db.conn.execute(
                        "SELECT value FROM settings WHERE key = 'owner_id'"
                    ).fetchone()
                    if oid:
                        owners = [int(oid["value"])]
                except Exception:
                    owners = []
            for oid in owners:
                try:
                    await bot.send_message(
                        oid,
                        f"📬 پیام جدید از کاربر {user_id}:\n\n{content[:500]}",
                    )
                except Exception:
                    pass
        except Exception:
            pass
        return True

    # =====================================================
    # OWNER REPLY TO FEEDBACK
    # =====================================================

    if kind == "owner_feedback_reply":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        content = (text or "").strip()
        if not content:
            await message.answer("❌ پاسخ خالی است.")
            return True
        fb_id = state.get("feedback_id")
        if not fb_id:
            clear_state(user_id)
            await message.answer("❌ نشست منقضی شده.")
            return True
        try:
            row = await db_fetchone(
                "SELECT * FROM user_feedback WHERE id = ?",
                (fb_id,),
            )
            if not row:
                clear_state(user_id)
                await message.answer("❌ پیام پیدا نشد.")
                return True
            await db_execute(
                """
                UPDATE user_feedback
                SET owner_reply = ?, replied_at = ?, status = 'replied'
                WHERE id = ?
                """,
                (content, db.now(), fb_id),
            )
            await db_commit()
            target_uid = row["user_id"]
        except Exception:
            logger.exception("OWNER FEEDBACK REPLY ERROR | id=%s", fb_id)
            await message.answer(GENERIC_ERROR)
            return True

        clear_state(user_id)
        try:
            await bot.send_message(
                target_uid,
                (
                    "📬 پاسخ مالک به پیام شما:\n\n"
                    f"{content}"
                ),
            )
        except Exception:
            logger.exception("OWNER REPLY DELIVER ERROR | user=%s", target_uid)
            await message.answer(
                "⚠️ پاسخ ذخیره شد ولی به کاربر نرسید (احتمالاً ربات را بلاک کرده).",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
            return True

        await message.answer(
            "✅ پاسخ برای کاربر ارسال شد.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return True

    # =====================================================
    # CHANNEL CHANGE
    # =====================================================

    if kind == "channel_change":

        if message.chat.type != "private":
            return True

        if not db.is_owner(user_id):
            clear_state(user_id)
            return True

        forwarded_chat = None

        # aiogram 3.x
        if getattr(message, "forward_origin", None):

            origin = message.forward_origin

            if getattr(origin, "type", None) == "channel":
                forwarded_chat = getattr(
                    origin,
                    "chat",
                    None,
                )

        if not forwarded_chat:

            await message.answer(
                (
                    "❌ این پیام از یک کانال فوروارد نشده است.\n\n"
                    "لطفاً یک پست را مستقیماً از کانال جدید "
                    "برای من فوروارد کن."
                )
            )

            return True

        channel_id = getattr(
            forwarded_chat,
            "id",
            None,
        )

        if not channel_id:

            await message.answer(
                "❌ نتوانستم آیدی کانال را تشخیص بدهم."
            )

            return True

        # بررسی اتصال به کانال
        try:

            chat = await bot.get_chat(
                channel_id
            )

            if getattr(chat, "type", None) != "channel":

                await message.answer(
                    "❌ مقصد انتخاب‌شده یک کانال معتبر نیست."
                )

                return True

            # بررسی دسترسی ربات
            me = await bot.get_me()

            member = await bot.get_chat_member(
                channel_id,
                me.id,
            )

            status = getattr(
                member,
                "status",
                None,
            )

            if status not in (
                "administrator",
                "creator",
            ):

                await message.answer(
                    (
                        "❌ ربات در این کانال ادمین نیست.\n\n"
                        "ابتدا ربات را در کانال جدید ادمین کن "
                        "و دوباره یک پست از آن فوروارد کن."
                    )
                )

                return True

        except Exception as e:

            logger.exception(
                "CHANNEL CHANGE ERROR | "
                "channel_id=%s | error=%s",
                channel_id,
                e,
            )

            await message.answer(
                (
                    "❌ اتصال به کانال جدید موفق نبود.\n\n"
                    "مطمئن شو ربات داخل کانال ادمین است "
                    "و اجازه ارسال پیام دارد."
                )
            )

            return True

        # فقط بعد از تأیید موفق، تنظیم قبلی تغییر می‌کند.
        db.set_channel_id(
            channel_id
        )

        clear_state(
            user_id
        )

        title = (
            getattr(chat, "title", None)
            or "کانال"
        )

        username = getattr(
            chat,
            "username",
            None,
        )

        public = (
            f"@{escape(username)}"
            if username
            else "کانال خصوصی"
        )

        await message.answer(
            (
                "✅ کانال با موفقیت تغییر کرد.\n\n"
                f"🏷 نام: <b>{escape(title)}</b>\n"
                f"📢 {public}\n"
                f"🆔 <code>{channel_id}</code>"
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

        return True

    # =====================================================
    # ANNOUNCEMENT STATE
    # =====================================================

    if kind == "announcement":

        if message.chat.type != "private":
            return True

        if not db.is_owner(user_id):
            clear_state(user_id)
            return True

        step = state.get("step")

        if step == "content":
            if not (message.text or "").strip():
                await message.answer("❌ متن اطلاعیه خالی است.")
                return True

            state["content"] = message.text
            state["entities"] = serialize_entities(message.entities)
            state["step"] = "schedule"

            await message.answer(
                "⏰ نوع زمان‌بندی را انتخاب کن:",
                reply_markup=announcement_schedule_keyboard(),
            )
            return True

        if step == "once_datetime":
            value = (message.text or "").strip()
            try:
                dt = datetime.strptime(value, "%Y-%m-%d %H:%M")
            except ValueError:
                await message.answer(
                    "❌ فرمت نادرست است.\nمثال: 2026-09-10 18:30"
                )
                return True

            create_announcement(
                target=state["target"],
                content=state["content"],
                schedule_type="once",
                created_by=user_id,
                entities_json=json.dumps(
                    state.get("entities") or [],
                    ensure_ascii=False,
                ),
                schedule_date=dt.strftime("%Y-%m-%d"),
                schedule_time=dt.strftime("%H:%M"),
            )
            clear_state(user_id)
            await message.answer(
                (
                    f"✅ اطلاعیه یک‌باره ثبت شد.\n\n"
                    f"🕐 {dt.strftime('%Y-%m-%d %H:%M')}"
                ),
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
            return True

        if step == "daily_time":
            value = (message.text or "").strip()
            if not valid_time(value):
                await message.answer("❌ ساعت معتبر نیست. مثال: 09:00")
                return True

            create_announcement(
                target=state["target"],
                content=state["content"],
                schedule_type="daily",
                created_by=user_id,
                entities_json=json.dumps(
                    state.get("entities") or [],
                    ensure_ascii=False,
                ),
                schedule_time=value,
            )
            clear_state(user_id)
            await message.answer(
                f"✅ اطلاعیه روزانه برای ساعت {value} ثبت شد.",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
            return True

        if step == "weekly_day":
            try:
                day = int((message.text or "").strip())
                if day < 0 or day > 6:
                    raise ValueError
            except ValueError:
                await message.answer(
                    "❌ عدد روز باید بین ۰ تا ۶ باشد (۰=دوشنبه)."
                )
                return True

            state["weekday"] = day
            state["step"] = "weekly_time"
            await message.answer(
                "🕐 ساعت ارسال هفتگی را بفرست.\nمثال: 10:00"
            )
            return True

        if step == "weekly_time":
            value = (message.text or "").strip()
            if not valid_time(value):
                await message.answer("❌ ساعت معتبر نیست. مثال: 10:00")
                return True

            create_announcement(
                target=state["target"],
                content=state["content"],
                schedule_type="weekly",
                created_by=user_id,
                entities_json=json.dumps(
                    state.get("entities") or [],
                    ensure_ascii=False,
                ),
                schedule_time=value,
                weekday=state.get("weekday"),
            )
            clear_state(user_id)
            await message.answer(
                (
                    f"✅ اطلاعیه هفتگی ثبت شد.\n\n"
                    f"📅 روز: {state.get('weekday')}\n"
                    f"🕐 ساعت: {value}"
                ),
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
            return True

        return True

    # =====================================================
    # USER MESSAGE
    # =====================================================

    if kind == "user_send":

        attempts = db.count_recent_attempts(
            user_id,
            rate_limit_window(),
        )

        if attempts >= rate_limit_max():

            await message.answer(
                "🚫 محدودیت ارسال. کمی بعد دوباره تلاش کن."
            )

            return True

        db.add_rate_attempt(
            user_id
        )

        valid, error = validate_submission(
            message
        )

        if not valid:

            await message.answer(
                error
            )

            return True

        # ضد پیام تکراری (قابل تنظیم از پنل مالک)
        if anti_dupe_enabled() and is_duplicate_user_message(
            user_id,
            message.text or "",
            hours=anti_dupe_hours(),
        ):
            hrs = anti_dupe_hours()
            await message.answer(
                (
                    f"🚫 این متن را در {hrs} ساعت گذشته ارسال کرده‌اید.\n\n"
                    "پیام تکراری به ادمین ارسال نمی‌شود.\n"
                    f"پس از گذشت {hrs} ساعت می‌توانید دوباره همان متن را بفرستید."
                )
            )
            return True

        msg_channel = channel_key_from_prefix(message.text or "") or DEFAULT_CHANNEL_KEY

        # خاموش بودن فقط همان کانال
        if not is_channel_enabled(msg_channel):
            ch_title = CHANNELS.get(msg_channel, {}).get("title", msg_channel)
            await message.answer(
                f"🔴 کانال «{ch_title}» در حال حاضر غیرفعال است.\n\n"
                "لطفاً بعداً دوباره امتحان کنید یا برای کانال دیگری پیام بفرستید."
            )
            return True

        # ساعات کاری کانال — خارج از بازه، پیام قبول نمی‌شود
        if not is_within_channel_hours(msg_channel):
            ch_title = CHANNELS.get(msg_channel, {}).get("title", msg_channel)
            hours_label = channel_hours_label(msg_channel)
            await message.answer(
                f"⏰ ساعت کاری «{ch_title}» از {hours_label} می‌باشد.\n\n"
                "لطفاً در ساعات ذکرشده پیام ارسال کنید."
            )
            return True

        current = await get_current_shift_safe_async(channel_key=msg_channel)

        entities = serialize_entities(
            message.entities
        )

        async def _set_msg_channel(mid: int):
            try:
                await db_execute(
                    """
                    UPDATE messages
                    SET channel_key = ?
                    WHERE id = ?
                    """,
                    (msg_channel, mid),
                )
                await db_commit()
            except Exception:
                logger.exception(
                    "SET MESSAGE CHANNEL ERROR | id=%s channel=%s",
                    mid,
                    msg_channel,
                )

        if not current:

            try:
                message_id = await asyncio.to_thread(
                    db.create_message,
                    user_id,
                    message.text,
                    entities,
                    None,
                )
                await _set_msg_channel(message_id)

                await db_execute(
                    """
                    UPDATE messages
                    SET status = 'queued',
                        admin_id = NULL
                    WHERE id = ?
                    """,
                    (message_id,),
                )
                await db_commit()
            except Exception:
                logger.exception("USER SEND CREATE QUEUED ERROR | user_id=%s", user_id)
                await message.answer(GENERIC_ERROR)
                return True

            next_shift = await get_next_shift_async(channel_key=msg_channel)

            if next_shift:

                shift, start_dt = next_shift

                await message.answer(
                    (
                        "✅ پیام ذخیره شد.\n\n"
                        f"🆔 شماره پیگیری: #{message_id}\n\n"
                        "🕐 در حال حاضر شیفت فعالی وجود ندارد.\n"
                        "پیامت در صف قرار گرفت و در شروع شیفت بعدی "
                        "برای ادمین ارسال می‌شود.\n\n"
                        f"⏰ شروع شیفت بعدی: "
                        f"{start_dt.strftime('%Y-%m-%d %H:%M')}"
                    ),
                    reply_markup=role_keyboard(user_id),
                )

            else:

                await message.answer(
                    (
                        "✅ پیام ذخیره شد.\n\n"
                        f"🆔 شماره پیگیری: #{message_id}\n\n"
                        "🕐 فعلاً شیفتی برای ارسال پیام وجود ندارد؛ "
                        "پیام حذف نمی‌شود."
                    ),
                    reply_markup=role_keyboard(user_id),
                )

            clear_state(
                user_id
            )

            return True

        shift = current[0]
        admin_id = shift["admin_id"]

        try:
            message_id = await asyncio.to_thread(
                db.create_message,
                user_id,
                message.text,
                entities,
                admin_id,
            )
            await _set_msg_channel(message_id)
            row = await asyncio.to_thread(db.get_message, message_id)
        except Exception:
            logger.exception("USER SEND CREATE PENDING ERROR | user_id=%s", user_id)
            await message.answer(GENERIC_ERROR)
            return True

        try:

            sent = await send_review_message(
                bot,
                admin_id,
                row,
            )

            await asyncio.to_thread(
                db.set_admin_message_id,
                message_id,
                sent.message_id,
            )

            await message.answer(
                (
                    "✅ پیامت با موفقیت ارسال شد.\n\n"
                    f"🆔 شماره پیگیری: #{message_id}\n\n"
                    "🟡 در انتظار بررسی ادمین است."
                ),
                reply_markup=role_keyboard(user_id),
            )

            clear_state(
                user_id
            )

        except Exception:

            logger.exception(
                "SEND REVIEW MESSAGE ERROR | "
                "message_id=%s | admin_id=%s",
                message_id,
                admin_id,
            )

            await asyncio.to_thread(
                db.set_message_status,
                message_id,
                "queued",
            )

            await message.answer(
                "⚠️ پیام ذخیره شد و بعداً دوباره برای بررسی ارسال می‌شود."
            )

        return True

    # =====================================================
    # ADD ADMIN
    # =====================================================

    if kind == "add_admin":

        value = text.strip()
        ch = state.get("channel_key") or DEFAULT_CHANNEL_KEY
        ch_title = CHANNELS.get(ch, CHANNELS[DEFAULT_CHANNEL_KEY])["title"]

        async def _resolve_one_admin(raw: str) -> tuple[int | None, str | None, str | None]:
            """برمی‌گرداند: (admin_id, name, error_msg)"""
            raw = raw.strip()
            if not raw:
                return None, None, None

            if raw.startswith("@"):
                row = find_user_by_username(raw)
                if not row:
                    return None, None, f"{raw}: در دیتابیس پیدا نشد (باید Start کرده باشد)"
                if not row["started"]:
                    return None, None, f"{raw}: هنوز ربات را Start نکرده"
                aid = int(row["user_id"])
                nm = " ".join(
                    x for x in (row["first_name"], row["last_name"]) if x
                ).strip()
                if not nm:
                    nm = f"@{row['username']}" if row["username"] else "ادمین"
                return aid, nm, None

            if raw.isdigit():
                aid = int(raw)
                nm = None
                row = db.get_user(aid)
                if row:
                    nm = " ".join(
                        x for x in (row["first_name"], row["last_name"]) if x
                    ).strip()
                    if not nm and row["username"]:
                        nm = f"@{row['username']}"
                if not nm:
                    try:
                        chat = await bot.get_chat(aid)
                        nm = (
                            getattr(chat, "full_name", None)
                            or (
                                f"@{chat.username}"
                                if getattr(chat, "username", None)
                                else None
                            )
                        )
                    except Exception:
                        pass
                if not nm:
                    nm = "ادمین"
                return aid, nm, None

            return None, None, f"{raw}: نامعتبر (فقط آیدی عددی یا @username)"

        async def _add_one(aid: int, nm: str) -> str | None:
            """None = موفق، در غیر این صورت متن خطا"""
            try:
                existing = db.get_admin(aid)
                if not existing:
                    db.add_admin(aid, nm)
                set_admin_channel(aid, ch)
                return None
            except Exception:
                logger.exception("ADD ADMIN ERROR | admin_id=%s", aid)
                return f"{aid}: خطای دیتابیس"

        # --- دسته‌جمعی: چند آیدی عددی با فاصله / ویرگول / خط جدید ---
        # اگر کل متن فقط عدد و جداکننده‌ها باشد → حالت bulk
        tokens = re.split(r"[\s,،;؛]+", value)
        tokens = [t for t in tokens if t]

        all_numeric = bool(tokens) and all(t.isdigit() for t in tokens)

        if all_numeric and len(tokens) >= 1:
            # حذف تکراری با حفظ ترتیب
            seen: set[int] = set()
            unique_ids: list[int] = []
            for t in tokens:
                i = int(t)
                if i not in seen:
                    seen.add(i)
                    unique_ids.append(i)

            ok_lines: list[str] = []
            fail_lines: list[str] = []

            for aid in unique_ids:
                _, nm, err = await _resolve_one_admin(str(aid))
                if err:
                    fail_lines.append(f"❌ {err}")
                    continue
                add_err = await _add_one(aid, nm or "ادمین")
                if add_err:
                    fail_lines.append(f"❌ {add_err}")
                else:
                    try:
                        mention = await mention_user(bot, aid, nm)
                    except Exception:
                        mention = f"<code>{aid}</code>"
                    ok_lines.append(f"✅ {mention}")
                await asyncio.sleep(0.03)

            clear_state(user_id)

            summary = (
                f"➕ نتیجه افزودن ادمین به «{ch_title}»\n\n"
                f"🟢 موفق: {len(ok_lines)}\n"
                f"🔴 ناموفق: {len(fail_lines)}\n"
            )
            if ok_lines:
                summary += "\n" + "\n".join(ok_lines[:40])
                if len(ok_lines) > 40:
                    summary += f"\n… و {len(ok_lines) - 40} مورد دیگر"
            if fail_lines:
                summary += "\n\n" + "\n".join(fail_lines[:20])

            await message.answer(
                summary,
                parse_mode=ParseMode.HTML,
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
            return True

        # --- تکی: یک آیدی یا یک username ---
        admin_id, name, err = await _resolve_one_admin(value)
        if err or admin_id is None:
            await message.answer(
                f"❌ {err or 'مقدار نامعتبر'}\n\n"
                "مثال تکی:\n123456789\n@sixiren\n\n"
                "مثال دسته‌جمعی:\n123 456 789"
            )
            return True

        add_err = await _add_one(admin_id, name or "ادمین")
        if add_err:
            await message.answer(
                "❌ افزودن ادمین ناموفق بود.\n"
                "لطفاً چند ثانیه بعد دوباره امتحان کنید."
            )
            return True

        clear_state(user_id)
        mention = await mention_user(bot, admin_id, name)
        await message.answer(
            (
                f"✅ ادمین با موفقیت به «{ch_title}» اضافه شد.\n\n"
                f"👤 {mention}\n\n"
                "ℹ️ اگر این کاربر قبلاً ادمین کانال دیگری بود، "
                "الان ادمین هر دو کانال است."
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return True

    # =====================================================
    # SHIFT REQUEST
    # =====================================================

    if kind == "shift_request":

        if not text.strip():

            await message.answer(
                "❌ متن درخواست خالی است."
            )

            return True

        db.create_shift_request(
            user_id,
            text.strip(),
        )

        clear_state(
            user_id
        )

        await message.answer(
            "✅ درخواست تغییر شیفت ثبت شد.",
            reply_markup=admin_keyboard(),
        )

        return True

    # =====================================================
    # OWNER SHIFT
    # =====================================================

    if kind == "create_shift":

        step = state.get(
            "step"
        )

        if step == "date":

            if not valid_date(text):

                await message.answer(
                    "❌ تاریخ معتبر نیست."
                )

                return True

            state["specific_date"] = text
            state["step"] = "time"

            await message.answer(
                (
                    "⏰ بازه شیفت را بفرست.\n\n"
                    "مثال:\n"
                    "09:00-17:00\n"
                    "یا\n"
                    "23:00-02:00"
                )
            )

            return True

        if step == "time":

            parsed = parse_time_range(
                text
            )

            if not parsed:

                await message.answer(
                    (
                        "❌ فرمت زمان درست نیست.\n\n"
                        "مثال:\n"
                        "09:00-17:00\n"
                        "23:00-02:00"
                    )
                )

                return True

            start, end = parsed

            # جلوگیری از شیفت تکراری / هم‌پوشان (برای تاریخ مشخص)
            if not state.get("permanent"):
                specific = state.get("specific_date") or today_string()
                if is_shift_slot_taken(start, end, specific):
                    await message.answer(
                        "⛔ این بازه با شیفت دیگری هم‌پوشانی دارد یا قبلاً ثبت شده است."
                    )
                    return True
                admin_id_for_shift = state.get("admin_id")
                if admin_id_for_shift and admin_has_overlapping_shift(
                    admin_id_for_shift, start, end, specific
                ):
                    await message.answer(
                        "⛔ این ادمین قبلاً شیفتی هم‌پوشان با این بازه (در هر کانالی) دارد.\n"
                        "انتخاب دو شیفت یکسان یا هم‌پوشان برای یک ادمین مجاز نیست."
                    )
                    return True

            try:
                shift_id = await asyncio.to_thread(
                    lambda: db.create_shift(
                        start_time=start,
                        end_time=end,
                        admin_id=state["admin_id"],
                        permanent=state["permanent"],
                        specific_date=state.get("specific_date"),
                    )
                )
                ch = state.get("channel_key") or DEFAULT_CHANNEL_KEY
                try:
                    await db_execute(
                        "UPDATE shifts SET channel_key = ? WHERE id = ?",
                        (ch, shift_id),
                    )
                    await db_commit()
                except Exception:
                    logger.exception(
                        "OWNER SET SHIFT CHANNEL ERROR | shift_id=%s",
                        shift_id,
                    )

            except Exception:

                logger.exception(
                    "OWNER CREATE SHIFT ERROR"
                )

                await message.answer(
                    "❌ ایجاد شیفت ناموفق بود.\n"
                    "لطفاً چند ثانیه بعد دوباره امتحان کنید."
                )

                return True

            clear_state(user_id)

            await message.answer(
                (
                    "✅ شیفت ایجاد شد.\n\n"
                    f"⏰ {start} تا {end}"
                ),
                reply_markup=owner_keyboard(
                    db.is_bot_enabled()
                ),
            )

            return True

    # =====================================================
    # GROUP SHIFT
    # فقط TODAY
    # =====================================================

    if kind == "group_shift":

        chat_id = state.get(
            "chat_id"
        )

        if message.chat.id != chat_id:
            return True

        # ---------------------------------------------
        # فقط ادمین‌ها
        # ---------------------------------------------

        admin = db.get_admin(
            user_id
        )

        if not admin:

            clear_state(
                user_id
            )

            return True

        # ---------------------------------------------
        # امنیت: فقط today یا tomorrow (در بازه مجاز)
        # ---------------------------------------------

        if state.get("mode") not in {"today", "tomorrow"}:

            clear_state(
                user_id
            )

            await message.answer(
                "⛔ فقط امکان تعیین شیفت امروز (و در صورت مجاز، فردا) وجود دارد."
            )

            return True

        step = state.get(
            "step"
        )

        # ---------------------------------------------
        # ادمین اجازه تعیین تاریخ ندارد
        # ---------------------------------------------

        if step == "date":

            clear_state(
                user_id
            )

            await message.answer(
                "⛔ تعیین تاریخ مجاز نیست. "
                "شیفت فقط برای امروز ثبت می‌شود."
            )

            return True

        # ---------------------------------------------
        # دریافت ساعت شیفت
        # ---------------------------------------------

        if step == "time":

            parsed = parse_time_range(
                text
            )

            if not parsed:

                await message.answer(
                    (
                        "❌ بازه زمانی نامعتبر است.\n\n"
                        "مثال:\n"
                        "09:00-10:00\n"
                        "یا\n"
                        "23:00-01:00"
                    )
                )

                return True

            start, end = parsed

            permanent = False
            specific_date = state.get("date") or today_string()
            is_tomorrow = bool(state.get("for_tomorrow"))

            try:
                sh = int(start.split(":")[0])
            except Exception:
                sh = -1
            ch_key_gs = state.get("channel_key") or DEFAULT_CHANNEL_KEY
            start_h, end_h = channel_hours(ch_key_gs)
            if not (start_h == 0 and end_h == 24):
                if sh < start_h or (end_h < 24 and sh >= end_h):
                    await message.answer(
                        f"⛔ فقط بازه‌های {channel_hours_label(ch_key_gs)} مجاز است."
                    )
                    return True

            # جلوگیری از شیفت تکراری یا هم‌پوشان در کانال
            if is_shift_slot_taken(start, end, specific_date, channel_key=ch_key_gs):
                await message.answer(
                    "⛔ این بازه با شیفت ثبت‌شدهٔ دیگری هم‌پوشانی دارد و قابل انتخاب نیست."
                )
                return True

            # جلوگیری از هم‌پوشانی شیفت‌های خود ادمین در همه کانال‌ها
            if admin_has_overlapping_shift(user_id, start, end, specific_date):
                await message.answer(
                    "⛔ شما قبلاً شیفتی در این بازه (یا هم‌پوشان با آن) در یکی از کانال‌ها دارید.\n"
                    "انتخاب دو شیفت یکسان یا هم‌پوشان برای یک ادمین مجاز نیست."
                )
                return True

            allowed, reason = (
                db.check_admin_shift_limit(
                    admin_id=user_id,
                    start_time=start,
                    end_time=end,
                    specific_date=specific_date,
                )
            )

            if not allowed:

                await message.answer(
                    reason
                )

                return True

            try:

                shift_id = db.create_shift(
                    start_time=start,
                    end_time=end,
                    admin_id=user_id,
                    permanent=False,
                    specific_date=specific_date,
                )

            except Exception:

                logger.exception(
                    "GROUP CREATE TODAY SHIFT ERROR | "
                    "admin_id=%s | date=%s",
                    user_id,
                    specific_date,
                )

                await message.answer(
                    "❌ ثبت شیفت ناموفق بود."
                )

                return True

            clear_state(
                user_id
            )

            admin_row = db.get_admin(user_id)
            admin_name = (
                (admin_row["name"] if admin_row else None)
                or message.from_user.full_name
                or str(user_id)
            )
            day_label = "فردا" if is_tomorrow else "امروز"

            await message.answer(
                (
                    "✅ شیفت با موفقیت ثبت شد.\n\n"
                    f"👤 ادمین: {admin_name}\n"
                    f"📅 {specific_date} ({day_label})\n"
                    f"⏰ {start} تا {end}\n\n"
                    "ℹ️ هر ادمین حداکثر ۲ شیفت "
                    "و مجموعاً ۲ ساعت در روز می‌تواند داشته باشد."
                )
            )

            return True

    # =====================================================
    # OWNER SEND TO CHANNEL
    # =====================================================
    if kind == "owner_send_channel":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        ch = state.get("channel_key") or DEFAULT_CHANNEL_KEY
        if ch not in CHANNELS:
            clear_state(user_id)
            await message.answer("❌ کانال نامعتبر.")
            return True
        body = (text or "").strip()
        if not body:
            await message.answer("❌ متن خالی است.")
            return True
        try:
            await bot.send_message(
                chat_id=int(CHANNELS[ch]["channel_id"]),
                text=body,
            )
            clear_state(user_id)
            await message.answer(
                f"✅ پیام در «{CHANNELS[ch]['title']}» منتشر شد.",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
        except Exception:
            logger.exception("OWNER SEND CHANNEL ERROR | ch=%s", ch)
            await message.answer(
                "❌ ارسال ناموفق بود. دسترسی ربات به کانال را چک کن.",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
        return True

    # =====================================================
    # OWNER SEND TO CHANNEL
    # =====================================================
    if kind == "owner_send_channel":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        ch = state.get("channel_key") or DEFAULT_CHANNEL_KEY
        if ch not in CHANNELS:
            clear_state(user_id)
            await message.answer("❌ کانال نامعتبر.")
            return True
        body = (text or "").strip()
        if not body:
            await message.answer("❌ متن خالی است.")
            return True
        try:
            await bot.send_message(
                chat_id=int(CHANNELS[ch]["channel_id"]),
                text=body,
            )
            clear_state(user_id)
            await message.answer(
                f"✅ پیام در «{CHANNELS[ch]['title']}» منتشر شد.",
                reply_markup=owner_keyboard(db.is_bot_enabled()),
            )
        except Exception as e:
            logger.exception("OWNER SEND CHANNEL ERROR | ch=%s", ch)
            await message.answer(
                f"❌ ارسال ناموفق:\n{str(e)[:150]}\n\nدوباره متن را بفرست یا بازگشت بزن."
            )
        return True

    # =====================================================
    # SEARCH MESSAGE (مالک)
    # =====================================================
    if kind == "search_message":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        raw = (text or "").strip().lstrip("#")
        if not raw.isdigit():
            await message.answer("❌ فقط آیدی عددی پیام را بفرست (مثلاً 389).")
            return True
        mid = int(raw)
        try:
            row = await asyncio.to_thread(db.get_message, mid)
        except Exception:
            row = None
        if not row:
            await message.answer("❌ پیامی با این آیدی پیدا نشد.")
            return True
        clear_state(user_id)
        st = row["status"]
        ch = row["channel_key"] or DEFAULT_CHANNEL_KEY
        ch_title = CHANNELS.get(ch, {}).get("title", ch)
        sender = row["user_id"]
        sender_name = "-"
        try:
            u = await asyncio.to_thread(db.get_user, sender)
            if u:
                sender_name = " ".join(
                    x for x in (u["first_name"], u["last_name"]) if x
                ).strip() or (f"@{u['username']}" if u["username"] else str(sender))
        except Exception:
            pass
        admin_id = row["admin_id"]
        admin_info = str(admin_id) if admin_id else "—"
        if admin_id:
            try:
                ar = await asyncio.to_thread(db.get_admin, int(admin_id))
                if ar and ar["name"]:
                    admin_info = f"{ar['name']} ({admin_id})"
            except Exception:
                pass
        content = row["content"] or ""
        if len(content) > 800:
            content = content[:800] + "…"
        body = (
            f"🔎 نتیجه جستجوی پیام\n\n"
            f"🆔 آیدی پیام: #{mid}\n"
            f"👤 فرستنده: {sender_name}\n"
            f"🔢 آیدی فرستنده: <code>{sender}</code>\n"
            f"📺 کانال: {ch_title}\n"
            f"🕐 زمان ارسال: {format_dt_fa(row['submitted_at'])}\n"
            f"📌 وضعیت: {_status_label_fa(st)}\n"
            f"👨‍💼 ادمین دریافت‌کننده: {admin_info}\n"
        )
        if st == "rejected" and row["reject_reason"]:
            body += f"📋 دلیل رد: {row['reject_reason']}\n"
        body += f"\n📝 متن پیام:\n{escape(content)}"

        extra_kb = None
        if st in ("pending", "queued", "processing"):
            extra_kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        _btn(
                            "✅ تأیید و انتشار",
                            f"approve:{mid}",
                            style="success",
                        )
                    ]
                ]
            )

        await message.answer(
            body,
            parse_mode=ParseMode.HTML,
            reply_markup=extra_kb,
        )
        await message.answer(
            "پنل مالک:",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return True

    # =====================================================
    # SEARCH USER (مالک)
    # =====================================================
    if kind == "search_user":
        if not db.is_owner(user_id):
            clear_state(user_id)
            return True
        raw = (text or "").strip()
        if not raw.isdigit():
            await message.answer("❌ فقط آیدی عددی کاربر را بفرست.")
            return True
        target = int(raw)
        clear_state(user_id)
        try:
            u = await asyncio.to_thread(db.get_user, target)
        except Exception:
            u = None
        if not u:
            # حتی بدون رکورد هم شمارش پیام‌ها را نشان بده
            name = await get_profile_name(bot, target)
        else:
            name = " ".join(
                x for x in (u["first_name"], u["last_name"]) if x
            ).strip() or (f"@{u['username']}" if u["username"] else str(target))
        uname = ""
        if u and u["username"]:
            uname = f"@{u['username']}"
        # تاریخ عضویت / اولین فعالیت
        joined = "-"
        if u:
            for key in ("created_at", "joined_at", "first_seen", "started_at"):
                try:
                    if u[key]:
                        joined = u[key]
                        break
                except Exception:
                    pass
        # تعداد پیام per channel
        counts = {}
        for ck, cfg in CHANNELS.items():
            try:
                if ck == DEFAULT_CHANNEL_KEY:
                    r = await db_fetchone(
                        """
                        SELECT COUNT(*) AS c FROM messages
                        WHERE user_id = ?
                          AND (
                                channel_key = ?
                                OR channel_key IS NULL
                                OR channel_key = ''
                              )
                        """,
                        (target, ck),
                    )
                else:
                    r = await db_fetchone(
                        """
                        SELECT COUNT(*) AS c FROM messages
                        WHERE user_id = ? AND channel_key = ?
                        """,
                        (target, ck),
                    )
                counts[ck] = int(r["c"] or 0) if r else 0
            except Exception:
                counts[ck] = 0
        total = sum(counts.values())
        blocked = False
        try:
            blocked = bool(db.is_blocked(target))
        except Exception:
            pass
        text_out = (
            f"👤 مشخصات کاربر\n\n"
            f"نام: {escape(name)}\n"
            f"یوزرنیم: {escape(uname) if uname else '—'}\n"
            f"آیدی: <code>{target}</code>\n"
            f"تاریخ عضویت/ثبت: {joined}\n"
            f"وضعیت بن: {'🚫 بن‌شده' if blocked else '✅ فعال'}\n\n"
            f"📊 تعداد پیام‌ها (کل: {total})\n"
        )
        for ck, cfg in CHANNELS.items():
            text_out += f"• {cfg['title']}: {counts.get(ck, 0)}\n"

        kb_rows = []
        for ck, cfg in CHANNELS.items():
            kb_rows.append(
                [
                    _btn(
                        f"📋 {cfg['title']} ({counts.get(ck, 0)})",
                        f"search_user_ch:{target}:{ck}",
                        style="primary",
                    )
                ]
            )
        kb_rows.append(
            [
                _btn(
                    "🚫 بن کاربر از ربات",
                    f"ban_user:{target}",
                    style="danger",
                )
            ]
        )
        await message.answer(
            text_out,
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=kb_rows),
        )
        await message.answer(
            "پنل مالک:",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return True

    return False


# =========================================================
# BACK
# =========================================================

@router.message(
    F.text == "🔙 بازگشت"
)
async def back_handler(
    message: Message,
    bot: Bot,
):

    clear_state(
        message.from_user.id
    )

    if message.chat.type == "private":

        await show_home(
            message,
            bot,
        )


# =========================================================
# HELP BUTTON
# =========================================================

@router.message(
    F.text.in_({
        "📖 راهنما",
        "❓ راهنما",
    }),
    F.chat.type == "private",
)
async def help_button(
    message: Message,
):

    user_id = message.from_user.id

    if db.is_owner(user_id):

        await message.answer(
            (
                "👑 راهنمای مالک\n\n"
                "• پیام‌های در انتظار را بررسی کن\n"
                "• ادمین اضافه/حذف کن\n"
                "• شیفت‌ها را مدیریت کن\n"
                "• آمار، کاربران و تنظیمات را ببین\n"
                "• اطلاعیه بفرست و کانال را تنظیم کن\n"
                "• ربات را روشن/خاموش کن"
            ),
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

    elif db.get_admin(user_id):

        await message.answer(
            (
                "👨‍💼 راهنمای ادمین\n\n"
                "📥 پیام‌های در انتظار\n"
                "فقط وقتی داخل شیفت خودت هستی می‌توانی "
                "پیام‌ها را ببینی، تأیید یا رد کنی.\n\n"
                "⏰ شیفت من\n"
                "شیفت‌های امروزت را ببین.\n\n"
                "📊 عملکرد من\n"
                "تعداد تأیید/رد و میانگین زمان بررسی.\n\n"
                "🔔 اعلان‌ها\n"
                "یادآوری قبل از شیفت و شروع شیفت.\n\n"
                "🔄 درخواست تغییر شیفت\n"
                "درخواستت برای مالک ثبت می‌شود.\n\n"
                "در گروه مدیریت، با فرستادن آیدی ربات "
                "می‌توانی شیفت ۱۲:۰۰ تا ۰۰:۰۰ را انتخاب کنی. "
                "بین ۲۲ تا ۰۰ امکان انتخاب فردا هم هست."
            ),
            reply_markup=admin_keyboard(),
        )

    else:

        await message.answer(
            (
                "📖 راهنمای ارسال پیام\n\n"
                "برای ارسال پیام این قوانین رو رعایت کن:\n\n"
                "1️⃣ پیام باید با یکی از این‌ها شروع شود:\n"
                "   • صدام بزن\n"
                "   • این کاربر\n"
                "   • تو زندگی بعدی\n"
                "2️⃣ کل پیام باید Bold باشد.\n"
                "3️⃣ پیام باید با « .» تمام شود.\n"
                "4️⃣ ارسال لینک مجاز نیست.\n"
                "5⃣ ارسال ایموجی مجاز نیست.\n\n"
                "بعد از ارسال، پیام توسط ادمین بررسی می‌شود "
                "و نتیجه به شما اطلاع‌رسانی خواهد شد.\n\n"
                "لطفا از ارسال پیام تکراری خودداری فرمایید."
            ),
            reply_markup=user_keyboard(),
        )


# =========================================================
# PRIVATE TEXT ROUTER
# =========================================================

@router.message(
    F.text,
    F.chat.type == "private",
)
async def text_router(
    message: Message,
    bot: Bot,
):

    user = message.from_user
    text = message.text

    # non-blocking — جلوگیری از بلاک شدن روی اولین پیام
    try:
        await asyncio.to_thread(touch_user, user)
    except Exception:
        logger.exception("TOUCH USER ERROR | user_id=%s", user.id if user else None)

    try:
        if await handle_state(message, bot):
            return
    except Exception:
        logger.exception("HANDLE STATE ERROR | user_id=%s", user.id if user else None)
        await message.answer(GENERIC_ERROR)
        return

    if text in {
        "📝 ارسال پیام",
        "📝 ارسال پیام به صورت کاربر عادی",
    }:
        await user_send_start(message)
        return

    if text == "📊 وضعیت پیام من":
        await user_status(message)
        return

    if text == "💬 انتقادات، پیشنهادات، گزارش مشکل":
        await user_feedback_start(message)
        return

    if text in {"📬 مشاهده پیام کاربران", "📬 پیام کاربران"}:
        await owner_view_feedback(message, bot)
        return

    if text == "🔍 جستجو":
        await owner_search_menu(message)
        return

    if text == "📋 لاگ در لحظه":
        await owner_instant_log(message, bot)
        return

    if text == "📥 پیام‌های در انتظار":

        await pending_messages(
            message,
            bot,
        )

        return

    if text == "⏰ شیفت من":

        await admin_current_shift(
            message
        )

        return

    if text == "📊 عملکرد من":

        await admin_stats(
            message
        )

        return

    if text == "🔄 درخواست تغییر شیفت":

        await shift_request_start(
            message
        )

        return

    if text == "🔔 اعلان‌ها":

        await admin_notifications(
            message
        )

        return

    if text == "👥 ادمین‌ها":

        await owner_admins(
            message,
            bot,
        )

        return

    if text == "⏰ شیفت‌ها":

        await owner_shifts(
            message,
            bot,
        )

        return

    if text == "📊 آمار و گزارش‌ها":

        await owner_stats_menu(
            message
        )

        return

    if text == "⚙️ مدیریت سیستم":
        await owner_system_menu(message)
        return

    # سازگاری با منوی قدیمی
    if text == "📢 کانال":

        await owner_channel(
            message,
            bot,
        )

        return

    if text == "📢 اطلاعیه‌ها":

        await owner_announcements_menu(
            message
        )

        return

    if text in {"⚙️ تنظیمات ربات", "⚙️ تنظیمات"}:

        await owner_settings(
            message
        )

        return

    if text == "📋 لاگ در لحظه":
        await owner_instant_log(message, bot)
        return

    if text in {"📬 مشاهده پیام کاربران", "📬 پیام کاربران"}:
        await owner_view_feedback(message, bot)
        return

    if text in {
        "🔴 خاموش کردن",
        "🟢 روشن کردن",
    }:

        await owner_toggle_bot(
            message
        )

        return

    if text in {
        "📖 راهنما",
        "❓ راهنما",
    }:

        await help_button(
            message
        )

        return


# =========================================================
# SAFE SHIFT ENGINE
# =========================================================

def parse_hm(
    value: str,
):

    hour, minute = map(
        int,
        value.split(":"),
    )

    return hour, minute


def shift_applies_to_date(
    shift,
    date,
):

    if shift["specific_date"]:

        return (
            shift["specific_date"]
            == date.strftime(
                "%Y-%m-%d"
            )
        )

    if shift["permanent"]:
        return True

    weekday = shift["weekday"]

    return (
        weekday == -1
        or weekday == date.weekday()
    )


def get_current_shift_safe(channel_key: str | None = None):

    now = local_now()

    rows = _sync_execute_fetchall(
        """
        SELECT
            s.*,
            a.name AS admin_name,
            a.notifications_enabled
        FROM shifts s
        JOIN admins a
            ON a.user_id = s.admin_id
        WHERE a.active = 1
        """
    )

    candidates = []

    for shift in rows:
        # فیلتر کانال (در صورت مشخص بودن)
        if channel_key:
            raw_sk = None
            try:
                raw_sk = shift["channel_key"]
            except Exception:
                raw_sk = None
            raw_sk = (str(raw_sk).strip() if raw_sk else "") or ""
            if raw_sk:
                if raw_sk != channel_key:
                    continue
            else:
                # شیفت قدیمی بدون channel_key
                if channel_key == DEFAULT_CHANNEL_KEY:
                    pass
                else:
                    # فقط اگر ادمین صرفاً ادمین همین کانال باشد
                    try:
                        a_keys = admin_channel_keys(int(shift["admin_id"]))
                    except Exception:
                        a_keys = []
                    if channel_key not in a_keys:
                        continue
                    if len(a_keys) > 1:
                        # مبهم است؛ به کانال پیش‌فرض نسبت بده نه این کانال
                        continue

        for date in (
            now.date(),
            now.date() - timedelta(days=1),
        ):

            if not shift_applies_to_date(
                shift,
                date,
            ):
                continue

            sh, sm = parse_hm(
                shift["start_time"]
            )

            eh, em = parse_hm(
                shift["end_time"]
            )

            start = datetime(
                date.year,
                date.month,
                date.day,
                sh,
                sm,
                tzinfo=TZ,
            )

            end = datetime(
                date.year,
                date.month,
                date.day,
                eh,
                em,
                tzinfo=TZ,
            )

            if end <= start:
                end += timedelta(
                    days=1
                )

            if start <= now < end:

                candidates.append(
                    (
                        shift,
                        start,
                    )
                )

    if not candidates:
        return None

    candidates.sort(
        key=lambda item: item[1],
        reverse=True,
    )

    return candidates[0]


def get_next_shift(channel_key: str | None = None):

    now = local_now()

    rows = _sync_execute_fetchall(
        """
        SELECT
            s.*,
            a.name AS admin_name,
            a.notifications_enabled
        FROM shifts s
        JOIN admins a
            ON a.user_id = s.admin_id
        WHERE a.active = 1
        """
    )

    candidates = []

    for offset in range(
        0,
        15,
    ):

        date = (
            now.date()
            + timedelta(days=offset)
        )

        for shift in rows:
            if channel_key:
                sk = None
                try:
                    sk = shift["channel_key"]
                except Exception:
                    sk = None
                sk = sk or DEFAULT_CHANNEL_KEY
                if sk != channel_key:
                    continue

            if not shift_applies_to_date(
                shift,
                date,
            ):
                continue

            sh, sm = parse_hm(
                shift["start_time"]
            )

            start = datetime(
                date.year,
                date.month,
                date.day,
                sh,
                sm,
                tzinfo=TZ,
            )

            if start <= now:
                continue

            candidates.append(
                (
                    shift,
                    start,
                )
            )

    if not candidates:
        return None

    candidates.sort(
        key=lambda item: item[1]
    )

    return candidates[0]


async def get_current_shift_safe_async(channel_key: str | None = None):
    """نسخه non-blocking برای استفاده در هندلرهای async."""
    return await asyncio.to_thread(get_current_shift_safe, channel_key)


async def get_next_shift_async(channel_key: str | None = None):
    """نسخه non-blocking برای استفاده در هندلرهای async."""
    return await asyncio.to_thread(get_next_shift, channel_key)


# =========================================================
# QUEUED MESSAGE DISPATCH
# =========================================================

async def dispatch_queued_messages(
    bot: Bot,
    shift,
):
    """
    همه پیام‌های باز همان کانال (queued / pending / processing) را
    به ادمین شیفت فعال می‌دهد و در پیوی‌اش ارسال می‌کند.

    قبلاً فقط status=queued فرستاده می‌شد؛ پیام‌هایی که pending مانده بودند
    (با admin_id قدیمی) هرگز به ادمین شیفت جدید نمی‌رسیدند.
    """
    try:
        shift_ch = shift["channel_key"]
    except Exception:
        shift_ch = None
    shift_ch = shift_ch or DEFAULT_CHANNEL_KEY

    admin_id = int(shift["admin_id"])

    if shift_ch == DEFAULT_CHANNEL_KEY:
        rows = await db_fetchall(
            """
            SELECT *
            FROM messages
            WHERE status IN ('queued', 'pending', 'processing')
              AND (
                    channel_key = ?
                    OR channel_key IS NULL
                    OR channel_key = ''
                  )
            ORDER BY submitted_at ASC, id ASC
            """,
            (shift_ch,),
        )
    else:
        rows = await db_fetchall(
            """
            SELECT *
            FROM messages
            WHERE status IN ('queued', 'pending', 'processing')
              AND channel_key = ?
            ORDER BY submitted_at ASC, id ASC
            """,
            (shift_ch,),
        )

    # جلوگیری از ارسال تکراری همان پیام در یک اجرای مانیتور
    sent_ids: set[int] = set()

    for row in rows:
        mid = int(row["id"])
        if mid in sent_ids:
            continue

        # اگر قبلاً برای همین ادمین admin_message_id دارد، دوباره نفرست
        try:
            prev_admin = row["admin_id"]
            prev_msg = row["admin_message_id"]
        except Exception:
            prev_admin, prev_msg = None, None
        if (
            prev_admin is not None
            and int(prev_admin) == admin_id
            and prev_msg
            and str(row["status"]) == "pending"
        ):
            # قبلاً برای همین ادمین ارسال شده؛ فقط claim را به‌روز کن
            try:
                await db_execute(
                    """
                    UPDATE messages
                    SET admin_id = ?, shift_id = ?, status = 'pending'
                    WHERE id = ? AND status IN ('queued', 'pending', 'processing')
                    """,
                    (admin_id, shift["id"], mid),
                )
                await db_commit()
            except Exception:
                pass
            continue

        try:
            await db_execute(
                """
                UPDATE messages
                SET
                    admin_id = ?,
                    status = 'pending',
                    shift_id = ?
                WHERE id = ?
                  AND status IN ('queued', 'pending', 'processing')
                """,
                (
                    admin_id,
                    shift["id"],
                    mid,
                ),
            )
            await db_commit()

            updated = await asyncio.to_thread(db.get_message, mid)
            if not updated:
                continue

            sent = await send_review_message(
                bot,
                admin_id,
                updated,
            )

            await asyncio.to_thread(
                db.set_admin_message_id,
                mid,
                sent.message_id,
            )
            sent_ids.add(mid)
            await asyncio.sleep(0.05)

        except Exception:
            logger.exception(
                "DISPATCH PENDING MESSAGE ERROR | "
                "message_id=%s | shift_id=%s | channel=%s",
                mid,
                shift["id"],
                shift_ch,
            )
            # در صورت خطای ارسال، حداقل admin_id را برای ادمین شیفت نگه دار
            # تا از پنل 📥 بتواند ببیند


# =========================================================
# SHIFT MONITOR
# =========================================================

async def shift_monitor(
    bot: Bot,
):
    """
    مانیتور سبک برای سرور کم‌منبع:
    - صف پیام‌ها در شروع شیفت
    - اعلان شروع شیفت
    - یادآوری ۱۰ دقیقه قبل (اگر اعلان ادمین روشن باشد)
    """

    global notified_shifts
    global notified_shift_reminders

    while True:

        try:

            now = local_now()

            # برای هر کانال جداگانه شیفت فعال و صف همان کانال را پردازش کن
            for ch_key in channel_keys():
                current = await get_current_shift_safe_async(channel_key=ch_key)
                if not current:
                    continue

                shift, start_dt = current
                key = (
                    start_dt.strftime("%Y-%m-%d"),
                    int(shift["id"]),
                )

                await dispatch_queued_messages(bot, shift)

                if (
                    now >= start_dt
                    and now - start_dt < timedelta(minutes=1)
                    and key not in notified_shifts
                ):
                    notified_shifts.add(key)
                    if shift["notifications_enabled"]:
                        try:
                            ch_title = CHANNELS.get(ch_key, {}).get("title", ch_key)
                            await bot.send_message(
                                shift["admin_id"],
                                (
                                    "🔔 <b>شروع شیفت</b>\n\n"
                                    f"📺 کانال: <b>{ch_title}</b>\n"
                                    f"⏰ {shift['start_time']} تا "
                                    f"{shift['end_time']}\n\n"
                                    "📥 فقط پیام‌های صف‌شدهٔ همین کانال ارسال شد."
                                ),
                                parse_mode=ParseMode.HTML,
                            )
                        except (
                            TelegramForbiddenError,
                            TelegramBadRequest,
                        ):
                            pass

                # یادآوری نزدیک شروع شیفت همین کانال
                next_item = await get_next_shift_async(channel_key=ch_key)
                if not next_item:
                    continue
                shift, start_dt = next_item
                delta = start_dt - now
                if (
                    timedelta(seconds=0) < delta <= timedelta(minutes=5)
                    and shift["notifications_enabled"]
                ):
                    mins_left = max(1, int(delta.total_seconds() // 60) + (
                        1 if delta.total_seconds() % 60 else 0
                    ))
                    remind_key = (
                        start_dt.strftime("%Y-%m-%d"),
                        int(shift["id"]),
                        int(delta.total_seconds() // 60),
                    )
                    if remind_key not in notified_shift_reminders:
                        notified_shift_reminders.add(remind_key)
                        try:
                            await bot.send_message(
                                shift["admin_id"],
                                (
                                    "⏰ <b>یادآوری شیفت</b>\n\n"
                                    f"حدود <b>{mins_left}</b> دقیقه تا شروع شیفت مانده است.\n\n"
                                    f"🕐 شروع: <b>{start_dt.strftime('%H:%M')}</b>\n"
                                    f"⏰ بازه: {shift['start_time']} تا {shift['end_time']}"
                                ),
                                parse_mode=ParseMode.HTML,
                            )
                        except (
                            TelegramForbiddenError,
                            TelegramBadRequest,
                        ):
                            pass

            if len(notified_shifts) > 500:
                notified_shifts = set(list(notified_shifts)[-150:])
            if len(notified_shift_reminders) > 500:
                notified_shift_reminders = set(
                    list(notified_shift_reminders)[-150:]
                )

        except Exception:

            logger.exception(
                "SHIFT MONITOR ERROR"
            )

        # روی سرور ۱ هسته‌ای / ۱ گیگ، فاصله بیشتر = فشار کمتر
        await asyncio.sleep(20)


# =========================================================
# TODAY SCHEDULE
# =========================================================

@router.message(
    F.text == "📅 برنامه کاری/امروز",
    F.chat.type == "private",
)
async def owner_today_schedule(
    message: Message,
    bot: Bot,
):

    if not db.is_owner(
        message.from_user.id
    ):
        return

    rows = db.get_today_shifts(
        local_now().weekday(),
        today_string(),
    )

    lines = [
        "📅 برنامه کاری امروز\n",
        f"📆 {today_string()}\n",
    ]

    for shift in rows:

        admin = await mention_user(
            bot,
            shift["admin_id"],
            shift["admin_name"],
        )

        lines.append(
            f"👤 {admin}\n"
            f"⏰ {shift['start_time']} تا "
            f"{shift['end_time']}\n"
        )

    if not rows:

        lines.append(
            "امروز شیفتی ثبت نشده."
        )

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


# =========================================================
# CLEANUP
# =========================================================

async def cleanup_loop():

    while True:

        try:

            db.cleanup_old_data()

        except Exception:

            logger.exception(
                "CLEANUP ERROR"
            )

        await asyncio.sleep(
            30 * 60
        )


async def announcement_monitor(bot: Bot):
    """
    بررسی اطلاعیه‌های زمان‌بندی‌شده — فاصله بیشتر برای سرور کم‌منبع.
    """
    while True:
        try:
            await process_scheduled_announcements(bot)
        except Exception:
            logger.exception("ANNOUNCEMENT MONITOR ERROR")
        await asyncio.sleep(60)


# =========================================================
# COMMANDS
# =========================================================

async def setup_commands(
    bot: Bot,
):

    await bot.set_my_commands(
        [
            BotCommand(
                command="start",
                description="راه‌اندازی ربات",
            ),
            BotCommand(
                command="help",
                description="راهنما",
            ),
        ],
        scope=BotCommandScopeDefault(),
    )


# =========================================================
# MAIN
# =========================================================

# =========================================================
# PERIODIC / INSTANT LOG (12h) — فقط اضافه شده، منطق قبلی دست نخورده
# =========================================================

_log_in_progress: set[int] = set()


def _register_log_recipient(user_id: int):
    """مالک را در لیست دریافت‌کنندگان لاگ ثبت می‌کند."""
    try:
        raw = get_setting("log_recipients", "") or ""
        ids = {x.strip() for x in raw.split(",") if x.strip().isdigit()}
        ids.add(str(int(user_id)))
        set_setting("log_recipients", ",".join(sorted(ids)))
    except Exception:
        logger.exception("REGISTER LOG RECIPIENT ERROR")


def get_log_recipients() -> list[int]:
    out: list[int] = []
    try:
        raw = get_setting("log_recipients", "") or ""
        for x in raw.split(","):
            x = x.strip()
            if x.isdigit():
                out.append(int(x))
    except Exception:
        pass
    # یکتا
    return list(dict.fromkeys(out))


def _status_label_fa(st: str) -> str:
    return {
        "queued": "در صف",
        "pending": "در انتظار بررسی",
        "processing": "در حال بررسی",
        "approved": "تأیید شده",
        "rejected": "رد شده",
    }.get(st or "", st or "نامشخص")


def _status_label_en(st: str) -> str:
    return {
        "queued": "Queued",
        "pending": "Pending review",
        "processing": "Processing",
        "approved": "Approved",
        "rejected": "Rejected",
    }.get(st or "", st or "Unknown")


async def _fetch_log_window(since: str | None, until: str | None):
    """داده‌های بازه زمانی برای لاگ."""
    def _norm(ts: str | None) -> str | None:
        if not ts:
            return None
        return str(ts).replace("T", " ").replace("Z", "").strip()[:19]

    since_n = _norm(since)
    until_n = _norm(until)
    params: list[Any] = []
    where = []
    # submitted_at ممکن است با T یا فاصله ذخیره شده باشد
    ts_expr = "REPLACE(REPLACE(COALESCE(submitted_at,''), 'T', ' '), 'Z', '')"
    if since_n:
        where.append(f"{ts_expr} >= ?")
        params.append(since_n)
    if until_n:
        where.append(f"{ts_expr} <= ?")
        params.append(until_n)
    wsql = (" AND " + " AND ".join(where)) if where else ""

    messages = await db_fetchall(
        f"""
        SELECT *
        FROM messages
        WHERE 1=1 {wsql}
        ORDER BY id ASC
        """,
        tuple(params),
    )

    # شیفت‌های مرتبط با بازه (بر اساس specific_date یا همه permanent)
    shifts = await db_fetchall(
        """
        SELECT s.*, a.name AS admin_name
        FROM shifts s
        LEFT JOIN admins a ON a.user_id = s.admin_id
        ORDER BY s.id DESC
        LIMIT 500
        """
    )

    # کاربران فعال در بازه (ارسال‌کننده پیام)
    user_ids = sorted({int(m["user_id"]) for m in messages if m["user_id"] is not None})
    users = []
    for uid in user_ids:
        try:
            u = await asyncio.to_thread(db.get_user, uid)
            if u:
                users.append(u)
        except Exception:
            pass

    admins = await db_fetchall(
        "SELECT * FROM admins ORDER BY user_id ASC"
    )
    return messages, shifts, users, admins


def _build_log_txt(
    messages,
    shifts,
    users,
    admins,
    since: str,
    until: str,
) -> str:
    lines: list[str] = []
    lines.append("=" * 60)
    lines.append("گزارش کامل ربات / Full Bot Report")
    lines.append(f"از / From: {since}")
    lines.append(f"تا / Until: {until}")
    lines.append(f"زمان تولید / Generated: {local_now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 60)
    lines.append("")

    lines.append("──────── پیام‌های کاربران / User Messages ────────")
    lines.append("")
    if not messages:
        lines.append("(خالی / empty)")
    for m in messages:
        mid = m["id"]
        uid = m["user_id"]
        st = m["status"]
        ch = m["channel_key"] or DEFAULT_CHANNEL_KEY
        ch_title = CHANNELS.get(ch, {}).get("title", ch)
        admin_id = m["admin_id"]
        content = (m["content"] or "").replace("\n", " ")
        if len(content) > 200:
            content = content[:200] + "…"
        lines.append(f"#{mid}")
        lines.append(f"  FA | وضعیت: {_status_label_fa(st)} | کانال: {ch_title}")
        lines.append(f"  EN | Status: {_status_label_en(st)} | Channel: {ch}")
        lines.append(f"  Sender ID / ایدی فرستنده: {uid}")
        lines.append(f"  Admin received / ادمین دریافت‌کننده: {admin_id or '-'}")
        lines.append(f"  Time / زمان: {format_dt_fa(m['submitted_at'])}")
        if st == "rejected" and m["reject_reason"]:
            lines.append(f"  Reject reason / دلیل رد: {m['reject_reason']}")
        lines.append(f"  Text / متن: {content}")
        lines.append("")

    lines.append("──────── شیفت‌ها و فعالیت ادمین / Shifts & Admin Activity ────────")
    lines.append("")
    if not shifts:
        lines.append("(خالی / empty)")
    for s in shifts:
        sk = s["channel_key"] or DEFAULT_CHANNEL_KEY
        lines.append(
            f"Shift #{s['id']} | Admin {s['admin_id']} ({s['admin_name'] or '-'}) | "
            f"{s['start_time']}-{s['end_time']} | "
            f"{'permanent' if s['permanent'] else s['specific_date'] or '-'} | ch={sk}"
        )
    lines.append("")

    lines.append("──────── ادمین‌ها / Admins ────────")
    lines.append("")
    for a in admins:
        lines.append(
            f"Admin {a['user_id']} | name={a['name'] or '-'} | "
            f"active={a['active']} | channels={a['channel_key'] or '-'}"
        )
    lines.append("")

    lines.append("──────── کاربران فعال / Active Users ────────")
    lines.append("")
    if not users:
        lines.append("(خالی / empty)")
    for u in users:
        try:
            uid = u["user_id"]
            uname = u["username"] or "-"
            fn = u["first_name"] or ""
            ln = u["last_name"] or ""
            started = u["started"] if "started" in u.keys() else "-"
            lines.append(
                f"User {uid} | @{uname} | {fn} {ln} | started={started}"
            )
        except Exception:
            lines.append(str(dict(u) if hasattr(u, "keys") else u))
    lines.append("")
    lines.append("=" * 60)
    lines.append("پایان گزارش / End of report")
    return "\n".join(lines)


def _build_log_xlsx(
    path: str,
    messages,
    shifts,
    users,
    admins,
    since: str,
    until: str,
):
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

    wb = Workbook()
    # فونت سازگار با فارسی
    fa_font = Font(name="Tahoma", size=11)
    fa_bold = Font(name="Tahoma", size=11, bold=True)

    def _clean(val):
        if val is None:
            return ""
        s = str(val)
        try:
            s = ILLEGAL_CHARACTERS_RE.sub("", s)
        except Exception:
            pass
        return s

    # Sheet 1 messages
    ws = wb.active
    ws.title = "Messages"
    try:
        ws.sheet_view.rightToLeft = True
    except Exception:
        pass
    headers = [
        "ID", "Sender ID", "Status FA", "Status EN", "Channel",
        "Admin ID", "Submitted At", "Reject Reason", "Text",
    ]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = fa_bold
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    # عرض ستون‌ها برای فارسی
    col_widths = {
        "A": 10, "B": 14, "C": 16, "D": 16, "E": 18,
        "F": 12, "G": 22, "H": 18, "I": 50,
    }
    for col, w in col_widths.items():
        ws.column_dimensions[col].width = w
    for m in messages:
        st = m["status"]
        ch = m["channel_key"] or DEFAULT_CHANNEL_KEY
        ch_title = CHANNELS.get(ch, {}).get("title", ch)
        content = (m["content"] or "")[:500]
        row_vals = [
            m["id"],
            m["user_id"],
            _clean(_status_label_fa(st)),
            _clean(_status_label_en(st)),
            _clean(ch_title),
            m["admin_id"],
            _clean(format_dt_fa(m["submitted_at"])),
            _clean(m["reject_reason"] if st == "rejected" else ""),
            _clean(content),
        ]
        ws.append(row_vals)
        for cell in ws[ws.max_row]:
            cell.font = fa_font
            cell.alignment = Alignment(
                wrap_text=True, vertical="top", readingOrder=2
            )

    ws2 = wb.create_sheet("Shifts")
    ws2.append([
        "Shift ID", "Admin ID", "Admin Name", "Start", "End",
        "Permanent", "Date", "Channel",
    ])
    for cell in ws2[1]:
        cell.font = fa_bold
    for s in shifts:
        ws2.append([
            s["id"],
            s["admin_id"],
            _clean(s["admin_name"]),
            _clean(s["start_time"]),
            _clean(s["end_time"]),
            "yes" if s["permanent"] else "no",
            _clean(s["specific_date"]),
            _clean(s["channel_key"] or DEFAULT_CHANNEL_KEY),
        ])
        for cell in ws2[ws2.max_row]:
            cell.font = fa_font

    ws3 = wb.create_sheet("Admins")
    ws3.append(["User ID", "Name", "Active", "Channels", "Notifications"])
    for cell in ws3[1]:
        cell.font = fa_bold
    for a in admins:
        ws3.append([
            a["user_id"],
            _clean(a["name"]),
            a["active"],
            _clean(a["channel_key"]),
            a["notifications_enabled"] if "notifications_enabled" in a.keys() else "",
        ])
        for cell in ws3[ws3.max_row]:
            cell.font = fa_font

    ws4 = wb.create_sheet("Users")
    ws4.append(["User ID", "Username", "First Name", "Last Name", "Started"])
    for cell in ws4[1]:
        cell.font = fa_bold
    for u in users:
        try:
            ws4.append([
                u["user_id"],
                _clean(u["username"]),
                _clean(u["first_name"]),
                _clean(u["last_name"]),
                u["started"] if "started" in u.keys() else "",
            ])
            for cell in ws4[ws4.max_row]:
                cell.font = fa_font
        except Exception:
            pass

    ws5 = wb.create_sheet("Meta")
    ws5.append(["Key", "Value"])
    ws5.append(["From", format_dt_fa(since)])
    ws5.append(["Until", format_dt_fa(until)])
    ws5.append(["Generated", format_dt_fa(local_now())])
    ws5.append(["Messages count", len(messages)])
    ws5.append(["Users count", len(users)])
    ws5.append(["Shifts count", len(shifts)])

    # عرض ستون‌ها برای فارسی خوانا
    for sheet in wb.worksheets:
        for col in sheet.columns:
            letter = col[0].column_letter
            max_len = 12
            for cell in col:
                try:
                    max_len = max(max_len, min(len(str(cell.value or "")), 60))
                except Exception:
                    pass
            sheet.column_dimensions[letter].width = max_len + 2

    wb.save(path)


async def _progress_edit(msg: Message | None, pct: int, label: str = ""):
    if not msg:
        return
    p = max(0, min(100, int(pct)))
    filled = p // 10
    bar = "▓" * filled + "░" * (10 - filled)
    text = f"📋 آماده‌سازی لاگ...\n{bar} {p}%"
    if label:
        text += f"\n{label}"
    try:
        await msg.edit_text(text)
    except Exception:
        pass


async def generate_and_send_log(
    bot: Bot,
    recipients: list[int],
    since: str | None = None,
    until: str | None = None,
    progress_to: int | None = None,
) -> bool:
    """
    ساخت فایل متنی + اکسل و ارسال به لیست مالکین.
    داده لاگ در دیتابیس ذخیره نمی‌شود؛ فقط زمان آخرین ارسال ثبت می‌شود.
    """
    progress_msg = None
    if progress_to:
        try:
            progress_msg = await bot.send_message(
                progress_to,
                f"📋 آماده‌سازی لاگ...\n{_progress_bar(0)}",
            )
        except Exception:
            progress_msg = None

    try:
        await _progress_edit(progress_msg, 10, "تعیین بازه زمانی...")
        until = until or local_now().strftime("%Y-%m-%d %H:%M:%S")
        if not since:
            # از نزدیک‌ترین مرز ۱۲:۰۰ یا ۰۰:۰۰ گذشته
            # اگر تازه به مرز رسیده‌ایم (کمتر از ۳۰ دقیقه)، دورهٔ قبلی را بگیر
            # تا لاگ خالی نشود (مثلاً ۱۲:۰۰:۲۴ → از ۰۰:۰۰ همان روز)
            now = local_now()
            if now.hour >= 12:
                boundary = now.replace(
                    hour=12, minute=0, second=0, microsecond=0
                )
            else:
                boundary = now.replace(
                    hour=0, minute=0, second=0, microsecond=0
                )
            if (now - boundary) < timedelta(minutes=30):
                boundary = boundary - timedelta(hours=12)
            since = boundary.strftime("%Y-%m-%d %H:%M:%S")

        await _progress_edit(progress_msg, 30, "خواندن پیام‌ها و کاربران...")
        messages, shifts, users, admins = await _fetch_log_window(since, until)

        await _progress_edit(progress_msg, 50, "ساخت فایل متنی...")
        txt_body = await asyncio.to_thread(
            _build_log_txt, messages, shifts, users, admins, since, until
        )

        stamp = local_now().strftime("%Y%m%d_%H%M%S")
        tmpdir = tempfile.mkdtemp(prefix="botlog_")
        txt_path = os.path.join(tmpdir, f"log_{stamp}.txt")
        xlsx_path = os.path.join(tmpdir, f"log_{stamp}.xlsx")

        def _write_txt():
            # utf-8-sig تا در ویندوز/اکسل فارسی درست دیده شود (نه \uXXXX)
            with open(txt_path, "w", encoding="utf-8-sig", newline="\n") as f:
                f.write(txt_body)

        await asyncio.to_thread(_write_txt)

        await _progress_edit(progress_msg, 70, "ساخت فایل اکسل...")
        await asyncio.to_thread(
            _build_log_xlsx, xlsx_path, messages, shifts, users, admins, since, until
        )

        await _progress_edit(progress_msg, 85, "ارسال به مالکین...")
        caption = (
            f"📋 لاگ ربات\n"
            f"🕐 از: {format_dt_fa(since)}\n"
            f"🕐 تا: {format_dt_fa(until)}\n"
            f"📨 پیام‌ها: {len(messages)}\n"
            f"👤 کاربران فعال: {len(users)}"
        )

        if not recipients:
            recipients = get_log_recipients()

        for rid in recipients:
            try:
                await bot.send_document(
                    rid,
                    document=FSInputFile(txt_path),
                    caption=caption + "\n📄 نسخه متنی / Text",
                )
                await asyncio.sleep(0.2)
                await bot.send_document(
                    rid,
                    document=FSInputFile(xlsx_path),
                    caption="📊 نسخه اکسل / Excel",
                )
                await asyncio.sleep(0.2)
            except Exception:
                logger.exception("SEND LOG TO OWNER ERROR | owner=%s", rid)

        set_setting("last_log_sent_at", until)
        # اسلات زمان‌بندی (برای جلوگیری از ارسال تکراری ۱۲/۰۰)
        set_setting(
            "last_log_slot",
            local_now().strftime("%Y-%m-%d %H"),
        )

        await _progress_edit(progress_msg, 100, "✅ ارسال شد")
        if progress_msg:
            try:
                await progress_msg.edit_text(
                    f"✅ لاگ با موفقیت ارسال شد.\n"
                    f"📨 {len(messages)} پیام | 👤 {len(users)} کاربر\n"
                    f"🕐 {since} → {until}"
                )
            except Exception:
                pass

        # پاک کردن فایل‌های موقت — در DB ذخیره نمی‌شوند
        for p in (txt_path, xlsx_path):
            try:
                os.remove(p)
            except Exception:
                pass
        try:
            os.rmdir(tmpdir)
        except Exception:
            pass

        return True
    except Exception:
        logger.exception("GENERATE LOG ERROR")
        if progress_msg:
            try:
                await progress_msg.edit_text("❌ ساخت/ارسال لاگ ناموفق بود.")
            except Exception:
                pass
        return False


async def send_daily_shift_report(bot: Bot):
    """
    ۱ دقیقه مانده به پایان روز:
    برای هر گروه شیفت کانال، گزارش شیفت‌ها و عملکرد ادمین‌های همان کانال.
    """
    today = today_string()
    fa_today = format_dt_fa(today)

    for ch_key, cfg in CHANNELS.items():
        group_id = cfg.get("group_id")
        if not group_id:
            continue
        title = cfg["title"]
        try:
            shifts = await db_fetchall(
                """
                SELECT s.*, a.name AS admin_name
                FROM shifts s
                LEFT JOIN admins a ON a.user_id = s.admin_id
                WHERE (
                        s.specific_date = ?
                        OR (s.permanent = 1 AND (s.specific_date IS NULL OR s.specific_date = ''))
                      )
                  AND (
                        s.channel_key = ?
                        OR (
                            (? = ?)
                            AND (s.channel_key IS NULL OR s.channel_key = '')
                        )
                      )
                ORDER BY s.start_time ASC
                """,
                (today, ch_key, ch_key, DEFAULT_CHANNEL_KEY),
            )
        except Exception:
            logger.exception("DAILY SHIFT LOAD | ch=%s", ch_key)
            shifts = []

        lines = [
            f"📅 گزارش پایان روز — {title}",
            f"🗓 {fa_today}",
            "━━━━━━━━━━━━━━",
            "",
            "⏰ شیفت‌های امروز:",
        ]
        if not shifts:
            lines.append("شیفتی ثبت نشده.")
        else:
            for s in shifts:
                name = s["admin_name"] or str(s["admin_id"])
                lines.append(
                    f"• {s['start_time']}–{s['end_time']} | {name}"
                )

        lines.append("")
        lines.append("🛡 عملکرد ادمین‌ها:")
        try:
            if ch_key == DEFAULT_CHANNEL_KEY:
                perf = await db_fetchall(
                    """
                    SELECT
                        admin_id,
                        COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved,
                        COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected
                    FROM messages
                    WHERE admin_id IS NOT NULL
                      AND submitted_at LIKE ?
                      AND status IN ('approved', 'rejected')
                      AND (
                            channel_key = ?
                            OR channel_key IS NULL
                            OR channel_key = ''
                          )
                    GROUP BY admin_id
                    """,
                    (f"{today}%", ch_key),
                )
            else:
                perf = await db_fetchall(
                    """
                    SELECT
                        admin_id,
                        COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved,
                        COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected
                    FROM messages
                    WHERE admin_id IS NOT NULL
                      AND submitted_at LIKE ?
                      AND status IN ('approved', 'rejected')
                      AND channel_key = ?
                    GROUP BY admin_id
                    """,
                    (f"{today}%", ch_key),
                )
        except Exception:
            logger.exception("DAILY PERF | ch=%s", ch_key)
            perf = []

        if not perf:
            lines.append("بررسی ثبت‌شده‌ای نبود.")
        else:
            for p in perf:
                aid = p["admin_id"]
                aname = str(aid)
                try:
                    ar = await asyncio.to_thread(db.get_admin, int(aid))
                    if ar and ar["name"]:
                        aname = ar["name"]
                except Exception:
                    pass
                lines.append(
                    f"• {aname}: ✅ {p['approved']} تأیید | ❌ {p['rejected']} رد"
                )

        text = "\n".join(lines)
        try:
            await bot.send_message(int(group_id), text)
            await asyncio.sleep(0.2)
        except Exception:
            logger.exception(
                "DAILY REPORT GROUP SEND | ch=%s group=%s", ch_key, group_id
            )

    # برای مالکین هم یک نسخه خلاصه
    for rid in get_log_recipients():
        try:
            await bot.send_message(
                rid,
                f"📅 گزارش پایان روز ارسال شد.\n🗓 {fa_today}\n"
                "نسخهٔ هر کانال در گروه شیفت همان کانال قرار گرفت.",
            )
        except Exception:
            pass


async def log_scheduler(bot: Bot):
    """ارسال خودکار لاگ ۱۲/۰۰ و گزارش شیفت ۲۳:۵۹."""
    while True:
        try:
            now = local_now()
            if now.hour in (0, 12) and now.minute < 2:
                slot = now.strftime("%Y-%m-%d %H")
                last = get_setting("last_log_slot", "")
                if last != slot:
                    recipients = get_log_recipients()
                    if recipients:
                        # بازهٔ کامل ۱۲ ساعتهٔ قبلی — نه از همین لحظه
                        # ۱۲:۰۰ → از ۰۰:۰۰ تا ۱۲:۰۰
                        # ۰۰:۰۰ → از ۱۲:۰۰ دیروز تا ۰۰:۰۰
                        if now.hour >= 12:
                            until_dt = now.replace(
                                hour=12, minute=0, second=0, microsecond=0
                            )
                            since_dt = until_dt - timedelta(hours=12)
                        else:
                            until_dt = now.replace(
                                hour=0, minute=0, second=0, microsecond=0
                            )
                            since_dt = until_dt - timedelta(hours=12)
                        await generate_and_send_log(
                            bot,
                            recipients,
                            since=since_dt.strftime("%Y-%m-%d %H:%M:%S"),
                            until=until_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        )
                    else:
                        logger.warning("LOG SCHEDULER: no recipients registered")

            # گزارش شیفت و عملکرد — هر شب ۲۳:۵۹
            if now.hour == 23 and now.minute >= 59:
                slot = now.strftime("%Y-%m-%d 2359")
                last = get_setting("last_daily_shift_report", "")
                if last != slot:
                    set_setting("last_daily_shift_report", slot)
                    await send_daily_shift_report(bot)

            await asyncio.sleep(40)
        except Exception:
            logger.exception("LOG SCHEDULER ERROR")
            await asyncio.sleep(60)


@router.message(
    F.text == "📋 لاگ در لحظه",
    F.chat.type == "private",
)
async def owner_instant_log(
    message: Message,
    bot: Bot,
):
    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return

    uid = message.from_user.id
    _register_log_recipient(uid)

    if uid in _log_in_progress:
        await message.answer(
            "⏳ لاگ در حال آماده‌سازی است. لطفاً صبر کنید.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
        )
        return

    _log_in_progress.add(uid)
    try:
        await generate_and_send_log(
            bot,
            recipients=[uid],
            progress_to=uid,
        )
    finally:
        _log_in_progress.discard(uid)

    await message.answer(
        "پنل مالک:",
        reply_markup=owner_keyboard(db.is_bot_enabled()),
    )


# =========================================================
# OWNER SEARCH (پیام / کاربر)
# =========================================================

@router.message(
    F.text == "🔍 جستجو",
    F.chat.type == "private",
)
async def owner_search_menu(
    message: Message,
):
    if not await asyncio.to_thread(db.is_owner, message.from_user.id):
        return
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                _btn("🔎 جستجو پیام", "search:msg", style="primary"),
            ],
            [
                _btn("👤 جستجو کاربر", "search:user", style="primary"),
            ],
        ]
    )
    await message.answer(
        "🔍 چه چیزی را می‌خواهی جستجو کنی؟",
        reply_markup=kb,
    )


@router.callback_query(F.data == "search:msg")
async def search_msg_start(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    set_state(callback.from_user.id, "search_message")
    await callback.answer()
    await callback.message.answer(
        "🔎 آیدی عددی پیام را بفرست (مثلاً 389):",
        reply_markup=back_keyboard(),
    )


@router.callback_query(F.data == "search:user")
async def search_user_start(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    set_state(callback.from_user.id, "search_user")
    await callback.answer()
    await callback.message.answer(
        "👤 آیدی عددی کاربر را بفرست:",
        reply_markup=back_keyboard(),
    )


@router.callback_query(F.data.startswith("search_user_ch:"))
async def search_user_channel_msgs(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    parts = callback.data.split(":")
    if len(parts) != 3:
        await callback.answer()
        return
    try:
        target = int(parts[1])
        ch = parts[2]
    except Exception:
        await callback.answer("نامعتبر", show_alert=True)
        return
    if ch not in CHANNELS:
        await callback.answer("نامعتبر", show_alert=True)
        return
    await callback.answer()
    rows = await db_fetchall(
        """
        SELECT id, status, submitted_at, content, reject_reason
        FROM messages
        WHERE user_id = ?
          AND (
                channel_key = ?
                OR (? = ? AND (channel_key IS NULL OR channel_key = ''))
              )
        ORDER BY id DESC
        LIMIT 30
        """,
        (target, ch, ch, DEFAULT_CHANNEL_KEY),
    )
    title = CHANNELS[ch]["title"]
    if not rows:
        await callback.message.answer(f"پیامی در «{title}» یافت نشد.")
        return
    lines = [f"📋 پیام‌های کاربر {target} — {title}\n"]
    for r in rows:
        st = _status_label_fa(r["status"])
        preview = (r["content"] or "")[:80].replace("\n", " ")
        lines.append(f"#{r['id']} | {st}")
        lines.append(f"🕐 {r['submitted_at'] or '-'}")
        lines.append(f"📝 {preview}")
        if r["status"] == "rejected" and r["reject_reason"]:
            lines.append(f"دلیل: {r['reject_reason']}")
        lines.append("")
    # split if too long
    text = "\n".join(lines)
    if len(text) > 3500:
        text = text[:3500] + "\n…"
    await callback.message.answer(text)


@router.callback_query(F.data.startswith("user_peek:"))
async def owner_user_peek(callback: CallbackQuery):
    """جایگزین لینک پیوی وقتی username وجود ندارد."""
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    try:
        target = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer()
        return
    await callback.answer()
    try:
        u = await asyncio.to_thread(db.get_user, target)
    except Exception:
        u = None
    name = await get_profile_name(callback.bot, target)
    uname = ""
    if u and u["username"]:
        uname = f"@{u['username']}"
    total = 0
    try:
        total = get_user_total_messages(target)
    except Exception:
        pass
    blocked = False
    try:
        blocked = bool(db.is_blocked(target))
    except Exception:
        pass
    text = (
        f"👤 کاربر\n"
        f"نام: {escape(name)}\n"
        f"یوزرنیم: {escape(uname) if uname else '—'}\n"
        f"آیدی: <code>{target}</code>\n"
        f"تعداد پیام: {total}\n"
        f"وضعیت: {'🚫 بن' if blocked else '✅ فعال'}\n\n"
        "برای جزئیات کامل از «🔍 جستجو → جستجو کاربر» استفاده کن."
    )
    kb = []
    if uname:
        kb.append(
            [InlineKeyboardButton(text="فتح پروفایل", url=f"https://t.me/{uname.lstrip('@')}")]
        )
    kb.append(
        [
            _btn("🔎 جستجوی کامل", f"search_user_fill:{target}", style="primary"),
        ]
    )
    await callback.message.answer(
        text,
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(inline_keyboard=kb) if kb else None,
    )


@router.callback_query(F.data.startswith("search_user_fill:"))
async def search_user_fill(callback: CallbackQuery, bot: Bot):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    try:
        target = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer()
        return
    await callback.answer()
    # شبیه‌سازی ورود به state جستجوی کاربر با همان آیدی
    set_state(callback.from_user.id, "search_user")
    fake = callback.message
    # مستقیم همان منطق را با فراخوانی state handler سخت است؛ پیام راهنما:
    clear_state(callback.from_user.id)
    # اجرای دستی: از handle_state کپی نمی‌کنیم؛ یک پیام با آیدی می‌سازیم از طریق state
    set_state(callback.from_user.id, "search_user")
    from types import SimpleNamespace
    # ساده‌ترین راه: answer و set then process as text
    class _M:
        pass
    m = callback.message
    # reuse search by calling internal path via message.answer instruction
    await callback.message.answer(
        f"در حال بارگذاری کاربر `{target}`...",
        parse_mode=ParseMode.HTML,
    )
    # set state data and process
    states = None
    # Direct implementation reuse: put text and call handle_state
    try:
        set_state(callback.from_user.id, "search_user")
        # monkey: call handle_state with a synthetic message-like object is hard
        # instead run the same query logic briefly
        text = str(target)
        user_id = callback.from_user.id
        state = {"kind": "search_user"}
        # fall through by simulating - just show same as search_user block by reusing get_user
        u = await asyncio.to_thread(db.get_user, target)
        name = await get_profile_name(bot, target)
        if u:
            name = " ".join(
                x for x in (u["first_name"], u["last_name"]) if x
            ).strip() or (f"@{u['username']}" if u["username"] else name)
        uname = f"@{u['username']}" if u and u["username"] else ""
        counts = {}
        for ck, cfg in CHANNELS.items():
            try:
                if ck == DEFAULT_CHANNEL_KEY:
                    r = await db_fetchone(
                        """
                        SELECT COUNT(*) AS c FROM messages
                        WHERE user_id = ?
                          AND (channel_key = ? OR channel_key IS NULL OR channel_key = '')
                        """,
                        (target, ck),
                    )
                else:
                    r = await db_fetchone(
                        "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND channel_key = ?",
                        (target, ck),
                    )
                counts[ck] = int(r["c"] or 0) if r else 0
            except Exception:
                counts[ck] = 0
        total = sum(counts.values())
        blocked = False
        try:
            blocked = bool(db.is_blocked(target))
        except Exception:
            pass
        text_out = (
            f"👤 مشخصات کاربر\n\n"
            f"نام: {escape(name)}\n"
            f"یوزرنیم: {escape(uname) if uname else '—'}\n"
            f"آیدی: <code>{target}</code>\n"
            f"وضعیت بن: {'🚫 بن‌شده' if blocked else '✅ فعال'}\n\n"
            f"📊 تعداد پیام‌ها (کل: {total})\n"
        )
        for ck, cfg in CHANNELS.items():
            text_out += f"• {cfg['title']}: {counts.get(ck, 0)}\n"
        kb_rows = []
        for ck, cfg in CHANNELS.items():
            kb_rows.append(
                [
                    _btn(
                        f"📋 {cfg['title']} ({counts.get(ck, 0)})",
                        f"search_user_ch:{target}:{ck}",
                        style="primary",
                    )
                ]
            )
        kb_rows.append(
            [_btn("🚫 بن کاربر از ربات", f"ban_user:{target}", style="danger")]
        )
        clear_state(callback.from_user.id)
        await callback.message.answer(
            text_out,
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=kb_rows),
        )
    except Exception:
        logger.exception("SEARCH USER FILL ERROR")
        await callback.message.answer(GENERIC_ERROR)


@router.callback_query(F.data.startswith("ban_user:"))
async def owner_ban_user(callback: CallbackQuery):
    if not await asyncio.to_thread(db.is_owner, callback.from_user.id):
        await callback.answer("⛔ فقط مالک.", show_alert=True)
        return
    try:
        target = int(callback.data.split(":")[1])
    except Exception:
        await callback.answer()
        return
    if db.is_owner(target):
        await callback.answer("نمی‌توان مالک را بن کرد.", show_alert=True)
        return
    try:
        if hasattr(db, "block_user"):
            await asyncio.to_thread(db.block_user, target)
        else:
            await db_execute(
                "UPDATE users SET blocked = 1 WHERE user_id = ?",
                (target,),
            )
            await db_commit()
    except Exception:
        logger.exception("BAN USER ERROR | %s", target)
        await callback.answer(GENERIC_ERROR, show_alert=True)
        return
    await callback.answer("کاربر بن شد.", show_alert=True)
    try:
        await callback.message.answer(f"🚫 کاربر `{target}` از ربات بن شد.")
    except Exception:
        pass


async def main():

    global shift_task
    global cleanup_task
    global BOT_USERNAME
    global BOT_ID

    ensure_runtime_schema()

    bot = Bot(
        token=BOT_TOKEN,
        session=build_telegram_session(),
    )

    me = await bot.get_me()

    BOT_ID = me.id

    BOT_USERNAME = (
        me.username or ""
    )

    logger.info(
        "Bot started: @%s | ID=%s",
        BOT_USERNAME,
        BOT_ID,
    )

    await setup_commands(
        bot
    )

    dp = Dispatcher()

    dp.include_router(
        router
    )

    shift_task = asyncio.create_task(
        shift_monitor(
            bot
        )
    )

    cleanup_task = asyncio.create_task(
        cleanup_loop()
    )

    ann_task = asyncio.create_task(
        announcement_monitor(bot)
    )

    log_task = asyncio.create_task(
        log_scheduler(bot)
    )

    try:

        await dp.start_polling(
            bot
        )

    finally:

        if shift_task:
            shift_task.cancel()

        if cleanup_task:
            cleanup_task.cancel()

        if ann_task:
            ann_task.cancel()

        db.close()

        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
