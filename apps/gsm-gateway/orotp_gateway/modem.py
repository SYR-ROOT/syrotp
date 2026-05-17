"""
GSM modem driver for inbound SMS.

Tested mental model: SIM800/SIM900-class serial modems (USB-attached
Huawei/Quectel sticks behave the same once switched into modem mode).

We deliberately stay in **text mode** (AT+CMGF=1). PDU mode is more
expressive (DCS, multi-part concatenation, full GSM 03.38) but text-mode
parsing is simple and the SYROTP protocol only cares about a short verb +
code body — we don't need full PDU semantics. If your carrier or modem
splits multi-part bodies, prefer a single short SMS or upgrade to a PDU
parser; that's deferred to PR 4.

AT commands used:
  AT                    sanity / wake from sleep
  ATE0                  echo off (cleaner parsing)
  AT+CMGF=1             text mode
  AT+CSCS="GSM"         GSM character set (predictable encoding)
  AT+CNMI=2,1,0,0,0     don't push URC for new SMS — we poll instead
  AT+CMGL="ALL"         list every SMS on the modem
  AT+CMGD=<idx>,4       delete by index (4 = "delete all matching" form)
  AT+CSQ                signal quality (rssi, ber)

The inbound-SMS list parser is regex-based; modems sometimes prefix
extra blank lines or mirror the command. We tolerate both.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass

import serial

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class IncomingSms:
    index: int
    sender: str
    received_at_ms: int
    body: str


# Text-mode CMGL line shape:
#   +CMGL: <index>,"<status>","<sender>",[<alpha>],"<scts>"
#   <body line(s)>
_CMGL_HEADER = re.compile(
    r'^\+CMGL:\s*(?P<index>\d+),\s*"(?P<status>[^"]*)",\s*"(?P<sender>[^"]*)"'
    r',\s*"?(?P<alpha>[^",]*)"?\s*,\s*"(?P<scts>[^"]+)"',
)
_CSQ = re.compile(r"^\+CSQ:\s*(\d+),\s*(\d+)")


def _parse_scts_to_ms(scts: str) -> int:
    """
    Parse modem SCTS timestamp like:
        "26/05/02,14:33:11+12"   (yy/mm/dd,hh:mm:ss±tz/4-hour-units)

    Falls back to the local wallclock if the format is off — a slight
    skew in received_at is preferable to dropping the SMS.
    """
    try:
        date_part, time_part = scts.split(",", 1)
        # Strip optional trailing timezone field "+12" / "-04".
        m = re.match(r"^(\d{2}):(\d{2}):(\d{2})(?:[+\-]\d{1,2})?$", time_part)
        if not m:
            return int(time.time() * 1000)
        yy, mm, dd = (int(x) for x in date_part.split("/"))
        hh, mn, ss = (int(x) for x in m.groups())
        # 2-digit year → 20xx
        year = 2000 + yy
        from datetime import datetime, timezone
        dt = datetime(year, mm, dd, hh, mn, ss, tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


class GsmModem:
    """
    Synchronous AT command driver. One serial port, one lock — every
    AT exchange holds the lock so SMS reads and CSQ probes never
    interleave their response lines.
    """

    def __init__(
        self,
        port: str,
        *,
        baudrate: int = 115200,
        read_timeout: float = 5.0,
        command_timeout: float = 8.0,
    ) -> None:
        self._port_name = port
        self._baud = baudrate
        self._read_timeout = read_timeout
        self._cmd_timeout = command_timeout
        self._lock = threading.Lock()
        self._port: serial.Serial | None = None

    def open(self) -> None:
        if self._port is not None:
            return
        log.info("opening modem at %s @ %d baud", self._port_name, self._baud)
        self._port = serial.Serial(
            port=self._port_name,
            baudrate=self._baud,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=self._read_timeout,
            write_timeout=self._read_timeout,
            rtscts=False,
            dsrdtr=False,
        )
        # Drain whatever URC garbage is sitting on the line.
        time.sleep(0.2)
        self._port.reset_input_buffer()

        # Initialization sequence — keep this short so a flaky modem
        # surfaces the failure quickly instead of looping forever.
        self._init_modem()

    def close(self) -> None:
        if self._port is not None:
            try:
                self._port.close()
            finally:
                self._port = None

    def _init_modem(self) -> None:
        for cmd, expect in (
            ("AT", "OK"),
            ("ATE0", "OK"),         # echo off
            ("AT+CMGF=1", "OK"),    # text mode
            ('AT+CSCS="GSM"', "OK"),
            ("AT+CNMI=2,1,0,0,0", "OK"),
        ):
            try:
                self._command(cmd, expect=expect)
            except ModemError as e:
                # ATE0 may fail on some modems if echo was already off —
                # don't let that block startup.
                if cmd == "ATE0":
                    log.debug("ATE0 returned non-OK (probably already off): %s", e)
                    continue
                raise
        log.info("modem initialized")

    def _command(self, cmd: str, *, expect: str = "OK") -> list[str]:
        """
        Send `cmd`, return all response lines (excluding the trailing
        OK/ERROR), or raise ModemError if `expect` doesn't appear.
        """
        if self._port is None:
            raise ModemError("modem not open")

        with self._lock:
            self._port.reset_input_buffer()
            payload = (cmd + "\r").encode("ascii")
            self._port.write(payload)
            self._port.flush()

            deadline = time.monotonic() + self._cmd_timeout
            lines: list[str] = []
            while time.monotonic() < deadline:
                raw = self._port.readline()
                if not raw:
                    continue
                line = raw.decode("ascii", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                if line == "OK":
                    if expect == "OK":
                        return lines
                    raise ModemError(f"expected {expect!r}, got OK; cmd={cmd!r}")
                if line.startswith("ERROR") or line.startswith("+CME ERROR"):
                    raise ModemError(f"modem error for {cmd!r}: {line}")
                lines.append(line)
            raise ModemError(f"timeout waiting for {expect!r} after {cmd!r}")

    def signal_dbm(self) -> int | None:
        """
        Return RSSI in dBm, or None if the modem reports "unknown" (99).

        AT+CSQ returns a 0-31 scale where:
          0   = -113 dBm or less
          31  = -51  dBm or greater
          99  = unknown / not detectable
          dBm = -113 + 2*rssi
        """
        try:
            lines = self._command("AT+CSQ")
        except ModemError as e:
            log.warning("CSQ failed: %s", e)
            return None
        for line in lines:
            m = _CSQ.match(line)
            if m:
                rssi = int(m.group(1))
                if rssi == 99:
                    return None
                return -113 + 2 * rssi
        return None

    def list_sms(self) -> list[IncomingSms]:
        """Return every SMS currently stored on the modem."""
        try:
            lines = self._command('AT+CMGL="ALL"')
        except ModemError as e:
            log.warning("CMGL failed: %s", e)
            return []
        return self._parse_cmgl_block(lines)

    def delete_sms(self, index: int) -> None:
        try:
            self._command(f"AT+CMGD={index}")
        except ModemError as e:
            # If we can't delete, the next CMGL will return it again and
            # we'll dedupe via the idempotency key — annoying but safe.
            log.warning("CMGD %d failed: %s", index, e)

    @staticmethod
    def _parse_cmgl_block(lines: list[str]) -> list[IncomingSms]:
        out: list[IncomingSms] = []
        i = 0
        while i < len(lines):
            m = _CMGL_HEADER.match(lines[i])
            if not m:
                i += 1
                continue
            # The body is everything up to the next +CMGL: or end of list.
            body_lines: list[str] = []
            j = i + 1
            while j < len(lines) and not lines[j].startswith("+CMGL:"):
                body_lines.append(lines[j])
                j += 1
            out.append(
                IncomingSms(
                    index=int(m.group("index")),
                    sender=m.group("sender"),
                    received_at_ms=_parse_scts_to_ms(m.group("scts")),
                    body="\n".join(body_lines).strip(),
                )
            )
            i = j
        return out


class ModemError(RuntimeError):
    pass
