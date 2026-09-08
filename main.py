from __future__ import annotations

import asyncio
import html
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

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
    BOT_NAME,
)

from database import Database


# =========================================================
# Basic setup
# =========================================================

router = Router()

db = Database()

TZ = ZoneInfo(TIMEZONE)

states: dict[int, dict[str, Any]] = {}

# کلمات نامناسبی که در پیامهای ارسالی محدود میشوند.
# تطبیق با نرمالسازی حروف فارسی/عربی انجام میشود.
BLOCKED_WORDS = {
    "کیر",
    "کص",
    "کصکش",
    "کسکش",
    "کس",
    "جنده",
    "هرزه",
    "فاحشه",
}

def normalize_text_for_filter(text: str) -> str:
    value = (text or "").lower()
    replacements = {
        "ي": "ی",
        "ى": "ی",
        "ك": "ک",
        "ة": "ه",
        "ۀ": "ه",
        "": " ",
        "\u200d": " ",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    return re.sub(r"\s+", " ", value).strip()

def contains_blocked_word(text: str) -> str | None:
    normalized = normalize_text_for_filter(text)
    # جداکنندههای رایج را به فاصله تبدیل میکنیم تا شکلهای چسبیده/جدا
    # هم تا حد معمول شناسایی شوند.
    probe = re.sub(r"[^\wآ-ی]+", " ", normalized)
    words = set(probe.split())
    for word in BLOCKED_WORDS:
        if word in words:
            return word
    return None

# جلوگیری از اعلان دوباره شروع یک شیفت در همین اجرای ربات
notified_shifts: set[tuple[str, int]] = set()

shift_task: asyncio.Task | None = None
cleanup_task: asyncio.Task | None = None


# =========================================================
# State
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
# Helpers
# =========================================================

def local_now() -> datetime:
    return datetime.now(TZ)


def today_string() -> str:
    return local_now().strftime("%Y-%m-%d")


def current_time_string() -> str:
    """برای شیفتها فقط HH:MM استفاده میشود."""
    return local_now().strftime("%H:%M")


def full_name(user: User) -> str:
    name = " ".join(
        part
        for part in (
            user.first_name,
            user.last_name,
        )
        if part
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


def serialize_entities(
    entities: list[MessageEntity] | None,
):
    if not entities:
        return []

    result = []

    for entity in entities:
        data = {
            "type": entity_type(entity),
            "offset": entity.offset,
            "length": entity.length,
        }

        optional_fields = (
            "url",
            "language",
            "custom_emoji_id",
        )

        for field in optional_fields:
            value = getattr(
                entity,
                field,
                None,
            )

            if value is not None:
                data[field] = value

        user = getattr(
            entity,
            "user",
            None,
        )

        if user is not None:
            try:
                if hasattr(
                    user,
                    "model_dump",
                ):
                    data["user"] = user.model_dump(
                        exclude_none=True
                    )
                elif hasattr(
                    user,
                    "dict",
                ):
                    data["user"] = user.dict(
                        exclude_none=True
                    )
            except Exception:
                pass

        result.append(data)

    return result


def entity_from_dict(
    data: dict,
):
    kwargs = {
        "type": data.get("type"),
        "offset": int(
            data.get("offset", 0)
        ),
        "length": int(
            data.get("length", 0)
        ),
    }

    for field in (
        "url",
        "language",
        "custom_emoji_id",
    ):
        if data.get(field) is not None:
            kwargs[field] = data[field]

    user_data = data.get("user")

    if user_data:
        try:
            kwargs["user"] = User.model_validate(
                user_data
            )
        except Exception:
            try:
                kwargs["user"] = User(**user_data)
            except Exception:
                pass

    return MessageEntity(**kwargs)


def deserialize_entities(
    entities: list[dict] | None,
):
    if not entities:
        return []

    result = []

    for data in entities:
        try:
            result.append(
                entity_from_dict(data)
            )
        except Exception:
            continue

    return result


def shift_entities(
    entities: list[MessageEntity],
    prefix: str,
):
    shift = utf16_length(prefix)

    result = []

    for entity in entities:
        try:
            data = {
                "type": entity_type(entity),
                "offset": entity.offset + shift,
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

            user = getattr(
                entity,
                "user",
                None,
            )

            if user is not None:
                try:
                    data["user"] = user
                except Exception:
                    pass

            result.append(
                MessageEntity(**data)
            )

        except Exception:
            continue

    return result


# =========================================================
# Validation
# =========================================================

def is_fully_bold(
    text: str,
    entities: list[MessageEntity] | None,
) -> bool:
    if not text or not entities:
        return False

    total = utf16_length(text)

    bold_entities = [
        entity
        for entity in entities
        if entity_type(entity) == "bold"
    ]

    if not bold_entities:
        return False

    intervals = []

    for entity in bold_entities:
        start = entity.offset
        end = (
            entity.offset
            + entity.length
        )

        intervals.append(
            (start, end)
        )

    intervals.sort()

    covered = 0

    for start, end in intervals:
        if start > covered:
            return False

        if end > covered:
            covered = end

        if covered >= total:
            return True

    return covered >= total


def contains_link(
    text: str,
    entities: list[MessageEntity] | None,
) -> bool:
    if entities:
        for entity in entities:
            kind = entity_type(entity)

            if kind in (
                "url",
                "text_link",
            ):
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

    if not text.startswith("صدام بزن"):
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
# Human readable Telegram profiles
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
    now = asyncio.get_running_loop().time()

    cached = profile_cache.get(user_id)

    if cached:
        timestamp, name = cached

        if now - timestamp < 300:
            return name

    # اولویت اول: نام ذخیرهشده در جدول admins
    admin = db.get_admin(user_id)
    if admin and admin["name"] and not str(admin["name"]).isdigit():
        profile_cache[user_id] = (now, admin["name"])
        return admin["name"]

    try:
        chat = await bot.get_chat(user_id)

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

    row = db.get_user(user_id)

    if row:
        name = " ".join(
            part
            for part in (
                row["first_name"],
                row["last_name"],
            )
            if part
        ).strip()

        if name:
            profile_cache[user_id] = (
                now,
                name,
            )
            return name

        if row["username"]:
            name = f"@{row['username']}"
            profile_cache[user_id] = (
                now,
                name,
            )
            return name

    if admin and admin["name"]:
        return admin["name"]

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


async def channel_title(
    bot: Bot,
):
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

        return (
            title,
            username,
        )

    except Exception:
        return (
            "کانال تنظیمشده",
            None,
        )


# =========================================================
# Keyboards
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
                )
            ],
        ],
        resize_keyboard=True,
    )


def admin_keyboard():
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="📥 پیامهای در انتظار"
                ),
                KeyboardButton(
                    text="⏰ شیفت من"
                ),
                KeyboardButton(
                    text="⏰ انتخاب شیفت"
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
                    text="🔔 اعلانها"
                ),
            ],
            [
                KeyboardButton(
                    text="❓ راهنما"
                )
            ],
        ],
        resize_keyboard=True,
    )


