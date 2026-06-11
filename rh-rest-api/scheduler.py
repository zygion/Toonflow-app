"""Background scheduler — polls DB, submits PENDING tasks to RunningHub, downloads outputs."""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
import http.client
from pathlib import Path
from threading import Thread
from typing import NoReturn

from config import Config, get_config
from db import (
    TaskStatus,
    count_running,
    create_task,
    get_model_by_name,
    get_tasks_by_status,
    mark_task_done,
    set_rh_task_id,
    set_task_error,
    update_task_outputs,
    update_task_status,
)
from rhclient import CreateTaskParams, NodeInfo, RunningHub, TaskOutput

log = logging.getLogger("scheduler")


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def download_file(url: str, filepath: Path, retries: int = 5) -> None:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    encoded = urllib.parse.quote(url, safe=":/")
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            urllib.request.urlretrieve(encoded, filepath)
            return
        except (OSError, urllib.error.URLError, http.client.RemoteDisconnected) as exc:
            last_err = exc
            log.warning("  download attempt %s/%s failed: %s", attempt + 1, retries, exc)
            if attempt < retries - 1:
                time.sleep(1 * (attempt + 1))
    log.error("  download failed after %s retries: %s", retries, last_err)


# ---------------------------------------------------------------------------
# Task submission
# ---------------------------------------------------------------------------

def _submit_task(task: dict, client: RunningHub, db_path: str) -> None:
    """
    Map task inputs to RunningHub nodeInfos using the model's node_mapping,
    then submit to RunningHub and record the RH taskId.
    """
    local_id: int = task["id"]
    workflow_id: str = task["workflow_id"]
    inputs: dict = json.loads(task["inputs"] or "{}")

    # Look up the model to get node_mapping
    # We stored workflow_id as the task's workflow_id — find the model by it
    model = None
    for m in _list_all_models(db_path):
        if m["workflow_id"] == workflow_id:
            model = m
            break

    if not model:
        log.error("[%s] no model found for workflow_id=%s", local_id, workflow_id)
        set_task_error(task["task_id"] or str(local_id), f"No model for workflow {workflow_id}")
        return

    node_mapping: dict = json.loads(model["node_mapping"])

    # Build nodeInfo list: map each input key to its nodeId via node_mapping
    node_info_list: list[NodeInfo] = []
    for input_key, input_value in inputs.items():
        # Find the nodeId(s) that use this input name
        for node_id, spec in node_mapping.items():
            if spec.get("name") == input_key:
                node_info_list.append(NodeInfo(
                    nodeId=node_id,
                    fieldName=input_key,
                    fieldValue=str(input_value),
                ))

    if not node_info_list:
        log.warning("[%s] no node mappings matched for inputs: %s", local_id, list(inputs.keys()))

    params = CreateTaskParams(
        workflowId=workflow_id,
        nodeInfoList=node_info_list,
        addMetadata=True,
    )

    try:
        rh_task_id: str = client.create_task(params)
        set_rh_task_id(local_id, rh_task_id, db_path=db_path)
        log.info("[%s] submitted -> RH %s", local_id, rh_task_id)
    except RuntimeError as exc:
        log.error("[%s] submission failed: %s", local_id, exc)


def _check_task(task: dict, client: RunningHub, output_base: Path, db_path: str) -> None:
    """Poll a QUEUED/RUNNING task; on terminal status store outputs and mark DONE."""
    rh_id: str = task["task_id"]
    current = TaskStatus(task["status"])
    if current in (TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.DONE):
        return

    try:
        new_status = client.get_task_status(rh_id)
        log.info("  [%s] %s -> %s", rh_id, current.value, new_status.value)
    except RuntimeError as exc:
        log.warning("  [%s] status poll failed: %s", rh_id, exc)
        return

    if new_status == TaskStatus.SUCCESS:
        try:
            outputs: list[TaskOutput] = client.get_task_outputs(rh_id)
            results: list[dict] = [o.__dict__ for o in outputs]
        except RuntimeError as exc:
            log.error("  [%s] failed to fetch outputs: %s", rh_id, exc)
            set_task_error(rh_id, str(exc), db_path=db_path)
            return

        update_task_outputs(rh_id, results, db_path=db_path)

        # Optionally download files
        for out in results:
            file_url = out.get("fileUrl") or ""
            if not file_url:
                continue
            file_type = out.get("fileType") or "bin"
            node_id = out.get("nodeId") or "0"
            filename = f"{rh_id}_{node_id}.{file_type}"
            download_file(file_url, output_base / filename)
            log.info("  [%s] downloaded %s", rh_id, filename)

        mark_task_done(rh_id, db_path=db_path)
        log.info("  [%s] marked DONE", rh_id)

    elif new_status == TaskStatus.FAILED:
        set_task_error(rh_id, "Task failed on RunningHub", db_path=db_path)

    else:
        update_task_status(rh_id, new_status, db_path=db_path)


# ---------------------------------------------------------------------------
# Model helpers (needed by scheduler)
# ---------------------------------------------------------------------------

def _list_all_models(db_path: str) -> list[dict]:
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript("CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, node_mapping TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    rows = conn.execute("SELECT * FROM models").fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Scheduler loop
# ---------------------------------------------------------------------------

def run_scheduler(cfg: Config) -> NoReturn:
    client = RunningHub(config=cfg.rh)
    output_base = Path("outputs")
    output_base.mkdir(parents=True, exist_ok=True)

    log.info(
        "Scheduler started — RH=%s max_running=%s interval=%.1fs",
        cfg.rh.base_url, cfg.max_running_tasks, cfg.scheduler_interval_seconds,
    )

    while True:
        try:
            _tick(client, cfg, output_base)
        except Exception as exc:
            log.exception("Scheduler tick error: %s", exc)
        time.sleep(cfg.scheduler_interval_seconds)


def _tick(client: RunningHub, cfg: Config, output_base: Path) -> None:
    running = count_running(db_path=cfg.db_path)
    log.info("--- tick: running=%s/%s ---", running, cfg.max_running_tasks)

    # 1. Submit PENDING tasks while we have capacity
    if running < cfg.max_running_tasks:
        for task in get_tasks_by_status([TaskStatus.PENDING], db_path=cfg.db_path):
            if count_running(db_path=cfg.db_path) >= cfg.max_running_tasks:
                break
            _submit_task(task, client, db_path=cfg.db_path)

    # 2. Poll active tasks
    for task in get_tasks_by_status(
        [TaskStatus.QUEUED, TaskStatus.RUNNING], db_path=cfg.db_path
    ):
        _check_task(task, client, output_base, db_path=cfg.db_path)
