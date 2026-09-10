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
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    MessageEntity,
    ReplyKeyboardMarkup,
    User,
)

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
    ضد پیام تکراری: اگر همین کاربر دقیقاً همین متن را
    در ۲۴ ساعت گذشته ارسال کرده باشد (و هنوز در دیتابیس باشد)
    True برمی‌گرداند. پیام‌هایی که مالک با پاک‌سازی صف حذف کرده
    دیگر در جدول نیستند و مانع ارسال مجدد نمی‌شوند.
    """
    cutoff = (local_now() - timedelta(hours=hours)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    # submitted_at ممکن است با فرمت‌های مختلف ذخیره شده باشد؛
    # مقایسه رشته‌ای برای ISO-like کار می‌کند.
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


PENDING_PAGE_SIZE = 12


def get_pending_rows_for_channel(
    channel_key: str,
    admin_id: int | None = None,
    limit: int = PENDING_PAGE_SIZE,
    offset: int = 0,
):
    """
    پیام‌های در انتظار یک کانال — صفحه‌بندی برای سرور ضعیف.
    پیام بدون channel_key فقط در کانال پیش‌فرض (صدام بزن) دیده می‌شود.
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
        if admin_id is None:
            return db.conn.execute(
                f"""
                SELECT *
                FROM messages
                WHERE status IN ('pending', 'queued', 'processing')
                  AND {ch_sql}
                ORDER BY id ASC
                LIMIT ? OFFSET ?
                """,
                (key, key, DEFAULT_CHANNEL_KEY, limit, offset),
            ).fetchall()

        return db.conn.execute(
            f"""
            SELECT *
            FROM messages
            WHERE status IN ('pending', 'queued', 'processing')
              AND {ch_sql}
              AND (
                    admin_id IS NULL
                    OR admin_id = ?
                    OR status = 'queued'
                  )
            ORDER BY id ASC
            LIMIT ? OFFSET ?
            """,
            (key, key, DEFAULT_CHANNEL_KEY, admin_id, limit, offset),
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
        if admin_id is None:
            row = db.conn.execute(
                f"""
                SELECT COUNT(*) AS c FROM messages
                WHERE status IN ('pending', 'queued', 'processing')
                  AND {ch_sql}
                """,
                (key, key, DEFAULT_CHANNEL_KEY),
            ).fetchone()
        else:
            row = db.conn.execute(
                f"""
                SELECT COUNT(*) AS c FROM messages
                WHERE status IN ('pending', 'queued', 'processing')
                  AND {ch_sql}
                  AND (admin_id IS NULL OR admin_id = ? OR status = 'queued')
                """,
                (key, key, DEFAULT_CHANNEL_KEY, admin_id),
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
                    text="📝 ارسال پیام"
                ),
                KeyboardButton(
                    text="📥 پیام‌های در انتظار"
                ),
            ],
            [
                KeyboardButton(
                    text="⏰ شیفت من"
                ),
                KeyboardButton(
                    text="📊 عملکرد من"
                ),
            ],
            [
                KeyboardButton(
                    text="🔔 اعلان‌ها"
                ),
                KeyboardButton(
                    text="🔄 درخواست تغییر شیفت"
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
                    text="📢 کانال"
                ),
                KeyboardButton(
                    text="📢 اطلاعیه‌ها"
                ),
            ],
            [
                KeyboardButton(
                    text="⚙️ تنظیمات"
                ),
                KeyboardButton(
                    text="❓ راهنما"
                ),
            ],
        ],
        resize_keyboard=True,
    )


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
            in REJECT_REASONS.items()
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
        can_pick_tomorrow = now.hour >= 22
        title = CHANNELS[group_ch]["title"]
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
            text_out = (
                f"👨‍💼 مدیریت شیفت — <b>{title}</b>\n\n"
                "شیفت فقط برای <b>امروز</b> قابل تعیین است.\n\n"
                "⏱ بازه‌های مجاز: فقط از <b>۱۲:۰۰ تا ۰۰:۰۰</b>"
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
            "از منوی مدیریت می‌توانی ادمین‌ها، "
            "شیفت‌ها، آمار، امنیت و تنظیمات را مدیریت کنی."
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
    F.text == "📝 ارسال پیام",
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
        10,
    )

    if not rows:

        await message.answer(
            "📊 هنوز پیامی ارسال نکرده‌ای.",
            reply_markup=user_keyboard(),
        )

        return

    status_map = {
        "queued": "🔵 در صف انتظار شیفت",
        "pending": "🟡 در انتظار بررسی",
        "processing": "🟠 در حال بررسی",
        "approved": "🟢 تأیید و منتشر شد",
        "rejected": "🔴 رد شد",
    }

    lines = [
        "📊 وضعیت پیام‌های اخیر\n"
    ]

    for row in rows:

        status = status_map.get(
            row["status"],
            row["status"],
        )

        lines.append(
            f"#{row['id']} — {status}"
        )

        if (
            row["status"] == "rejected"
            and row["reject_reason"]
        ):

            lines.append(
                f"دلیل: {row['reject_reason']}"
            )

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
    ادمین فقط اگر پیام برای او باشد و در شیفت فعال خودش باشد.
    """
    if db.is_owner(user_id):
        return True

    admin = db.get_admin(user_id)
    if not admin:
        return False

    try:
        row_admin = row["admin_id"] if not isinstance(row, dict) else row.get("admin_id")
    except Exception:
        row_admin = None

    # پیام بدون ادمین (queued) برای ادمین شیفت همان کانال مجاز است
    if row_admin is not None and int(row_admin) != int(user_id):
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
    # دکمه صفحه بعد
    if total_n > shown_to and channel_key:
        next_offset = offset + PENDING_PAGE_SIZE
        markup_inline = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    _btn(
                        f"📄 صفحه بعد ({shown_to + 1}…)",
                        f"pending_more:{channel_key}:{next_offset}:{'1' if is_owner else '0'}",
                        style="primary",
                    )
                ]
            ]
        )
        await bot.send_message(
            chat_id=user_id,
            text=summary,
            reply_markup=markup_inline,
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

    reason = REJECT_REASONS.get(
        parts[2],
        REJECT_REASONS["no_reason"],
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
            "مثال:\n"
            "123456789\n"
            "@sixiren\n\n"
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

        lines.append(
            f"#{shift['id']} — {date_text}\n"
            f"👤 {escape(admin_name)}\n"
            f"⏰ {shift['start_time']} تا "
            f"{shift['end_time']}\n"
        )

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
    صدام بزن: فقط ۱۲:۰۰ تا ۰۰:۰۰
    این کاربر / تو زندگی بعدی: کل ۲۴ ساعت
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

    # صدام بزن محدود به ۱۲–۲۴؛ بقیه کانال‌ها ۰–۲۴
    if ch == "sadambazan":
        SHIFT_START_HOUR = 12
        SHIFT_END_HOUR = 24
    else:
        SHIFT_START_HOUR = 0
        SHIFT_END_HOUR = 24

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

    if ch_for_group == "sadambazan":
        range_hint = "۱۲:۰۰ تا ۰۰:۰۰"
    else:
        range_hint = "۰۰:۰۰ تا ۲۴:۰۰ (کل شبانه‌روز)"

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
        if ch_key == "sadambazan" and sh < 12:
            await callback.answer(
                "⛔ در کانال صدام بزن فقط بازه‌های ۱۲:۰۰ تا ۰۰:۰۰ مجاز است.",
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
                )
                buttons.append(
                    [
                        InlineKeyboardButton(
                            text=f"{i}. {label[:28]}",
                            url=f"tg://user?id={row['user_id']}",
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

    try:
        overall = _count_messages()
        today = today_string()
        today_stats = _count_messages(
            "WHERE submitted_at LIKE ?",
            (f"{today}%",),
        )
        week_stats = _count_messages(
            "WHERE submitted_at >= datetime('now', '-7 days')",
        )
        month_stats = _count_messages(
            "WHERE submitted_at >= datetime('now', '-30 days')",
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
            f"📅 <b>امروز</b>\n"
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
            f"🔴 {month_stats['rejected']}\n\n"
            "جزئیات بیشتر:"
        )

        await message.answer(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=owner_stats_keyboard(),
        )
    except Exception:
        logger.exception("OWNER STATS MENU ERROR")
        await message.answer(
            "❌ خطا در بارگذاری آمار. لاگ ثبت شد.",
            reply_markup=owner_keyboard(db.is_bot_enabled()),
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


@router.message(
    F.text == "⚙️ تنظیمات ربات",
    F.chat.type == "private",
)
def owner_runtime_settings_keyboard():
    dupe_on = anti_dupe_enabled()
    return InlineKeyboardMarkup(
        inline_keyboard=[
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
                    f"🤖 ربات: {'روشن' if db.is_bot_enabled() else 'خاموش'}",
                    "cfg:bot_toggle",
                    style="success" if db.is_bot_enabled() else "danger",
                )
            ],
            [
                _btn(
                    "🧪 تست هر ۳ کانال",
                    "cfg:test_channels",
                    style="primary",
                )
            ],
        ]
    )


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

        admin_id = None
        name = None

        if value.startswith("@"):

            row = find_user_by_username(
                value
            )

            if not row:

                await message.answer(
                    (
                        "❌ این username در دیتابیس پیدا نشد.\n\n"
                        "کاربر باید ابتدا ربات را Start کند."
                    )
                )

                return True

            if not row["started"]:

                await message.answer(
                    "❌ این کاربر هنوز ربات را Start نکرده."
                )

                return True

            admin_id = row["user_id"]

            name = " ".join(
                x
                for x in (
                    row["first_name"],
                    row["last_name"],
                )
                if x
            ).strip()

            if not name:
                name = (
                    f"@{row['username']}"
                )

        elif value.isdigit():

            admin_id = int(
                value
            )

            row = db.get_user(
                admin_id
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

                if (
                    not name
                    and row["username"]
                ):

                    name = (
                        f"@{row['username']}"
                    )

            if not name:

                try:

                    chat = await bot.get_chat(
                        admin_id
                    )

                    name = (
                        getattr(
                            chat,
                            "full_name",
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

                except Exception:
                    pass

            if not name:
                name = "ادمین"

        else:

            await message.answer(
                (
                    "❌ مقدار نامعتبر است.\n\n"
                    "مثال:\n"
                    "123456789\n"
                    "@sixiren"
                )
            )

            return True

        try:
            # اگر قبلاً ادمین است، فقط کانال جدید را اضافه می‌کنیم
            existing = db.get_admin(admin_id)
            if not existing:
                db.add_admin(
                    admin_id,
                    name,
                )
            ch = state.get("channel_key") or DEFAULT_CHANNEL_KEY
            set_admin_channel(admin_id, ch)

        except Exception:

            logger.exception(
                "ADD ADMIN ERROR"
            )

            await message.answer(
                "❌ افزودن ادمین ناموفق بود.\n"
                "لطفاً چند ثانیه بعد دوباره امتحان کنید."
            )

            return True

        clear_state(
            user_id
        )

        mention = await mention_user(
            bot,
            admin_id,
            name,
        )
        ch_title = CHANNELS.get(
            state.get("channel_key") or DEFAULT_CHANNEL_KEY,
            CHANNELS[DEFAULT_CHANNEL_KEY],
        )["title"]

        await message.answer(
            (
                f"✅ ادمین با موفقیت به «{ch_title}» اضافه شد.\n\n"
                f"👤 {mention}\n\n"
                "ℹ️ اگر این کاربر قبلاً ادمین کانال دیگری بود، "
                "الان ادمین هر دو کانال است."
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
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
            if sh < 12:
                await message.answer(
                    "⛔ فقط بازه‌های ۱۲:۰۰ تا ۰۰:۰۰ مجاز است."
                )
                return True

            # جلوگیری از شیفت تکراری یا هم‌پوشان در کانال
            if is_shift_slot_taken(start, end, specific_date):
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

    if text == "📝 ارسال پیام":

        await user_send_start(
            message
        )

        return

    if text == "📊 وضعیت پیام من":

        await user_status(
            message
        )

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
            sk = None
            try:
                sk = shift["channel_key"]
            except Exception:
                sk = None
            sk = sk or DEFAULT_CHANNEL_KEY
            if sk != channel_key:
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
    ).fetchall()

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

    rows = await db_fetchall(
        """
        SELECT *
        FROM messages
        WHERE status = 'queued'
        ORDER BY submitted_at ASC, id ASC
        """
    )

    for row in rows:

        try:

            await db_execute(
                """
                UPDATE messages
                SET
                    admin_id = ?,
                    status = 'pending',
                    shift_id = ?
                WHERE id = ?
                  AND status = 'queued'
                """,
                (
                    shift["admin_id"],
                    shift["id"],
                    row["id"],
                ),
            )

            await db_commit()

            updated = await asyncio.to_thread(db.get_message, row["id"])

            sent = await send_review_message(
                bot,
                shift["admin_id"],
                updated,
            )

            await asyncio.to_thread(
                db.set_admin_message_id,
                row["id"],
                sent.message_id,
            )

        except Exception:

            logger.exception(
                "DISPATCH QUEUED MESSAGE ERROR | "
                "message_id=%s | shift_id=%s",
                row["id"],
                shift["id"],
            )

            try:
                await db_execute(
                    """
                    UPDATE messages
                    SET
                        status = 'queued',
                        admin_id = NULL
                    WHERE id = ?
                    """,
                    (row["id"],),
                )
                await db_commit()
            except Exception:
                logger.exception(
                    "DISPATCH RESTORE QUEUED ERROR | message_id=%s",
                    row["id"],
                )


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
            current = await get_current_shift_safe_async()

            if current:

                shift, start_dt = current

                key = (
                    start_dt.strftime("%Y-%m-%d"),
                    int(shift["id"]),
                )

                await dispatch_queued_messages(
                    bot,
                    shift,
                )

                if (
                    now >= start_dt
                    and now - start_dt < timedelta(minutes=1)
                    and key not in notified_shifts
                ):

                    notified_shifts.add(key)

                    if shift["notifications_enabled"]:

                        try:

                            await bot.send_message(
                                shift["admin_id"],
                                (
                                    "🔔 <b>شروع شیفت</b>\n\n"
                                    f"⏰ {shift['start_time']} تا "
                                    f"{shift['end_time']}\n\n"
                                    "📥 پیام‌های صف‌شده نیز بررسی شدند."
                                ),
                                parse_mode=ParseMode.HTML,
                            )

                        except (
                            TelegramForbiddenError,
                            TelegramBadRequest,
                        ):
                            pass

            # یادآوری هر ۱ دقیقه در ۵ دقیقهٔ آخر تا شروع شیفت
            next_item = await get_next_shift_async()
            if next_item:
                shift, start_dt = next_item
                delta = start_dt - now
                # بین ۰ تا ۵ دقیقه مانده
                if (
                    timedelta(seconds=0) < delta <= timedelta(minutes=5)
                    and shift["notifications_enabled"]
                ):
                    mins_left = max(1, int(delta.total_seconds() // 60) + (
                        1 if delta.total_seconds() % 60 else 0
                    ))
                    # کلید: تاریخ + id + دقیقه باقی‌مانده تا هر دقیقه یک‌بار
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