def owner_keyboard(
    bot_enabled: bool,
):
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="📥 پیامهای در انتظار"
                ),
                KeyboardButton(
                    text="👥 ادمینها"
                ),
            ],
            [
                KeyboardButton(
                    text="⏰ شیفتها"
                ),
                KeyboardButton(
                    text="📅 برنامه کاری/امروز"
                ),
            ],
            [
                KeyboardButton(
                    text="📊 آمار و گزارشها"
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
                    text="❓ راهنما"
                ),
            ],
            [
                KeyboardButton(
                    text=(
                        "🟢 روشن کردن"
                        if not bot_enabled
                        else
                        "🔴 خاموش کردن"
                    )
                )
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
    buttons = []

    for key, title in REJECT_REASONS.items():
        buttons.append(
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
        )

    return InlineKeyboardMarkup(
        inline_keyboard=buttons
    )


# =========================================================
# Menus / Home
# =========================================================

async def show_home(
    message: Message,
    bot: Bot,
):
    user_id = message.from_user.id

    if db.is_owner(user_id):
        current = db.get_current_shift(
            local_now().weekday(),
            current_time_string(),
            today_string(),
        )

        if current:
            admin_mention = await mention_user(
                bot,
                current["admin_id"],
                current["admin_name"],
            )

            current_text = (
                f"{admin_mention} "
                f"({current['start_time']} تا "
                f"{current['end_time']})"
            )
        else:
            current_text = "ندارد"

        await message.answer(
            (
                "👑 سلام مالک عزیز\n"
                "به مرکز کنترل ربات صدام بزن خوش آمدی.\n\n"
                f"🟢 وضعیت ربات: "
                f"{'فعال' if db.is_bot_enabled() else 'غیرفعال'}\n"
                f"👥 ادمینها: {db.count_admins()}\n"
                f"📥 پیامهای در انتظار: "
                f"{db.count_pending()}\n"
                f"⏰ شیفت فعلی: {current_text}"
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=owner_keyboard(
                db.is_bot_enabled()
            ),
        )

        return

    admin = db.get_admin(user_id)

    if admin:
        current = db.get_current_shift(
            local_now().weekday(),
            current_time_string(),
            today_string(),
        )

        if (
            current
            and current["admin_id"] == user_id
        ):
            shift_status = "فعال"
            shift_time = (
                f"{current['start_time']} تا "
                f"{current['end_time']}"
            )
        else:
            shift_status = "غیرفعال"

            shifts = db.get_admin_today_shifts(
                user_id,
                today_string(),
            )

            if shifts:
                shift_time = (
                    f"{shifts[0]['start_time']} تا "
                    f"{shifts[0]['end_time']}"
                )
            else:
                shift_time = "ندارد"

        await message.answer(
            (
                f"👋 سلام "
                f"{escape(await get_profile_name(bot, user_id, admin['name']))}\n"
                "شما ادمین کانال صدام بزن هستید.\n\n"
                f"🟢 وضعیت شیفت: {shift_status}\n"
                f"⏰ شیفت امروز: {shift_time}\n"
                f"📥 پیامهای منتظر بررسی: "
                f"{len(db.get_pending_for_admin(user_id, 100))}\n\n"
                "اگر در ساعت مشخصشده امکان حضور ندارید، "
                "از همین ربات به مالک اطلاع دهید تا شیفت شما تغییر کند."
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
# Start / Help
# =========================================================

@router.message(CommandStart())
async def start_handler(
    message: Message,
    bot: Bot,
):
    clear_state(
        message.from_user.id
    )

    user = message.from_user

    db.upsert_user(
        user.id,
        user.username,
        user.first_name,
        user.last_name,
        started=True,
    )
    db.mark_user_started(user.id)

    await show_home(
        message,
        bot,
    )


@router.message(Command("help"))
async def help_command(
    message: Message,
):
    clear_state(
        message.from_user.id
    )

    if db.is_owner(
        message.from_user.id
    ):
        text = (
            "👑 راهنمای مالک\n\n"
            "از منوی ربات میتوانید ادمینها، "
            "شیفتها، کانال، امنیت، آمار و تنظیمات "
            "را مدیریت کنید."
        )

    elif db.get_admin(
        message.from_user.id
    ):
        text = (
            "👨‍💼 راهنمای ادمین\n\n"
            "پیامهای شیفت خود را بررسی کنید، "
            "برنامه و عملکرد خود را ببینید و در "
            "صورت نیاز درخواست تغییر شیفت بدهید."
        )

    else:
        text = HELP_MESSAGE

    await message.answer(
        text,
        reply_markup=(
            owner_keyboard(
                db.is_bot_enabled()
            )
            if db.is_owner(
                message.from_user.id
            )
            else
            admin_keyboard()
            if db.get_admin(
                message.from_user.id
            )
            else
            user_keyboard()
        ),
    )


# =========================================================
# User send
# =========================================================

@router.message(
    F.text == "📝 ارسال پیام"
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
            "حتماً این قوانین را رعایت کن:\n"
            "• با «صدام بزن» شروع شود\n"
            "• کل پیام Bold باشد\n"
            "• با « .» تمام شود\n"
            "• لینک نداشته باشد"
        ),
        reply_markup=back_keyboard(),
    )


# =========================================================
# User status
# =========================================================

@router.message(
    F.text == "📊 وضعیت پیام من"
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
            "📊 هنوز پیامی ارسال نکردهای.",
            reply_markup=user_keyboard(),
        )
        return

    status_map = {
        "pending": "🟡 در انتظار بررسی",
        "processing": "🟠 در حال بررسی",
        "approved": "🟢 تأیید و منتشر شد",
        "rejected": "🔴 رد شد",
    }

    lines = [
        "📊 وضعیت پیامهای اخیر\n"
    ]

    for row in rows:
        status = status_map.get(
            row["status"],
            row["status"],
        )

        lines.append(
            f"#{row['id']} — {status}"
        )

        if row["status"] == "rejected":
            if row["reject_reason"]:
                lines.append(
                    f"دلیل: "
                    f"{row['reject_reason']}"
                )

    await message.answer(
        "\n".join(lines),
        reply_markup=user_keyboard(),
    )


# =========================================================
# Admin pending
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
        f"👤 ارسالکننده: {sender}\n\n"
    )

    original_entities = deserialize_entities(
        row["entities"]
        if isinstance(row, dict)
        else []
    )

    entities = shift_entities(
        original_entities,
        prefix,
    )

    text = (
        prefix
        + row["content"]
    )

    sent = await bot.send_message(
        chat_id=chat_id,
        text=text,
        entities=entities,
        reply_markup=review_keyboard(
            message_id
        ),
    )

    return sent


@router.message(
    F.text == "📥 پیامهای در انتظار"
)
async def pending_messages(
    message: Message,
    bot: Bot,
):
    user_id = message.from_user.id

    if db.is_owner(user_id):
        rows = db.get_all_pending(
            PENDING_MESSAGES_PAGE_SIZE
        )
    elif db.get_admin(user_id):
        rows = db.get_pending_for_admin(
            user_id,
            PENDING_MESSAGES_PAGE_SIZE,
        )
    else:
        return

    if not rows:
        if db.is_owner(user_id):
            text = (
                "📥 پیام در انتظاری وجود ندارد.\n\n"
                "در حال حاضر هیچ پیامی برای بررسی نیست."
            )
        else:
            text = (
                "📥 فعلاً پیامی برای بررسی نداری."
            )

        await message.answer(
            text,
            reply_markup=(
                owner_keyboard(
                    db.is_bot_enabled()
                )
                if db.is_owner(user_id)
                else admin_keyboard()
            ),
        )

        return

    for row in rows:
        data = dict(row)

        data["entities"] = (
            __import__("json")
            .loads(
                data["entities_json"]
            )
            if data["entities_json"]
            else []
        )

        await send_review_message(
            bot,
            user_id,
            data,
        )

    await message.answer(
        (
            f"📥 {len(rows)} پیام برای بررسی نمایش داده شد."
        ),
        reply_markup=(
            owner_keyboard(
                db.is_bot_enabled()
            )
            if db.is_owner(user_id)
            else admin_keyboard()
        ),
    )


# =========================================================
# Approve / Reject
# =========================================================

async def can_review(
    user_id: int,
    row,
):
    if db.is_owner(user_id):
        return True

    admin = db.get_admin(user_id)

    if not admin:
        return False

    return (
        admin["user_id"]
        == row["admin_id"]
    )


async def edit_original_admin_message(
    bot: Bot,
    row,
    text: str,
):
    admin_id = row["admin_id"]
    admin_message_id = row[
        "admin_message_id"
    ]

    if not admin_message_id:
        return

    try:
        await bot.edit_message_text(
            chat_id=admin_id,
            message_id=admin_message_id,
            text=text,
            reply_markup=None,
        )
    except Exception:
        pass


@router.callback_query(
    F.data.startswith("approve:")
)
async def approve_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    await callback.answer()

    try:
        message_id = int(
            callback.data.split(":")[1]
        )
    except Exception:
        return

    row = db.get_message(
        message_id
    )

    if not row:
        await callback.message.edit_text(
            "❌ این پیام دیگر وجود ندارد.",
            reply_markup=None,
        )
        return

    if row["status"] != "pending":
        await callback.message.edit_text(
            (
                "ℹ️ این پیام قبلاً بررسی شده است.\n\n"
                f"وضعیت: {row['status']}"
            ),
            reply_markup=None,
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
            "این پیام قبلاً توسط شخص دیگری بررسی شده.",
            show_alert=True,
        )
        return

    channel_id = db.get_channel_id()

    entities = deserialize_entities(
        row["entities"]
    )

    try:
        sent = await bot.send_message(
            chat_id=channel_id,
            text=row["content"],
            entities=entities,
        )

    except Exception as exc:
        db.restore_pending(
            message_id
        )

        await callback.answer(
            "انتشار در کانال ناموفق بود.",
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

    db.log(
        callback.from_user.id,
        "message_approved",
        f"message={message_id}",
    )

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


@router.callback_query(
    F.data.startswith("reject:")
)
async def reject_callback(
    callback: CallbackQuery,
):
    await callback.answer()

    try:
        message_id = int(
            callback.data.split(":")[1]
        )
    except Exception:
        return

    row = db.get_message(
        message_id
    )

    if not row:
        await callback.message.edit_text(
            "❌ پیام پیدا نشد.",
            reply_markup=None,
        )
        return

    if row["status"] != "pending":
        await callback.message.edit_text(
            "ℹ️ این پیام قبلاً بررسی شده است.",
            reply_markup=None,
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
    await callback.answer()

    parts = callback.data.split(
        ":",
        2,
    )

    if len(parts) != 3:
        return

    try:
        message_id = int(parts[1])
    except Exception:
        return

    reason_key = parts[2]

    reason = REJECT_REASONS.get(
        reason_key,
        REJECT_REASONS["no_reason"],
    )

    row = db.get_message(
        message_id
    )

    if not row:
        await callback.message.edit_text(
            "❌ پیام پیدا نشد.",
            reply_markup=None,
        )
        return

    if row["status"] != "pending":
        await callback.message.edit_text(
            "ℹ️ این پیام قبلاً بررسی شده است.",
            reply_markup=None,
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

    db.log(
        callback.from_user.id,
        "message_rejected",
        (
            f"message={message_id};"
            f"reason={reason}"
        ),
    )

    text = (
        "🔴 رد شد\n\n"
        f"دلیل: {reason}"
    )

    try:
        await callback.message.edit_text(
            text,
            reply_markup=None,
        )
    except Exception:
        pass

    await edit_original_admin_message(
        bot,
        row,
        text,
    )


# =========================================================
# Admin schedule
# =========================================================

@router.message(
    F.text == "⏰ شیفت من"
)
async def admin_current_shift(
    message: Message,
):
    user_id = message.from_user.id

    if not db.get_admin(user_id):
        return

    shift = db.get_current_shift(
        local_now().weekday(),
        current_time_string(),
        today_string(),
    )

    if (
        shift
        and shift["admin_id"] == user_id
    ):
        await message.answer(
            (
                "🟢 شیفت فعلی شما فعال است.\n\n"
                f"⏰ {shift['start_time']} تا "
                f"{shift['end_time']}"
            ),
            reply_markup=admin_keyboard(),
        )
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
        "⏰ شیفتهای امروز شما\n"
    ]

    for shift in shifts:
        if shift["permanent"]:
            prefix = "🔁 دائمی"
        else:
            prefix = (
                f"📅 {shift['specific_date']}"
            )

        lines.append(
            f"{prefix}\n"
            f"{shift['start_time']} تا "
            f"{shift['end_time']}\n"
        )

    await message.answer(
        "\n".join(lines),
        reply_markup=admin_keyboard(),
    )


@router.message(
    F.text == "📅 برنامه من"
)
async def admin_schedule(
    message: Message,
):
    user_id = message.from_user.id

    if not db.get_admin(user_id):
        return

    permanent = db.get_permanent_shifts(
        user_id
    )

    dated = db.get_date_shifts(
        user_id
    )

    lines = [
        "📅 برنامه کاری من\n"
    ]

    if permanent:
        lines.append(
            "🔁 برنامه دائمی\n"
        )

        for shift in permanent:
            lines.append(
                "🔁 دائمی\n"
                f"{shift['start_time']} تا "
                f"{shift['end_time']}\n"
            )
    else:
        lines.append(
            "🔁 برنامه دائمی\n"
            "شیفت دائمی ثبت نشده.\n"
        )

    if dated:
        lines.append(
            "\n📅 شیفتهای تاریخدار\n"
        )

        for shift in dated:
            lines.append(
                f"📅 {shift['specific_date']}\n"
                f"{shift['start_time']} تا "
                f"{shift['end_time']}\n"
            )

    await message.answer(
        "\n".join(lines),
        reply_markup=admin_keyboard(),
    )


# =========================================================
# Admin stats
# =========================================================

@router.message(
    F.text == "📊 عملکرد من"
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

    avg_minutes = (
        stats["avg_seconds"]
        / 60
    )

    await message.answer(
        (
            "📊 عملکرد من\n\n"
            f"📨 بررسیشده: "
            f"{stats['reviewed']}\n"
            f"🟢 تأییدشده: "
            f"{stats['approved']}\n"
            f"🔴 ردشده: "
            f"{stats['rejected']}\n"
            f"⏱ میانگین زمان بررسی: "
            f"{avg_minutes:.1f} دقیقه"
        ),
        reply_markup=admin_keyboard(),
    )


# =========================================================
# Notifications
# =========================================================

@router.message(
    F.text == "🔔 اعلانها"
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
                        else
                        "🟢 روشن کردن"
                    ),
                    callback_data=(
                        "notif:off"
                        if enabled
                        else
                        "notif:on"
                    ),
                )
            ]
        ]
    )

    await message.answer(
        (
            "🔔 اعلانهای شروع شیفت\n\n"
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
    await callback.answer()

    admin = db.get_admin(
        callback.from_user.id
    )

    if not admin:
        return

    enabled = (
        callback.data == "notif:on"
    )

    db.set_admin_notifications(
        callback.from_user.id,
        enabled,
    )

    await callback.message.edit_text(
        (
            "🔔 اعلانهای شروع شیفت\n\n"
            f"وضعیت جدید: "
            f"{'🟢 فعال' if enabled else '🔴 غیرفعال'}"
        )
    )


# =========================================================
# Shift request
# =========================================================

@router.message(
    F.text == "🔄 درخواست تغییر شیفت"
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
        (
            "🔄 درخواست تغییر شیفت\n\n"
            "توضیح بده چه تغییری لازم داری "
            "و چرا."
        ),
        reply_markup=back_keyboard(),
    )


# =========================================================
# Owner - Admins
# =========================================================

@router.message(
    F.text == "👥 ادمینها"
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

    if not admins:
        text = (
            "👥 هیچ ادمینی ثبت نشده."
        )
    else:
        lines = [
            "👥 ادمینها\n"
        ]

        for admin in admins:
            mention = await mention_user(
                bot,
                admin["user_id"],
                admin["name"],
            )

            status = (
                "🟢 فعال"
                if admin["active"]
                else "🔴 غیرفعال"
            )

            lines.append(
                f"• {mention} — {status}"
            )

        text = "\n".join(lines)

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="➕ افزودن ادمین",
                    callback_data="admin:add",
                )
            ]
        ]
    )

    await message.answer(
        text,
        parse_mode=ParseMode.HTML,
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data == "admin:add"
)
async def owner_add_admin_start(
    callback: CallbackQuery,
):
    await callback.answer()

    if not db.is_owner(
        callback.from_user.id
    ):
        return

    set_state(
        callback.from_user.id,
        "add_admin",
    )

    await callback.message.answer(
        (
            "➕ افزودن ادمین\n\n"
            "آیدی عددی کاربر را بفرست.\n\n"
            "کاربر باید قبلاً ربات را Start کرده باشد."
        ),
        reply_markup=back_keyboard(),
    )


