"""
Tests for `syrotp.fastapi.SyrotpSettings`.

Pin the env-var contract so a future change to the Settings shape
fails noisily here instead of silently breaking apps in production.
"""
from __future__ import annotations

import pytest

from syrotp.fastapi import SyrotpSettings


def test_settings_reads_secret_key_from_env(monkeypatch):
    monkeypatch.setenv("SYROTP_BASE_URL", "https://otp.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_from_env")
    monkeypatch.delenv("SYROTP_PUBLIC_KEY", raising=False)

    s = SyrotpSettings()

    assert s.base_url == "https://otp.example.com"
    assert s.api_key == "sk_live_from_env"
    assert s.timeout_ms == 15_000
    assert s.retries == 2
    assert s.user_agent is None


def test_settings_falls_back_to_public_key_when_secret_missing(monkeypatch):
    monkeypatch.setenv("SYROTP_BASE_URL", "https://otp.example.com")
    monkeypatch.delenv("SYROTP_SECRET_KEY", raising=False)
    monkeypatch.setenv("SYROTP_PUBLIC_KEY", "pk_live_from_env")

    s = SyrotpSettings()

    assert s.api_key == "pk_live_from_env"


def test_settings_secret_key_wins_over_public_key(monkeypatch):
    """When both are set, the secret key takes precedence — same
    convention as `scripts/smoke.mjs` and the Laravel config."""
    monkeypatch.setenv("SYROTP_BASE_URL", "https://otp.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_secret_wins")
    monkeypatch.setenv("SYROTP_PUBLIC_KEY", "pk_live_should_lose")

    s = SyrotpSettings()

    assert s.api_key == "sk_live_secret_wins"


def test_settings_reads_optional_overrides(monkeypatch):
    monkeypatch.setenv("SYROTP_BASE_URL", "https://otp.example.com")
    monkeypatch.setenv("SYROTP_SECRET_KEY", "sk_live_x")
    monkeypatch.setenv("SYROTP_TIMEOUT_MS", "9000")
    monkeypatch.setenv("SYROTP_RETRIES", "0")
    monkeypatch.setenv("SYROTP_USER_AGENT", "my-svc/1.2")

    s = SyrotpSettings()

    assert s.timeout_ms == 9000
    assert s.retries == 0
    assert s.user_agent == "my-svc/1.2"


def test_settings_can_be_constructed_directly_without_env(monkeypatch):
    """
    The host app can build settings programmatically and pass them
    to `setup_syrotp(app, settings=...)`. We intentionally clear the
    env so this test fails noisily if direct construction starts
    pulling from env unexpectedly.
    """
    for key in (
        "SYROTP_BASE_URL",
        "SYROTP_SECRET_KEY",
        "SYROTP_PUBLIC_KEY",
        "SYROTP_TIMEOUT_MS",
        "SYROTP_RETRIES",
        "SYROTP_USER_AGENT",
    ):
        monkeypatch.delenv(key, raising=False)

    s = SyrotpSettings(base_url="http://syrotp.test", api_key="sk_live_x")

    assert s.base_url == "http://syrotp.test"
    assert s.api_key == "sk_live_x"


def test_settings_missing_required_fails(monkeypatch):
    """Without SYROTP_BASE_URL, SyrotpSettings() must fail loudly."""
    for key in (
        "SYROTP_BASE_URL",
        "SYROTP_SECRET_KEY",
        "SYROTP_PUBLIC_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        SyrotpSettings()
