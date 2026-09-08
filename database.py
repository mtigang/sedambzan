from __future__ import annotations

import json
import sqlite3
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

        Path(self.path).parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.conn = sqlite3.connect(
            self.path,
            check_same_thread=False,
            timeout=30,
        )

        self.conn.row_factory = sqlite3.Row

        self._configure()
        self._create_tables()
        self._migrate()
        self._load_initial_owners()
        self._load_defaults()

    def _configure(self):
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA synchronous = NORMAL")
        self.conn.execute("PRAGMA busy_timeout = 30000")
        self.conn.commit()

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass

    def _create_tables(self):
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS owners (
                user_id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admins (
                user_id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                notifications_enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
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
                status TEXT NOT NULL DEFAULT 'pending',
                admin_id INTEGER,
                admin_message_id INTEGER,
                channel_message_id INTEGER,
                reject_reason TEXT,
                submitted_at TEXT NOT NULL,
                reviewed_at TEXT,

                FOREIGN KEY(user_id)
                    REFERENCES users(user_id)
                    ON DELETE CASCADE,

                FOREIGN KEY(admin_id)
                    REFERENCES admins(user_id)
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

            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                created_at TEXT NOT NULL
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

            CREATE INDEX IF NOT EXISTS idx_messages_status
            ON messages(status);

            CREATE INDEX IF NOT EXISTS idx_messages_admin
            ON messages(admin_id);

            CREATE INDEX IF NOT EXISTS idx_messages_submitted
            ON messages(submitted_at);

            CREATE INDEX IF NOT EXISTS idx_rate_user_time
            ON rate_limits(user_id, created_at);

            CREATE INDEX IF NOT EXISTS idx_logs_time
            ON activity_logs(created_at);

            CREATE INDEX IF NOT EXISTS idx_shifts_weekday
            ON shifts(weekday);

            CREATE INDEX IF NOT EXISTS idx_shifts_date
            ON shifts(specific_date);
            """
        )

        self.conn.commit()

    def _migrate(self):
        """
        شیفت دائمی در نسخه جدید یعنی:
        هر روز، بدون وابستگی به weekday.

        برای سازگاری با دیتابیس قدیمی، تمام شیفت‌های permanent
        به weekday=-1 تبدیل می‌شوند.
        """
        try:
            self.conn.execute(
                """
                UPDATE shifts
                SET weekday = -1
                WHERE permanent = 1
                """
            )

            self.conn.commit()
        except Exception:
            pass

    @staticmethod
    def now() -> str:
        return datetime.utcnow().isoformat(timespec="seconds")

    @staticmethod
    def _json(value: Any) -> str | None:
        if value is None:
            return None

        try:
            return json.dumps(
                value,
                ensure_ascii=False,
            )
        except Exception:
            return None

    @staticmethod
    def _load_json(value: str | None):
        if not value:
            return []

        try:
            return json.loads(value)
        except Exception:
            return []

    # ---------------------------------------------------------
    # Owners
    # ---------------------------------------------------------

    def _load_initial_owners(self):
        for user_id in OWNER_IDS:
            self.conn.execute(
                """
                INSERT OR IGNORE INTO owners(
                    user_id,
                    created_at
                )
                VALUES (?, ?)
                """,
                (
                    int(user_id),
                    self.now(),
                ),
            )

        self.conn.commit()

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
            ORDER BY user_id
            """
        ).fetchall()

    def add_owner(self, user_id: int):
        self.conn.execute(
            """
            INSERT OR IGNORE INTO owners(
                user_id,
                created_at
            )
            VALUES (?, ?)
            """,
            (
                user_id,
                self.now(),
            ),
        )

        self.conn.commit()

    def remove_owner(self, user_id: int):
        self.conn.execute(
            """
            DELETE FROM owners
            WHERE user_id = ?
            """,
            (user_id,),
        )

        self.conn.commit()

    # ---------------------------------------------------------
    # Admins
    # ---------------------------------------------------------

    def add_admin(
        self,
        user_id: int,
        name: str,
    ):
        self.conn.execute(
            """
            INSERT INTO admins(
                user_id,
                name,
                active,
                notifications_enabled,
                created_at
            )
            VALUES (?, ?, 1, 1, ?)

            ON CONFLICT(user_id)
            DO UPDATE SET
                name = excluded.name
            """,
            (
                user_id,
                name,
                self.now(),
            ),
        )

        self.conn.commit()

    def delete_admin(self, user_id: int):
        self.conn.execute(
            """
            DELETE FROM admins
            WHERE user_id = ?
            """,
            (user_id,),
        )

        self.conn.commit()

    def set_admin_active(
        self,
        user_id: int,
        active: bool,
    ):
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

        self.conn.commit()

    def set_admin_notifications(
        self,
        user_id: int,
        enabled: bool,
    ):
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

        self.conn.commit()

    def get_admin(self, user_id: int):
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
                ORDER BY name COLLATE NOCASE
                """
            ).fetchall()

        return self.conn.execute(
            """
            SELECT *
            FROM admins
            ORDER BY name COLLATE NOCASE
            """
        ).fetchall()

    def count_admins(self):
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM admins
            """
        ).fetchone()

        return row["c"]

    # ---------------------------------------------------------
    # Users
    # ---------------------------------------------------------

    def upsert_user(
        self,
        user_id: int,
        username: str | None,
        first_name: str | None,
        last_name: str | None,
    ):
        now = self.now()

        self.conn.execute(
            """
            INSERT INTO users(
                user_id,
                username,
                first_name,
                last_name,
                blocked,
                created_at,
                last_seen
            )
            VALUES (?, ?, ?, ?, 0, ?, ?)

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
                now,
                now,
            ),
        )

        self.conn.commit()

    def get_user(self, user_id: int):
        return self.conn.execute(
            """
            SELECT *
            FROM users
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    def is_blocked(self, user_id: int) -> bool:
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

        self.conn.commit()

    def count_active_users(self):
        cutoff = (
            datetime.utcnow()
            - timedelta(hours=24)
        ).isoformat(timespec="seconds")

        row = self.conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM users
            WHERE last_seen >= ?
            """,
            (cutoff,),
        ).fetchone()

        return row["c"]

    # ---------------------------------------------------------
    # Shifts
    # ---------------------------------------------------------

    def create_shift(
        self,
        start_time: str,
        end_time: str,
        admin_id: int,
        permanent: bool = True,
        specific_date: str | None = None,
    ):
        # weekday دیگر برای permanent استفاده نمی‌شود.
        weekday = -1

        if permanent:
            specific_date = None
        else:
            if not specific_date:
                raise ValueError(
                    "specific_date is required for date-specific shift"
                )

        cur = self.conn.execute(
            """
            INSERT INTO shifts(
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

        self.conn.commit()

        return cur.lastrowid

    def delete_shift(self, shift_id: int):
        self.conn.execute(
            """
            DELETE FROM shifts
            WHERE id = ?
            """,
            (shift_id,),
        )

        self.conn.commit()

    def get_shift(self, shift_id: int):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            LEFT JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE shifts.id = ?
            """,
            (shift_id,),
        ).fetchone()

    def get_today_shifts(
        self,
        weekday: int,
        specific_date: str,
    ):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE admins.active = 1
              AND (
                    shifts.permanent = 1
                    OR (
                        shifts.permanent = 0
                        AND shifts.specific_date = ?
                    )
                  )
            ORDER BY
                CASE
                    WHEN shifts.permanent = 0
                    THEN 0
                    ELSE 1
                END,
                shifts.start_time
            """,
            (specific_date,),
        ).fetchall()

    def get_current_shift(
        self,
        weekday: int,
        current_time: str,
        specific_date: str,
    ):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name,
                admins.notifications_enabled
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE admins.active = 1
              AND shifts.start_time <= ?
              AND shifts.end_time > ?
              AND (
                    shifts.permanent = 1
                    OR (
                        shifts.permanent = 0
                        AND shifts.specific_date = ?
                    )
                  )
            ORDER BY
                CASE
                    WHEN shifts.permanent = 0
                    THEN 0
                    ELSE 1
                END,
                shifts.start_time DESC
            LIMIT 1
            """,
            (
                current_time,
                current_time,
                specific_date,
            ),
        ).fetchone()

    def get_admin_today_shifts(
        self,
        admin_id: int,
        specific_date: str,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM shifts
            WHERE admin_id = ?
              AND (
                    permanent = 1
                    OR (
                        permanent = 0
                        AND specific_date = ?
                    )
                  )
            ORDER BY
                CASE
                    WHEN permanent = 0
                    THEN 0
                    ELSE 1
                END,
                start_time
            """,
            (
                admin_id,
                specific_date,
            ),
        ).fetchall()

    def get_permanent_shifts(
        self,
        admin_id: int | None = None,
    ):
        if admin_id is None:
            return self.conn.execute(
                """
                SELECT
                    shifts.*,
                    admins.name AS admin_name
                FROM shifts
                JOIN admins
                    ON admins.user_id = shifts.admin_id
                WHERE shifts.permanent = 1
                ORDER BY
                    shifts.start_time
                """
            ).fetchall()

        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE shifts.permanent = 1
              AND shifts.admin_id = ?
            ORDER BY
                shifts.start_time
            """,
            (admin_id,),
        ).fetchall()

    def get_date_shifts(
        self,
        admin_id: int | None = None,
    ):
        if admin_id is None:
            return self.conn.execute(
                """
                SELECT
                    shifts.*,
                    admins.name AS admin_name
                FROM shifts
                JOIN admins
                    ON admins.user_id = shifts.admin_id
                WHERE shifts.permanent = 0
                ORDER BY
                    shifts.specific_date,
                    shifts.start_time
                """
            ).fetchall()

        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            JOIN admins
                ON admins.user_id = shifts.admin_id
            WHERE shifts.permanent = 0
              AND shifts.admin_id = ?
            ORDER BY
                shifts.specific_date,
                shifts.start_time
            """,
            (admin_id,),
        ).fetchall()

    def get_all_shifts(self):
        return self.conn.execute(
            """
            SELECT
                shifts.*,
                admins.name AS admin_name
            FROM shifts
            LEFT JOIN admins
                ON admins.user_id = shifts.admin_id
            ORDER BY
                CASE
                    WHEN shifts.permanent = 1
                    THEN 0
                    ELSE 1
                END,
                shifts.specific_date,
                shifts.start_time
            """
        ).fetchall()

    # ---------------------------------------------------------
    # Messages
    # ---------------------------------------------------------

    def create_message(
        self,
        user_id: int,
        content: str,
        entities: list[dict] | None,
        admin_id: int,
    ):
        cur = self.conn.execute(
            """
            INSERT INTO messages(
                user_id,
                content,
                entities_json,
                status,
                admin_id,
                submitted_at
            )
            VALUES (?, ?, ?, 'pending', ?, ?)
            """,
            (
                user_id,
                content,
                self._json(entities),
                admin_id,
                self.now(),
            ),
        )

        self.conn.commit()

        return cur.lastrowid

    def get_message(self, message_id: int):
        row = self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE id = ?
            """,
            (message_id,),
        ).fetchone()

        if row is None:
            return None

        data = dict(row)

        data["entities"] = self._load_json(
            data.get("entities_json")
        )

        return data

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
        limit: int = 10,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM messages
            WHERE status = 'pending'
              AND admin_id = ?
            ORDER BY submitted_at
            LIMIT ?
            """,
            (
                admin_id,
                limit,
            ),
        ).fetchall()

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
        telegram_message_id: int,
    ):
        self.conn.execute(
            """
            UPDATE messages
            SET admin_message_id = ?
            WHERE id = ?
            """,
            (
                telegram_message_id,
                message_id,
            ),
        )

        self.conn.commit()

    def set_channel_message_id(
        self,
        message_id: int,
        telegram_message_id: int,
    ):
        self.conn.execute(
            """
            UPDATE messages
            SET channel_message_id = ?
            WHERE id = ?
            """,
            (
                telegram_message_id,
                message_id,
            ),
        )

        self.conn.commit()

    def claim_message(
        self,
        message_id: int,
    ) -> bool:
        cur = self.conn.execute(
            """
            UPDATE messages
            SET status = 'processing'
            WHERE id = ?
              AND status = 'pending'
            """,
            (message_id,),
        )

        self.conn.commit()

        return cur.rowcount == 1

    def restore_pending(
        self,
        message_id: int,
    ):
        self.conn.execute(
            """
            UPDATE messages
            SET status = 'pending'
            WHERE id = ?
              AND status = 'processing'
            """,
            (message_id,),
        )

        self.conn.commit()

    def set_message_status(
        self,
        message_id: int,
        status: str,
        reject_reason: str | None = None,
    ):
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
                self.now(),
                message_id,
            ),
        )

        self.conn.commit()

    def count_pending(self):
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM messages
            WHERE status = 'pending'
            """
        ).fetchone()

        return row["c"]

    # ---------------------------------------------------------
    # Rate Limit
    # ---------------------------------------------------------

    def count_recent_attempts(
        self,
        user_id: int,
        seconds: int,
    ):
        cutoff = (
            datetime.utcnow()
            - timedelta(seconds=seconds)
        ).isoformat(timespec="seconds")

        row = self.conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM rate_limits
            WHERE user_id = ?
              AND created_at >= ?
            """,
            (
                user_id,
                cutoff,
            ),
        ).fetchone()

        return row["c"]

    def add_rate_attempt(
        self,
        user_id: int,
    ):
        self.conn.execute(
            """
            INSERT INTO rate_limits(
                user_id,
                created_at
            )
            VALUES (?, ?)
            """,
            (
                user_id,
                self.now(),
            ),
        )

        self.conn.commit()

    # ---------------------------------------------------------
    # Settings
    # ---------------------------------------------------------

    def _load_defaults(self):
        defaults = {
            "bot_enabled": (
                "1"
                if BOT_ENABLED_DEFAULT
                else "0"
            ),
            "channel_id": str(CHANNEL_ID),
        }

        for key, value in defaults.items():
            self.conn.execute(
                """
                INSERT OR IGNORE INTO settings(
                    key,
                    value
                )
                VALUES (?, ?)
                """,
                (
                    key,
                    value,
                ),
            )

        self.conn.commit()

    def get_setting(
        self,
        key: str,
        default=None,
    ):
        row = self.conn.execute(
            """
            SELECT value
            FROM settings
            WHERE key = ?
            """,
            (key,),
        ).fetchone()

        if row is None:
            return default

        return row["value"]

    def set_setting(
        self,
        key: str,
        value: str,
    ):
        self.conn.execute(
            """
            INSERT INTO settings(
                key,
                value
            )
            VALUES (?, ?)

            ON CONFLICT(key)
            DO UPDATE SET
                value = excluded.value
            """,
            (
                key,
                value,
            ),
        )

        self.conn.commit()

    def is_bot_enabled(self):
        return (
            self.get_setting(
                "bot_enabled",
                "1",
            )
            == "1"
        )

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
            str(CHANNEL_ID),
        )

        try:
            return int(value)
        except Exception:
            return 0

    # ---------------------------------------------------------
    # Logs
    # ---------------------------------------------------------

    def log(
        self,
        actor_id: int | None,
        action: str,
        details: str | None = None,
    ):
        self.conn.execute(
            """
            INSERT INTO activity_logs(
                actor_id,
                action,
                details,
                created_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                actor_id,
                action,
                details,
                self.now(),
            ),
        )

        self.conn.commit()

    def get_recent_logs(
        self,
        limit: int = 30,
    ):
        return self.conn.execute(
            """
            SELECT *
            FROM activity_logs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    # ---------------------------------------------------------
    # Shift Requests
    # ---------------------------------------------------------

    def create_shift_request(
        self,
        admin_id: int,
        message: str,
    ):
        cur = self.conn.execute(
            """
            INSERT INTO shift_requests(
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

        self.conn.commit()

        return cur.lastrowid

    def get_pending_shift_requests(self):
        return self.conn.execute(
            """
            SELECT
                shift_requests.*,
                admins.name AS admin_name
            FROM shift_requests
            JOIN admins
                ON admins.user_id =
                   shift_requests.admin_id
            WHERE shift_requests.status = 'pending'
            ORDER BY shift_requests.created_at
            """
        ).fetchall()

    def set_shift_request_status(
        self,
        request_id: int,
        status: str,
    ):
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

        self.conn.commit()

    # ---------------------------------------------------------
    # Statistics
    # ---------------------------------------------------------

    def owner_stats(self):
        result = {}

        for status in (
            "pending",
            "approved",
            "rejected",
        ):
            row = self.conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM messages
                WHERE status = ?
                """,
                (status,),
            ).fetchone()

            result[status] = row["c"]

        result["users"] = self.count_active_users()

        return result

    def admin_stats(
        self,
        admin_id: int,
    ):
        row = self.conn.execute(
            """
            SELECT
                COUNT(*) AS reviewed,

                SUM(
                    CASE
                        WHEN status = 'approved'
                        THEN 1
                        ELSE 0
                    END
                ) AS approved,

                SUM(
                    CASE
                        WHEN status = 'rejected'
                        THEN 1
                        ELSE 0
                    END
                ) AS rejected

            FROM messages

            WHERE admin_id = ?

              AND status IN (
                  'approved',
                  'rejected'
              )
            """,
            (admin_id,),
        ).fetchone()

        reviewed = row["reviewed"] or 0
        approved = row["approved"] or 0
        rejected = row["rejected"] or 0

        avg_row = self.conn.execute(
            """
            SELECT AVG(
                (
                    julianday(reviewed_at)
                    -
                    julianday(submitted_at)
                ) * 86400
            ) AS avg_seconds

            FROM messages

            WHERE admin_id = ?
              AND reviewed_at IS NOT NULL
              AND submitted_at IS NOT NULL
            """,
            (admin_id,),
        ).fetchone()

        return {
            "reviewed": reviewed,
            "approved": approved,
            "rejected": rejected,
            "avg_seconds": (
                avg_row["avg_seconds"]
                or 0
            ),
        }

    # ---------------------------------------------------------
    # Cleanup
    # ---------------------------------------------------------

    def cleanup_old_data(self):
        cutoff = (
            datetime.utcnow()
            - timedelta(
                hours=DATA_RETENTION_HOURS
            )
        ).isoformat(timespec="seconds")

        counts = {}

        cur = self.conn.execute(
            """
            DELETE FROM messages
            WHERE submitted_at < ?
            """,
            (cutoff,),
        )

        counts["messages"] = cur.rowcount

        cur = self.conn.execute(
            """
            DELETE FROM rate_limits
            WHERE created_at < ?
            """,
            (cutoff,),
        )

        counts["rate_limits"] = cur.rowcount

        cur = self.conn.execute(
            """
            DELETE FROM activity_logs
            WHERE created_at < ?
            """,
            (cutoff,),
        )

        counts["logs"] = cur.rowcount

        cur = self.conn.execute(
            """
            DELETE FROM shift_requests
            WHERE created_at < ?
            """,
            (cutoff,),
        )

        counts["shift_requests"] = cur.rowcount

        cur = self.conn.execute(
            """
            DELETE FROM users
            WHERE last_seen < ?
              AND user_id NOT IN (
                  SELECT DISTINCT user_id
                  FROM messages
              )
            """,
            (cutoff,),
        )

        counts["users"] = cur.rowcount

        self.conn.commit()

        counts["temporary"] = (
            counts["rate_limits"]
            + counts["users"]
            + counts["shift_requests"]
        )

        return counts

    def health_check(self):
        try:
            self.conn.execute(
                "SELECT 1"
            ).fetchone()

            return True

        except Exception:
            return False