# =========================================================
# Owner - shifts
# =========================================================

@router.message(
    F.text == "⏰ شیفتها"
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
        "⏰ مدیریت شیفتها\n"
    ]

    buttons = []

    if not shifts:
        lines.append(
            "هیچ شیفتی ثبت نشده."
        )
    else:
        for shift in shifts:
            admin_name = shift["admin_name"] or await get_profile_name(
                bot,
                shift["admin_id"],
            )

            if shift["permanent"]:
                type_text = "🔁 دائمی"
                date_text = ""
            else:
                type_text = "📅 تاریخدار"
                date_text = (
                    f"\n📅 {shift['specific_date']}"
                )

            lines.append(
                f"#{shift['id']} — "
                f"{type_text}\n"
                f"👤 {escape(admin_name)}"
                f"{date_text}\n"
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
    bot: Bot,
):
    await callback.answer()

    if not db.is_owner(
        callback.from_user.id
    ):
        return

    try:
        shift_id = int(
            callback.data.split(":")[1]
        )
    except Exception:
        return

    shift = db.get_shift(shift_id)

    if not shift:
        await callback.message.answer(
            "❌ این شیفت پیدا نشد."
        )
        return

    db.delete_shift(shift_id)

    db.log(
        callback.from_user.id,
        "shift_deleted",
        f"shift={shift_id}",
    )

    admin_name = shift["admin_name"] or await get_profile_name(
        bot,
        shift["admin_id"],
    )

    await callback.message.answer(
        (
            f"✅ شیفت #{shift_id} حذف شد.\n\n"
            f"👤 {escape(admin_name)}\n"
            f"⏰ {shift['start_time']} تا {shift['end_time']}"
        ),
        parse_mode=ParseMode.HTML,
    )


