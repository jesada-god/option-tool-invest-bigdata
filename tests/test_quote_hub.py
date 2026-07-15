import asyncio
import unittest

from quote_hub import LiveQuoteHub, LiveQuoteHubCapacityError


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.messages = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, payload):
        self.messages.append(dict(payload))


async def wait_for(predicate, timeout=1.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Timed out waiting for quote hub output")


class LiveQuoteHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_upstream_poll_is_fanned_out_to_multiple_subscribers(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def fetch_quote(ticker):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {
                "price": 123.45,
                "market_session": "REGULAR",
                "provider": "test",
                "stale": False,
            }

        hub = LiveQuoteHub(fetch_quote, regular_poll_seconds=0.1)
        first, second = FakeWebSocket(), FakeWebSocket()
        await hub.subscribe("NVDA", first)
        await started.wait()
        await hub.subscribe("NVDA", second)
        release.set()
        await wait_for(lambda: len(first.messages) == 1 and len(second.messages) == 1)

        self.assertTrue(first.accepted)
        self.assertTrue(second.accepted)
        self.assertEqual(calls, 1)
        self.assertEqual(first.messages[0]["seq"], second.messages[0]["seq"])
        self.assertEqual(first.messages[0]["ticker"], "NVDA")
        self.assertEqual(first.messages[0]["price"], 123.45)

        await hub.unsubscribe("NVDA", first)
        await hub.unsubscribe("NVDA", second)
        await hub.close()

    async def test_provider_failure_is_broadcast_as_stale_without_a_fake_price(self):
        async def fail_quote(ticker):
            raise RuntimeError("provider unavailable")

        hub = LiveQuoteHub(fail_quote, retry_seconds=0.1)
        socket = FakeWebSocket()
        await hub.subscribe("NVDA", socket)
        await wait_for(lambda: len(socket.messages) == 1)

        payload = socket.messages[0]
        self.assertEqual(payload["type"], "quote")
        self.assertEqual(payload["ticker"], "NVDA")
        self.assertTrue(payload["stale"])
        self.assertIsNone(payload["price"])

        await hub.unsubscribe("NVDA", socket)
        await hub.close()

    async def test_active_ticker_capacity_rejects_new_ticker_without_starting_worker(self):
        hold = asyncio.Event()

        async def fetch_quote(ticker):
            await hold.wait()
            return {"price": 1.0, "market_session": "REGULAR", "stale": False}

        hub = LiveQuoteHub(fetch_quote, max_active_tickers=1, max_subscribers=2)
        first, blocked = FakeWebSocket(), FakeWebSocket()
        await hub.subscribe("NVDA", first)
        with self.assertRaises(LiveQuoteHubCapacityError):
            await hub.subscribe("AAPL", blocked)

        self.assertTrue(first.accepted)
        self.assertTrue(blocked.accepted)
        await hub.unsubscribe("NVDA", first)
        await hub.close()
