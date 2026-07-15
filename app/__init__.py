"""Persistence primitives for Quantora AI.

The package deliberately has no import-time network or database side effects.
Legacy routes can keep running without a ``DATABASE_URL`` while the application
is incrementally moved to user-scoped persistence.
"""

from .config import PersistenceSettings, PersistenceConfigurationError, load_persistence_settings

__all__ = [
    "PersistenceConfigurationError",
    "PersistenceSettings",
    "load_persistence_settings",
]