@router.callback_query(
    F.data == "shift:add"
)
async def shift_add_start(
    callback: CallbackQuery,
):
    await callback.answer()

    if not db.is_owner(
        callback.from_user.id
    ):
        return

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
        (
            "⏰ نوع شیفت را انتخاب کن.\n\n"
            "🔁 دائمی یعنی این شیفت هر روز فعال است "
            "و دیگر روز هفته نمیخواهد."
        ),
        reply_markup=keyboard,
    )


@router.callback_query(
    F.data.startswith("shift_type:")
)
async def shift_type_callback(
    callback: CallbackQuery,
    bot: Bot,
):
    await callback.answer()

    if not db.is_owner(
        callback.from_user.id
    ):
        return

    shift_type = callback.data.split(
        ":",
        1,
    )[1]

    admins = db.get_admins(
        active_only=True
    )

    if not admins:
        await callback.message.answer(
            "❌ ابتدا حداقل یک ادمین فعال اضافه کن."
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
        # اولویت با نام ذخیرهشده در دیتابیس
        name = admin["name"]
        if not name or str(name).isdigit():
            name = await get_profile_name(
                bot,
                admin["user_id"],
                admin["name"],
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

    await callback.message.answer(
        "👤 ادمین شیفت را انتخاب کن:",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        ),
    )


@router.callback_query(
    F.data.startswith(
        "select_shift_admin:"
    )
)
async def select_shift_admin(
    callback: CallbackQuery,
    bot: Bot,
):
    await callback.answer()

    if not db.is_owner(
        callback.from_user.id
    ):
        return

    state = get_state(
        callback.from_user.id
    )

    if not state:
        return

    try:
        admin_id = int(
            callback.data.split(":")[1]
        )
    except Exception:
        return

    admin = db.get_admin(admin_id)
    if not admin:
        await callback.message.answer(
            "❌ این ادمین وجود ندارد."
        )
        return

    state["admin_id"] = admin_id

    # نمایش واضح اسم ادمین انتخابشده
    admin_name = admin["name"]
    if not admin_name or str(admin_name).isdigit():
        admin_name = await get_profile_name(
            bot,
            admin_id,
            admin["name"],
        )

    if state["permanent"]:
        state["step"] = "start_time"

        await callback.message.answer(
            (
                f"✅ ادمین انتخاب شد: <b>{escape(admin_name)}</b>\n\n"
                "⏰ ساعت شروع را بفرست.\n\n"
                "فرمت: HH:MM\n"
                "مثال: 03:16"
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=back_keyboard(),
        )
    else:
        state["step"] = "date"

        await callback.message.answer(
            (
                f"✅ ادمین انتخاب شد: <b>{escape(admin_name)}</b>\n\n"
                "📅 تاریخ شیفت را بفرست.\n\n"
                "فرمت: YYYY-MM-DD\n"
                "مثال: 2026-09-08"
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=back_keyboard(),
        )


def valid_time(
    value: str,
):
    return bool(
        re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d",
            value,
        )
    )


def valid_date(
    value: str,
):
    return bool(
        re.fullmatch(
            r"\d{4}-\d{2}-\d{2}",
            value,
        )
    )


# =========================================================
# Owner schedule / today
# =========================================================

@router.message(
    F.text == "📅 برنامه کاری/امروز"
)
async def owner_today_schedule(
    message: Message,
    bot: Bot,
):
    if not db.is_owner(
        message.from_user.id
    ):
        return

    shifts = db.get_today_shifts(
        local_now().weekday(),
        today_string(),
    )

    lines = [
        "📅 برنامه کاری امروز\n",
        f"📆 {today_string()}\n",
    ]

    if not shifts:
        lines.append(
            "امروز شیفتی ثبت نشده."
        )
    else:
        for shift in shifts:
            admin = await mention_user(
                bot,
                shift["admin_id"],
                shift["admin_name"],
            )

            prefix = (
                "🔁 دائمی"
                if shift["permanent"]
                else
                f"📅 {shift['specific_date']}"
            )

            lines.append(
                f"{prefix}\n"
                f"👤 {admin}\n"
                f"⏰ {shift['start_time']} تا "
                f"{shift['end_time']}\n"
            )

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


# =========================================================
# Owner stats
# =========================================================

def owner_stats_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="👤 آمار پیام هر کاربر",
                    callback_data="stats:users",
                )
            ],
            [
                InlineKeyboardButton(
                    text="🛡 آمار ادمینها",
                    callback_data="stats:admins",
                )
            ],
        ]
    )


