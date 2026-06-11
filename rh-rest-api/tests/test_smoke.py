"""Smoke tests — run with: python -m pytest tests/test_smoke.py -v"""
import pytest


def test_imports():
    from config import get_config
    from db import TaskStatus, create_model, create_task, init_db, list_models, list_tasks
    from rhclient import RunningHub, CreateTaskParams, NodeInfo
    from scheduler import run_scheduler
    from app import app
    assert True


def test_task_status_enum():
    from db import TaskStatus as DB_Status
    from rhclient import TaskStatus as RH_Status
    assert DB_Status.PENDING.value == "PENDING"
    assert DB_Status.DONE.value == "DONE"
    assert RH_Status.SUCCESS.value == "SUCCESS"


def test_node_info():
    from rhclient import NodeInfo
    n = NodeInfo(nodeId="2", fieldName="prompt", fieldValue="hello")
    assert n.nodeId == "2"
    assert n.fieldName == "prompt"
    assert n.fieldValue == "hello"


def test_model_round_trip(tmp_path):
    """create_model + list_models round-trip using an in-memory DB."""
    import tempfile
    from db import create_model, list_models, delete_model, get_db

    # Use a temp file so tests are isolated
    db = str(tmp_path / "test.db")
    with get_db(db) as conn:
        pass  # init schema

    create_model(
        workflow_id="wf-abc",
        name="test-model",
        type="t2i",
        node_mapping={"2": {"name": "prompt"}, "6": {"name": "image"}},
        db_path=db,
    )

    models = list_models(db_path=db)
    assert len(models) == 1
    assert models[0].name == "test-model"
    assert models[0].workflow_id == "wf-abc"
    assert models[0].type == "t2i"
    assert models[0].node_mapping == {"2": {"name": "prompt"}, "6": {"name": "image"}}

    deleted = delete_model("test-model", db_path=db)
    assert deleted is True
    assert list_models(db_path=db) == []


def test_task_round_trip(tmp_path):
    """create_task + get_task_by_id round-trip."""
    from db import create_task, get_task_by_id, TaskStatus, get_db

    db = str(tmp_path / "test_tasks.db")
    with get_db(db) as conn:
        pass

    local_id = create_task(
        workflow_id="wf-abc",
        inputs={"prompt": "a cat", "image": "http://example.com/cat.png"},
        db_path=db,
    )

    task = get_task_by_id(local_id, db_path=db)
    assert task is not None
    assert task.id == local_id
    assert task.workflow_id == "wf-abc"
    assert task.status == TaskStatus.PENDING
    assert task.inputs == {"prompt": "a cat", "image": "http://example.com/cat.png"}
    assert task.outputs is None
