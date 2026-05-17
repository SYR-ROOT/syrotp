"""Config validation tests — fail fast on misconfigured deployments."""
from __future__ import annotations

from pathlib import Path

import pytest

from syrotp_gateway.config import ConfigError, GatewayConfig


_MIN_VALID = """
[server]
url = "https://syrotp.example.com"

[receiver]
id          = "rcv_01ABC"
msisdn      = "+963991234567"
signing_key = "0123456789abcdef0123456789abcdef0123456789abcdef"

[modem]
port = "/dev/ttyUSB0"
"""


def _write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "config.toml"
    p.write_text(body, encoding="utf-8")
    return p


def test_minimal_valid_config(tmp_path: Path):
    cfg = GatewayConfig.load(_write(tmp_path, _MIN_VALID))
    assert cfg.server_url == "https://syrotp.example.com"
    assert cfg.receiver_id == "rcv_01ABC"
    assert cfg.receiver_msisdn == "+963991234567"
    # Defaults applied:
    assert cfg.modem_baudrate == 115200
    assert cfg.poll_seconds == 5.0
    assert cfg.heartbeat_seconds == 60
    assert cfg.log_level == "INFO"
    assert cfg.queue_db_path.endswith("queue.db")
    assert cfg.sim_slot is None


def test_missing_file_raises(tmp_path: Path):
    with pytest.raises(ConfigError, match="not found"):
        GatewayConfig.load(tmp_path / "missing.toml")


def test_bad_toml_raises(tmp_path: Path):
    with pytest.raises(ConfigError, match="invalid TOML"):
        GatewayConfig.load(_write(tmp_path, "not [valid toml"))


def test_missing_server_url_raises(tmp_path: Path):
    body = _MIN_VALID.replace('url = "https://syrotp.example.com"', 'url = ""')
    with pytest.raises(ConfigError, match="server.url"):
        GatewayConfig.load(_write(tmp_path, body))


def test_bad_receiver_id_raises(tmp_path: Path):
    body = _MIN_VALID.replace('id          = "rcv_01ABC"', 'id          = "not-a-rcv-id"')
    with pytest.raises(ConfigError, match="receiver.id"):
        GatewayConfig.load(_write(tmp_path, body))


def test_bad_msisdn_raises(tmp_path: Path):
    body = _MIN_VALID.replace('msisdn      = "+963991234567"', 'msisdn      = "0991234567"')
    with pytest.raises(ConfigError, match="E.164"):
        GatewayConfig.load(_write(tmp_path, body))


def test_short_signing_key_raises(tmp_path: Path):
    body = _MIN_VALID.replace(
        'signing_key = "0123456789abcdef0123456789abcdef0123456789abcdef"',
        'signing_key = "tooshort"',
    )
    with pytest.raises(ConfigError, match="signing_key"):
        GatewayConfig.load(_write(tmp_path, body))


def test_overrides_apply(tmp_path: Path):
    body = """
[server]
url = "https://syrotp.example.com"

[receiver]
id          = "rcv_01ABC"
msisdn      = "+963991234567"
signing_key = "0123456789abcdef0123456789abcdef0123456789abcdef"

[modem]
port     = "/dev/ttyACM0"
baudrate = 9600
sim_slot = 1

[runtime]
queue_db_path     = "/tmp/q.db"
poll_seconds      = 1.5
heartbeat_seconds = 30
log_level         = "debug"
"""
    cfg = GatewayConfig.load(_write(tmp_path, body))
    assert cfg.modem_port == "/dev/ttyACM0"
    assert cfg.modem_baudrate == 9600
    assert cfg.sim_slot == 1
    assert cfg.queue_db_path == "/tmp/q.db"
    assert cfg.poll_seconds == 1.5
    assert cfg.heartbeat_seconds == 30
    assert cfg.log_level == "DEBUG"
