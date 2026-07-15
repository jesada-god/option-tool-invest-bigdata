"""Single-process live quote fan-out used by the FastAPI WebSocket endpoint.

The hub intentionally separates one upstream poll per ticker from the number
of browser tabs connected to that ticker.  It is process-local by design: when
the application is scaled beyond one worker or one instance, replace this hub
with a Redis/pub-sub backed implementation.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import WebSocket


QuoteFetcher = Callable[[str], Awaitable[dict[str, Any]] | dict[str, Any]]


class LiveQuoteHubCapacityError(RuntimeError):
    """Raised when a public client would exceed bounded live-feed capacity."""


class LiveQuoteHub:
    """Fan out a single ticker poll to every subscribed WebSocket.

    ``fetch_quote`` must return a JSON-serialisable quote payload.  The hub
    adds the common transport fields (``type``, ``seq`` and ``sent_at``), keeps
    the last known snapshot for reconnects, and marks a retained snapshot as
    stale whenever the upstream provider fails.
    """

    def __init__(
        self,
        fetch_quote: QuoteFetcher,
        *,
        regular_poll_seconds: float = 3.0,
        off_hours_poll_seconds: float = 15.0,
        retry_seconds: float = 8.0,
        max_active_tickers: int = 200,
        max_subscribers: int = 2_000,
        max_snapshots: int = 1_000,
        snapshot_ttl_seconds: float = 900.0,
        logger: logging.Logger | None = None,
    ) -> None:
        self._fetch_quote = fetch_quote
        self._regular_poll_seconds = max(float(regular_poll_seconds), 0.1)
        self._off_hours_poll_seconds = max(float(off_hours_poll_seconds), 0.2)
        self._retry_seconds = max(float(retry_seconds), 0.1)
        self._max_active_tickers = max(int(max_active_tickers), 1)
        self._max_subscribers = max(int(max_subscribers), 1)
        self._max_snapshots = max(int(max_snapshots), self._max_active_tickers)
        self._snapshot_ttl_ms = max(int(float(snapshot_ttl_seconds) * 1_000), 1_000)
        self._logger = logger or logging.getLogger(__name__)
        self._subscribers: dict[str, set[WebSocket]] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._snapshots: dict[str, dict[str, Any]] = {}
        self._sequences: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, ticker: str, websocket: WebSocket) -> None:
        """Accept and register a client, then start the ticker worker if needed."""
        await websocket.accept()
        snapshot: dict[str, Any] | None
        async with self._lock:
            self._prune_snapshots_locked()
            is_new_ticker = ticker not in self._subscribers
            subscriber_count = sum(len(items) for items in self._subscribers.values())
            if is_new_ticker and len(self._subscribers) >= self._max_active_tickers:
                raise LiveQuoteHubCapacityError("Live quote ticker capacity is temporarily full")
            if subscriber_count >= self._max_subscribers:
                raise LiveQuoteHubCapacityError("Live quote connection capacity is temporarily full")
            self._subscribers.setdefault(ticker, set()).add(websocket)
            snapshot = self._snapshots.get(ticker)
            task = self._tasks.get(ticker)
            if task is None or task.done():
                self._tasks[ticker] = asyncio.create_task(
                    self._run_ticker(ticker), name=f"live-quote:{ticker}"
                )

        # Send the cached state right away; the worker immediately refreshes it
        # afterwards.  This makes a reconnect feel responsive without inventing
        # a price when an upstream provider is unavailable.
        if snapshot is not None:
            await self._send_one(websocket, snapshot)

    async def unsubscribe(self, ticker: str, websocket: WebSocket) -> None:
        """Remove a client and stop its worker when it was the last listener."""
        task_to_cancel: asyncio.Task[None] | None = None
        async with self._lock:
            subscribers = self._subscribers.get(ticker)
            if subscribers is not None:
                subscribers.discard(websocket)
                if not subscribers:
                    self._subscribers.pop(ticker, None)
                    task_to_cancel = self._tasks.pop(ticker, None)
                    self._prune_snapshots_locked()

        if task_to_cancel is asyncio.current_task():
            # A failed send can be discovered by the ticker worker itself.  It
            # will exit at the top of its next loop; a task must never await or
            # cancel itself here.
            return

        if task_to_cancel is not None and not task_to_cancel.done():
            task_to_cancel.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task_to_cancel

    async def latest(self, ticker: str) -> dict[str, Any] | None:
        """Return a copy of the most recently broadcast quote, if any."""
        async with self._lock:
            self._prune_snapshots_locked()
            snapshot = self._snapshots.get(ticker)
            return dict(snapshot) if snapshot is not None else None

    async def close(self) -> None:
        """Cancel all workers during application shutdown."""
        async with self._lock:
            tasks = list(self._tasks.values())
            self._tasks.clear()
            self._subscribers.clear()
            self._snapshots.clear()
            self._sequences.clear()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _run_ticker(self, ticker: str) -> None:
        current_task = asyncio.current_task()
        try:
            while True:
                async with self._lock:
                    if not self._subscribers.get(ticker):
                        return

                try:
                    payload = self._fetch_quote(ticker)
                    if inspect.isawaitable(payload):
                        payload = await payload
                    if not isinstance(payload, dict):
                        raise TypeError("Quote fetcher returned a non-object payload")
                    snapshot = await self._record_snapshot(ticker, payload)
                    await self._broadcast(ticker, snapshot)
                    delay = (
                        self._regular_poll_seconds
                        if snapshot.get("market_session") == "REGULAR"
                        else self._off_hours_poll_seconds
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # Keep live clients connected with an explicit stale state.
                    self._logger.warning("Live quote poll failed for %s: %s", ticker, exc)
                    snapshot = await self._record_failure(ticker, str(exc))
                    await self._broadcast(ticker, snapshot)
                    delay = self._retry_seconds

                await asyncio.sleep(delay)
        finally:
            # Do not remove a newer task that may have been started after a race.
            async with self._lock:
                if self._tasks.get(ticker) is current_task:
                    self._tasks.pop(ticker, None)

    async def _record_snapshot(self, ticker: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            snapshot = self._decorate_snapshot(ticker, payload)
            self._snapshots[ticker] = snapshot
            self._prune_snapshots_locked()
            return dict(snapshot)

    async def _record_failure(self, ticker: str, error: str) -> dict[str, Any]:
        async with self._lock:
            previous = self._snapshots.get(ticker, {})
            stale_payload = {
                **previous,
                "ticker": ticker,
                "price": previous.get("price"),
                "stale": True,
                "error": "Market data is temporarily unavailable.",
            }
            # Do not leak provider internals or return a made-up fallback price.
            snapshot = self._decorate_snapshot(ticker, stale_payload)
            self._snapshots[ticker] = snapshot
            self._prune_snapshots_locked()
            return dict(snapshot)

    def _prune_snapshots_locked(self) -> None:
        """Bound retained ticker state without disrupting active subscriptions."""
        now_ms = int(time.time() * 1_000)
        inactive = [
            (ticker, snapshot)
            for ticker, snapshot in self._snapshots.items()
            if not self._subscribers.get(ticker)
        ]
        for ticker, snapshot in inactive:
            sent_at = int(snapshot.get("sent_at") or 0)
            if now_ms - sent_at > self._snapshot_ttl_ms:
                self._snapshots.pop(ticker, None)
                self._sequences.pop(ticker, None)

        overflow = len(self._snapshots) - self._max_snapshots
        if overflow <= 0:
            return
        oldest_inactive = sorted(
            (
                (int(snapshot.get("sent_at") or 0), ticker)
                for ticker, snapshot in self._snapshots.items()
                if not self._subscribers.get(ticker)
            )
        )
        for _, ticker in oldest_inactive[:overflow]:
            self._snapshots.pop(ticker, None)
            self._sequences.pop(ticker, None)

    def _decorate_snapshot(self, ticker: str, payload: dict[str, Any]) -> dict[str, Any]:
        seq = self._sequences.get(ticker, 0) + 1
        self._sequences[ticker] = seq
        return {
            **payload,
            "type": "quote",
            "ticker": ticker,
            "seq": seq,
            "sent_at": int(time.time() * 1000),
        }

    async def _broadcast(self, ticker: str, snapshot: dict[str, Any]) -> None:
        async with self._lock:
            subscribers = list(self._subscribers.get(ticker, set()))
        if not subscribers:
            return

        results = await asyncio.gather(
            *(self._send_one(websocket, snapshot) for websocket in subscribers),
            return_exceptions=True,
        )
        failed = [
            websocket
            for websocket, result in zip(subscribers, results)
            if isinstance(result, Exception)
        ]
        for websocket in failed:
            await self.unsubscribe(ticker, websocket)

    async def _send_one(self, websocket: WebSocket, snapshot: dict[str, Any]) -> None:
        await websocket.send_json(snapshot)
