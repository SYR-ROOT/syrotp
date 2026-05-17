"""Shared test helpers."""
from __future__ import annotations

from typing import Callable, List

import httpx
import pytest

from syrotp import AsyncSyrotpClient, SyrotpClient


def pytest_configure(config):
    """
    Configure Django once per test session before any tests are
    collected. Without this, importing `syrotp.django` from a test
    raises `ImproperlyConfigured` if no `DJANGO_SETTINGS_MODULE` is
    set.

    The settings here are the bare minimum for `django.conf.settings`
    to report `configured=True`. Individual tests use
    `@override_settings(SYROTP_*)` to inject their own values.
    """
    import django
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=True,
            DATABASES={
                "default": {
                    "ENGINE": "django.db.backends.sqlite3",
                    "NAME": ":memory:",
                }
            },
            INSTALLED_APPS=[],
            USE_TZ=True,
        )
        django.setup()


@pytest.fixture(autouse=True)
def _reset_django_syrotp_singletons():
    """
    Drop the module-global singletons in `syrotp.django` between
    tests. Without this, the first test's client leaks into the
    second test and per-test settings overrides don't take effect.
    """
    from syrotp import django as syrotp_django

    syrotp_django._sync_client = None
    syrotp_django._async_clients.clear()
    yield
    syrotp_django._sync_client = None
    syrotp_django._async_clients.clear()


def _fixed_verification(**overrides: object) -> dict:
    base = {
        "id": "vrf_01HX",
        "status": "pending",
        "phone_masked": "+96399****567",
        "send_to": "+963998887777",
        "message": "VERIFY ABC123",
        "purpose": "login",
        "expires_at": "2026-05-02T18:00:00.000Z",
        "created_at": "2026-05-02T17:00:00.000Z",
    }
    base.update(overrides)
    return base


@pytest.fixture
def make_client() -> Callable[..., SyrotpClient]:
    def _factory(handler: Callable[[httpx.Request], httpx.Response], **kwargs) -> SyrotpClient:
        kwargs.setdefault("base_url", "http://syrotp.test")
        kwargs.setdefault("api_key", "sk_live_TESTKEY_DO_NOT_USE")
        kwargs.setdefault("retries", 0)  # default to 0 for deterministic tests
        return SyrotpClient(transport=httpx.MockTransport(handler), **kwargs)

    return _factory


@pytest.fixture
def make_async_client() -> Callable[..., AsyncSyrotpClient]:
    """
    Build an `AsyncSyrotpClient` wired to an `httpx.MockTransport` over
    a sync handler — `httpx.MockTransport` accepts a sync callable and
    transparently exposes both `handle_request` and
    `handle_async_request`, so the same handler shape works for the
    sync and async client tests.
    """

    def _factory(
        handler: Callable[[httpx.Request], httpx.Response], **kwargs
    ) -> AsyncSyrotpClient:
        kwargs.setdefault("base_url", "http://syrotp.test")
        kwargs.setdefault("api_key", "sk_live_TESTKEY_DO_NOT_USE")
        kwargs.setdefault("retries", 0)
        return AsyncSyrotpClient(transport=httpx.MockTransport(handler), **kwargs)

    return _factory


@pytest.fixture
def captured_requests() -> List[httpx.Request]:
    return []


@pytest.fixture
def fixed_verification() -> Callable[..., dict]:
    return _fixed_verification
