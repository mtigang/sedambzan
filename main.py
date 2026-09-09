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

shift_task: asyncio.Task | None = None
cleanup_task: asyncio.Task | None = None

BOT_USERNAME = ""
BOT_ID = 0


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


# =========================================================
# GROUP CONFIGURATION
# =========================================================

def configured_group_id() -> int | None:
    value = get_setting(
        "admin_group_id"
    )

    if not value:
        return None

    try:
        return int(value)
    except ValueError:
        return None


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
    text = message.text or ""
    entities = message.entities or []

    if contains_blocked_word(text):
        return (
            False,
            "🚫 این پیام به دلیل استفاده از کلمات غیرمجاز قابل ارسال نیست.",
        )

    if not text.startswith(
        "صدام بزن"
    ):
        return (
            False,
            ERROR_MESSAGES["prefix"],
        )

    if not is_fully_bold(
        text,
        entities,
    ):
        return (
            False,
            ERROR_MESSAGES["bold"],
        )

    if not text.endswith(" ."):
        return (
            False,
            ERROR_MESSAGES["suffix"],
        )

    if contains_link(
        text,
        entities,
    ):
        return (
            False,
            ERROR_MESSAGES["link"],
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
                    text="📥 پیام‌های در انتظار"
                ),
                KeyboardButton(
                    text="⏰ شیفت من"
                ),
            ],
            [
                KeyboardButton(
                    text="📅 برنامه من"
                ),
                KeyboardButton(
                    text="📊 عملکرد من"
                ),
            ],
            [
                KeyboardButton(
                    text="🔄 درخواست تغییر شیفت"
                ),
                KeyboardButton(
                    text="🔔 اعلان‌ها"
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
                    text="📅 برنامه کاری/امروز"
                ),
            ],
            [
                KeyboardButton(
                    text="📊 آمار و گزارش‌ها"
                ),
                KeyboardButton(
                    text="📢 کانال"
                ),
            ],
            [
                KeyboardButton(
                    text="⚙️ تنظیمات ربات"
                ),
                KeyboardButton(
                    text="🛡️ امنیت و دسترسی"
                ),
            ],
            [
                KeyboardButton(
                    text=(
                        "🔴 خاموش کردن"
                        if enabled
                        else "🟢 روشن کردن"
                    )
                )
            ],
            [
                KeyboardButton(
                    text="❓ راهنما"
                ),
            ],
        ],
        resize_keyboard=True,
    )


def review_keyboard(
    message_id: int,
):
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🟢 تأیید و ارسال",
                    callback_data=(
                        f"approve:{message_id}"
                    ),
                ),
                InlineKeyboardButton(
                    text="🔴 رد",
                    callback_data=(
                        f"reject:{message_id}"
                    ),
                ),
            ]
        ]
    )


