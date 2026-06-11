"""Behavioral tests for mmrag._embed_with_retry + _throttle_embed_rpm.

Run from knowledge-base/scripts:

    python -m _test_clients.test_embed_retry

Exits 0 on all-pass, 1 on any failure. Scenarios:

  1. per-minute 429 (with server retryDelay) -> 200: succeeds, sleeps the
     server-suggested 21s (not the positional backoff)
  2. PerDay 429: fails FAST (single attempt) — daily quota cannot be
     retried into success, so the file-level failure is genuine
  3. non-transient 403: raises immediately (structural predicate)
  4. transient exhausted: 503 x3 raises the last APIError after 3 attempts
  5. RPM throttle: 4th call into a limit-3 window sleeps ~60s; entries
     outside the rolling 60s window are pruned (no sleep)
  6. limit 0 disables the throttle entirely

sleep_fn is injected everywhere so tests run in milliseconds.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection
from google.genai.errors import APIError


FAILURES = []

# Messages must not contain commas — the fault-injection script parser
# splits entries on ','.
PER_MINUTE_MSG = (
    "Quota exceeded for metric EmbedContentRequestsPerMinute; "
    "please retry later. 'retryDelay': '21s'"
)
PER_DAY_MSG = (
    "Quota exceeded for metric EmbedContentRequestsPerDay; "
    "limit resets at midnight PT"
)


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _fresh():
    """Reset the module-level RPM ledger between scenarios."""
    mmrag._embed_call_times.clear()


def _embed(client, sleeps, backoffs=(25, 35, 65)):
    return mmrag._embed_with_retry(
        client,
        model="m",
        contents="text",
        embed_config=None,
        backoffs=backoffs,
        sleep_fn=sleeps.append,
    )


def test_per_minute_retry_honors_retry_delay():
    print("\n[test 1/6] per-minute 429 w/ retryDelay -> 200")
    _fresh()
    client = fault_injection.FaultInjectionClient(
        [(429, PER_MINUTE_MSG), (200, "")]
    )
    sleeps = []
    response = _embed(client, sleeps)
    _check("returns embed response", response is not None and response.embeddings[0].values == [0.0] * 8)
    _check("consumed exactly 2 attempts", client.models._index == 2, f"got {client.models._index}")
    _check("slept the server retryDelay (21s) not the positional backoff (25s)",
           sleeps == [21.0], f"got {sleeps}")


def test_per_day_fails_fast():
    print("\n[test 2/6] PerDay 429 -> immediate raise")
    _fresh()
    client = fault_injection.FaultInjectionClient(
        [(429, PER_DAY_MSG), (200, "")]
    )
    sleeps = []
    raised = None
    try:
        _embed(client, sleeps)
    except APIError as e:
        raised = e
    _check("raised APIError", raised is not None)
    _check("single attempt only (no retry burned)", client.models._index == 1, f"got {client.models._index}")
    _check("no sleeps", sleeps == [], f"got {sleeps}")


def test_non_transient_fails_fast():
    print("\n[test 3/6] 403 -> immediate raise")
    _fresh()
    client = fault_injection.FaultInjectionClient([(403, "denied"), (200, "")])
    sleeps = []
    raised = None
    try:
        _embed(client, sleeps)
    except APIError as e:
        raised = e
    _check("raised APIError", raised is not None)
    _check("single attempt only", client.models._index == 1, f"got {client.models._index}")


def test_transient_exhausted():
    print("\n[test 4/6] 503 x3 -> raises after exhausting backoffs")
    _fresh()
    client = fault_injection.FaultInjectionClient([(503, ""), (503, ""), (503, "")])
    sleeps = []
    raised = None
    try:
        _embed(client, sleeps)
    except APIError as e:
        raised = e
    _check("raised last APIError", raised is not None and raised.code == 503)
    _check("3 attempts consumed", client.models._index == 3, f"got {client.models._index}")
    _check("slept positional backoffs between attempts", sleeps == [25, 35], f"got {sleeps}")


def test_rpm_throttle_window():
    print("\n[test 5/6] RPM throttle: 4th call into a limit-3 window sleeps")
    _fresh()
    clock = {"now": 1000.0}
    sleeps = []

    def now_fn():
        return clock["now"]

    def sleep_fn(s):
        sleeps.append(s)
        clock["now"] += s  # sleeping advances the fake clock

    for _ in range(3):
        mmrag._throttle_embed_rpm(limit=3, now_fn=now_fn, sleep_fn=sleep_fn)
    _check("first 3 calls unthrottled", sleeps == [], f"got {sleeps}")

    mmrag._throttle_embed_rpm(limit=3, now_fn=now_fn, sleep_fn=sleep_fn)
    _check("4th call slept ~60s", len(sleeps) == 1 and 59.0 <= sleeps[0] <= 61.0, f"got {sleeps}")
    _check("ledger pruned to window", len(mmrag._embed_call_times) <= 3,
           f"got {len(mmrag._embed_call_times)}")

    # After the window has passed, calls are unthrottled again.
    clock["now"] += 120.0
    before = len(sleeps)
    mmrag._throttle_embed_rpm(limit=3, now_fn=now_fn, sleep_fn=sleep_fn)
    _check("call after window passage unthrottled", len(sleeps) == before, f"got {sleeps}")


def test_rpm_throttle_disabled():
    print("\n[test 6/6] limit 0 disables the throttle")
    _fresh()
    sleeps = []
    for _ in range(500):
        mmrag._throttle_embed_rpm(limit=0, now_fn=lambda: 0.0, sleep_fn=sleeps.append)
    _check("no sleeps and no ledger growth", sleeps == [] and mmrag._embed_call_times == [],
           f"sleeps={len(sleeps)} ledger={len(mmrag._embed_call_times)}")


def main():
    test_per_minute_retry_honors_retry_delay()
    test_per_day_fails_fast()
    test_non_transient_fails_fast()
    test_transient_exhausted()
    test_rpm_throttle_window()
    test_rpm_throttle_disabled()
    print(f"\n{'ALL PASS' if not FAILURES else f'{len(FAILURES)} FAILURES: {FAILURES}'}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
