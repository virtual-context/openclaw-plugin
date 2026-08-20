#!/usr/bin/env python3
"""Backfill VC turns lost during the 2026-07-31 cloud outage.

Context
-------
Between 03:01:00Z and 14:49:29Z on 2026-07-31 the VC cloud service was wedged
(self-deadlock in TenantRegistry). Every plugin ingest in that window aborted
client-side at the 15s timeout, so the turns were never recorded. The raw turns
survive in the OpenClaw session JSONLs; this script replays them.

Design constraints (why this is not VCREINGEST)
-----------------------------------------------
VCREINGEST only deletes a session's tracker entry. The re-send then happens on
that session's NEXT PREPARE and pushes the session's ENTIRE JSONL through the
prepare endpoint -- 31.3 MB across the eight affected sessions, one of them
27.66 MB. Prepare is the fragile path (a 1,444-byte prepare was measured at
14.287s against a 15,000ms timeout). This script instead posts each lost turn
individually to the INGEST endpoint, which measured 1.156-1.494s.

Envelope fidelity
-----------------
Replicates the deployed plugin (index.js) exactly:

  URL   {baseUrl}/api/v1/context/ingest?vckey={key}&vcconv={convId}
  body  {"assistant_message": str,
         "user_message": str | absent,
         ...turnProvenance}

turnProvenance (index.js:2895) carries actor attribution:
  sender_actor_id, sender_name,
  reply_target_message_id, reply_target_body,
  reply_subject_actor_id, reply_subject_label
plus trustedPromptProvenance fields.

*** REVIEWER: this is the highest-risk area. We reconstruct provenance from the
JSONL, but the plugin derives it from live group-speaker resolution that is not
fully recoverable after the fact. Fields we cannot recover are OMITTED rather
than guessed -- an absent key is how the plugin itself signals "unknown"
(conditional spread), so omission is envelope-faithful while a fabricated value
would not be. Confirm that omission degrades attribution gracefully rather than
mis-attributing. ***

Safety
------
* --dry-run is the DEFAULT. --execute is required to send.
* --limit N stops after N turns (use --limit 1 for the canary).
* Strictly sequential: each POST must return 200 before the next is attempted.
* Any non-200 or exception ABORTS the run. No blind retries -- a failure is
  reported for a human decision (per team-lead's standing order).
* Oldest-first ordering so anchors/summaries observe history in sequence.
* Canary conversation cccccccc-* is EXCLUDED (synthetic; 12 of the 28 in-window
  user turns belong to it and are worthless to restore).

Idempotency
-----------
*** REVIEWER: unresolved. If a turn is posted twice, cloud-side behaviour
depends on turn_hash / sort_key handling -- it may dedupe, or it may create a
duplicate canonical_turns row. This script does NOT assume dedupe: it is
single-shot, aborts on first failure, and prints a resume index so a re-run can
skip what already landed. Please confirm the server-side behaviour so we know
whether a partial run is safely resumable. ***
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import sys
import time
import urllib.parse
import urllib.request

WINDOW_START = dt.datetime(2026, 7, 31, 3, 1, 0, tzinfo=dt.timezone.utc)
WINDOW_END = dt.datetime(2026, 7, 31, 14, 49, 29, tzinfo=dt.timezone.utc)

CANARY_SESSION = "cccccccc-0000-4000-8000-000000000001"

# Sessions with failed ingests in the window, from the journal-side analysis and
# confirmed against the JSONLs. Canary deliberately absent.
AFFECTED_SESSIONS = [
    "83b4db04-17d2-469b-9da8-b52731750bfd",
    "7c749837-aa9e-4b9e-81ef-a99328c2ec4f",
    "458b1f27-fe26-4c29-9cf9-bb771f655d57",
    "a9fbb097-43bf-4c17-b5d6-cd43dd18b647",
    "ffcb348d-93f6-4a7f-ae4a-2b6eee83ddd1",
    "ec7ad2be-9bfd-48d8-9fdf-78acc5c5ca1f",
    "5394a912-f227-4cac-a585-3e3f2653e30c",
]

SESSION_GLOB = "/root/.openclaw/agents/*/sessions/%s.jsonl"

PROVENANCE_KEYS = (
    "sender_actor_id",
    "sender_name",
    "reply_target_message_id",
    "reply_target_body",
    "reply_subject_actor_id",
    "reply_subject_label",
)


def parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def text_of(entry):
    """Flatten an OpenClaw message entry to plain text, mirroring the plugin."""
    content = entry.get("content")
    if content is None:
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return ""


def role_of(entry):
    role = entry.get("role")
    if role:
        return role
    message = entry.get("message")
    return message.get("role") if isinstance(message, dict) else None


def provenance_of(entry):
    """Recover only provenance fields actually present. Never fabricate."""
    out = {}
    for key in PROVENANCE_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value
    return out


def session_path(session_id):
    hits = glob.glob(SESSION_GLOB % session_id)
    return hits[0] if hits else None


def load_turns(session_id):
    """Return in-window (user, assistant) pairs, oldest first.

    A turn is a user entry followed by the next assistant entry. Unpaired
    entries are dropped: the plugin only ever ingests a completed pair, so
    replaying a fragment would create a shape the cloud never receives live.
    """
    path = session_path(session_id)
    if not path:
        return [], "JSONL NOT FOUND"
    entries = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            stamp = parse_ts(obj.get("timestamp") or obj.get("ts"))
            if stamp is None or not (WINDOW_START <= stamp <= WINDOW_END):
                continue
            entries.append((stamp, obj))
    entries.sort(key=lambda pair: pair[0])

    turns = []
    pending_user = None
    for stamp, obj in entries:
        role = role_of(obj)
        if role == "user":
            pending_user = (stamp, obj)
        elif role == "assistant" and pending_user is not None:
            user_stamp, user_obj = pending_user
            user_text = text_of(user_obj)
            assistant_text = text_of(obj)
            if user_text.strip() and assistant_text.strip():
                turns.append(
                    {
                        "session_id": session_id,
                        "ts": user_stamp,
                        "user_message": user_text,
                        "assistant_message": assistant_text,
                        "provenance": provenance_of(user_obj),
                    }
                )
            pending_user = None
    return turns, None


def post_ingest(base_url, vc_key, conv_id, turn, timeout):
    url = "%s/api/v1/context/ingest?%s" % (
        base_url.rstrip("/"),
        urllib.parse.urlencode({"vckey": vc_key, "vcconv": conv_id}),
    )
    body = {"assistant_message": turn["assistant_message"]}
    if turn["user_message"]:
        body["user_message"] = turn["user_message"]
    body.update(turn["provenance"])
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
        return response.status, payload, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="actually POST (default: dry run)")
    parser.add_argument("--limit", type=int, default=0, help="stop after N turns (1 = canary)")
    parser.add_argument("--start-at", type=int, default=0, help="skip the first N turns (resume)")
    parser.add_argument("--sleep", type=float, default=2.0, help="seconds between turns")
    parser.add_argument("--timeout", type=float, default=15.0, help="per-request timeout")
    parser.add_argument("--conv-map", required=True, help="JSON file: {session_id: conversation_id}")
    parser.add_argument("--base-url", default="https://api.virtual-context.com")
    args = parser.parse_args()

    vc_key = os.environ.get("VC_KEY", "").strip()
    if not vc_key:
        sys.exit("VC_KEY not set in environment (never pass the key on argv)")

    with open(args.conv_map, encoding="utf-8") as handle:
        conv_map = json.load(handle)

    all_turns = []
    print("== SOURCE ==")
    for session_id in AFFECTED_SESSIONS:
        if session_id == CANARY_SESSION:
            continue
        turns, err = load_turns(session_id)
        if err:
            print("  %-38s %s" % (session_id[:38], err))
            continue
        conv_id = conv_map.get(session_id)
        marker = "" if conv_id else "   *** NO CONV ID -- WILL SKIP ***"
        print("  %-38s turns=%d conv=%s%s" % (session_id[:38], len(turns), conv_id, marker))
        if conv_id:
            for turn in turns:
                turn["conv_id"] = conv_id
                all_turns.append(turn)

    all_turns.sort(key=lambda turn: turn["ts"])  # oldest first, globally
    print("\n  TOTAL replayable turns: %d" % len(all_turns))

    selected = all_turns[args.start_at:]
    if args.limit:
        selected = selected[: args.limit]
    print("  selected for this run : %d (start_at=%d limit=%s)\n"
          % (len(selected), args.start_at, args.limit or "none"))

    if not args.execute:
        print("== DRY RUN (no requests sent) ==")
        for index, turn in enumerate(selected, start=args.start_at):
            print("  [%3d] %s %s user=%dch asst=%dch prov=%s"
                  % (index, turn["ts"].strftime("%H:%M:%S"), turn["session_id"][:8],
                     len(turn["user_message"]), len(turn["assistant_message"]),
                     sorted(turn["provenance"]) or "none"))
        print("\n  Re-run with --execute to send.")
        return

    print("== EXECUTING ==")
    landed = 0
    for index, turn in enumerate(selected, start=args.start_at):
        label = "[%3d] %s %s" % (index, turn["ts"].strftime("%H:%M:%S"), turn["session_id"][:8])
        try:
            status, payload, elapsed = post_ingest(
                args.base_url, vc_key, turn["conv_id"], turn, args.timeout
            )
        except Exception as exc:  # noqa: BLE001 - abort on any failure, by design
            print("  %s FAILED: %s: %s" % (label, type(exc).__name__, str(exc)[:160]))
            print("\n  ABORTED after %d successful turn(s)." % landed)
            print("  Resume with --start-at %d once the cause is understood." % index)
            sys.exit(1)
        if status != 200:
            print("  %s HTTP %s -- ABORTING" % (label, status))
            print("  Resume with --start-at %d" % index)
            sys.exit(1)
        landed += 1
        print("  %s OK %.2fs status=%s conv=%s"
              % (label, elapsed, payload.get("status"), payload.get("conversation_id")))
        if index != args.start_at + len(selected) - 1:
            time.sleep(args.sleep)

    print("\n== LEDGER ==")
    by_session = {}
    for turn in selected[:landed]:
        by_session[turn["session_id"]] = by_session.get(turn["session_id"], 0) + 1
    for session_id, count in sorted(by_session.items()):
        print("  %-38s %d turn(s) re-ingested" % (session_id[:38], count))
    print("  TOTAL landed: %d / %d selected" % (landed, len(selected)))
    print("\n  Verify store-side: canonical_turns rows per conversation_id above.")


if __name__ == "__main__":
    main()
