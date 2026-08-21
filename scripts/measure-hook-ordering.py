#!/usr/bin/env python3
"""Measure hook and delivery ordering for one turn at a time, from a log stream.

Reads journal lines on stdin and reports, per turn, the offsets between
``agent_end``, ``message_sent``, and the exact-source ingest POST.

WHY THIS EXISTS AS A SCRIPT
---------------------------
The question it answers -- can a delivery carry an identity that is witnessed
after its own turn's ingest -- was first answered with a one-second-resolution
timestamp. A third of the turns came back as ``0.00s``, which is not a result:
it is a resolution limit wearing one. That was caught only because a zero on an
ordering question is self-announcing. **A uniform ``-1.00s`` would have been
directionally right, quantitatively meaningless, and silent.**

So this script refuses to report when the resolution of its own input is too
coarse for the magnitudes it is measuring. The check is the point; the
measurement is incidental.
"""

import re
import statistics
import sys
from datetime import datetime

# A measurement is only trustworthy when the quantity is well clear of the
# instrument's granularity. Ten buckets is the conventional floor for reporting
# a median at all; below that the digits are the clock's, not the system's.
MIN_TICKS_PER_MEASUREMENT = 10

TS = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d)")
KINDS = (
    ("agent_end", "running agent_end"),
    ("message_sent", "running message_sent"),
    ("post_end", "__vc_exact_source_ingest_v2 — HTTP"),
    ("post_start", "__vc_exact_source_ingest_v2"),
)


def classify(line):
    for name, needle in KINDS:
        if needle in line:
            return name
    return None


def resolution_of(stamps):
    """Smallest non-zero gap the input can express, inferred from the stamps."""
    fractional = [s for s in stamps if "." in s.split("+")[0]]
    if not fractional:
        return 1.0
    digits = max(len(s.split("+")[0].split(".")[1]) for s in fractional)
    return 10.0 ** (-digits)


def main():
    events, raw_stamps = [], []
    for line in sys.stdin:
        match = TS.search(line)
        kind = classify(line)
        if not match or not kind:
            continue
        raw_stamps.append(match.group(1))
        events.append((datetime.fromisoformat(match.group(1)), kind))

    if not events:
        print("no matching events on stdin -- this is NOT a measurement of zero.")
        return 2

    resolution = resolution_of(raw_stamps)
    turns, current = [], None
    for when, kind in events:
        if kind == "agent_end":
            if current:
                turns.append(current)
            current = {"agent_end": when}
        elif current is not None and kind not in current:
            current[kind] = when
    if current:
        turns.append(current)

    needed = {"agent_end", "message_sent", "post_start", "post_end"}
    full = [t for t in turns if needed <= set(t)]
    if not full:
        print(f"{len(turns)} turn(s) seen, none with all four events. "
              "UNCOVERED, not zero.")
        return 2

    def gap(t, a, b):
        return (t[b] - t[a]).total_seconds()

    print(f"turns with all four events: {len(full)}   "
          f"input resolution: {resolution:g}s")

    series = [
        ("margin (post_start - message_sent)",
         lambda t: gap(t, "message_sent", "post_start")),
        ("agent_end -> message_sent", lambda t: gap(t, "agent_end", "message_sent")),
        ("agent_end -> post_start", lambda t: gap(t, "agent_end", "post_start")),
        ("agent_end -> post_end (TOTAL)", lambda t: gap(t, "agent_end", "post_end")),
    ]

    unusable = []
    for label, fn in series:
        values = [fn(t) for t in full]
        typical = statistics.median([abs(v) for v in values])
        line = (f"  {label:<36} min {min(values):+.3f}  "
                f"median {statistics.median(values):+.3f}  max {max(values):+.3f}")
        # THE GUARD. A median of 0.4s read off a 1s clock is one tick, and a
        # difference of two such stamps carries an error as large as the
        # quantity. Report the numbers, then refuse to let them be quoted.
        if typical < resolution * MIN_TICKS_PER_MEASUREMENT:
            line += "   <-- BELOW RESOLUTION, DO NOT QUOTE"
            unusable.append(label)
        print(line)

    margins = [gap(t, "message_sent", "post_start") for t in full]
    after = sum(1 for m in margins if m > 0)
    print(f"  POST began AFTER the id existed: {after} of {len(margins)} turns")

    if unusable:
        print()
        print("REFUSING TO CONCLUDE. These series are within "
              f"{MIN_TICKS_PER_MEASUREMENT} ticks of the input's own resolution:")
        for label in unusable:
            print(f"  - {label}")
        print("Re-run against a source with finer timestamps. A number produced "
              "at this resolution is the clock's, not the system's.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
