import unittest
import uuid
from http.cookies import SimpleCookie
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from app.auth import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    OAUTH_TRANSACTION_COOKIE,
    REFRESH_COOKIE,
    REMEMBER_COOKIE,
    AuthProviderError,
    AuthSettings,
    CurrentUser,
    begin_google_oauth,
    coordinated_refresh_session,
    consume_google_oauth,
    get_optional_current_user,
    password_sign_up,
    resend_signup_confirmation,
    set_session_cookies,
    verify_request_origin,
)


def make_request(*, headers=None, path="/api/me"):
    raw_headers = []
    for key, value in (headers or {}).items():
        raw_headers.append((key.lower().encode("latin-1"), value.encode("latin-1")))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": path,
            "query_string": b"",
            "headers": raw_headers,
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 443),
        }
    )


def cookies_from_response(response):
    parsed = SimpleCookie()
    for key, value in response.raw_headers:
        if key.lower() == b"set-cookie":
            parsed.load(value.decode("latin-1"))
    return {name: morsel.value for name, morsel in parsed.items()}


class AuthSecurityTests(unittest.TestCase):
    def setUp(self):
        self.settings = AuthSettings(
            supabase_url="https://project.supabase.co",
            anon_key="anon-key",
            public_app_url="https://terminal.example/app",
            google_enabled=True,
            secure_cookies=True,
            timeout_seconds=10,
            oauth_state_secret="x" * 32,
            oauth_transaction_ttl_seconds=600,
        )

    def test_production_origin_is_normalized_and_missing_origin_is_rejected(self):
        verify_request_origin(
            make_request(headers={"Origin": "https://terminal.example"}), self.settings
        )
        verify_request_origin(
            make_request(headers={"Referer": "https://terminal.example/app/settings"}), self.settings
        )
        with self.assertRaises(HTTPException) as missing:
            verify_request_origin(make_request(), self.settings)
        self.assertEqual(missing.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            verify_request_origin(
                make_request(headers={"Origin": "https://attacker.example"}), self.settings
            )

    def test_oauth_transaction_is_http_only_signed_and_state_bound(self):
        start_response = Response()
        transaction = begin_google_oauth(start_response, self.settings)
        cookies = cookies_from_response(start_response)
        self.assertIn(OAUTH_TRANSACTION_COOKIE, cookies)

        request = make_request(
            headers={"Cookie": f"{OAUTH_TRANSACTION_COOKIE}={cookies[OAUTH_TRANSACTION_COOKIE]}"}
        )
        callback_response = Response()
        verifier = consume_google_oauth(
            request, callback_response, self.settings, state=transaction["state"]
        )
        self.assertGreater(len(verifier), 40)
        with self.assertRaises(AuthProviderError):
            consume_google_oauth(
                request, Response(), self.settings, state="wrong-state"
            )

    def test_missing_access_cookie_uses_refresh_cookie_and_preserves_session_policy(self):
        refresh_token = "refresh-token"
        request = make_request(
            headers={
                "Cookie": "; ".join(
                    [
                        f"{REFRESH_COOKIE}={refresh_token}",
                        f"{CSRF_COOKIE}=csrf-token",
                        f"{REMEMBER_COOKIE}=0",
                    ]
                )
            }
        )
        response = Response()
        user = CurrentUser(id=uuid.uuid4(), email="user@example.com", metadata={}, raw={})
        refreshed = {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}
        with patch("app.auth.get_auth_settings", return_value=self.settings), patch(
            "app.auth.refresh_session", return_value=refreshed
        ) as refresh, patch("app.auth.get_user_from_access_token", return_value=user) as get_user:
            resolved = get_optional_current_user(request, response)

        self.assertEqual(resolved, user)
        refresh.assert_called_once_with(refresh_token, self.settings)
        get_user.assert_called_once_with("new-access", self.settings)
        self.assertEqual(request.state.auth_access_token, "new-access")
        response_cookies = cookies_from_response(response)
        self.assertEqual(response_cookies[CSRF_COOKIE], "csrf-token")
        self.assertEqual(response_cookies[REMEMBER_COOKIE], "0")
        # Session-only policy means the new access cookie does not receive Max-Age.
        access_set_cookie = [
            value.decode("latin-1")
            for key, value in response.raw_headers
            if key.lower() == b"set-cookie" and value.decode("latin-1").startswith(f"{ACCESS_COOKIE}=")
        ][0]
        self.assertNotIn("Max-Age", access_set_cookie)

    def test_set_session_cookies_returns_csrf_token(self):
        response = Response()
        csrf = set_session_cookies(
            response,
            {"access_token": "access", "refresh_token": "refresh", "expires_in": 3600},
            self.settings,
            remember_me=True,
        )
        cookies = cookies_from_response(response)
        self.assertEqual(cookies[CSRF_COOKIE], csrf)
        self.assertEqual(cookies[REMEMBER_COOKIE], "1")

    def test_production_request_without_public_app_url_is_rejected(self):
        unsafe_settings = AuthSettings(
            supabase_url=self.settings.supabase_url,
            anon_key=self.settings.anon_key,
            public_app_url=None,
            google_enabled=False,
            secure_cookies=True,
            timeout_seconds=10,
            oauth_state_secret=None,
            oauth_transaction_ttl_seconds=600,
        )
        with self.assertRaises(HTTPException) as rejected:
            verify_request_origin(
                make_request(headers={"Origin": "https://terminal.example"}), unsafe_settings
            )
        self.assertEqual(rejected.exception.status_code, 500)

    def test_rotating_refresh_success_is_shared_briefly_across_tabs(self):
        refresh_token = f"refresh-{uuid.uuid4()}"
        refreshed = {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}
        with patch("app.auth.refresh_session", return_value=refreshed) as refresh:
            first = coordinated_refresh_session(refresh_token, self.settings)
            second = coordinated_refresh_session(refresh_token, self.settings)

        self.assertEqual(first, refreshed)
        self.assertEqual(second, refreshed)
        refresh.assert_called_once_with(refresh_token, self.settings)

    def test_signup_stores_optional_name_only_in_provider_metadata(self):
        with patch("app.auth._provider_request", return_value={}) as request:
            password_sign_up(
                self.settings,
                email="user@example.com",
                password="safe-password",
                redirect_to="https://terminal.example",
                full_name="Quantora User",
            )

        self.assertEqual(request.call_args.kwargs["json_body"]["options"]["data"], {"full_name": "Quantora User"})
        self.assertNotIn("password_hash", request.call_args.kwargs["json_body"])

    def test_resend_confirmation_uses_generic_signup_provider_flow(self):
        with patch("app.auth._provider_request", return_value={}) as request:
            resend_signup_confirmation(
                self.settings,
                email="user@example.com",
                redirect_to="https://terminal.example",
            )

        self.assertEqual(request.call_args.kwargs["json_body"]["type"], "signup")
        self.assertEqual(request.call_args.kwargs["json_body"]["email"], "user@example.com")
