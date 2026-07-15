import unittest
from unittest.mock import patch

from rate_limit import SlidingWindowRateLimiter


class SlidingWindowRateLimiterTests(unittest.TestCase):
    def test_rejects_after_limit_then_allows_after_window(self):
        limiter = SlidingWindowRateLimiter()
        with patch("rate_limit.time.monotonic", side_effect=[10.0, 10.1, 10.2, 71.0]):
            self.assertEqual(limiter.allow("ip", limit=2, window_seconds=60), (True, 0))
            self.assertEqual(limiter.allow("ip", limit=2, window_seconds=60), (True, 0))
            allowed, retry_after = limiter.allow("ip", limit=2, window_seconds=60)
            self.assertFalse(allowed)
            self.assertGreaterEqual(retry_after, 1)
            self.assertEqual(limiter.allow("ip", limit=2, window_seconds=60), (True, 0))

    def test_invalid_policy_is_rejected(self):
        limiter = SlidingWindowRateLimiter()
        with self.assertRaises(ValueError):
            limiter.allow("ip", limit=0, window_seconds=60)
        with self.assertRaises(ValueError):
            limiter.allow("ip", limit=1, window_seconds=0)
