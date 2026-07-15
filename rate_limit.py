"""Small bounded in-process sliding-window limiter.

It protects sensitive endpoints on the single-worker Render deployment without
adding a third-party dependency.  It is deliberately not presented as a
distributed limiter: production horizontal scaling should replace it with a
Redis-backed implementation.
"""

from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowRateLimiter:
    def __init__(self, *, max_keys: int = 20_000) -> None:
        self._max_keys = max(100, int(max_keys))
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, *, limit: int, window_seconds: float) -> tuple[bool, int]:
        """Return ``(allowed, retry_after_seconds)`` for one fixed key."""
        if limit < 1 or window_seconds <= 0:
            raise ValueError("limit and window_seconds must be positive")
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            events = self._events.get(key)
            if events is None:
                if len(self._events) >= self._max_keys:
                    # Opportunistically discard an expired/old key so an IP
                    # spray cannot grow memory without bound.
                    oldest_key = next(iter(self._events), None)
                    if oldest_key is not None:
                        self._events.pop(oldest_key, None)
                events = deque()
                self._events[key] = events
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry_after = max(1, int(events[0] + window_seconds - now) + 1)
                return False, retry_after
            events.append(now)
            return True, 0


__all__ = ["SlidingWindowRateLimiter"]
