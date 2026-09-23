from __future__ import annotations

import threading
from collections import Counter

_BUCKETS = ("0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10")


class RequestMetrics:
    """In-process counters for the Prometheus text endpoint. Lost on restart."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: Counter[tuple[str, str, str]] = Counter()
        self._failed: Counter[tuple[str, str]] = Counter()
        self._sum: Counter[tuple[str, str]] = Counter()
        self._count: Counter[tuple[str, str]] = Counter()
        self._bucket: Counter[tuple[str, str, str]] = Counter()

    def observe(self, method: str, path: str, status: int, seconds: float) -> None:
        with self._lock:
            self._requests[(method, path, str(status))] += 1
            if status >= 400:
                self._failed[(method, path)] += 1
            key = (method, path)
            self._sum[key] += seconds
            self._count[key] += 1
            for bound in _BUCKETS:
                if seconds <= float(bound):
                    self._bucket[(method, path, bound)] += 1
            self._bucket[(method, path, "+Inf")] += 1

    def render(
        self,
        *,
        provider_calls: int,
        provider_errors: int,
        active_tasks: int,
        active_realtime_sessions: int,
    ) -> str:
        with self._lock:
            requests = list(self._requests.items())
            failed = list(self._failed.items())
            duration_sum = list(self._sum.items())
            duration_count = list(self._count.items())
            buckets = list(self._bucket.items())

        lines = [
            "# HELP requests_total HTTP requests served by this process.",
            "# TYPE requests_total counter",
        ]
        for (method, path, status), value in sorted(requests):
            lines.append(
                f"requests_total{{method={_q(method)},path={_q(path)},status={_q(status)}}} {value}"
            )
        lines += [
            "# HELP requests_failed_total HTTP requests that returned 4xx or 5xx.",
            "# TYPE requests_failed_total counter",
        ]
        for (method, path), value in sorted(failed):
            lines.append(
                f"requests_failed_total{{method={_q(method)},path={_q(path)}}} {value}"
            )
        lines += [
            "# HELP request_duration_seconds HTTP request latency.",
            "# TYPE request_duration_seconds histogram",
        ]
        for (method, path, le), value in sorted(buckets, key=lambda item: (item[0][0], item[0][1], _le_sort(item[0][2]))):
            lines.append(
                "request_duration_seconds_bucket"
                f"{{method={_q(method)},path={_q(path)},le={_q(le)}}} {value}"
            )
        for (method, path), value in sorted(duration_sum):
            lines.append(
                f"request_duration_seconds_sum{{method={_q(method)},path={_q(path)}}} {value:.6f}"
            )
        for (method, path), value in sorted(duration_count):
            lines.append(
                f"request_duration_seconds_count{{method={_q(method)},path={_q(path)}}} {value}"
            )
        lines += [
            "# HELP provider_calls_total Upstream ASR calls started.",
            "# TYPE provider_calls_total counter",
            f"provider_calls_total {provider_calls}",
            "# HELP provider_errors_total Upstream ASR calls that failed.",
            "# TYPE provider_errors_total counter",
            f"provider_errors_total {provider_errors}",
            "# HELP active_tasks File tasks that have not reached a terminal status.",
            "# TYPE active_tasks gauge",
            f"active_tasks {active_tasks}",
            "# HELP active_realtime_sessions Realtime sessions that are not finished.",
            "# TYPE active_realtime_sessions gauge",
            f"active_realtime_sessions {active_realtime_sessions}",
            "",
        ]
        return "\n".join(lines)


def _q(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace("\n", "").replace('"', '\\"') + '"'


def _le_sort(le: str) -> float:
    if le == "+Inf":
        return float("inf")
    return float(le)


request_metrics = RequestMetrics()
