"""
RH REST API — FastAPI server + embedded background scheduler.

Models:
  POST   /models Create or update a model
  GET    /models              List all models
  GET    /models/{name}       Get a model by name
  DELETE /models/{name}       Delete a model

Tasks:
  POST   /tasks               Create a new task (looks up model by name, maps inputs)
  GET    /tasks               List tasks (filter by status)
  GET    /tasks/{id}          Get a single task by local id
  GET    /tasks/by-rh/{id}    Get a task by RunningHub taskId

Workflow:
  GET    /workflow/{id}/json  Fetch workflow structure from RunningHub

Health:
  GET    /health Liveness probe
"""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from config import Config, get_config
from db import (
    DB_PATH as _default_db_path,
    TaskStatus,
    create_model,
    create_task,
    delete_model,
    get_model_by_id,
    get_model_by_name,
    get_task_by_id,
    get_task_by_rh_id,
    list_models,
    upsert_model,
)
from rhclient import RunningHub
from scheduler import run_scheduler

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("api")

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

# -- Model inputs/outputs ---------------------------------------------------

class NodeMappingEntry(BaseModel):
    name: str


class ModelRequest(BaseModel):
    workflowId: str
    name: str
    type: str = Field(description="t2i | i2i | t2v | v2v")
    nodeMapping: dict[str, NodeMappingEntry]


class ModelResponse(BaseModel):
    id: int | None
    workflow_id: str
    name: str
    type: str
    node_mapping: dict[str, dict]
    created_at: str
    updated_at: str


# -- Task inputs/outputs ----------------------------------------------------

class TaskCreateRequest(BaseModel):
    model: str = Field(description="Model name to run")
    inputs: dict = Field(description="Input key-value pairs (e.g. prompt, image)")


class TaskResponse(BaseModel):
    id: int
    task_id: str | None
    workflow_id: str
    status: TaskStatus
    inputs: dict
    outputs: list[dict] | None
    error_msg: str | None
    created_at: str
    updated_at: str
    done_at: str | None


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

_scheduler_thread: threading.Thread | None = None
_app_cfg: Config | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler_thread, _app_cfg
    _app_cfg = get_config()

    from db import get_db
    with get_db(_app_cfg.db_path) as conn:
        pass  # ensure schema is created

    _scheduler_thread = threading.Thread(
        target=run_scheduler,
        args=(_app_cfg,),
        name="rh-scheduler",
        daemon=True,
    )
    _scheduler_thread.start()
    log.info("Scheduler thread started — RH=%s", _app_cfg.rh.base_url)

    yield
    log.info("Shutting down")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="RH REST API",
    description="Model-based REST wrapper for RunningHub",
    version="2.0.0",
    lifespan=lifespan,
)


def rh_client() -> RunningHub:
    if _app_cfg is None:
        raise RuntimeError("App not initialised")
    return RunningHub(config=_app_cfg.rh)


# ---------------------------------------------------------------------------
# Routes — Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


import os

@app.get("/ui")
async def ui():
    return FileResponse(os.path.join(os.path.dirname(__file__), "ui.html"), media_type="text/html")


# ---------------------------------------------------------------------------
# Routes — Models
# ---------------------------------------------------------------------------

