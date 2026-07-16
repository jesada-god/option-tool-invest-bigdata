"""Concurrency coverage for the process-local expensive-call cache."""

from __future__ import annotations

import threading
import time
import unittest

from cache import ttl_cache


class CacheSingleFlightTests(unittest.TestCase):
    def test_concurrent_misses_share_one_producer(self) -> None:
        calls = 0
        calls_lock = threading.Lock()
        release = threading.Event()

        @ttl_cache(ttl_seconds=30)
        def expensive(symbol: str) -> str:
            nonlocal calls
            with calls_lock:
                calls += 1
            release.wait(timeout=2)
            return symbol

        results: list[str] = []
        threads = [threading.Thread(target=lambda: results.append(expensive("NVDA"))) for _ in range(8)]
        for thread in threads:
            thread.start()

        # Give followers time to join the first miss before allowing the
        # producer to finish. This catches a cache-stampede regression.
        time.sleep(0.05)
        release.set()
        for thread in threads:
            thread.join(timeout=2)

        self.assertEqual(calls, 1)
        self.assertEqual(results, ["NVDA"] * 8)

