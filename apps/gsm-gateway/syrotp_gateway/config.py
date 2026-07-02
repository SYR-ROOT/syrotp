"""
TOML config loader. Validates required fields up-front so misconfigured
deployments fail at startup, not on the first SMS.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib  # type: ignore[no-redef]


@dataclass(frozen=True, slots=True)
class GatewayConfig:
    server_url: str
    receiver_id: str
    receiver_msisdn: str
    signing_key: str
    modem_port: str
    modem_baudrate: int
    queue_db_path: str
    poll_seconds: float
    heartbeat_seconds: int
    sim_slot: int | None
    log_level: str

    @classmethod
    def load(cls, path: str | Path) -> "GatewayConfig":
        p = Path(path)
        if not p.is_file():
            raise ConfigError(f"config file not found: {p}")
        try:
            data = tomllib.loads(p.read_text("utf-8"))
        except tomllib.TOMLDecodeError as e:
            raise ConfigError(f"invalid TOML: {e}") from e

        server = data.get("server", {})
        receiver = data.get("receiver", {})
        modem = data.get("modem", {})
        runtime = data.get("runtime", {})

        return cls(
            server_url=_require_str(server, "url", "server.url"),
            receiver_id=_validate_receiver_id(_require_str(receiver, "id", "receiver.id")),
            receiver_msisdn=_validate_msisdn(
                _require_str(receiver, "msisdn", "receiver.msisdn")
            ),
            signing_key=_validate_signing_key(
                _require_str(receiver, "signing_key", "receiver.signing_key")
            ),
            modem_port=_require_str(modem, "port", "modem.port"),
            modem_baudrate=int(modem.get("baudrate", 115200)),
            sim_slot=int(modem["sim_slot"]) if "sim_slot" in modem else None,
            queue_db_path=str(runtime.get("queue_db_path", "/var/lib/syrotp-gateway/queue.db")),
            poll_seconds=float(runtime.get("poll_seconds", 5.0)),
            heartbeat_seconds=int(runtime.get("heartbeat_seconds", 60)),
            log_level=str(runtime.get("log_level", "INFO")).upper(),
        )


def _require_str(d: dict, key: str, full_path: str) -> str:
    v = d.get(key)
    if not isinstance(v, str) or not v:
        raise ConfigError(f"missing or empty {full_path}")
    return v


def _validate_receiver_id(value: str) -> str:
    if not re.match(r"^rcv_[A-Za-z0-9]+$", value):
        raise ConfigError("receiver.id must match ^rcv_[A-Za-z0-9]+$")
    return value


def _validate_msisdn(value: str) -> str:
    if not re.match(r"^\+\d{8,15}$", value):
        raise ConfigError("receiver.msisdn must be E.164 (e.g. +963991234567)")
    return value


def _validate_signing_key(value: str) -> str:
    # We don't pin the exact length here — the server validates the
    # signature, and operators may rotate to longer keys. We just want
    # to reject obvious paste errors / placeholders.
    if len(value) < 32 or " " in value:
        raise ConfigError("receiver.signing_key looks invalid (too short or has whitespace)")
    return value


class ConfigError(ValueError):
    pass