@app.post("/models", response_model=ModelResponse, status_code=201)
async def create_or_update_model(req: ModelRequest):
    """Create a new model or update an existing one by name."""
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path

    # Normalise nodeMapping: { nodeId: { name: "..." } }
    normalised = {
        node_id: {"name": entry.name}
        for node_id, entry in req.nodeMapping.items()
    }

    upsert_model(
        workflow_id=req.workflowId,
        name=req.name,
        type=req.type,
        node_mapping=normalised,
        db_path=db_path,
    )

    model = get_model_by_name(req.name, db_path=db_path)
    if model is None:
        raise HTTPException(status_code=500, detail="Failed to retrieve model")

    return ModelResponse(
        id=model.id,
        workflow_id=model.workflow_id,
        name=model.name,
        type=model.type,
        node_mapping=model.node_mapping,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


@app.get("/models", response_model=list[ModelResponse])
async def list_all_models():
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    models = list_models(db_path=db_path)
    return [
        ModelResponse(
            id=m.id,
            workflow_id=m.workflow_id,
            name=m.name,
            type=m.type,
            node_mapping=m.node_mapping,
            created_at=m.created_at,
            updated_at=m.updated_at,
        )
        for m in models
    ]


@app.get("/models/{name}", response_model=ModelResponse)
async def get_model(name: str):
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    model = get_model_by_name(name, db_path=db_path)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    return ModelResponse(
        id=model.id,
        workflow_id=model.workflow_id,
        name=model.name,
        type=model.type,
        node_mapping=model.node_mapping,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


@app.delete("/models/{name}")
async def delete_model_by_name(name: str):
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    deleted = delete_model(name, db_path=db_path)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    return {"deleted": name}


# ---------------------------------------------------------------------------
# Routes — Tasks
# ---------------------------------------------------------------------------

@app.post("/tasks", response_model=TaskResponse, status_code=201)
async def create_new_task(req: TaskCreateRequest):
    """
    Create a new task.

    Looks up the model by name, gets its workflowId and nodeMapping,
    then creates a task in PENDING status. The scheduler will pick it up,
    map inputs to nodeIds, submit to RunningHub, and poll until done.
    """
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path

    # Resolve model name -> workflow_id
    model = get_model_by_name(req.model, db_path=db_path)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{req.model}' not found")

    local_id = create_task(
        workflow_id=model.workflow_id,
        inputs=req.inputs,
        db_path=db_path,
    )

    task = get_task_by_id(local_id, db_path=db_path)
    if task is None:
        raise HTTPException(status_code=500, detail="Failed to retrieve created task")

    return TaskResponse(
        id=task.id,
        task_id=task.task_id,
        workflow_id=task.workflow_id,
        status=task.status,
        inputs=task.inputs,
        outputs=task.outputs,
        error_msg=task.error_msg,
        created_at=task.created_at,
        updated_at=task.updated_at,
        done_at=task.done_at,
    )


@app.get("/tasks", response_model=list[TaskResponse])
async def list_tasks(
    status: TaskStatus | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    from db import list_tasks as _list_tasks
    tasks = _list_tasks(status=status, limit=limit, db_path=db_path)
    return [
        TaskResponse(
            id=t.id,
            task_id=t.task_id,
            workflow_id=t.workflow_id,
            status=t.status,
            inputs=t.inputs,
            outputs=t.outputs,
            error_msg=t.error_msg,
            created_at=t.created_at,
            updated_at=t.updated_at,
            done_at=t.done_at,
        )
        for t in tasks
    ]


@app.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: int):
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    task = get_task_by_id(task_id, db_path=db_path)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return TaskResponse(
        id=task.id,
        task_id=task.task_id,
        workflow_id=task.workflow_id,
        status=task.status,
        inputs=task.inputs,
        outputs=task.outputs,
        error_msg=task.error_msg,
        created_at=task.created_at,
        updated_at=task.updated_at,
        done_at=task.done_at,
    )


@app.get("/tasks/by-rh/{rh_task_id}", response_model=TaskResponse)
async def get_task_by_rh(rh_task_id: str):
    db_path = _app_cfg.db_path if _app_cfg else _default_db_path
    task = get_task_by_rh_id(rh_task_id, db_path=db_path)
    if task is None:
        raise HTTPException(status_code=404, detail=f"RunningHub task '{rh_task_id}' not found")
    return TaskResponse(
        id=task.id,
        task_id=task.task_id,
        workflow_id=task.workflow_id,
        status=task.status,
        inputs=task.inputs,
        outputs=task.outputs,
        error_msg=task.error_msg,
        created_at=task.created_at,
        updated_at=task.updated_at,
        done_at=task.done_at,
    )


# ---------------------------------------------------------------------------
# Routes — Workflow
# ---------------------------------------------------------------------------

@app.get("/workflow/{workflow_id}/json")
async def get_workflow_json(workflow_id: str):
    """Fetch the node skeleton for a RunningHub workflow."""
    print(f"Fetching workflow JSON for {workflow_id} from RunningHub...")
    try:
        wf = rh_client().get_workflow_json(workflow_id)
        return JSONResponse(wf)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    cfg = get_config()
    uvicorn.run("app:app", host=cfg.host, port=cfg.port, reload=False)
