"""Validate deployment configuration without changing local/demo behaviour."""

from __future__ import annotations

import os
import sys
from urllib.parse import urlsplit

from app.auth import AuthProviderError, get_auth_settings
from app.config import PersistenceConfigurationError, load_persistence_settings


def required_in_this_environment() -> bool:
    return os.getenv("REQUIRE_PRODUCTION_CONFIG", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def validate() -> list[str]:
    """Return release-blocking configuration errors, if any."""

    errors: list[str] = []
    try:
        auth = get_auth_settings()
    except AuthProviderError as exc:
        return [str(exc)]
    try:
        persistence = load_persistence_settings()
    except PersistenceConfigurationError as exc:
        return [str(exc)]

    if not required_in_this_environment():
        return errors

    if not auth.enabled:
        errors.append("Production release requires SUPABASE_URL and SUPABASE_ANON_KEY.")
    if not persistence.is_configured:
        errors.append("Production release requires DATABASE_URL for private, durable workspaces.")
    if not auth.public_app_url:
        errors.append("Production release requires PUBLIC_APP_URL.")
    elif urlsplit(auth.public_app_url).scheme != "https":
        errors.append("PUBLIC_APP_URL must use HTTPS in production.")
    if auth.enabled and not auth.secure_cookies:
        errors.append("AUTH_COOKIE_SECURE must be true when cloud authentication is enabled.")
    if auth.google_enabled and not auth.google_ready:
        errors.append("Google sign-in requires a 32+ character AUTH_STATE_SECRET.")
    return errors


if __name__ == "__main__":
    problems = validate()
    if problems:
        print("Production configuration is invalid:", file=sys.stderr)
        print("\n".join(f"- {problem}" for problem in problems), file=sys.stderr)
        raise SystemExit(1)
    print("Production configuration validation passed.")