def reject_keyboard(
    message_id: int,
):
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=title,
                    callback_data=(
                        f"reject_reason:"
                        f"{message_id}:"
                        f"{key}"
                    ),
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

    if db.is_owner(user_id):

        await message.answer(
            (
                "👑 سلام مالک عزیز\n\n"
                "به مرکز کنترل ربات صدام بزن خوش آمدی.\n\n"
                f"🟢 وضعیت ربات: "
                f"{'فعال' if db.is_bot_enabled() else 'غیرفعال'}\n"
                f"👥 ادمین‌ها: "
                f"{db.count_admins()}\n"
                f"📥 پیام‌های در انتظار: "
                f"{db.count_pending()}"
            ),
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

        return

    admin = db.get_admin(
        user_id
    )

    if admin:

        await message.answer(
            (
                f"👋 سلام "
                f"{escape(await get_profile_name(bot, user_id, admin['name']))}\n\n"
                "شما ادمین ربات صدام بزن هستید."
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=admin_keyboard(),
        )

        return

    await message.answer(
        WELCOME_MESSAGE,
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
    # فقط شیفت امروز
    # =====================================================

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="📅 تعیین شیفت امروز",
                    callback_data="group_shift:today",
                )
            ]
        ]
    )

    await message.answer(
        (
            "👨‍💼 مدیریت شیفت\n\n"
            "شیفت فقط برای <b>امروز</b> قابل تعیین است.\n\n"
            "ساعت‌ها کاملاً آزاد هستند؛ حتی شیفت‌هایی مثل "
            "23:00 تا 02:00 هم قابل ثبت هستند."
        ),
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
    clear_state(
        message.from_user.id
    )

    mark_user_started(
        message.from_user
    )

    await show_home(
        message,
        bot,
    )


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

    if db.is_blocked(
        message.from_user.id
    ):

        await message.answer(
            ERROR_MESSAGES["blocked"]
        )

        return

    if not db.is_bot_enabled():

        await message.answer(
            ERROR_MESSAGES["bot_disabled"]
        )

        return

    set_state(
        message.from_user.id,
        "user_send",
    )

    await message.answer(
        (
            "📝 پیام خودت را بفرست.\n\n"
            "• با «صدام بزن» شروع شود\n"
            "• کل پیام Bold باشد\n"
            "• با « .» تمام شود\n"
            "• لینک نداشته باشد"
        ),
        reply_markup=back_keyboard(),
    )


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

    prefix = (
        f"📨 پیام جدید #{message_id}\n"
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
                owner_keyboard(
                    db.is_bot_enabled()
                )
                if db.is_owner(user_id)
                else admin_keyboard()
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

    await message.answer(
        summary,
        reply_markup=(
            owner_keyboard(
                db.is_bot_enabled()
            )
            if db.is_owner(user_id)
            else admin_keyboard()
        ),
    )


async def can_review(
    user_id: int,
    row,
):

    if db.is_owner(user_id):
        return True

    admin = db.get_admin(
        user_id
    )

    return bool(
        admin
        and admin["user_id"]
        == row["admin_id"]
    )


async def edit_original_admin_message(
    bot: Bot,
    row,
    text: str,
):

    if not row["admin_message_id"]:
        return

    try:

        await bot.edit_message_text(
            chat_id=row["admin_id"],
            message_id=row["admin_message_id"],
            text=text,
        )

    except Exception:
        pass


# =========================================================
# APPROVE
# =========================================================

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

    row = db.get_message(
        message_id
    )

    if not row:

        await callback.answer(
            "پیام پیدا نشد.",
            show_alert=True,
        )

        return

    if row["status"] != "pending":

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

    if not db.claim_message(
        message_id
    ):

        await callback.answer(
            "این پیام قبلاً بررسی شده.",
            show_alert=True,
        )

        return

    channel_id = db.get_channel_id()

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
            "CHANNEL PUBLISH ERROR | "
            "message_id=%s | channel_id=%s | error=%s",
            message_id,
            channel_id,
            e,
        )

        db.restore_pending(
            message_id
        )

        error_text = str(e).strip()

        if not error_text:
            error_text = (
                "خطای نامشخص Telegram"
            )

        await callback.answer(
            (
                "انتشار ناموفق بود:\n"
                f"{error_text[:180]}"
            ),
            show_alert=True,
        )

        return

    db.set_channel_message_id(
        message_id,
        sent.message_id,
    )

    db.set_message_status(
        message_id,
        "approved",
    )

    await callback.answer(
        "پیام منتشر شد."
    )

    await callback.message.edit_text(
        "🟢 ارسال شد",
        reply_markup=None,
    )

    await edit_original_admin_message(
        bot,
        row,
        "🟢 ارسال شد",
    )


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

    if row["status"] != "pending":

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

    if row["status"] != "pending":

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


@router.message(
    F.text == "📅 برنامه من",
    F.chat.type == "private",
)
async def admin_schedule(
    message: Message,
):

    user_id = message.from_user.id

    if not db.get_admin(user_id):
        return

    # =====================================================
    # ادمین فقط برنامه امروز خودش را می‌بیند
    # =====================================================

    shifts = db.get_admin_today_shifts(
        user_id,
        today_string(),
    )

    lines = [
        "📅 برنامه کاری امروز\n",
        f"📆 {today_string()}\n",
    ]

    if shifts:

        for shift in shifts:

            lines.append(
                f"⏰ {shift['start_time']} تا "
                f"{shift['end_time']}"
            )

    else:

        lines.append(
            "امروز شیفتی برای شما ثبت نشده."
        )

    await message.answer(
        "\n".join(lines),
        reply_markup=admin_keyboard(),
    )


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

    stats = db.admin_stats(
        user_id
    )

    reviewed = stats["reviewed"] or 0
    avg_seconds = stats["avg_seconds"] or 0
    avg_minutes = (
        avg_seconds / 60
        if reviewed
        else 0
    )

    await message.answer(
        (
            "📊 عملکرد من\n\n"
            f"📨 بررسی‌شده: "
            f"{reviewed}\n"
            f"🟢 تأییدشده: "
            f"{stats['approved']}\n"
            f"🔴 ردشده: "
            f"{stats['rejected']}\n"
            f"⏱ میانگین بررسی: "
            f"{avg_minutes:.1f} دقیقه"
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

    admins = db.get_admins()

    lines = [
        "👥 ادمین‌ها\n"
    ]

    if not admins:

        lines.append(
            "هیچ ادمینی ثبت نشده."
        )

    for admin in admins:

        mention = await mention_user(
            bot,
            admin["user_id"],
            admin["name"],
        )

        lines.append(
            f"• {mention}"
        )

    buttons = [[
        InlineKeyboardButton(
            text="➕ افزودن ادمین",
            callback_data="admin:add",
        )
    ]]

    if admins:
        buttons.append([InlineKeyboardButton(
            text="🗑 حذف ادمین",
            callback_data="admin:delete",
        )])

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=buttons
    )

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data == "admin:delete"
)
async def owner_delete_admin_start(
    callback: CallbackQuery,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    admins = db.get_admins()

    if not admins:
        await callback.answer(
            "⚠️ هیچ ادمینی ثبت نشده است.",
            show_alert=True,
        )
        return

    buttons = []

    for admin in admins:
        name = admin["name"] or str(admin["user_id"])

        buttons.append([InlineKeyboardButton(
            text=f"🗑 {name}",
            callback_data=f"admin:delete_select:{admin['user_id']}",
        )])

    buttons.append([InlineKeyboardButton(
        text="❌ انصراف",
        callback_data="admin:delete_cancel",
    )])

    await callback.answer()

    await callback.message.answer(
        "🗑 <b>حذف ادمین</b>\n\n"
        "ادمینی که می‌خواهی حذف شود را انتخاب کن:",
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        ),
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
    F.data == "admin:add"
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

    await callback.answer()

    set_state(
        callback.from_user.id,
        "add_admin",
    )

    await callback.message.answer(
        (
            "➕ افزودن ادمین\n\n"
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

    if not db.is_owner(
        message.from_user.id
    ):
        return

    shifts = db.get_all_shifts()

    lines = [
        "⏰ مدیریت شیفت‌ها\n"
    ]

    buttons = []

    for shift in shifts:

        admin_name = (
            shift["admin_name"]
            or await get_profile_name(
                bot,
                shift["admin_id"],
            )
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
                    callback_data=(
                        f"delete_shift:{shift['id']}"
                    ),
                )
            ]
        )

    buttons.append(
        [
            InlineKeyboardButton(
                text="➕ ایجاد شیفت",
                callback_data="shift:add",
            )
        ]
    )

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        ),
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
    F.data == "shift:add"
)
async def shift_add_start(
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
        "⏰ نوع شیفت را انتخاب کن.",
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data.startswith("shift_type:")
)
async def shift_type_callback(
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

    shift_type = callback.data.split(
        ":",
        1,
    )[1]

    admins = db.get_admins(
        active_only=True
    )

    if not admins:

        await callback.answer(
            "ابتدا یک ادمین اضافه کن.",
            show_alert=True,
        )

        return

    set_state(
        callback.from_user.id,
        "create_shift",
        permanent=(
            shift_type == "permanent"
        ),
    )

    buttons = []

    for admin in admins:

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

def group_shift_hourly_keyboard():
    now = local_now()

    buttons = []

    # بازه باقی‌مانده از ساعت فعلی
    # مثال: 18:27 تا 19:00
    # اگر ساعت فعلی نزدیک پایان شب باشد (مثلاً 23:15)، بازه‌ی باقی‌مانده
    # باید تا 00:00 (شروع روز بعد) به‌عنوان شیفت شب معتبر ثبت شود، نه
    # اینکه به‌خاطر next_hour == 24 کلاً حذف شود.
    if now.minute > 0 or now.second > 0 or now.microsecond > 0:
        next_hour = now.hour + 1

        end = f"{next_hour % 24:02d}:00"

        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"⏰ {now.strftime('%H:%M')} تا {end}",
                    callback_data=f"group_shift_time:{now.strftime('%H:%M')}-{end}",
                )
            ]
        )

        first_hour = now.hour + 1

    else:
        first_hour = now.hour

    # ساعت‌های کامل باقی‌مانده امروز
    for hour in range(first_hour, 24):
        start_time = f"{hour:02d}:00"
        end_hour = (hour + 1) % 24
        end_time = f"{end_hour:02d}:00"

        buttons.append(
            [
                InlineKeyboardButton(
                    text=f"⏰ {start_time} تا {end_time}",
                    callback_data=f"group_shift_time:{start_time}-{end_time}",
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

    group_id = configured_group_id()

    if (
        not callback.message
        or callback.message.chat.id != group_id
    ):

        await callback.answer(
            "این گروه مجاز نیست.",
            show_alert=True,
        )

        return

    admin = db.get_admin(
        callback.from_user.id
    )

    if not admin:

        await callback.answer(
            "⛔ شما ادمین ربات نیستید.",
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

    # =====================================================
    # فقط today مجاز است
    # =====================================================

    if mode != "today":

        await callback.answer(
            "⛔ فقط امکان تعیین شیفت امروز وجود دارد.",
            show_alert=True,
        )

        return

    set_state(
        callback.from_user.id,
        "group_shift",
        chat_id=group_id,
        mode="today",
        step="time",
        date=today_string(),
    )

    logger.info(
        "GROUP SHIFT MENU | user_id=%s | group_id=%s | date=%s",
        callback.from_user.id,
        group_id,
        today_string(),
    )

    await callback.answer()

    await callback.message.answer(
        (
            "📅 <b>شیفت امروز</b>\n\n"
            "⏰ یکی از بازه‌های یک‌ساعته زیر را انتخاب کن:"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=group_shift_hourly_keyboard(),
    )


# =========================================================
# GROUP SHIFT HOURLY CALLBACK
# =========================================================

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

        group_id = configured_group_id()

        if callback.message.chat.id != group_id:

            logger.warning(
                "GROUP SHIFT WRONG GROUP | user_id=%s | chat_id=%s | configured=%s",
                user_id,
                callback.message.chat.id,
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

        specific_date = today_string()

        logger.info(
            "GROUP SHIFT LIMIT CHECK | user_id=%s | start=%s | end=%s | date=%s",
            user_id,
            start,
            end,
            specific_date,
        )

        allowed, reason = db.check_admin_shift_limit(
            admin_id=user_id,
            start_time=start,
            end_time=end,
            specific_date=specific_date,
        )

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

            shift_id = db.create_shift(
                start_time=start,
                end_time=end,
                admin_id=user_id,
                permanent=False,
                specific_date=specific_date,
            )

        except Exception:

            logger.exception(
                "GROUP SHIFT DATABASE ERROR | user_id=%s | start=%s | end=%s | date=%s",
                user_id,
                start,
                end,
                specific_date,
            )

            await callback.answer(
                "❌ خطا در ثبت شیفت. لاگ ثبت شد.",
                show_alert=True,
            )

            await callback.message.answer(
                "❌ ثبت شیفت انجام نشد. خطای سیستم در لاگ ثبت شده است."
            )

            return

        clear_state(user_id)

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

        await callback.message.answer(
            (
                "✅ <b>شیفت شما با موفقیت ثبت شد.</b>\n\n"
                f"📅 تاریخ: <b>{specific_date}</b>\n"
                f"⏰ ساعت: <b>{start} تا {end}</b>\n\n"
                "🔁 این شیفت فقط برای امروز است."
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
        (
            "📊 آمار و گزارش‌ها\n\n"
            "بخش موردنظر را انتخاب کن:"
        ),
        reply_markup=owner_stats_keyboard(),
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

    if not db.is_owner(
        message.from_user.id
    ):
        return

    channel_id = db.get_channel_id()

    try:

        chat = await bot.get_chat(
            channel_id
        )

        title = (
            getattr(
                chat,
                "title",
                None,
            )
            or getattr(
                chat,
                "full_name",
                None,
            )
            or "کانال"
        )

        username = getattr(
            chat,
            "username",
            None,
        )

        public = (
            f"🔗 @{escape(username)}"
            if username
            else "🔒 کانال خصوصی"
        )

        connection = (
            "🟢 اتصال Telegram موفق"
        )

    except Exception as e:

        logger.exception(
            "CHANNEL GET_CHAT ERROR | "
            "channel_id=%s | error=%s",
            channel_id,
            e,
        )

        title = "کانال تنظیم‌شده"
        public = "❌ اتصال کانال ناموفق"
        connection = (
            f"🔴 خطا: {str(e)[:180]}"
        )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🔄 تغییر کانال",
                    callback_data="channel:change",
                )
            ]
        ]
    )

    await message.answer(
        (
            "📢 تنظیمات کانال\n\n"
            f"🏷 نام: "
            f"<b>{escape(title)}</b>\n"
            f"{public}\n\n"
            f"{connection}\n\n"
            "⚠️ برای انتشار پیام، ربات باید در کانال "
            "ادمین و دارای اجازه ارسال پیام باشد."
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=keyboard,
    )


@router.message(
    F.text == "⚙️ تنظیمات ربات",
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
            "⚙️ تنظیمات ربات\n\n"
            f"🟢 وضعیت: "
            f"{'فعال' if db.is_bot_enabled() else 'غیرفعال'}\n"
            f"🌐 منطقه زمانی: {TIMEZONE}\n"
            f"🚦 محدودیت ارسال: "
            f"{RATE_LIMIT_MAX_MESSAGES} پیام در "
            f"{RATE_LIMIT_WINDOW_SECONDS // 60} دقیقه\n"
            f"👥 گروه شیفت: "
            f"{'تنظیم شده' if group_id else 'تنظیم نشده'}"
        ),
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


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
    # USER MESSAGE
    # =====================================================

    if kind == "user_send":

        attempts = db.count_recent_attempts(
            user_id,
            RATE_LIMIT_WINDOW_SECONDS,
        )

        if attempts >= RATE_LIMIT_MAX_MESSAGES:

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

        current = get_current_shift_safe()

        entities = serialize_entities(
            message.entities
        )

        if not current:

            message_id = db.create_message(
                user_id,
                message.text,
                entities,
                None,
            )

            db.conn.execute(
                """
                UPDATE messages
                SET status = 'queued',
                    admin_id = NULL
                WHERE id = ?
                """,
                (message_id,),
            )

            db.conn.commit()

            next_shift = get_next_shift()

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
                    reply_markup=user_keyboard(),
                )

            else:

                await message.answer(
                    (
                        "✅ پیام ذخیره شد.\n\n"
                        "🕐 فعلاً شیفتی برای ارسال پیام وجود ندارد؛ "
                        "پیام حذف نمی‌شود."
                    ),
                    reply_markup=user_keyboard(),
                )

            clear_state(
                user_id
            )

            return True

        shift = current[0]
        admin_id = shift["admin_id"]

        message_id = db.create_message(
            user_id,
            message.text,
            entities,
            admin_id,
        )

        row = db.get_message(
            message_id
        )

        try:

            sent = await send_review_message(
                bot,
                admin_id,
                row,
            )

            db.set_admin_message_id(
                message_id,
                sent.message_id,
            )

            await message.answer(
                (
                    "✅ پیامت با موفقیت ارسال شد.\n\n"
                    "🟡 در انتظار بررسی ادمین است."
                ),
                reply_markup=user_keyboard(),
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

            db.set_message_status(
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

            db.add_admin(
                admin_id,
                name,
            )

        except Exception:

            logger.exception(
                "ADD ADMIN ERROR"
            )

            await message.answer(
                "❌ افزودن ادمین ناموفق بود."
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

        await message.answer(
            (
                "✅ ادمین با موفقیت اضافه شد.\n\n"
                f"👤 {mention}"
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

            try:

                shift_id = db.create_shift(
                    start_time=start,
                    end_time=end,
                    admin_id=state["admin_id"],
                    permanent=state["permanent"],
                    specific_date=state.get(
                        "specific_date"
                    ),
                )

            except Exception:

                logger.exception(
                    "OWNER CREATE SHIFT ERROR"
                )

                await message.answer(
                    "❌ ایجاد شیفت ناموفق بود."
                )

                return True

            clear_state(
                user_id
            )

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
        # امنیت:
        # گروه فقط باید شیفت امروز را ثبت کند.
        # ---------------------------------------------

        if state.get("mode") != "today":

            clear_state(
                user_id
            )

            await message.answer(
                "⛔ فقط امکان تعیین شیفت امروز وجود دارد."
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

            # -----------------------------------------
            # همیشه فقط امروز
            # -----------------------------------------

            permanent = False
            specific_date = today_string()

            # -----------------------------------------
            # بررسی محدودیت ادمین
            #
            # حداکثر:
            # ۲ شیفت
            # ۲ ساعت مجموع
            # -----------------------------------------

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

            # -----------------------------------------
            # ثبت شیفت
            # -----------------------------------------

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

            # -----------------------------------------
            # پایان state
            # -----------------------------------------

            clear_state(
                user_id
            )

            await message.answer(
                (
                    "✅ شیفت امروز شما ثبت شد.\n\n"
                    f"📅 {specific_date}\n"
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
                "ادمین‌ها، شیفت‌ها، آمار، امنیت و تنظیمات "
                "از منوی مدیریت قابل کنترل هستند."
            ),
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

    elif db.get_admin(user_id):

        await message.answer(
            (
                "👨‍💼 راهنمای ادمین\n\n"
                "پیام‌های در انتظار، شیفت امروز و عملکرد خودت "
                "را مدیریت کن."
            ),
            reply_markup=admin_keyboard(),
        )

    else:

        await message.answer(
            HELP_MESSAGE,
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

    touch_user(
        user
    )

    if await handle_state(
        message,
        bot,
    ):
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

    if text == "📅 برنامه من":

        await admin_schedule(
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

    if text == "📅 برنامه کاری/امروز":

        await owner_today_schedule(
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

    if text == "⚙️ تنظیمات ربات":

        await owner_settings(
            message
        )

        return

    if text == "🛡️ امنیت و دسترسی":

        await owner_security(
            message,
            bot,
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


def get_current_shift_safe():

    now = local_now()

    rows = db.conn.execute(
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

    for shift in rows:

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


def get_next_shift():

    now = local_now()

    rows = db.conn.execute(
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


# =========================================================
# QUEUED MESSAGE DISPATCH
# =========================================================

async def dispatch_queued_messages(
    bot: Bot,
    shift,
):

    rows = db.conn.execute(
        """
        SELECT *
        FROM messages
        WHERE status = 'queued'
        ORDER BY submitted_at ASC, id ASC
        """
    ).fetchall()

    for row in rows:

        try:

            db.conn.execute(
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

            db.conn.commit()

            updated = db.get_message(
                row["id"]
            )

            sent = await send_review_message(
                bot,
                shift["admin_id"],
                updated,
            )

            db.set_admin_message_id(
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

            db.conn.execute(
                """
                UPDATE messages
                SET
                    status = 'queued',
                    admin_id = NULL
                WHERE id = ?
                """,
                (row["id"],),
            )

            db.conn.commit()


# =========================================================
# SHIFT MONITOR
# =========================================================

async def shift_monitor(
    bot: Bot,
):

    global notified_shifts

    while True:

        try:

            current = get_current_shift_safe()

            if current:

                shift, start_dt = current

                key = (
                    start_dt.strftime(
                        "%Y-%m-%d"
                    ),
                    int(
                        shift["id"]
                    ),
                )

                await dispatch_queued_messages(
                    bot,
                    shift,
                )

                now = local_now()

                if (
                    now >= start_dt
                    and now - start_dt
                    < timedelta(minutes=1)
                    and key not in notified_shifts
                ):

                    notified_shifts.add(
                        key
                    )

                    if shift[
                        "notifications_enabled"
                    ]:

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

            if len(
                notified_shifts
            ) > 1000:

                notified_shifts = set(
                    list(
                        notified_shifts
                    )[-200:]
                )

        except Exception:

            logger.exception(
                "SHIFT MONITOR ERROR"
            )

        await asyncio.sleep(
            10
        )


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

    try:

        await dp.start_polling(
            bot
        )

    finally:

        if shift_task:
            shift_task.cancel()

        if cleanup_task:
            cleanup_task.cancel()

        db.close()

        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
