from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from config import (
    DATABASE_PATH,
    OWNER_IDS,
    BOT_ENABLED_DEFAULT,
    CHANNEL_ID,
    DATA_RETENTION_HOURS,
)


class Database:
    def __init__(self, path: str | Path = DATABASE_PATH):
        self.path = str(path)
        self.lock = threading.RLock()

        self.conn = sqlite3.connect(
            self.path,
            check_same_thread=False,
            timeout=30,
        )

        self.conn.row_factory = sqlite3.Row

        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=30000")

        self._create_tables()
        self._migrate()
        self._load_initial_owners()
        self._load_defaults()

    # =====================================================
    # BASIC
    # =====================================================

    def now(self) -> str:
        return datetime.utcnow().isoformat(
            timespec="seconds"
        )

    def _commit(self):
        self.conn.commit()

    def _json_dump(self, value: Any) -> str:
        return json.dumps(
            value if value is not None else [],
            ensure_ascii=False,
        )

    def _json_load(self, value: str | None):
        if not value:
            return []

        try:
            return json.loads(value)
        except Exception:
            return []

    # =====================================================
    # TABLES
    # =====================================================

    def _create_tables(self):
        with self.lock:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS owners (
                    user_id INTEGER PRIMARY KEY,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS admins (
                    user_id INTEGER PRIMARY KEY,
                    name TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    notifications_enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    started INTEGER NOT NULL DEFAULT 0,
                    blocked INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_seen TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS shifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    weekday INTEGER NOT NULL DEFAULT -1,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    admin_id INTEGER NOT NULL,
                    permanent INTEGER NOT NULL DEFAULT 1,
                    specific_date TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(admin_id)
                        REFERENCES admins(user_id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    entities_json TEXT,
                    status TEXT NOT NULL DEFAULT 'queued',
                    admin_id INTEGER,
                    shift_id INTEGER,
                    admin_message_id INTEGER,
                    channel_message_id INTEGER,
                    reject_reason TEXT,
                    submitted_at TEXT NOT NULL,
                    reviewed_at TEXT,
                    assigned_at TEXT,
                    queued_at TEXT,
                    FOREIGN KEY(user_id)
                        REFERENCES users(user_id)
                        ON DELETE CASCADE,
                    FOREIGN KEY(admin_id)
                        REFERENCES admins(user_id)
                        ON DELETE SET NULL,
                    FOREIGN KEY(shift_id)
                        REFERENCES shifts(id)
                        ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS rate_limits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );

                CREATE TABLE IF NOT EXISTS shift_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(admin_id)
                        REFERENCES admins(user_id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS admin_groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER UNIQUE NOT NULL,
                    title TEXT,
                    owner_id INTEGER NOT NULL,
                    confirmed INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    confirmed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS admin_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id INTEGER NOT NULL,
                    admin_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    reason TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(message_id)
                        REFERENCES messages(id)
                        ON DELETE CASCADE,
                    FOREIGN KEY(admin_id)
                        REFERENCES admins(user_id)
                        ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_messages_status
                    ON messages(status);

                CREATE INDEX IF NOT EXISTS idx_messages_admin
                    ON messages(admin_id);

                CREATE INDEX IF NOT EXISTS idx_messages_user
                    ON messages(user_id);

                CREATE INDEX IF NOT EXISTS idx_messages_submitted
                    ON messages(submitted_at);

                CREATE INDEX IF NOT EXISTS idx_rate_limits_user
                    ON rate_limits(user_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_shifts_admin
                    ON shifts(admin_id);

                CREATE INDEX IF NOT EXISTS idx_shifts_date
                    ON shifts(specific_date);

                CREATE INDEX IF NOT EXISTS idx_shifts_weekday
                    ON shifts(weekday);

                CREATE INDEX IF NOT EXISTS idx_admin_actions_admin
                    ON admin_actions(admin_id);

                CREATE INDEX IF NOT EXISTS idx_admin_actions_message
                    ON admin_actions(message_id);
                """
            )

            self._commit()

    # =====================================================
    # MIGRATION
    # =====================================================

    def _column_exists(
        self,
        table: str,
        column: str,
    ) -> bool:
        rows = self.conn.execute(
            f"PRAGMA table_info({table})"
        ).fetchall()

        return any(
            row["name"] == column
            for row in rows
        )

    def _migrate(self):
        with self.lock:

            # users.started
            if not self._column_exists(
                "users",
                "started",
            ):
                self.conn.execute(
                    """
                    ALTER TABLE users
                    ADD COLUMN started INTEGER
                    NOT NULL DEFAULT 0
                    """
                )

            # messages.shift_id
            if not self._column_exists(
                "messages",
                "shift_id",
            ):
                self.conn.execute(
                    """
                    ALTER TABLE messages
                    ADD COLUMN shift_id INTEGER
                    """
                )

            # messages.assigned_at
            if not self._column_exists(
                "messages",
                "assigned_at",
            ):
                self.conn.execute(
                    """
                    ALTER TABLE messages
                    ADD COLUMN assigned_at TEXT
                    """
                )

            # messages.queued_at
            if not self._column_exists(
                "messages",
                "queued_at",
            ):
                self.conn.execute(
                    """
                    ALTER TABLE messages
                    ADD COLUMN queued_at TEXT
                    """
                )

            # قدیمی‌ها
            self.conn.execute(
                """
                UPDATE shifts
                SET weekday = -1
                WHERE permanent = 1
                """
            )

            self._commit()

    # =====================================================
    # DEFAULTS
    # =====================================================

    def _load_initial_owners(self):
        with self.lock:
            for owner_id in OWNER_IDS:
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO owners
                    (user_id, created_at)
                    VALUES (?, ?)
                    """,
                    (
                        int(owner_id),
                        self.now(),
                    ),
                )

            self._commit()

    def _load_defaults(self):
        with self.lock:

            self.conn.execute(
                """
                INSERT OR IGNORE INTO settings
                (key, value)
                VALUES ('bot_enabled', ?)
                """,
                (
                    "1"
                    if BOT_ENABLED_DEFAULT
                    else "0",
                ),
            )

            if CHANNEL_ID:
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO settings
                    (key, value)
                    VALUES ('channel_id', ?)
                    """,
                    (
                        str(CHANNEL_ID),
                    ),
                )

            self._commit()

    # =====================================================
    # OWNERS
    # =====================================================

    def is_owner(self, user_id: int) -> bool:
        row = self.conn.execute(
            """
            SELECT 1
            FROM owners
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

        return row is not None

    def get_owners(self):
        return self.conn.execute(
            """
            SELECT *
            FROM owners
            ORDER BY created_at
            """
        ).fetchall()

    def add_owner(self, user_id: int):
        with self.lock:
            self.conn.execute(
                """
                INSERT OR IGNORE INTO owners
                (user_id, created_at)
                VALUES (?, ?)
                """,
                (
                    user_id,
                    self.now(),
                ),
            )

            self._commit()

    def remove_owner(self, user_id: int):
        with self.lock:
            self.conn.execute(
                """
                DELETE FROM owners
                WHERE user_id = ?
                """,
                (user_id,),
            )

            self._commit()

    # =====================================================
    # ADMINS
    # =====================================================

    def add_admin(
        self,
        user_id: int,
        name: str | None = None,
    ):
        with self.lock:

            self.conn.execute(
                """
                INSERT INTO admins
                (
                    user_id,
                    name,
                    active,
                    created_at
                )
                VALUES (?, ?, 1, ?)

                ON CONFLICT(user_id)
                DO UPDATE SET
                    name = COALESCE(
                        excluded.name,
                        admins.name
                    ),
                    active = 1
                """,
                (
                    user_id,
                    name,
                    self.now(),
                ),
            )

            self._commit()

    def delete_admin(
        self,
        user_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                DELETE FROM admins
                WHERE user_id = ?
                """,
                (user_id,),
            )

            self._commit()

    def set_admin_active(
        self,
        user_id: int,
        active: bool,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE admins
                SET active = ?
                WHERE user_id = ?
                """,
                (
                    1 if active else 0,
                    user_id,
                ),
            )

            self._commit()

    def set_admin_notifications(
        self,
        user_id: int,
        enabled: bool,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE admins
                SET notifications_enabled = ?
                WHERE user_id = ?
                """,
                (
                    1 if enabled else 0,
                    user_id,
                ),
            )

            self._commit()

    def get_admin(
        self,
        user_id: int,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM admins
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    def get_admins(
        self,
        active_only: bool = False,
    ):
        if active_only:
            return self.conn.execute(
                """
                SELECT *
                FROM admins
                WHERE active = 1
                ORDER BY created_at
                """
            ).fetchall()

        return self.conn.execute(
            """
            SELECT *
            FROM admins
            ORDER BY created_at
            """
        ).fetchall()

    def count_admins(self) -> int:
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM admins
            """
        ).fetchone()

        return int(row["count"])

    # =====================================================
    # USERS
    # =====================================================

    def upsert_user(
        self,
        user_id: int,
        username: str | None,
        first_name: str | None,
        last_name: str | None,
        started: bool | None = None,
    ):
        with self.lock:

            if started is None:
                self.conn.execute(
                    """
                    INSERT INTO users
                    (
                        user_id,
                        username,
                        first_name,
                        last_name,
                        created_at,
                        last_seen
                    )
                    VALUES (?, ?, ?, ?, ?, ?)

                    ON CONFLICT(user_id)
                    DO UPDATE SET
                        username = excluded.username,
                        first_name = excluded.first_name,
                        last_name = excluded.last_name,
                        last_seen = excluded.last_seen
                    """,
                    (
                        user_id,
                        username,
                        first_name,
                        last_name,
                        self.now(),
                        self.now(),
                    ),
                )

            else:
                self.conn.execute(
                    """
                    INSERT INTO users
                    (
                        user_id,
                        username,
                        first_name,
                        last_name,
                        started,
                        created_at,
                        last_seen
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)

                    ON CONFLICT(user_id)
                    DO UPDATE SET
                        username = excluded.username,
                        first_name = excluded.first_name,
                        last_name = excluded.last_name,
                        started = excluded.started,
                        last_seen = excluded.last_seen
                    """,
                    (
                        user_id,
                        username,
                        first_name,
                        last_name,
                        1 if started else 0,
                        self.now(),
                        self.now(),
                    ),
                )

            self._commit()

    def mark_user_started(
        self,
        user_id: int,
        username: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
    ):
        self.upsert_user(
            user_id,
            username,
            first_name,
            last_name,
            started=True,
        )

    def has_started(
        self,
        user_id: int,
    ) -> bool:
        row = self.conn.execute(
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

    def get_user(
        self,
        user_id: int,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM users
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    def find_user_by_username(
        self,
        username: str,
    ):
        username = username.strip().lstrip("@")

        return self.conn.execute(
            """
            SELECT *
            FROM users
            WHERE LOWER(username) = LOWER(?)
            LIMIT 1
            """,
            (username,),
        ).fetchone()

    def find_admin_by_username(
        self,
        username: str,
    ):
        username = username.strip().lstrip("@")

        return self.conn.execute(
            """
            SELECT
                admins.*,
                users.username,
                users.first_name,
                users.last_name,
                users.started
            FROM admins
            LEFT JOIN users
                ON users.user_id = admins.user_id
            WHERE
                LOWER(
                    COALESCE(
                        users.username,
                        ''
                    )
                ) = LOWER(?)
            LIMIT 1
            """,
            (username,),
        ).fetchone()

    def get_started_users(
        self,
        limit: int | None = None,
    ):
        query = """
            SELECT *
            FROM users
            WHERE started = 1
            ORDER BY last_seen DESC
        """

        if limit is not None:
            query += f" LIMIT {int(limit)}"

        return self.conn.execute(
            query
        ).fetchall()

    def count_started_users(self) -> int:
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM users
            WHERE started = 1
            """
        ).fetchone()

        return int(row["count"])

    def is_blocked(
        self,
        user_id: int,
    ) -> bool:
        row = self.conn.execute(
            """
            SELECT blocked
            FROM users
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

        return bool(
            row and row["blocked"]
        )

    def set_blocked(
        self,
        user_id: int,
        blocked: bool,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE users
                SET blocked = ?
                WHERE user_id = ?
                """,
                (
                    1 if blocked else 0,
                    user_id,
                ),
            )

            self._commit()

    def count_active_users(self) -> int:
        since = (
            datetime.utcnow()
            - timedelta(hours=24)
        ).isoformat(
            timespec="seconds"
        )

        row = self.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM users
            WHERE started = 1
            AND last_seen >= ?
            """,
            (since,),
        ).fetchone()

        return int(row["count"])

    # =====================================================
    # SHIFTS
    # =====================================================

    def create_shift(
        self,
        start_time: str,
        end_time: str,
        admin_id: int,
        permanent: bool = True,
        specific_date: str | None = None,
        weekday: int = -1,
    ) -> int:

        with self.lock:

            cursor = self.conn.execute(
                """
                INSERT INTO shifts
                (
                    weekday,
                    start_time,
                    end_time,
                    admin_id,
                    permanent,
                    specific_date,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    weekday,
                    start_time,
                    end_time,
                    admin_id,
                    1 if permanent else 0,
                    specific_date,
                    self.now(),
                ),
            )

            self._commit()

            return int(cursor.lastrowid)

    def delete_shift(
        self,
        shift_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                DELETE FROM shifts
                WHERE id = ?
                """,
                (shift_id,),
            )

            self._commit()

    def get_shift(
        self,
        shift_id: int,
    ):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            LEFT JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE shifts.id = ?
            """,
            (shift_id,),
        ).fetchone()

    def _shift_matches_date(
        self,
        row,
        date_string: str,
        weekday: int,
    ) -> bool:

        if not row["permanent"]:
            return (
                row["specific_date"]
                == date_string
            )

        row_weekday = row["weekday"]

        if row_weekday == -1:
            return True

        return row_weekday == weekday

    def get_today_shifts(
        self,
        weekday: int,
        specific_date: str,
    ):
        rows = self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE admins.active = 1
            ORDER BY start_time
            """
        ).fetchall()

        return [
            row
            for row in rows
            if self._shift_matches_date(
                row,
                specific_date,
                weekday,
            )
        ]

    def get_current_shift(
        self,
        weekday: int,
        current_time: str,
        specific_date: str,
    ):
        rows = self.get_today_shifts(
            weekday,
            specific_date,
        )

        for row in rows:
            start = row["start_time"]
            end = row["end_time"]

            # شیفت معمولی
            if start < end:
                if start <= current_time < end:
                    return row

            # شیفت عبوری از نیمه‌شب
            else:
                if (
                    current_time >= start
                    or current_time < end
                ):
                    return row

        return None

    def get_admin_today_shifts(
        self,
        admin_id: int,
        specific_date: str,
    ):
        weekday = datetime.strptime(
            specific_date,
            "%Y-%m-%d",
        ).weekday()

        rows = self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE shifts.admin_id = ?
            ORDER BY start_time
            """,
            (admin_id,),
        ).fetchall()

        return [
            row
            for row in rows
            if self._shift_matches_date(
                row,
                specific_date,
                weekday,
            )
        ]

    def get_permanent_shifts(
        self,
        admin_id: int,
    ):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE
                shifts.admin_id = ?
                AND shifts.permanent = 1
            ORDER BY start_time
            """,
            (admin_id,),
        ).fetchall()

    def get_date_shifts(
        self,
        admin_id: int,
    ):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE
                shifts.admin_id = ?
                AND shifts.permanent = 0
            ORDER BY specific_date, start_time
            """,
            (admin_id,),
        ).fetchall()

    def get_all_shifts(self):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            LEFT JOIN admins
                ON admins.user_id = shifts.admin_id
            ORDER BY
                specific_date,
                start_time
            """
        ).fetchall()

    # =====================================================
    # NEXT SHIFT
    # =====================================================

    def get_next_shift(
        self,
        after: datetime | None = None,
    ):
        """
        نزدیک‌ترین شیفت آینده را پیدا می‌کند.
        تا 8 روز آینده بررسی می‌شود.
        """

        if after is None:
            after = datetime.utcnow()

        rows = self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE admins.active = 1
            """
        ).fetchall()

        candidates = []

        for row in rows:

            if row["permanent"]:
                for day_offset in range(0, 8):
                    date = (
                        after.date()
                        + timedelta(
                            days=day_offset
                        )
                    )

                    weekday = date.weekday()

                    if (
                        row["weekday"] != -1
                        and row["weekday"] != weekday
                    ):
                        continue

                    try:
                        start_dt = datetime.strptime(
                            f"{date} {row['start_time']}",
                            "%Y-%m-%d %H:%M",
                        )
                    except ValueError:
                        continue

                    if start_dt > after:
                        candidates.append(
                            (start_dt, row)
                        )

                    

            else:
                if not row["specific_date"]:
                    continue

                try:
                    start_dt = datetime.strptime(
                        f"{row['specific_date']} "
                        f"{row['start_time']}",
                        "%Y-%m-%d %H:%M",
                    )
                except ValueError:
                    continue

                if start_dt > after:
                    candidates.append(
                        (start_dt, row)
                    )

        if not candidates:
            return None

        candidates.sort(
            key=lambda item: item[0]
        )

        start_dt, row = candidates[0]

        data = dict(row)
        data["occurrence"] = start_dt.isoformat(
            timespec="minutes"
        )

        return data

    # =====================================================
    # MESSAGES
    # =====================================================

    def create_message(
        self,
        user_id: int,
        content: str,
        entities,
        admin_id: int | None = None,
        shift_id: int | None = None,
    ) -> int:

        with self.lock:

            now = self.now()

            status = (
                "pending"
                if admin_id
                else "queued"
            )

            cursor = self.conn.execute(
                """
                INSERT INTO messages
                (
                    user_id,
                    content,
                    entities_json,
                    status,
                    admin_id,
                    shift_id,
                    submitted_at,
                    queued_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    content,
                    self._json_dump(
                        entities
                    ),
                    status,
                    admin_id,
                    shift_id,
                    now,
                    now if not admin_id else None,
                ),
            )

            self._commit()

            return int(cursor.lastrowid)

    def get_message(
        self,
        message_id: int,
    ):
        return self.conn.execute(
            """
            SELECT
                messages.*,
                users.username,
                users.first_name,
                users.last_name,
                admins.name AS admin_name
            FROM messages
            LEFT JOIN users
                ON users.user_id = messages.user_id
            LEFT JOIN admins
                ON admins.user_id = messages.admin_id
            WHERE messages.id = ?
            """,
            (message_id,),
        ).fetchone()

    def get_all_pending(
        self,
        limit: int = 20,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE status = 'pending'
            ORDER BY submitted_at
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    def get_pending_for_admin(
        self,
        admin_id: int,
        limit: int = 20,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE
                status = 'pending'
                AND admin_id = ?
            ORDER BY submitted_at
            LIMIT ?
            """,
            (
                admin_id,
                limit,
            ),
        ).fetchall()

    def get_queued_messages(
        self,
        limit: int = 100,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE status = 'queued'
            ORDER BY submitted_at
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    def assign_queued_messages(
        self,
        admin_id: int,
        shift_id: int | None = None,
        limit: int = 100,
    ) -> list[int]:

        with self.lock:

            rows = self.conn.execute(
                """
                SELECT id
                FROM messages
                WHERE status = 'queued'
                ORDER BY submitted_at
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            if not rows:
                return []

            now = self.now()

            ids = [
                int(row["id"])
                for row in rows
            ]

            placeholders = ",".join(
                "?" for _ in ids
            )

            self.conn.execute(
                f"""
                UPDATE messages
                SET
                    status = 'pending',
                    admin_id = ?,
                    shift_id = ?,
                    assigned_at = ?
                WHERE
                    id IN ({placeholders})
                    AND status = 'queued'
                """,
                (
                    admin_id,
                    shift_id,
                    now,
                    *ids,
                ),
            )

            self._commit()

            return ids

    def get_user_messages(
        self,
        user_id: int,
        limit: int = 10,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (
                user_id,
                limit,
            ),
        ).fetchall()

    def set_admin_message_id(
        self,
        message_id: int,
        admin_message_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE messages
                SET admin_message_id = ?
                WHERE id = ?
                """,
                (
                    admin_message_id,
                    message_id,
                ),
            )

            self._commit()

    def set_channel_message_id(
        self,
        message_id: int,
        channel_message_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE messages
                SET channel_message_id = ?
                WHERE id = ?
                """,
                (
                    channel_message_id,
                    message_id,
                ),
            )

            self._commit()

    def claim_message(
        self,
        message_id: int,
    ) -> bool:

        with self.lock:

            cursor = self.conn.execute(
                """
                UPDATE messages
                SET status = 'processing'
                WHERE
                    id = ?
                    AND status = 'pending'
                """,
                (message_id,),
            )

            self._commit()

            return cursor.rowcount == 1

    def restore_pending(
        self,
        message_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE messages
                SET status = 'pending'
                WHERE id = ?
                """,
                (message_id,),
            )

            self._commit()

    def set_message_status(
        self,
        message_id: int,
        status: str,
        reject_reason: str | None = None,
    ):
        with self.lock:

            reviewed_at = (
                self.now()
                if status
                in {
                    "approved",
                    "rejected",
                }
                else None
            )

            self.conn.execute(
                """
                UPDATE messages
                SET
                    status = ?,
                    reject_reason = ?,
                    reviewed_at = ?
                WHERE id = ?
                """,
                (
                    status,
                    reject_reason,
                    reviewed_at,
                    message_id,
                ),
            )

            self._commit()

    def count_pending(self) -> int:
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM messages
            WHERE status IN
                ('pending', 'queued')
            """
        ).fetchone()

        return int(row["count"])

    # =====================================================
    # ADMIN ACTIONS
    # =====================================================

    def record_admin_action(
        self,
        message_id: int,
        admin_id: int,
        action: str,
        reason: str | None = None,
    ):
        with self.lock:
            self.conn.execute(
                """
                INSERT INTO admin_actions
                (
                    message_id,
                    admin_id,
                    action,
                    reason,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    admin_id,
                    action,
                    reason,
                    self.now(),
                ),
            )

            self._commit()

    def get_rejected_messages(
        self,
        admin_id: int,
        limit: int = 50,
    ):
        return self.conn.execute(
            """
            SELECT
                messages.*,
                users.username,
                users.first_name,
                users.last_name
            FROM messages
            WHERE
                messages.admin_id = ?
                AND messages.status = 'rejected'
            ORDER BY messages.reviewed_at DESC
            LIMIT ?
            """,
            (
                admin_id,
                limit,
            ),
        ).fetchall()

    # =====================================================
    # RATE LIMIT
    # =====================================================

    def count_recent_attempts(
        self,
        user_id: int,
        window_seconds: int,
    ) -> int:

        since = (
            datetime.utcnow()
            - timedelta(
                seconds=window_seconds
            )
        ).isoformat(
            timespec="seconds"
        )

        row = self.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM rate_limits
            WHERE
                user_id = ?
                AND created_at >= ?
            """,
            (
                user_id,
                since,
            ),
        ).fetchone()

        return int(row["count"])

    def add_rate_attempt(
        self,
        user_id: int,
    ):
        with self.lock:
            self.conn.execute(
                """
                INSERT INTO rate_limits
                (user_id, created_at)
                VALUES (?, ?)
                """,
                (
                    user_id,
                    self.now(),
                ),
            )

            self._commit()

    # =====================================================
    # SETTINGS
    # =====================================================

    def get_setting(
        self,
        key: str,
        default: Any = None,
    ):
        row = self.conn.execute(
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
        self,
        key: str,
        value: Any,
    ):
        with self.lock:
            self.conn.execute(
                """
                INSERT INTO settings
                (key, value)
                VALUES (?, ?)

                ON CONFLICT(key)
                DO UPDATE SET
                    value = excluded.value
                """,
                (
                    key,
                    str(value),
                ),
            )

            self._commit()

    def is_bot_enabled(self) -> bool:
        value = self.get_setting(
            "bot_enabled",
            "1",
        )

        return str(value) == "1"

    def set_bot_enabled(
        self,
        enabled: bool,
    ):
        self.set_setting(
            "bot_enabled",
            "1" if enabled else "0",
        )

    def get_channel_id(self):
        value = self.get_setting(
            "channel_id",
            CHANNEL_ID,
        )

        try:
            return int(value)
        except Exception:
            return value

    def set_channel_id(
        self,
        channel_id: int,
    ):
        self.set_setting(
            "channel_id",
            channel_id,
        )

    # =====================================================
    # ADMIN GROUP
    # =====================================================

    def create_group_confirmation(
        self,
        group_id: int,
        title: str | None,
        owner_id: int,
    ):
        """
        گروه را به‌صورت pending ذخیره می‌کند.
        """

        with self.lock:

            self.conn.execute(
                """
                INSERT INTO admin_groups
                (
                    group_id,
                    title,
                    owner_id,
                    confirmed,
                    created_at
                )
                VALUES (?, ?, ?, 0, ?)

                ON CONFLICT(group_id)
                DO UPDATE SET
                    title = excluded.title,
                    owner_id = excluded.owner_id
                """,
                (
                    group_id,
                    title,
                    owner_id,
                    self.now(),
                ),
            )

            self._commit()

    def confirm_admin_group(
        self,
        group_id: int,
        owner_id: int,
    ) -> bool:

        if not self.is_owner(owner_id):
            return False

        with self.lock:

            # فقط یک گروه اصلی داشته باشیم
            self.conn.execute(
                """
                UPDATE admin_groups
                SET
                    confirmed = 0
                WHERE confirmed = 1
                """
            )

            cursor = self.conn.execute(
                """
                UPDATE admin_groups
                SET
                    confirmed = 1,
                    owner_id = ?,
                    confirmed_at = ?
                WHERE group_id = ?
                """,
                (
                    owner_id,
                    self.now(),
                    group_id,
                ),
            )

            self._commit()

            return cursor.rowcount == 1

    def get_admin_group(self):
        return self.conn.execute(
            """
            SELECT *
            FROM admin_groups
            WHERE confirmed = 1
            ORDER BY confirmed_at DESC
            LIMIT 1
            """
        ).fetchone()

    def get_pending_group(
        self,
        group_id: int,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM admin_groups
            WHERE group_id = ?
            LIMIT 1
            """,
            (group_id,),
        ).fetchone()

    def is_admin_group(
        self,
        group_id: int,
    ) -> bool:
        row = self.conn.execute(
            """
            SELECT 1
            FROM admin_groups
            WHERE
                group_id = ?
                AND confirmed = 1
            LIMIT 1
            """,
            (group_id,),
        ).fetchone()

        return row is not None

    def delete_admin_group(self):
        with self.lock:
            self.conn.execute(
                """
                UPDATE admin_groups
                SET confirmed = 0
                WHERE confirmed = 1
                """
            )

            self._commit()

    # =====================================================
    # SHIFT REQUESTS
    # =====================================================

    def create_shift_request(
        self,
        admin_id: int,
        message: str,
    ) -> int:

        with self.lock:

            cursor = self.conn.execute(
                """
                INSERT INTO shift_requests
                (
                    admin_id,
                    message,
                    status,
                    created_at
                )
                VALUES (?, ?, 'pending', ?)
                """,
                (
                    admin_id,
                    message,
                    self.now(),
                ),
            )

            self._commit()

            return int(cursor.lastrowid)

    def get_shift_requests(
        self,
        status: str = "pending",
        limit: int = 50,
    ):
        return self.conn.execute(
            """
            SELECT
                shift_requests.*,
                admins.name AS admin_name
            FROM shift_requests
            LEFT JOIN admins
                ON admins.user_id =
                    shift_requests.admin_id
            WHERE shift_requests.status = ?
            ORDER BY shift_requests.created_at DESC
            LIMIT ?
            """,
            (
                status,
                limit,
            ),
        ).fetchall()

    def set_shift_request_status(
        self,
        request_id: int,
        status: str,
    ):
        with self.lock:
            self.conn.execute(
                """
                UPDATE shift_requests
                SET status = ?
                WHERE id = ?
                """,
                (
                    status,
                    request_id,
                ),
            )

            self._commit()

    # =====================================================
    # STATS
    # =====================================================

    def owner_stats(self):
        row = self.conn.execute(
            """
            SELECT
                SUM(
                    CASE
                        WHEN status IN
                        ('pending', 'processing', 'queued')
                        THEN 1 ELSE 0
                    END
                ) AS pending,

                SUM(
                    CASE
                        WHEN status = 'approved'
                        THEN 1 ELSE 0
                    END
                ) AS approved,

                SUM(
                    CASE
                        WHEN status = 'rejected'
                        THEN 1 ELSE 0
                    END
                ) AS rejected
            FROM messages
            """
        ).fetchone()

        return {
            "pending": int(
                row["pending"] or 0
            ),
            "approved": int(
                row["approved"] or 0
            ),
            "rejected": int(
                row["rejected"] or 0
            ),
            "users": self.count_active_users(),
        }

    def admin_stats(
        self,
        admin_id: int,
    ):
        row = self.conn.execute(
            """
            SELECT
                COUNT(
                    CASE
                        WHEN action IN
                        ('approved', 'rejected')
                        THEN 1
                    END
                ) AS reviewed,

                COUNT(
                    CASE
                        WHEN action = 'approved'
                        THEN 1
                    END
                ) AS approved,

                COUNT(
                    CASE
                        WHEN action = 'rejected'
                        THEN 1
                    END
                ) AS rejected
            FROM admin_actions
            WHERE admin_id = ?
            """,
            (admin_id,),
        ).fetchone()

        avg_row = self.conn.execute(
            """
            SELECT AVG(
                (
                    julianday(messages.reviewed_at)
                    -
                    julianday(messages.submitted_at)
                ) * 86400
            ) AS avg_seconds
            FROM messages
            WHERE
                messages.admin_id = ?
                AND messages.reviewed_at IS NOT NULL
                AND messages.status IN
                    ('approved', 'rejected')
            """,
            (admin_id,),
        ).fetchone()

        return {
            "reviewed": int(
                row["reviewed"] or 0
            ),
            "approved": int(
                row["approved"] or 0
            ),
            "rejected": int(
                row["rejected"] or 0
            ),
            "avg_seconds": float(
                avg_row["avg_seconds"] or 0
            ),
        }

    def get_user_message_stats(
        self,
        limit: int = 100,
    ):
        return self.conn.execute(
            """
            SELECT
                users.user_id,
                users.username,
                users.first_name,
                users.last_name,
                COUNT(messages.id) AS message_count
            FROM users
            LEFT JOIN messages
                ON messages.user_id = users.user_id
            WHERE users.started = 1
            GROUP BY users.user_id
            ORDER BY message_count DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    def get_admin_message_stats(
        self,
        limit: int = 100,
    ):
        return self.conn.execute(
            """
            SELECT
                admins.user_id,
                admins.name,
                COUNT(
                    CASE
                        WHEN admin_actions.action
                        IN ('approved', 'rejected')
                        THEN 1
                    END
                ) AS reviewed,

                COUNT(
                    CASE
                        WHEN admin_actions.action =
                        'approved'
                        THEN 1
                    END
                ) AS approved,

                COUNT(
                    CASE
                        WHEN admin_actions.action =
                        'rejected'
                        THEN 1
                    END
                ) AS rejected

            FROM admins

            LEFT JOIN admin_actions
                ON admin_actions.admin_id =
                    admins.user_id

            GROUP BY admins.user_id

            ORDER BY reviewed DESC

            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    # =====================================================
    # CLEANUP
    # =====================================================

    def cleanup_old_data(self):
        with self.lock:

            cutoff = (
                datetime.utcnow()
                - timedelta(
                    hours=DATA_RETENTION_HOURS
                )
            ).isoformat(
                timespec="seconds"
            )

            self.conn.execute(
                """
                DELETE FROM messages
                WHERE
                    submitted_at < ?
                    AND status IN
                    ('approved', 'rejected')
                """,
                (cutoff,),
            )

            self.conn.execute(
                """
                DELETE FROM rate_limits
                WHERE created_at < ?
                """,
                (cutoff,),
            )

            self.conn.execute(
                """
                DELETE FROM shift_requests
                WHERE created_at < ?
                AND status != 'pending'
                """,
                (cutoff,),
            )

            self._commit()

    # =====================================================
    # HEALTH
    # =====================================================

    def health_check(self) -> bool:
        try:
            self.conn.execute(
                "SELECT 1"
            ).fetchone()

            return True

        except Exception:
            return False

    # =====================================================
    # CLOSE
    # =====================================================

    def close(self):
        with self.lock:
            try:
                self.conn.close()
            except Exception:
                pass
