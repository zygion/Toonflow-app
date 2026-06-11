"""SQLite database schema and helper functions."""
from __future__ import annotations

import json
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import http.client
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

DB_PATH = "rh_tasks.db"

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id  TEXT    NOT NULL,
    name         TEXT    NOT NULL UNIQUE,
    type         TEXT    NOT NULL,
    node_mapping TEXT NOT NULL,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_name    ON models(name);
CREATE INDEX IF NOT EXISTS idx_models_type ON models(type);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT    UNIQUE,
    workflow_id TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    inputs      TEXT    NOT NULL,
    outputs     TEXT,
    error_msg   TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow  ON tasks(workflow_id);
"""

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class TaskStatus(str, Enum):
    PENDING  = "PENDING"
    QUEUED   = "QUEUED"
    RUNNING  = "RUNNING"
    SUCCESS  = "SUCCESS"
    FAILED   = "FAILED"
    DONE     = "DONE"


# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------

def init_db(path: str = DB_PATH) -> None:
    with get_db(path) as conn:
        pass  # schema created by get_db()


from contextlib import contextmanager

@contextmanager
def get_db(path: str = DB_PATH):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    try:
        yield conn
    finally:
        conn.close()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Model:
    id: int | None
    workflow_id: str
    name: str
    type: str          # t2i | i2i | t2v | v2v
    node_mapping: dict[str, dict]   # { nodeId: { name: str } }
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Model":
        return cls(
            id=row["id"],
            workflow_id=row["workflow_id"],
            name=row["name"],
            type=row["type"],
            node_mapping=json.loads(row["node_mapping"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass
class Task:
    id: int | None
    task_id: str | None        # RunningHub taskId
    workflow_id: str
    status: TaskStatus
    inputs: dict # { image?, prompt?, ... }
    outputs: list[dict] | None
    error_msg: str | None
    created_at: str
    updated_at: str
    done_at: str | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Task":
        return cls(
            id=row["id"],
            task_id=row["task_id"],
            workflow_id=row["workflow_id"],
            status=TaskStatus(row["status"]),
            inputs=json.loads(row["inputs"]),
            outputs=json.loads(row["outputs"]) if row["outputs"] else None,
            error_msg=row["error_msg"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            done_at=row["done_at"],
        )


# ---------------------------------------------------------------------------
# Models CRUD
# ---------------------------------------------------------------------------

def create_model(
    *,
    workflow_id: str,
    name: str,
    type: str,
    node_mapping: dict,
    db_path: str = DB_PATH,
) -> int:
    now = _now()
    with get_db(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO models (workflow_id, name, type, node_mapping, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (workflow_id, name, type, json.dumps(node_mapping), now, now),
        )
        conn.commit()
        return cur.lastrowid


def upsert_model(
    *,
    workflow_id: str,
    name: str,
    type: str,
    node_mapping: dict,
    db_path: str = DB_PATH,
) -> int:
    """Insert or replace — used for create-or-update."""
    now = _now()
    with get_db(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO models (workflow_id, name, type, node_mapping, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                workflow_id = excluded.workflow_id,
                type       = excluded.type,
                node_mapping = excluded.node_mapping,
                updated_at  = excluded.updated_at
            """,
            (workflow_id, name, type, json.dumps(node_mapping), now, now),
        )
        conn.commit()
        return cur.lastrowid


def get_model_by_name(name: str, db_path: str = DB_PATH) -> Model | None:
    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM models WHERE name = ?", (name,)
        ).fetchone()
        return Model.from_row(row) if row else None


def get_model_by_id(model_id: int, db_path: str = DB_PATH) -> Model | None:
    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM models WHERE id = ?", (model_id,)
        ).fetchone()
        return Model.from_row(row) if row else None


def list_models(db_path: str = DB_PATH) -> list[Model]:
    with get_db(db_path) as conn:
        return [Model.from_row(r) for r in conn.execute(
            "SELECT * FROM models ORDER BY name"
        ).fetchall()]


