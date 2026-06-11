"""RunningHub API client — adapted from the upstream rhclient.py."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import http.client
from dataclasses import dataclass
from enum import Enum
from typing import Optional

# ---------------------------------------------------------------------------
# Enums & dataclasses
# ---------------------------------------------------------------------------

class TaskStatus(str, Enum):
    PENDING  = "PENDING"
    ADDED    = "ADDED"
    QUEUED   = "QUEUED"
    RUNNING  = "RUNNING"
    SUCCESS  = "SUCCESS"
    FAILED   = "FAILED"


@dataclass
class NodeInfo:
    nodeId: str
    fieldName: str
    fieldValue: str


@dataclass
class CreateTaskParams:
    workflowId: str
    nodeInfoList: list[NodeInfo] | None = None
    addMetadata: bool = True
    instanceType: str = "plus"


@dataclass
class UploadResourceResponse:
    type: str
    download_url: str
    fileName: str
    size: str


@dataclass
class TaskOutput:
    fileUrl: str
    fileType: str
    taskCostTime: str
    nodeId: str
    thirdPartyConsumeMoney: str
    consumeMoney: str
    consumeCoins: str


@dataclass
class RunningHubConfig:
    baseUrl: str
    apiKey: str


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class RunningHub:
    def __init__(self, config: RunningHubConfig):
        self.base_url = config.baseUrl.rstrip("/")
        self.api_key = config.apiKey

    def _headers(self) -> dict[str, str]:
        parsed = urllib.parse.urlparse(self.base_url)
        return {
            "Host": parsed.netloc,
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _post(self, path: str, body: dict, retries: int = 5) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers(), method="POST")

        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return json.loads(resp.read())
            except (
                http.client.RemoteDisconnected,
                BrokenPipeError,
                ConnectionResetError,
                urllib.error.URLError,
            ) as exc:
                last_err = exc
                print(f"  [{path}] attempt {attempt + 1}/{retries} failed: {exc}")
                if attempt < retries - 1:
                    time.sleep(1 * (attempt + 1))
                    req = urllib.request.Request(url, data=data, headers=self._headers(), method="POST")

        raise RuntimeError(f"Failed after {retries} retries: {last_err}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_task(self, params: CreateTaskParams) -> str:
        body = {
            "apiKey": self.api_key,
            "workflowId": params.workflowId,
            "nodeInfoList": (
                [{"nodeId": n.nodeId, "fieldName": n.fieldName, "fieldValue": n.fieldValue}
                 for n in params.nodeInfoList]
                if params.nodeInfoList else []
            ),
            "addMetadata": params.addMetadata,
            "instanceType": params.instanceType,
        }
        data = self._post("/task/openapi/create", body)
        task_id = (data.get("data") or {}).get("taskId")
        if task_id:
            return task_id
        error = data.get("details") or data.get("msg") or "Failed to create task"
        raise RuntimeError(error)

    def get_task_status(self, task_id: str) -> TaskStatus:
        body = {"apiKey": self.api_key, "taskId": task_id}
        data = self._post("/task/openapi/status", body)
        status = data.get("data")
        if isinstance(status, str):
            return TaskStatus(status)
        if isinstance(status, dict) and status.get("status"):
            return TaskStatus(status["status"])
        raise RuntimeError(f"Unexpected status response: {data}")

    def get_task_outputs(self, task_id: str) -> list[TaskOutput]:
        body = {"apiKey": self.api_key, "taskId": task_id}
        data = self._post("/task/openapi/outputs", body)
        return [TaskOutput(**o) for o in (data.get("data") or [])]

    def get_workflow_json(self, workflow_id: str) -> dict:
        body = {"apiKey": self.api_key, "workflowId": workflow_id}
        data = self._post("/api/openapi/getJsonApiFormat", body)
        if data.get("code") == 0 and data.get("data", {}).get("prompt"):
            return json.loads(data["data"]["prompt"])
        raise RuntimeError(data.get("msg") or "Failed to get workflow JSON")

    def upload_resource(self, file_data: bytes | bytearray) -> UploadResourceResponse:
        url = f"{self.base_url}/openapi/v2/media/upload/binary"
        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="file"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + bytes(file_data) + f"\r\n--{boundary}--\r\n".encode("utf-8")

        headers = self._headers().copy()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        headers.pop("Content-Type", None)

        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())

        code = data.get("code")
        if code not in (0, 200) or not data.get("data", {}).get("fileName"):
            raise RuntimeError(data.get("msg") or "Failed to upload resource")
        return UploadResourceResponse(**data["data"])

    def wait_for_task(self, task_id: str, interval_seconds: float = 30) -> list[TaskOutput]:
        while True:
            status = self.get_task_status(task_id)
            if status == TaskStatus.SUCCESS:
                break
            if status == TaskStatus.FAILED:
                raise RuntimeError("Task failed on RunningHub")
            time.sleep(interval_seconds)
        return self.get_task_outputs(task_id)
