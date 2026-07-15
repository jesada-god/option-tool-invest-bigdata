import unittest
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.alert_service import (
    AlertDefinition,
    AlertServiceValidationError,
    alert_payload,
    create_alert,
    evaluate_alert,
    evaluate_price_alerts,
    list_alerts,
    list_notification_events,
    normalize_alert_definition,
    notification_event_payload,
    record_alert_trigger,
)
from app.models import Alert, NotificationEvent, Profile


NOW = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)


class AlertDefinitionTests(unittest.TestCase):
    def test_price_definition_normalizes_and_preserves_decimal_precision(self):
        definition = normalize_alert_definition(
            {
                "alert_type": " PRICE ",
                "condition": "above",
                "ticker": " nvda ",
                "target_value": "200.125",
                "delivery_channels": ["push", "in_app", "push"],
            }
        )

        self.assertEqual(definition.alert_type, "price")
        self.assertEqual(definition.ticker, "NVDA")
        self.assertEqual(definition.target_value, Decimal("200.125"))
        self.assertEqual(definition.delivery_channels, ("push", "in_app"))
        self.assertEqual(definition.cooldown_seconds, 300)

    def test_type_specific_rules_reject_invalid_target_and_condition_combinations(self):
        with self.assertRaises(AlertServiceValidationError):
            normalize_alert_definition(
                {
                    "alert_type": "price",
                    "condition": "matched",
                    "ticker": "AAPL",
                    "target_value": 100,
                }
            )
        with self.assertRaises(AlertServiceValidationError):
            normalize_alert_definition(
                {"alert_type": "news", "condition": "matched", "target_value": 1}
            )
        with self.assertRaises(AlertServiceValidationError):
            normalize_alert_definition(
                {
                    "alert_type": "earnings",
                    "condition": "within_days",
                    "ticker": "MSFT",
                    "target_value": "2.5",
                }
            )

    def test_news_can_be_global_while_quote_alerts_need_a_ticker(self):
        news = normalize_alert_definition({"alert_type": "news", "condition": "matched"})
        self.assertIsNone(news.ticker)
        with self.assertRaises(AlertServiceValidationError):
            normalize_alert_definition(
                {"alert_type": "iv", "condition": "above", "target_value": "0.4"}
            )


class AlertEvaluationTests(unittest.TestCase):
    def test_crossing_price_alert_requires_a_real_cross(self):
        definition = normalize_alert_definition(
            {
                "alert_type": "price",
                "condition": "crosses_above",
                "ticker": "NVDA",
                "target_value": "180",
            }
        )
        matched = evaluate_alert(
            definition,
            {"price": "181.5", "previous_price": "179.8"},
            now=NOW,
        )
        already_above = evaluate_alert(
            definition,
            {"price": "181.5", "previous_price": "181.0"},
            now=NOW,
        )

        self.assertTrue(matched.matched)
        self.assertEqual(matched.observed_value, Decimal("181.5"))
        self.assertEqual(matched.payload["target_value"], "180")
        self.assertFalse(already_above.matched)

    def test_support_bounce_uses_only_supplied_price_values(self):
        definition = normalize_alert_definition(
            {
                "alert_type": "support_resistance",
                "condition": "bounce",
                "ticker": "AMD",
                "target_value": "100",
                "config": {"tolerance_percent": "0.01"},
            }
        )
        result = evaluate_alert(
            definition,
            {"price": "101.5", "previous_price": "100.5"},
            now=NOW,
        )

        self.assertTrue(result.matched)
        self.assertEqual(result.reason, "bounced_from_level")

    def test_iv_news_and_earnings_have_explicit_observation_contracts(self):
        iv = normalize_alert_definition(
            {
                "alert_type": "iv",
                "condition": "below",
                "ticker": "TSLA",
                "target_value": "0.45",
            }
        )
        news = normalize_alert_definition({"alert_type": "news", "condition": "matched"})
        earnings = normalize_alert_definition(
            {
                "alert_type": "earnings",
                "condition": "within_days",
                "ticker": "AAPL",
                "target_value": 7,
            }
        )

        self.assertTrue(evaluate_alert(iv, {"iv": "0.44"}, now=NOW).matched)
        self.assertTrue(evaluate_alert(news, {"news_match": True}, now=NOW).matched)
        self.assertTrue(
            evaluate_alert(earnings, {"days_until_earnings": 3}, now=NOW).matched
        )
        self.assertFalse(evaluate_alert(news, {}, now=NOW).matched)

    def test_disabled_expired_and_cooldown_rules_do_not_match(self):
        disabled = {
            "alert_type": "price",
            "condition": "above",
            "ticker": "SPY",
            "target_value": 500,
            "is_enabled": False,
        }
        expired = {
            "alert_type": "price",
            "condition": "above",
            "ticker": "SPY",
            "target_value": 500,
            "expires_at": NOW - timedelta(seconds=1),
        }
        cooling_down = {
            "alert_type": "price",
            "condition": "above",
            "ticker": "SPY",
            "target_value": 500,
            "last_triggered_at": NOW - timedelta(seconds=10),
            "cooldown_seconds": 60,
        }

        self.assertEqual(evaluate_alert(disabled, {"price": 501}, now=NOW).reason, "disabled")
        self.assertEqual(evaluate_alert(expired, {"price": 501}, now=NOW).reason, "expired")
        self.assertEqual(evaluate_alert(cooling_down, {"price": 501}, now=NOW).reason, "cooldown")


class AlertSerializationAndSurfaceTests(unittest.TestCase):
    def test_models_have_profile_owned_relationships_without_a_database(self):
        self.assertIn("alerts", Profile.__mapper__.relationships)
        self.assertIn("notification_events", Profile.__mapper__.relationships)
        self.assertIn("events", Alert.__mapper__.relationships)
        self.assertIn("alert", NotificationEvent.__mapper__.relationships)

    def test_payloads_are_json_ready_without_opening_a_database(self):
        profile_id = uuid.uuid4()
        alert = Alert(
            id=9,
            profile_id=profile_id,
            name="NVDA price above",
            alert_type="price",
            condition="above",
            ticker="NVDA",
            target_value=Decimal("180.50"),
            config_json={},
            delivery_channels=["in_app"],
            is_enabled=True,
            cooldown_seconds=300,
            trigger_count=0,
            created_at=NOW,
            updated_at=NOW,
        )
        event = NotificationEvent(
            id=10,
            profile_id=profile_id,
            alert_id=9,
            notification_type="price",
            severity="info",
            title="NVDA price alert",
            payload_json={"observed_value": "181"},
            delivery_status="in_app",
            created_at=NOW,
        )

        self.assertEqual(alert_payload(alert)["target_value"], "180.50")
        self.assertEqual(notification_event_payload(event)["alert_id"], 9)
        self.assertEqual(notification_event_payload(event)["payload"]["observed_value"], "181")

    def test_database_bound_crud_surface_is_exposed_but_not_run_in_unit_tests(self):
        self.assertTrue(callable(create_alert))
        self.assertTrue(callable(list_alerts))
        self.assertTrue(callable(list_notification_events))
        self.assertTrue(callable(record_alert_trigger))
        self.assertTrue(callable(evaluate_price_alerts))
