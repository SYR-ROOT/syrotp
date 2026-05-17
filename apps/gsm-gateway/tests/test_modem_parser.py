"""
AT+CMGL response parsing tests.

We test the parser in isolation (no serial port required). Real modem
quirks observed in the wild:
  - extra blank lines between SMS entries
  - <alpha> field empty (just two adjacent commas)
  - bodies that span multiple lines
  - bodies with commas / quotes that look like header fields
"""
from __future__ import annotations

from syrotp_gateway.modem import GsmModem


def test_single_sms():
    lines = [
        '+CMGL: 1,"REC UNREAD","+963991111111",,"26/05/02,14:33:11+12"',
        "VERIFY YFEVZN",
    ]
    out = GsmModem._parse_cmgl_block(lines)
    assert len(out) == 1
    sms = out[0]
    assert sms.index == 1
    assert sms.sender == "+963991111111"
    assert sms.body == "VERIFY YFEVZN"
    # SCTS parses to a positive epoch.
    assert sms.received_at_ms > 0


def test_multiple_sms():
    lines = [
        '+CMGL: 1,"REC UNREAD","+1","","26/05/02,14:00:00+12"',
        "first",
        '+CMGL: 2,"REC READ","+2","","26/05/02,14:01:00+12"',
        "second",
        '+CMGL: 3,"REC UNREAD","+3","","26/05/02,14:02:00+12"',
        "third",
    ]
    out = GsmModem._parse_cmgl_block(lines)
    assert [s.index for s in out] == [1, 2, 3]
    assert [s.body for s in out] == ["first", "second", "third"]
    assert [s.sender for s in out] == ["+1", "+2", "+3"]


def test_multi_line_body():
    lines = [
        '+CMGL: 7,"REC UNREAD","+963999","","26/05/02,14:33:11+12"',
        "line one",
        "line two",
        "line three",
    ]
    [sms] = GsmModem._parse_cmgl_block(lines)
    assert sms.body == "line one\nline two\nline three"


def test_empty_alpha_field_tolerated():
    # Some modems emit `,,` (empty alpha), others emit `,"",` — both must work.
    a = '+CMGL: 1,"REC UNREAD","+963","","26/05/02,14:33:11+12"'
    b = '+CMGL: 2,"REC UNREAD","+963",,"26/05/02,14:33:11+12"'
    out = GsmModem._parse_cmgl_block([a, "x", b, "y"])
    assert [s.body for s in out] == ["x", "y"]


def test_garbage_lines_before_header_are_skipped():
    lines = [
        "junk",
        "",
        '+CMGL: 1,"REC UNREAD","+1","","26/05/02,14:33:11+12"',
        "ok",
    ]
    [sms] = GsmModem._parse_cmgl_block(lines)
    assert sms.body == "ok"


def test_no_sms_returns_empty():
    assert GsmModem._parse_cmgl_block([]) == []
    assert GsmModem._parse_cmgl_block(["OK"]) == []
