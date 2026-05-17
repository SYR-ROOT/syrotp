"""
CLI entrypoint:

    syrotp-gateway --config /etc/syrotp-gateway/config.toml
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from .config import ConfigError, GatewayConfig
from .service import GatewayService


def _setup_logging(level: str) -> None:
    # journalctl-friendly: timestamped, single line, no ANSI.
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="syrotp-gateway")
    parser.add_argument(
        "--config",
        default=os.environ.get("SYROTP_GATEWAY_CONFIG", "/etc/syrotp-gateway/config.toml"),
        help="path to config.toml (default: /etc/syrotp-gateway/config.toml)",
    )
    args = parser.parse_args(argv)

    try:
        cfg = GatewayConfig.load(args.config)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2

    _setup_logging(cfg.log_level)

    service = GatewayService(cfg)
    service.install_signal_handlers()
    try:
        service.start()
    except Exception as e:
        print(f"failed to start: {e}", file=sys.stderr)
        return 1

    service.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