@router.message(
    F.text == "📊 آمار و گزارشها"
)
async def owner_stats(
    message: Message,
):
    if not db.is_owner(message.from_user.id):
        return

    stats = db.owner_stats()

    await message.answer(
        (
            "📊 آمار کلی\n\n"
            f"📥 در انتظار: {stats['pending']}\n"
            f"🟢 تأییدشده: {stats['approved']}\n"
            f"🔴 ردشده: {stats['rejected']}\n"
            f"👥 کاربران فعال ۲۴ ساعت اخیر: {stats['users']}\n"
            f"🕒 صف بدون ادمین: {db.count_queued_messages()}"
        ),
        reply_markup=owner_stats_keyboard(),
    )


@router.callback_query(F.data == "stats:users")
async def owner_user_stats(
    callback: CallbackQuery,
    bot: Bot,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    rows = db.user_message_stats(200)
    lines = ["👤 تعداد پیامهای هر کاربر\n"]

    if not rows:
        lines.append("هنوز پیام ثبتشدهای وجود ندارد.")
    else:
        for row in rows:
            mention = await mention_user(
                bot,
                int(row["user_id"]),
                (
                    " ".join(
                        p for p in (
                            row["first_name"],
                            row["last_name"],
                        ) if p
                    ).strip()
                    or (f"@{row['username']}" if row["username"] else "کاربر")
                ),
            )
            lines.append(
                f"• {mention} — <b>{row['message_count']}</b> پیام"
            )

    await callback.message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_stats_keyboard(),
    )
    await callback.answer()


@router.callback_query(F.data == "stats:admins")
async def owner_admin_stats(
    callback: CallbackQuery,
    bot: Bot,
):
    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ دسترسی ندارید.", show_alert=True)
        return

    admins = db.all_admin_stats()
    if not admins:
        await callback.message.answer(
            "🛡 هنوز ادمینی ثبت نشده.",
            reply_markup=owner_stats_keyboard(),
        )
        await callback.answer()
        return

    for admin in admins:
        admin_id = int(admin["user_id"])
        mention = await mention_user(
            bot,
            admin_id,
            admin["name"],
        )
        approved = admin["approved"] or 0
        rejected = admin["rejected"] or 0

        await callback.message.answer(
            (
                f"🛡 <b>{mention}</b>\n\n"
                f"🟢 قبول کرده: <b>{approved}</b>\n"
                f"🔴 رد کرده: <b>{rejected}</b>"
            ),
            parse_mode=ParseMode.HTML,
        )

        rejected_rows = db.admin_review_details(admin_id, 100)
        rejected_rows = [
            r for r in rejected_rows
            if r["status"] == "rejected"
        ]

        if rejected_rows:
            text = ["🔴 پیامهای ردشده:"]
            for row in rejected_rows:
                content = escape(row["content"])
                reason = escape(row["reject_reason"] or "بدون دلیل")
                if len(content) > 350:
                    content = content[:350] + "…"
                text.append(
                    f"\n#{row['id']} — {reason}\n{content}"
                )
            await callback.message.answer(
                "\n".join(text),
                parse_mode=ParseMode.HTML,
            )

    await callback.message.answer(
        "📊 پایان گزارش ادمینها.",
        reply_markup=owner_stats_keyboard(),
    )
    await callback.answer()


# Owner channel
# =========================================================

