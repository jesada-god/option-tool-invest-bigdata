"""Configuration for the optional PostgreSQL persistence layer.

The legacy terminal remains runnable without PostgreSQL.  Callers that need
persistence must explicitly call :meth:`PersistenceSettings.require_database_url`
or a helper from ``app.db``; this keeps imports and health checks safe in a
local/demo installation where ``DATABASE_URL`` is not configured yet.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit


class PersistenceConfigurationError(RuntimeError):
    """Raised only when code attempts to use persistence without its config."""


def _read_bool(value: str | None, *, default: bool) -> bool:
    if value is None or value == "":
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise PersistenceConfigurationError(
        "DATABASE_ECHO must be one of true/false, yes/no, on/off, or 1/0."
    )


def _read_positive_int(
    environ: Mapping[str, str], key: str, *, default: int, minimum: int = 1
) -> int:
    raw_value = environ.get(key)
    if raw_value is None or raw_value == "":
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise PersistenceConfigurationError(f"{key} must be an integer.") from exc
    if value < minimum:
        raise PersistenceConfigurationError(f"{key} must be at least {minimum}.")
    return value


def normalize_postgres_url(raw_url: str) -> str:
    """Normalize common hosted-Postgres URLs to SQLAlchemy's psycopg dialect.

    Render and Supabase often expose ``postgres://`` or ``postgresql://``.
    The project deliberately uses psycopg v3, so those schemes become
    ``postgresql+psycopg://``.  URLs for another driver are rejected rather
    than silently loading an unpinned driver.
    """

    value = raw_url.strip()
    if not value:
        raise PersistenceConfigurationError("DATABASE_URL cannot be blank.")

    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if scheme == "postgres":
        scheme = "postgresql+psycopg"
    elif scheme == "postgresql":
        scheme = "postgresql+psycopg"
    elif scheme == "postgresql+psycopg2":
        scheme = "postgresql+psycopg"
    elif scheme != "postgresql+psycopg":
        raise PersistenceConfigurationError(
            "DATABASE_URL must use a PostgreSQL URL (postgresql:// or "
            "postgresql+psycopg://)."
        )

    if not parsed.hostname:
        raise PersistenceConfigurationError("DATABASE_URL must include a database host.")
    if not parsed.path or parsed.path == "/":
        raise PersistenceConfigurationError("DATABASE_URL must include a database name.")
    try:
        # Accessing ``.port`` is what validates malformed values such as
        # ``host:not-a-port`` in urllib's parser.
        _ = parsed.port
    except ValueError as exc:
        raise PersistenceConfigurationError("DATABASE_URL contains an invalid port.") from exc
    return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def redact_database_url(url: str | None) -> str:
    """Return a safe representation for logs without credentials or query data."""

    if not url:
        return "<not configured>"
    parsed = urlsplit(url)
    host = parsed.hostname or "<invalid-host>"
    try:
        port = f":{parsed.port}" if parsed.port else ""
    except ValueError:
        port = ""
    return f"{parsed.scheme}://{host}{port}{parsed.path}"


@dataclass(frozen=True, slots=True)
class PersistenceSettings:
    """Validated, non-secret persistence settings read from environment variables."""

    database_url: str | None
    direct_database_url: str | None = None
    echo: bool = False
    pool_size: int = 5
    max_overflow: int = 5
    pool_timeout_seconds: int = 30
    pool_recycle_seconds: int = 1_800

    @property
    def is_configured(self) -> bool:
        return self.database_url is not None

    def require_database_url(self) -> str:
        if not self.database_url:
            raise PersistenceConfigurationError(
                "Persistence is not configured. Set DATABASE_URL to enable PostgreSQL-backed "
                "accounts and cloud sync."
            )
        return self.database_url

    def require_migration_database_url(self) -> str:
        """Prefer a direct connection for Alembic when a pooler is configured.

        Supabase transaction-pooler URLs are suitable for web requests but can
        be unsuitable for DDL.  ``DATABASE_URL_DIRECT`` is optional and only
        used by migrations; normal runtime traffic continues to use
        ``DATABASE_URL``.
        """

        return self.direct_database_url or self.require_database_url()


def load_persistence_settings(
    environ: Mapping[str, str] | None = None,
) -> PersistenceSettings:
    """Load settings without opening a connection or requiring a database.

    Passing a mapping makes configuration unit-testable and avoids mutating the
    process environment in tests.
    """

    source = os.environ if environ is None else environ
    raw_database_url = source.get("DATABASE_URL", "").strip()
    raw_direct_database_url = source.get("DATABASE_URL_DIRECT", "").strip()
    return PersistenceSettings(
        database_url=normalize_postgres_url(raw_database_url) if raw_database_url else None,
        direct_database_url=(
            normalize_postgres_url(raw_direct_database_url) if raw_direct_database_url else None
        ),
        echo=_read_bool(source.get("DATABASE_ECHO"), default=False),
        pool_size=_read_positive_int(source, "DATABASE_POOL_SIZE", default=5),
        max_overflow=_read_positive_int(source, "DATABASE_MAX_OVERFLOW", default=5, minimum=0),
        pool_timeout_seconds=_read_positive_int(
            source, "DATABASE_POOL_TIMEOUT_SECONDS", default=30
        ),
        pool_recycle_seconds=_read_positive_int(
            source, "DATABASE_POOL_RECYCLE_SECONDS", default=1_800
        ),
    )
