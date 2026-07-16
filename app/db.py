"""Lazy SQLAlchemy 2.0 database runtime helpers.

Nothing in this module connects at import time.  This allows legacy/demo
deployments to start without a database while giving new API routes a clear,
configuration-gated way to obtain a sync Session.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Generator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import (
    PersistenceConfigurationError,
    PersistenceSettings,
    load_persistence_settings,
)


class PersistenceNotConfiguredError(RuntimeError):
    """Raised when a route asks for a database before DATABASE_URL is supplied."""


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_configured_url: str | None = None


def create_persistence_engine(settings: PersistenceSettings) -> Engine:
    """Build a PostgreSQL engine from explicit settings without connecting yet."""

    try:
        url = settings.require_database_url()
    except PersistenceConfigurationError as exc:
        raise PersistenceNotConfiguredError(str(exc)) from exc

    return create_engine(
        url,
        echo=settings.echo,
        future=True,
        pool_pre_ping=True,
        pool_size=settings.pool_size,
        max_overflow=settings.max_overflow,
        pool_timeout=settings.pool_timeout_seconds,
        pool_recycle=settings.pool_recycle_seconds,
    )


def get_persistence_engine() -> Engine:
    """Return the process-local engine, creating it only when first requested."""

    global _engine, _session_factory, _configured_url
    settings = load_persistence_settings()
    url = settings.require_database_url()
    if _engine is None:
        _engine = create_persistence_engine(settings)
        _session_factory = sessionmaker(
            bind=_engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            class_=Session,
        )
        _configured_url = url
    elif _configured_url != url:
        raise RuntimeError(
            "DATABASE_URL changed after the persistence engine was initialized. "
            "Restart the process instead of switching databases at runtime."
        )
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    """Return the configured sync session factory (and never open a session early)."""

    get_persistence_engine()
    assert _session_factory is not None
    return _session_factory


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    """Commit on success and roll back on error for service-layer work."""

    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def database_ready() -> bool:
    """Perform a lightweight readiness check only when explicitly invoked."""

    engine = get_persistence_engine()
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return True


def _reset_runtime_for_tests() -> None:
    """Dispose cached state for unit tests; not for application runtime."""

    global _engine, _session_factory, _configured_url
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
    _configured_url = None
