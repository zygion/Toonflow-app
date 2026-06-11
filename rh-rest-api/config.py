"""Environment and app configuration."""
from dataclasses import dataclass
import os
from dotenv import load_dotenv

load_dotenv()


@dataclass
class RunningHubConfig:
    base_url: str
    api_key: str


@dataclass
class Config:
    rh: RunningHubConfig
    db_path: str
    host: str
    port: int
    scheduler_interval_seconds: float
    max_running_tasks: int


def get_config() -> Config:
    return Config(
        rh=RunningHubConfig(
            base_url=os.environ["RH_BASE_URL"].rstrip("/"),
            api_key=os.environ["RH_API_KEY"],
        ),
        db_path=os.environ.get("DB_PATH", "rh_tasks.db"),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        scheduler_interval_seconds=float(os.environ.get("SCHEDULER_INTERVAL_SECONDS", "10")),
        max_running_tasks=int(os.environ.get("MAX_RUNNING_TASKS", "3")),
    )
