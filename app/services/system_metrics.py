from __future__ import annotations

from pathlib import Path
import shutil

from app.config import Settings
from app.services.asr_monitoring import asr_monitor
from app.services.realtime_manager import RealtimeManager
from app.services.stream_manager import TaskManager


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total


def collect_system_metrics(
    settings: Settings,
    manager: TaskManager,
    realtime_manager: RealtimeManager,
) -> dict:
    disk = shutil.disk_usage(settings.output_dir.parent)

    active_tasks = sum(
        1
        for task in manager._tasks.values()  # noqa: SLF001
        if task.info.status.value not in {"done", "failed"}
    )

    monitor = asr_monitor.snapshot()

    return {
        "disk_percent": round(
            ((disk.used / disk.total) * 100) if disk.total else 0,
            1,
        ),
        "temp_size_mb": round(_dir_size(settings.temp_dir) / 1024 / 1024, 2),
        "outputs_size_mb": round(_dir_size(settings.output_dir) / 1024 / 1024, 2),
        "active_tasks": active_tasks,
        "realtime_sessions": len(realtime_manager.list()),
        "realtime_limit": settings.realtime_max_sessions,
        "asr_running": monitor["summary"]["running"],
        "asr_total": monitor["summary"]["total"],
    }


def collect_dashboard_metrics(
    manager: TaskManager,
    realtime_manager: RealtimeManager,
) -> dict:
    monitor = asr_monitor.snapshot()
    summary = monitor["summary"]

    total = summary["total"]
    succeeded = summary["succeeded"]

    return {
        "total_calls": total,
        "success_rate": round((succeeded / total) * 100, 1) if total else 100.0,
        "avg_elapsed_ms": summary["avg_elapsed_ms"],
        "active_realtime_sessions": len(realtime_manager.list()),
        "active_tasks": sum(
            1
            for task in manager._tasks.values()  # noqa: SLF001
            if task.info.status.value not in {"done", "failed"}
        ),
    }