@router.message(
    F.text == "📢 کانال"
)
async def owner_channel(
    message: Message,
    bot: Bot,
):
    if not db.is_owner(
        message.from_user.id
    ):
        return

    title, username = await channel_title(
        bot
    )

    if username:
        public_line = (
            f"🔗 @{escape(username)}"
        )
    else:
        public_line = (
            "🔒 کانال خصوصی"
        )

    await message.answer(
        (
            "📢 تنظیمات کانال\n\n"
            f"🏷 نام کانال: "
            f"<b>{escape(title)}</b>\n"
            f"{public_line}\n\n"
            "🟢 اتصال: موفق"
        ),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


# =========================================================
# Owner settings
# =========================================================

@router.message(
    F.text == "⚙️ تنظیمات ربات"
)
async def owner_settings(
    message: Message,
):
    if not db.is_owner(
        message.from_user.id
    ):
        return

    await message.answer(
        (
            "⚙️ تنظیمات ربات\n\n"
            f"🟢 وضعیت: "
            f"{'فعال' if db.is_bot_enabled() else 'غیرفعال'}\n"
            f"🌐 منطقه زمانی: {TIMEZONE}\n"
            f"🚦 محدودیت ارسال: "
            f"{RATE_LIMIT_MAX_MESSAGES} پیام در "
            f"{RATE_LIMIT_WINDOW_SECONDS // 60} دقیقه\n"
            f"🧹 نگهداری اطلاعات موقت: ۲۴ ساعت"
        ),
        reply_markup=owner_keyboard(
            db.is_bot_enabled()
        ),
    )


# =========================================================
# Owner security
# =========================================================

@router.message(
    F.text == "🛡️ امنیت و دسترسی"
)
async def owner_security(
    message: Message,
    bot: Bot,
):
    if not db.is_owner(message.from_user.id):
        return

    admins = db.get_admins()
    users = db.get_started_users(200)

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
            status = "🟢" if admin["active"] else "🔴"
            lines.append(f"• {status} {mention}")
    else:
        lines.append("• هیچ ادمینی ثبت نشده.")

    lines.append("\n👤 کاربرهای Start کرده:")

    admin_ids = {int(a["user_id"]) for a in admins}
    shown = 0
    for user in users:
        # مالکین در این لیست هم نمایش داده نمیشوند.
        if db.is_owner(int(user["user_id"])):
            continue
        mention = await mention_user(
            bot,
            int(user["user_id"]),
            full_name(User(
                id=int(user["user_id"]),
                is_bot=False,
                first_name=user["first_name"] or "",
                last_name=user["last_name"],
                username=user["username"],
            )),
        )
        suffix = " — ادمین" if int(user["user_id"]) in admin_ids else ""
        lines.append(f"• {mention}{suffix}")
        shown += 1

    if shown == 0:
        lines.append("• هنوز کاربری Start نکرده.")

    group_id = db.get_admin_group_id()
    if group_id:
        try:
            group = await bot.get_chat(group_id)
            group_name = getattr(group, "title", None) or str(group_id)
            lines.append(f"\n🏠 گروه مدیریت شیفت: <b>{escape(group_name)}</b>")
        except Exception:
            lines.append("\n🏠 گروه مدیریت شیفت: تنظیم شده")
    else:
        lines.append("\n🏠 گروه مدیریت شیفت: تنظیم نشده")

    await message.answer(
        "\n".join(lines),
        parse_mode=ParseMode.HTML,
        reply_markup=owner_keyboard(db.is_bot_enabled()),
    )


# Owner toggle bot
# =========================================================

@router.message(
    F.text.in_({
        "🔴 خاموش کردن",
        "🟢 روشن کردن",
    })
)
async def owner_toggle_bot(
    message: Message,
):
    if not db.is_owner(
        message.from_user.id
    ):
        return

    enable = (
        message.text
        == "🟢 روشن کردن"
    )

    db.set_bot_enabled(
        enable
    )

    db.log(
        message.from_user.id,
        (
            "bot_enabled"
            if enable
            else
            "bot_disabled"
        ),
    )

    await message.answer(
        (
            "🟢 ربات روشن شد."
            if enable
            else
            "🔴 ربات خاموش شد."
        ),
        reply_markup=owner_keyboard(
            enable
        ),
    )


# =========================================================
# Generic state handler
# =========================================================

async def handle_state(
    message: Message,
    bot: Bot,
) -> bool:
    state = get_state(
        message.from_user.id
    )

    if not state:
        return False

    kind = state["kind"]
    text = message.text or ""

    # -----------------------------------------------------
    # Group shift selection
    # -----------------------------------------------------
    if kind == "group_shift":
        configured_group = db.get_admin_group_id()
        if (
            message.chat.type not in {"group", "supergroup"}
            or message.chat.id != configured_group
        ):
            clear_state(message.from_user.id)
            return True

        admin = db.get_admin(message.from_user.id)
        if not admin or not db.has_started(message.from_user.id):
            clear_state(message.from_user.id)
            return True

        step = state.get("step")

        if step == "start_time":
            if not valid_time(text):
                await message.answer(
                    "❌ ساعت شروع درست نیست.\nفرمت: HH:MM"
                )
                return True

            state["start_time"] = text
            state["step"] = "end_time"

            await message.answer(
                "⏰ ساعت پایان را بفرست.\n\nفرمت: <code>HH:MM</code>",
                parse_mode=ParseMode.HTML,
            )
            return True

        if step == "end_time":
            if not valid_time(text):
                await message.answer(
                    "❌ ساعت پایان درست نیست.\nفرمت: HH:MM"
                )
                return True

            start = state["start_time"]
            end = text
            if end <= start:
                await message.answer(
                    "❌ ساعت پایان باید بعد از شروع باشد.\nمثال: 14:30 تا 16:00"
                )
                return True

            try:
                shift_id = db.create_shift(
                    start_time=start,
                    end_time=end,
                    admin_id=message.from_user.id,
                    permanent=True,
                )
            except Exception:
                await message.answer("❌ ایجاد شیفت ناموفق بود.")
                return True

            clear_state(message.from_user.id)
            await message.answer(
                (
                    "✅ شیفت شما ثبت شد.\n\n"
                    f"⏰ <b>{start}</b> تا <b>{end}</b>\n"
                    "🔁 نوع: دائمی"
                ),
                parse_mode=ParseMode.HTML,
            )
            return True

        clear_state(message.from_user.id)
        return True

    # -----------------------------------------------------
    # User submission
    # -----------------------------------------------------

    if kind == "user_send":
        user_id = message.from_user.id

        attempts = db.count_recent_attempts(
            user_id,
            RATE_LIMIT_WINDOW_SECONDS,
        )

        if attempts >= RATE_LIMIT_MAX_MESSAGES:
            await message.answer(
                (
                    "🚫 محدودیت ارسال\n\n"
                    f"در {RATE_LIMIT_WINDOW_SECONDS // 60} دقیقه اخیر "
                    f"{RATE_LIMIT_MAX_MESSAGES} پیام ارسال کردهای.\n\n"
                    "⏳ لطفاً کمی صبر کن و بعد دوباره امتحان کن."
                )
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

        blocked_word = contains_blocked_word(message.text)
        if blocked_word:
            await message.answer(
                "❌ این پیام به دلیل استفاده از کلمات محدودشده قابل ارسال نیست."
            )
            return True

        current = db.get_current_shift(
            local_now().weekday(),
            current_time_string(),
            today_string(),
        )

        admin_id = current["admin_id"] if current else None

        entities = serialize_entities(
            message.entities
        )

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
            if admin_id is not None:
                sent = await send_review_message(
                    bot,
                    admin_id,
                    row,
                )

                db.set_admin_message_id(
                    message_id,
                    sent.message_id,
                )

                queue_text = (
                    "🟡 در انتظار بررسی ادمین است."
                )
            else:
                queue_text = (
                    "🕒 فعلاً ادمینی در شیفت نیست.\n\n"
                    "پیامت ذخیره شد و به محض شروع نزدیکترین شیفت "
                    "برای ادمین ارسال میشود."
                )

            db.log(
                user_id,
                "message_submitted",
                (
                    f"message={message_id};"
                    f"admin={admin_id or 'queued'}"
                ),
            )

            await message.answer(
                "✅ پیامت با موفقیت ثبت شد.\n\n" + queue_text,
                reply_markup=user_keyboard(),
            )

            clear_state(user_id)

        except Exception:
            db.set_message_status(
                message_id,
                "rejected",
                "خطای داخلی در ارسال به ادمین",
            )

            await message.answer(
                "❌ در ارسال پیام مشکلی پیش آمد. دوباره تلاش کن."
            )

        return True

    # -----------------------------------------------------
    # Add admin
    # -----------------------------------------------------

    if kind == "add_admin":
        raw = text.strip()
        admin_id = None
        profile = None

        if raw.isdigit():
            admin_id = int(raw)
        elif re.fullmatch(r"@[A-Za-z0-9_]{5,32}", raw):
            found = db.get_user_by_username(raw)
            if found:
                admin_id = int(found["user_id"])
            else:
                await message.answer(
                    "❌ این username در کاربران ثبتشده پیدا نشد.\n\n"
                    "برای افزودن با @username، کاربر باید حداقل یکبار ربات را Start کرده باشد."
                )
                return True
        else:
            await message.answer(
                "❌ آیدی یا username معتبر بفرست.\n\n"
                "مثالها:\n"
                "123456789\n"
                "@sixiren"
            )
            return True

        try:
            profile = await bot.get_chat(admin_id)

            name = (
                getattr(
                    profile,
                    "full_name",
                    None,
                )
                or getattr(
                    profile,
                    "title",
                    None,
                )
                or (
                    f"@{profile.username}"
                    if getattr(
                        profile,
                        "username",
                        None,
                    )
                    else None
                )
            )

            if not name:
                name = "ادمین"

        except Exception:
            await message.answer(
                (
                    "❌ این کاربر پیدا نشد.\n\n"
                    "مطمئن شو کاربر قبلاً ربات را Start کرده "
                    "و آیدی را درست فرستادهای."
                )
            )
            return True

        db.add_admin(
            admin_id,
            name,
        )

        db.log(
            message.from_user.id,
            "admin_added",
            f"admin={admin_id}",
        )

        clear_state(
            message.from_user.id
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

    # -----------------------------------------------------
    # Shift request
    # -----------------------------------------------------

    if kind == "shift_request":
        if not text.strip():
            await message.answer(
                "❌ متن درخواست خالی است."
            )
            return True

        db.create_shift_request(
            message.from_user.id,
            text.strip(),
        )

        db.log(
            message.from_user.id,
            "shift_change_requested",
        )

        clear_state(
            message.from_user.id
        )

        await message.answer(
            (
                "✅ درخواستت برای مالک ارسال شد.\n\n"
                "بعد از بررسی، نتیجه اعلام میشود."
            ),
            reply_markup=admin_keyboard(),
        )

        return True

    # -----------------------------------------------------
    # Create shift
    # -----------------------------------------------------

    if kind == "create_shift":
        step = state.get(
            "step"
        )

        if step == "date":
            if not valid_date(text):
                await message.answer(
                    (
                        "❌ تاریخ درست نیست.\n\n"
                        "فرمت صحیح:\n"
                        "YYYY-MM-DD"
                    )
                )
                return True

            try:
                datetime.strptime(
                    text,
                    "%Y-%m-%d",
                )
            except ValueError:
                await message.answer(
                    "❌ این تاریخ معتبر نیست."
                )
                return True

            state["specific_date"] = text
            state["step"] = "start_time"

            await message.answer(
                (
                    "⏰ ساعت شروع را بفرست.\n\n"
                    "فرمت: HH:MM\n"
                    "مثال: 03:16"
                ),
                reply_markup=back_keyboard(),
            )

            return True

        if step == "start_time":
            if not valid_time(text):
                await message.answer(
                    (
                        "❌ ساعت درست نیست.\n\n"
                        "فرمت صحیح: HH:MM\n"
                        "مثال: 03:16"
                    )
                )
                return True

            state["start_time"] = text
            state["step"] = "end_time"

            await message.answer(
                (
                    "⏰ ساعت پایان را بفرست.\n\n"
                    "فرمت: HH:MM\n"
                    "مثال: 04:00"
                ),
                reply_markup=back_keyboard(),
            )

            return True

        if step == "end_time":
            if not valid_time(text):
                await message.answer(
                    "❌ ساعت درست نیست."
                )
                return True

            start = state["start_time"]
            end = text

            if start == end:
                await message.answer(
                    "❌ ساعت شروع و پایان نمیتوانند یکسان باشند."
                )
                return True

            # برای نسخه فعلی شیفت شبِ عبوری از نیمهشب
            # عمداً مجاز نیست؛ شیفت باید در همان روز باشد.
            if end <= start:
                await message.answer(
                    (
                        "❌ ساعت پایان باید بعد از ساعت شروع باشد.\n\n"
                        "مثلاً:\n"
                        "03:16 تا 04:00"
                    )
                )
                return True

            permanent = bool(
                state["permanent"]
            )

            try:
                shift_id = db.create_shift(
                    start_time=start,
                    end_time=end,
                    admin_id=state["admin_id"],
                    permanent=permanent,
                    specific_date=(
                        state.get(
                            "specific_date"
                        )
                    ),
                )
            except Exception:
                await message.answer(
                    "❌ ایجاد شیفت ناموفق بود."
                )
                return True

            db.log(
                message.from_user.id,
                "shift_created",
                f"shift={shift_id}",
            )

            clear_state(
                message.from_user.id
            )

            admin = db.get_admin(state["admin_id"])
            admin_name = admin["name"] if admin else "ادمین"

            if permanent:
                schedule = (
                    "🔁 دائمی"
                )
            else:
                schedule = (
                    f"📅 {state['specific_date']}"
                )

            await message.answer(
                (
                    "✅ شیفت با موفقیت ایجاد شد.\n\n"
                    f"👤 {escape(admin_name)}\n"
                    f"{schedule}\n"
                    f"⏰ {start} تا {end}"
                ),
                parse_mode=ParseMode.HTML,
                reply_markup=owner_keyboard(
                    db.is_bot_enabled()
                ),
            )

            return True

    return False


# =========================================================
# Back button MUST come before state handler
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

    await show_home(
        message,
        bot,
    )


# =========================================================
# Help buttons
# =========================================================

@router.message(
    F.text.in_({
        "📖 راهنما",
        "❓ راهنما",
    })
)
async def help_button(
    message: Message,
):
    if db.is_owner(
        message.from_user.id
    ):
        text = (
            "👑 راهنمای مالک\n\n"
            "از منوی مدیریت میتوانی ادمینها، "
            "شیفتها، کانال، امنیت و آمار را مدیریت کنی."
        )
        keyboard = owner_keyboard(
            db.is_bot_enabled()
        )

    elif db.get_admin(
        message.from_user.id
    ):
        text = (
            "👨‍💼 راهنمای ادمین\n\n"
            "پیامهای در انتظار را بررسی کن، "
            "برنامه و عملکرد خودت را ببین و "
            "در صورت نیاز درخواست تغییر شیفت بده."
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
# =========================================================
# Admin group / in-group shift selection
# =========================================================

def is_group_message(message: Message) -> bool:
    return message.chat.type in {"group", "supergroup"}


async def bot_identity_matches(
    message: Message,
    bot: Bot,
) -> bool:
    text = (message.text or "").strip()
    me = await bot.get_me()
    username = f"@{me.username}".lower() if me.username else ""
    return (
        text == str(me.id)
        or (username and text.lower() == username)
    )


pending_group_setup: dict[int, int] = {}

def group_setup_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="✅ تأیید این گروه",
                    callback_data="group_setup:confirm",
                ),
                InlineKeyboardButton(
                    text="❌ لغو",
                    callback_data="group_setup:cancel",
                ),
            ]
        ]
    )

