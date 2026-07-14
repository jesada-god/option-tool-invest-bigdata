"""
cache.py
========
Phase 8 — Performance / Caching.

A tiny, dependency-free, thread-safe TTL (time-to-live) memoization
cache. yfinance calls are the dominant latency + rate-limit cost in
this app, so every expensive fetch/compute (price bundle, historical
stats, option chains) should be wrapped with @ttl_cache(ttl_seconds=N).

Not a distributed cache (single-process in-memory dict) — sufficient
for a single-instance FastAPI deployment. If this app is ever run with
multiple worker processes, swap this for Redis using the same
decorator interface.
"""

from __future__ import annotations

import functools
import threading
import time
from typing import Any, Callable, Optional


class TTLCache:
    def __init__(self):
        self._store: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None, False
            expires_at, value = entry
            if time.time() >= expires_at:
                del self._store[key]
                return None, False
            return value, True

    def set(self, key, value, ttl_seconds: float):
        with self._lock:
            self._store[key] = (time.time() + ttl_seconds, value)

    def clear(self, prefix: Optional[str] = None):
        with self._lock:
            if prefix is None:
                self._store.clear()
            else:
                for k in [k for k in self._store if str(k).startswith(prefix)]:
                    del self._store[k]

    def stats(self):
        with self._lock:
            return {"entries": len(self._store)}


_global_cache = TTLCache()


def ttl_cache(ttl_seconds: float = 60.0):
    """Decorator: memoize a function's return value per unique args for
    ttl_seconds. Safe for concurrent access (FastAPI runs handlers in a
    threadpool for sync endpoints)."""
    def decorator(fn: Callable):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                key = (fn.__module__, fn.__qualname__, args, tuple(sorted(kwargs.items())))
                hash(key)
            except TypeError:
                # unhashable arg (e.g. a dict) -> fall back to a repr-based key
                key = (fn.__module__, fn.__qualname__, repr(args), repr(sorted(kwargs.items())))
            value, hit = _global_cache.get(key)
            if hit:
                return value
            value = fn(*args, **kwargs)
            _global_cache.set(key, value, ttl_seconds)
            return value
        wrapper.cache_clear = lambda: _global_cache.clear(prefix=f"({fn.__module__!r}")
        return wrapper
    return decorator


def get_cache_stats() -> dict:
    return _global_cache.stats()


def clear_all_cache():
    _global_cache.clear()
