"""
Tests for the SYROTP Django settings resolver. The contract: Django
settings win → env vars next → defaults last; SYROTP_SECRET_KEY falls
back to SYROTP_PUBLIC_KEY at every layer.

We use `django.test.override_settings` instead of mutating
`django.conf.settings` directly so each test resets cleanly.
"""
from __future__ import annotations

import pytest
from django.test import override_settings

from syrotp.django import _resolve_settings


def _clear_env(monkeypatch):
    for key in (
        "SYROTP_BASE_URL",
        "SYROTP_SECRET_KEY",
        "SYROTP_PUBLIC_KEY",
        "SYROTP_TIMEOUT_MS",
        "SYROTP_RETRIES",
        "SYROTP_USER_AGENT",
    ):
        monkeypatch.delenv(key, raising=False)


@override_settings(
    SYROTP_BASE_URL="https://from-django.example.com",
    SYROTP_SECRET_KEY="sk_live_django",
)
def test_django_settings_take_precedence_over_env(monkeypatch):
    monkeypatch.setenv("SYROTP_BASE_URL", "https://from-env.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_env_should_lose")

    s = _resolve_settings()
    assert s["base_url"] == "https://from-django.example.com"
    assert s["api_key"] == "sk_live_django"


def test_falls_back_to_env_when_django_settings_missing(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYROTP_BASE_URL", "https://from-env.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_from_env")

    s = _resolve_settings()
    assert s["base_url"] == "https://from-env.example.com"
    assert s["api_key"] == "sk_live_from_env"


@override_settings(SYROTP_BASE_URL="https://x.test", SYROTP_PUBLIC_KEY="pk_live_django")
def test_secret_key_falls_back_to_public_in_django_settings(monkeypatch):
    _clear_env(monkeypatch)
    s = _resolve_settings()
    assert s["api_key"] == "pk_live_django"


def test_secret_key_falls_back_to_public_in_env(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYROTP_BASE_URL", "https://x.test")
    monkeypatch.setenv("SYROTP_PUBLIC_KEY", "pk_live_env")

    s = _resolve_settings()
    assert s["api_key"] == "pk_live_env"


@override_settings(
    SYROTP_BASE_URL="https://x.test",
    SYROTP_SECRET_KEY="sk_live_secret_wins",
    SYROTP_PUBLIC_KEY="pk_live_should_lose",
)
def test_secret_wins_over_public_when_both_set(monkeypatch):
    _clear_env(monkeypatch)
    s = _resolve_settings()
    assert s["api_key"] == "sk_live_secret_wins"


@override_settings(SYROTP_BASE_URL="https://x.test", SYROTP_SECRET_KEY="sk_live_x")
def test_defaults_apply_when_optional_keys_missing(monkeypatch):
    _clear_env(monkeypatch)
    s = _resolve_settings()
    assert s["timeout_ms"] == 15_000
    assert s["retries"] == 2
    assert s["user_agent"] is None


@override_settings(
    SYROTP_BASE_URL="https://x.test",
    SYROTP_SECRET_KEY="sk_live_x",
    SYROTP_TIMEOUT_MS=9000,
    SYROTP_RETRIES=0,
    SYROTP_USER_AGENT="my-svc/1.2",
)
def test_optional_overrides_from_django(monkeypatch):
    _clear_env(monkeypatch)
    s = _resolve_settings()
    assert s["timeout_ms"] == 9000
    assert s["retries"] == 0
    assert s["user_agent"] == "my-svc/1.2"


def test_missing_base_url_raises(monkeypatch):
    _clear_env(monkeypatch)
    with pytest.raises(RuntimeError, match="SYROTP_BASE_URL"):
        _resolve_settings()


@override_settings(SYROTP_BASE_URL="https://x.test")
def test_missing_api_key_raises(monkeypatch):
    _clear_env(monkeypatch)
    with pytest.raises(RuntimeError, match="SYROTP_SECRET_KEY"):
        _resolve_settings()


@override_settings(
    SYROTP_BASE_URL="",  # placeholder; should not shadow a real env value
    SYROTP_SECRET_KEY="",
)
def test_empty_django_value_falls_through_to_env(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYROTP_BASE_URL", "https://from-env.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_from_env")

    s = _resolve_settings()
    assert s["base_url"] == "https://from-env.example.com"
    assert s["api_key"] == "sk_live_from_env"