def group_shift_keyboard():
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="⏰ انتخاب شیفت",
                    callback_data="group_shift:start",
                )
            ]
        ]
    )


@router.message(F.text, F.chat.type.in_({"group", "supergroup"}))
async def group_setup_and_router(
    message: Message,
    bot: Bot,
):
    if not is_group_message(message):
        return

    # هیچ گروهی جز گروهی که مالک تعیین کرده، پاسخی از ربات نمیگیرد.
    configured_group = db.get_admin_group_id()

    # فقط مالک اجازه دارد با فرستادن ID/username ربات، گروه را تعیین کند.
    if await bot_identity_matches(message, bot):
        if db.is_owner(message.from_user.id):
            pending_group_setup[message.from_user.id] = message.chat.id
            await message.answer(
                (
                    "🔐 <b>تأیید گروه مدیریت شیفت</b>\n\n"
                    f"گروه «{escape(message.chat.title or 'بدون نام')}» "
                    "را به عنوان گروه مدیریت شیفت انتخاب کنم؟\n\n"
                    "این قابلیت فقط بعد از تأیید مالک فعال می‌شود."
                ),
                parse_mode=ParseMode.HTML,
                reply_markup=group_setup_keyboard(),
            )
        return

    if not configured_group or message.chat.id != configured_group:
        return

    user_id = message.from_user.id

    current_state = get_state(user_id)
    if current_state and current_state.get("kind") == "group_shift":
        await handle_state(message, bot)
        return

    if db.is_owner(user_id):
        return

    admin = db.get_admin(user_id)
    if not admin:
        await message.answer(
            WELCOME_MESSAGE
        )
        return

    if not db.has_started(user_id):
        await message.answer(
            "⚠️ برای استفاده از امکانات ادمینی، ابتدا ربات را در پیوی Start کن و سپس به این گروه برگرد."
        )
        return

    if message.text.strip() in {"⏰ انتخاب شیفت", "/shift", "/shifts"}:
        set_state(
            user_id,
            "group_shift",
            chat_id=message.chat.id,
            step="start_time",
        )
        await message.answer(
            (
                "⏰ <b>انتخاب شیفت</b>\n\n"
                "ساعت شروع را به فرمت <code>HH:MM</code> بفرست.\n"
                "مثال: <code>14:30</code>"
            ),
            parse_mode=ParseMode.HTML,
        )
        return

    if message.text.strip() in {"⏰ شیفت من"}:
        current = db.get_current_shift(
            local_now().weekday(),
            current_time_string(),
            today_string(),
        )
        if current and current["admin_id"] == user_id:
            await message.answer(
                f"🟢 شیفت فعلی شما: {current['start_time']} تا {current['end_time']}"
            )
        else:
            await message.answer(
                "⏰ در حال حاضر شیفت فعالی برای شما وجود ندارد.",
                reply_markup=group_shift_keyboard(),
            )