def list_tasks(
    *,
    status: TaskStatus | None = None,
    limit: int = 100,
    db_path: str = DB_PATH,
) -> list[Task]:
    sql = "SELECT * FROM tasks"
    args: list[Any] = []
    where: list[str] = []
    if status:
        where.append("status = ?")
        args.append(status.value)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with get_db(db_path) as conn:
        return [Task.from_row(r) for r in conn.execute(sql, args).fetchall()]


def delete_model(name: str, db_path: str = DB_PATH) -> bool:
    with get_db(db_path) as conn:
        cur = conn.execute("DELETE FROM models WHERE name = ?", (name,))
        conn.commit()
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Tasks CRUD
# ---------------------------------------------------------------------------

def create_task(
    *,
    workflow_id: str,
    inputs: dict,
    db_path: str = DB_PATH,
) -> int:
    now = _now()
    with get_db(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO tasks (workflow_id, status, inputs, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (workflow_id, TaskStatus.PENDING.value, json.dumps(inputs), now, now),
        )
        conn.commit()
        return cur.lastrowid


def get_task_by_id(task_id: int, db_path: str = DB_PATH) -> Task | None:
    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return Task.from_row(row) if row else None


def get_task_by_rh_id(rh_task_id: str, db_path: str = DB_PATH) -> Task | None:
    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE task_id = ?", (rh_task_id,)
        ).fetchone()
        return Task.from_row(row) if row else None


def get_tasks_by_status(
    statuses: list[TaskStatus], db_path: str = DB_PATH
) -> list[dict]:
    placeholders = ",".join("?" * len(statuses))
    sql = f"SELECT * FROM tasks WHERE status IN ({placeholders}) ORDER BY created_at ASC"
    with get_db(db_path) as conn:
        return [dict(r) for r in conn.execute(sql, [s.value for s in statuses]).fetchall()]


def count_running(db_path: str = DB_PATH) -> int:
    with get_db(db_path) as conn:
        (count,) = conn.execute(
            f"SELECT COUNT(*) FROM tasks WHERE status IN (?, ?)",
            (TaskStatus.QUEUED.value, TaskStatus.RUNNING.value)
        ).fetchone()
        return count


def set_rh_task_id(local_id: int, rh_task_id: str, db_path: str = DB_PATH) -> None:
    now = _now()
    with get_db(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET task_id=?, status=?, updated_at=? WHERE id=?",
            (rh_task_id, TaskStatus.QUEUED.value, now, local_id)
        )
        conn.commit()


def update_task_status(rh_task_id: str, status: TaskStatus, db_path: str = DB_PATH) -> None:
    now = _now()
    extra = {"updated_at": now}
    if status == TaskStatus.DONE:
        extra["done_at"] = now
    sets = ["status=?", "updated_at=?"] + list(extra.keys())
    vals = [status.value, now] + list(extra.values()) + [rh_task_id]
    with get_db(db_path) as conn:
        conn.execute(f"UPDATE tasks SET {','.join(sets)} WHERE task_id=?", vals)
        conn.commit()


def update_task_outputs(rh_task_id: str, outputs: list[dict], db_path: str = DB_PATH) -> None:
    now = _now()
    with get_db(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET outputs=?, updated_at=? WHERE task_id=?",
            (json.dumps(outputs), now, rh_task_id)
        )
        conn.commit()


def set_task_error(rh_task_id: str, error_msg: str, db_path: str = DB_PATH) -> None:
    now = _now()
    with get_db(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET status=?, error_msg=?, updated_at=? WHERE task_id=?",
            (TaskStatus.FAILED.value, error_msg, now, rh_task_id)
        )
        conn.commit()


def mark_task_done(rh_task_id: str, db_path: str = DB_PATH) -> None:
    now = _now()
    with get_db(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET status=?, done_at=?, updated_at=? WHERE task_id=?",
            (TaskStatus.DONE.value, now, now, rh_task_id)
        )
        conn.commit()