@router.callback_query(
    F.data.in_({"group_setup:confirm", "group_setup:cancel"})
)
async def group_setup_callback(
    callback: CallbackQuery,
):
    if callback.message.chat.type not in {"group", "supergroup"}:
        await callback.answer()
        return

    if not db.is_owner(callback.from_user.id):
        await callback.answer("⛔ فقط مالک می‌تواند گروه را تعیین کند.", show_alert=True)
        return

    pending_chat = pending_group_setup.get(callback.from_user.id)
    if pending_chat != callback.message.chat.id:
        await callback.answer("❌ درخواست تنظیم گروه منقضی شده است.", show_alert=True)
        return

    if callback.data == "group_setup:cancel":
        pending_group_setup.pop(callback.from_user.id, None)
        await callback.message.edit_text("❌ تنظیم گروه لغو شد.")
        await callback.answer()
        return

    db.set_admin_group_id(callback.message.chat.id)
    pending_group_setup.pop(callback.from_user.id, None)

    await callback.message.edit_text(
        (
            "✅ <b>گروه مدیریت شیفت تنظیم شد.</b>\n\n"
            f"گروه «{escape(callback.message.chat.title or 'بدون نام')}» "
            "از این به بعد تنها گروه مجاز برای امکانات شیفت است."
        ),
        parse_mode=ParseMode.HTML,
    )
    await callback.message.answer(
        "⏰ ادمین‌ها می‌توانند از اینجا شیفت خود را انتخاب کنند.",
        reply_markup=group_shift_keyboard(),
    )
    await callback.answer()


@router.callback_query(F.data == "group_shift:start")
async def group_shift_start(
    callback: CallbackQuery,
):
    if callback.message.chat.type not in {"group", "supergroup"}:
        await callback.answer()
        return

    if callback.message.chat.id != db.get_admin_group_id():
        await callback.answer("⛔ این گروه مجاز نیست.", show_alert=True)
        return

    user_id = callback.from_user.id
    if db.is_owner(user_id):
        await callback.answer("مالک لازم نیست شیفت ادمینی انتخاب کند.")
        return

    admin = db.get_admin(user_id)
    if not admin:
        await callback.answer("⛔ شما ادمین نیستید.", show_alert=True)
        return

    if not db.has_started(user_id):
        await callback.answer("ابتدا ربات را در پیوی Start کن.", show_alert=True)
        return

    set_state(
        user_id,
        "group_shift",
        chat_id=callback.message.chat.id,
        step="start_time",
    )

    await callback.message.answer(
        (
            "⏰ ساعت شروع را بفرست.\n\n"
            "فرمت: <code>HH:MM</code>\n"
            "مثال: <code>14:30</code>"
        ),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.message(Command("shift"))
async def group_shift_command(
    message: Message,
    bot: Bot,
):
    if not is_group_message(message):
        return

    if message.chat.id != db.get_admin_group_id():
        return

    user_id = message.from_user.id
    if db.is_owner(user_id):
        return
    if not db.get_admin(user_id):
        await message.answer(WELCOME_MESSAGE)
        return
    if not db.has_started(user_id):
        await message.answer(
            "⚠️ ابتدا ربات را در پیوی Start کن و سپس /shift را در گروه بزن."
        )
        return

    set_state(
        user_id,
        "group_shift",
        chat_id=message.chat.id,
        step="start_time",
    )
    await message.answer(
        "⏰ ساعت شروع را بفرست. فرمت: HH:MM",
    )


# Generic text handler
# =========================================================

@router.message(F.text)
async def text_router(
    message: Message,
    bot: Bot,
):
    # پیامهای گروهی در handler اختصاصی گروه مدیریت شیفت بررسی میشوند.
    if is_group_message(message):
        return

    user = message.from_user

    db.upsert_user(
        user.id,
        user.username,
        user.first_name,
        user.last_name,
    )

    text = message.text

    # بازگشت قبلاً جداگانه و با اولویت بالاتر هندل شده.

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

    if text == "📥 پیامهای در انتظار":
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

    if text == "🔔 اعلانها":
        await admin_notifications(
            message
        )
        return

    if text == "👥 ادمینها":
        await owner_admins(
            message,
            bot,
        )
        return

    if text == "⏰ شیفتها":
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

    if text == "📊 آمار و گزارشها":
        await owner_stats(
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

    # اگر کاربر متن عادی فرستاد،
    # آن را به عنوان شروع ارسال پیام در نظر میگیریم.
    if (
        not db.is_owner(user.id)
        and not db.get_admin(user.id)
    ):
        if not db.is_bot_enabled():
            await message.answer(
                ERROR_MESSAGES["bot_disabled"]
            )
            return

        set_state(
            user.id,
            "user_send",
        )

        await handle_state(
            message,
            bot,
        )


# =========================================================
# Shift monitor
# =========================================================

async def shift_monitor(
    bot: Bot,
):
    global notified_shifts

    while True:
        try:
            now = local_now()

            shift = db.get_current_shift(
                now.weekday(),
                now.strftime("%H:%M"),
                now.strftime("%Y-%m-%d"),
            )

            if shift:
                key = (
                    now.strftime("%Y-%m-%d"),
                    int(shift["id"]),
                )

                current_hm = now.strftime("%H:%M")

                # اعلان شروع شیفت فقط یکبار.
                if (
                    current_hm == shift["start_time"]
                    and key not in notified_shifts
                ):
                    notified_shifts.add(key)

                    if shift["notifications_enabled"]:
                        try:
                            await bot.send_message(
                                shift["admin_id"],
                                (
                                    "🔔 <b>شروع شیفت</b>\n\n"
                                    f"⏰ شیفت شما از <b>{shift['start_time']}</b> "
                                    f"تا <b>{shift['end_time']}</b> شروع شد.\n\n"
                                    "📥 ربات آماده دریافت و بررسی پیامهاست."
                                ),
                                parse_mode=ParseMode.HTML,
                            )
                        except (
                            TelegramForbiddenError,
                            TelegramBadRequest,
                        ):
                            pass

                # هر پیامی که وقتی ادمین فعال نبود در صف مانده،
                # به اولین شیفت فعال بعدی اختصاص داده میشود.
                queued = db.assign_pending_messages_to_admin(
                    shift["admin_id"],
                    100,
                )

                for queued_row in queued:
                    try:
                        sent = await send_review_message(
                            bot,
                            shift["admin_id"],
                            queued_row,
                        )
                        db.set_admin_message_id(
                            queued_row["id"],
                            sent.message_id,
                        )
                    except Exception:
                        db.clear_message_admin_id(
                            queued_row["id"],
                        )

            # جلوگیری از رشد بینهایت set
            if len(notified_shifts) > 1000:
                notified_shifts = {
                    item
                    for item in notified_shifts
                    if item[0] == now.strftime("%Y-%m-%d")
                }

        except Exception:
            pass

        await asyncio.sleep(15)


# =========================================================
# Cleanup monitor
# =========================================================

async def cleanup_loop():
    while True:
        try:
            db.cleanup_old_data()
        except Exception:
            pass

        await asyncio.sleep(
            30 * 60
        )


# =========================================================
# Bot commands
# =========================================================

async def setup_commands(
    bot: Bot,
):
    await bot.set_my_commands(
        [
            BotCommand(
                command="start",
                description="راهاندازی مجدد",
            ),
            BotCommand(
                command="help",
                description="راهنما",
            ),
            BotCommand(
                command="shift",
                description="انتخاب شیفت در گروه مدیریت",
            ),
        ],
        scope=BotCommandScopeDefault(),
    )


# =========================================================
# Main
# =========================================================

async def main():
    global shift_task
    global cleanup_task

    bot = Bot(
        token=BOT_TOKEN
    )

    dp = Dispatcher()

    dp.include_router(
        router
    )

    await setup_commands(
        bot
    )

    shift_task = asyncio.create_task(
        shift_monitor(bot)
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
