"""Mutation harness: flip one shipped safety property, confirm the suite fails.

A test that has never failed has not been shown to discriminate.
"""
import io
import shutil
import os
import signal
import subprocess
import sys

INDEX = "index.js"
PRISTINE = "/tmp/.vc-pristine-index.js"
SUITE = [
    "tests/outbound-message-id.test.js",
    "tests/outbound-id-hooks.test.js",
]

NUL = chr(0)

MUTATIONS = [
    (
        "P0 metadata failure no longer retries the turn clean",
        "        return postIngestWithLifecycleRetry(\n"
        "          path, vcKeyFor(sessionKey), convId, ingestPayload);\n"
        "      }\n"
        "    }",
        "        throw error;\n      }\n    }",
    ),
    (
        "P1-7 observe mode drains the late path again",
        "      if (!outboundIdCfg.carry || !outboundIdCfg.latePath) return;",
        "      if (!outboundIdCfg.latePath) return;",
    ),
    (
        "P1-6 future timestamps become immortal again",
        "    const age = !Number.isFinite(parsed) || skewMs > OUTBOUND_ID_MAX_SKEW_MS\n"
        "      ? Number.POSITIVE_INFINITY\n"
        "      : Math.max(0, now - parsed);",
        "    const age = Number.isFinite(parsed)\n"
        "      ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;",
    ),
    (
        "P1-5 fairness removed: strict oldest-first ordering",
        "    if (leftAttempts !== rightAttempts) return leftAttempts - rightAttempts;\n",
        "",
    ),
    (
        "P2 record key ignores the identity entirely",
        '    .update(JSON.stringify([\n'
        '      "outbound-id/v1", deploymentId, convId, identityKey,\n'
        '    ]), "utf8")',
        '    .update(JSON.stringify(["outbound-id/v1", deploymentId, convId]), "utf8")',
    ),
    (
        "P2 wire projection gains a denominator field",
        "  return observed.length > 0 ? { [OUTBOUND_ID_WIRE_KEY]: observed } : {};",
        "  return observed.length > 0\n"
        "    ? { [OUTBOUND_ID_WIRE_KEY]: observed, expected_count: observed.length }\n"
        "    : {};",
    ),
    (
        "P1-2 pending state keyed by conversation alone",
        "      return `${deployment.deployment_id}" + chr(92) + "u0000${convId}`;",
        "      return convId;",
    ),
    (
        "P1-8 inventory root scan throws instead of reporting",
        "  } catch (error) {\n"
        "    // This is a DIAGNOSTIC.",
        "  } catch (error) {\n"
        "    throw error;\n"
        "    // This is a DIAGNOSTIC.",
    ),
    (
        "verdict.permanent ignored in favour of the HTTP status",
        "  if (verdict && typeof verdict === \"object\" && \"permanent\" in verdict) {\n"
        "    return verdict.permanent === true;\n  }\n",
        "",
    ),
    (
        "a bare unrecognised reason is dropped instead of retried",
        "  const reason = typeof verdict?.reason === \"string\" ? verdict.reason : \"\";\n"
        "  if (reason) return OUTBOUND_ID_PERMANENT_REASONS.has(reason);",
        "  const reason = typeof verdict?.reason === \"string\" ? verdict.reason : \"\";\n"
        "  if (reason) return true;",
    ),
    (
        "A9 multi-chunk bound stops being published",
        "    `multiChunkPayloads>=${stats.chunkedLowerBound} ` +\n",
        "",
    ),
    (
        "a permanent decline is retried forever instead of dropped",
        "        permanent: !OUTBOUND_ID_RETRYABLE_REASONS.has(reason),",
        "        permanent: false,",
    ),
    (
        "instrument counters go back to per-registration",
        "    if (outboundIdCfg.enabled) outboundIdRegistrations += 1;",
        "    if (outboundIdCfg.enabled) outboundIdRegistrations += 1;\n"
        "    const outboundIdStats = newOutboundIdStats();",
    ),
    (
        "pre-delivery denominator stops being counted",
        "      if (outboundIdCfg.enabled) outboundIdStats.sendingHookEvents += 1;",
        "",
    ),
    (
        "sent_per_sending divides by zero instead of saying NO_DATA",
        "    `sent_per_sending=${stats.sendingHookEvents > 0\n"
        "      ? (stats.events / stats.sendingHookEvents).toFixed(2)\n"
        "      : \"NO_DATA\"}(SELF-REFERENTIAL",
        "    `sent_per_sending=${(stats.events / stats.sendingHookEvents)\n"
        "      .toFixed(2)}(SELF-REFERENTIAL",
    ),
    (
        "a counts body with no accept is treated as success",
        "  const verdict = classifyOutboundIdResponse(result);\n  if (!verdict.ok) {",
        "  const verdict = classifyOutboundIdResponse(result);\n  if (false) {",
    ),
    (
        "duplicate stops counting as success",
        'const OUTBOUND_ID_ACCEPTED_OUTCOMES = ["accepted", "duplicate"];',
        'const OUTBOUND_ID_ACCEPTED_OUTCOMES = ["accepted"];',
    ),
    (
        "the retryable declines become permanent and get dropped",
        'const OUTBOUND_ID_RETRYABLE_REASONS = new Set(["store_unavailable", "write_failed"]);',
        "const OUTBOUND_ID_RETRYABLE_REASONS = new Set([]);",
    ),
    (
        "an unrecognised response is treated as success",
        "  // No outcome of any kind. A 200 carrying nothing recognisable proves\n"
        "  // nothing, so it is not success.\n"
        "  return { ok: false, reason: \"\", permanent: false };",
        "  return { ok: true, reason: \"\", permanent: false };",
    ),
    (
        "outbound ids get covered by the completion fingerprint again",
        "  const { [OUTBOUND_ID_EXACT_PAYLOAD_KEY]: _identities, ...covered } =\n"
        "    payload && typeof payload === \"object\" ? payload : {};",
        "  const covered = payload;",
    ),
    (
        "the completion fingerprint stops covering the payload at all",
        '    .update(JSON.stringify({ conv_id: convId, payload: covered }), "utf8")',
        '    .update(JSON.stringify({ conv_id: convId }), "utf8")',
    ),
    (
        "the current wire vocabulary stops being recognised",
        '  "malformed_identity",\n  "unresolvable_tenant_scope",\n'
        '  "conversation_deleted",\n  "ambiguous_alias_resolution",\n'
        '  "fence_rejection",\n',
        "",
    ),
    (
        "agent scope attribution stops being recorded",
        "          outboundIdStats.byAgentScope.set(\n"
        "            agentScope, (outboundIdStats.byAgentScope.get(agentScope) ?? 0) + 1,\n"
        "          );",
        "",
    ),
    (
        "the early report burst collapses back to event 1 only",
        "            outboundIdStats.events <= OUTBOUND_ID_REPORT_EARLY_THROUGH",
        "            outboundIdStats.events === 1",
    ),
    (
        "the two paths go back to different wire keys",
        "const OUTBOUND_ID_WIRE_KEY = OUTBOUND_ID_EXACT_PAYLOAD_KEY;",
        'const OUTBOUND_ID_WIRE_KEY = "observed_outbound_messages";',
    ),
    (
        "agent_scope_id stops being sent per entry",
        "      ...(agentScopeId ? { agent_scope_id: agentScopeId } : {}),",
        "",
    ),
    (
        "the wire key drops to a bare name the receiver never reads",
        'const OUTBOUND_ID_EXACT_PAYLOAD_KEY = "_vc_agent_outbound_ids";',
        'const OUTBOUND_ID_EXACT_PAYLOAD_KEY = "agent_outbound_ids";',
    ),
    (
        "absent and unreadable collapse into one state",
        '    return { state: "absent", reason: "", counts: null };\n  }\n'
        '  const block = response[OUTBOUND_ID_ACK_KEY];\n'
        '  if (!block || typeof block !== "object" || Array.isArray(block)) {\n'
        '    return { state: "unreadable", reason: "", counts: null };',
        '    return { state: "absent", reason: "", counts: null };\n  }\n'
        '  const block = response[OUTBOUND_ID_ACK_KEY];\n'
        '  if (!block || typeof block !== "object" || Array.isArray(block)) {\n'
        '    return { state: "absent", reason: "", counts: null };',
    ),
    (
        "an unrecognised ack body is read as accepted",
        '  // It answered, and nothing in the answer is an outcome this side knows.\n'
        '  return { state: "unreadable", reason: "", counts: block };',
        '  return { state: "accepted", reason: "", counts: block };',
    ),
    (
        "the ack is read from top level instead of the nested key",
        "  const block = response[OUTBOUND_ID_ACK_KEY];",
        "  const block = response;",
    ),
    (
        "a decline is counted but never logged",
        '        log?.warn?.(\n'
        '          `[vc:outbound-id] DECLINED by receiver reason=${reason} ` +',
        '        if (false) log?.warn?.(\n'
        '          `[vc:outbound-id] DECLINED by receiver reason=${reason} ` +',
    ),
    (
        "declines are counted as accepted",
        "    stats.ackAccepted += acceptedCount;\n    stats.ackDeclined += declinedCount;",
        "    stats.ackAccepted += acceptedCount + declinedCount;",
    ),
    (
        "acknowledgement attributed from the sent count, not the receiver's",
        "    stats.ackAccepted += acceptedCount;\n    stats.ackDeclined += declinedCount;",
        "    if (ack.state === \"accepted\") stats.ackAccepted += carried;\n"
        "    else stats.ackDeclined += carried;",
    ),
    (
        "unaccounted identities are silently dropped",
        "    if (balance > 0) stats.ackUnaccounted += balance;",
        "",
    ),
    (
        "a mixed ack returns before recording the decline reason",
        "  if (declinedCount > 0) {\n    for (const reason of [",
        "  if (ack.state === \"accepted\") return;\n  if (declinedCount > 0) {\n    for (const reason of [",
    ),
    (
        "decline reasons counted per response instead of per identity",
        "          reason, (stats.ackDeclinedByReason.get(reason) ?? 0) + count,",
        "          reason, (stats.ackDeclinedByReason.get(reason) ?? 0) + 1,",
    ),
    (
        "retry keys on the status code instead of the verified type",
        "          const retryable = error?.vcType === INGEST_RETRY_TYPE\n"
        "            && attempt < INGEST_RETRY_MAX_ATTEMPTS;",
        "          const retryable = error?.status === 503\n"
        "            && attempt < INGEST_RETRY_MAX_ATTEMPTS;",
    ),
    (
        "retry keys on the retryable flag alone",
        "          const retryable = error?.vcType === INGEST_RETRY_TYPE\n"
        "            && attempt < INGEST_RETRY_MAX_ATTEMPTS;",
        "          const retryable = error?.retryable === true\n"
        "            && attempt < INGEST_RETRY_MAX_ATTEMPTS;",
    ),
    (
        "terminal loss stops being logged",
        "              log.error?.(\n"
        "                `[vc] TURN LOST — ingest exhausted retries for ` +",
        "              if (false) log.error?.(\n"
        "                `[vc] TURN LOST — ingest exhausted retries for ` +",
    ),
    (
        "the retry loop becomes unbounded",
        "            && attempt < INGEST_RETRY_MAX_ATTEMPTS;",
        "            && attempt < 9999;",
    ),
    (
        "a missing Retry-After is treated as zero delay",
        "          const advised = Number.isFinite(error?.retryAfterMs)\n"
        "            ? error.retryAfterMs\n"
        "            : INGEST_RETRY_DEFAULT_DELAY_MS;",
        "          const advised = error?.retryAfterMs ?? 0;",
    ),
    (
        "the vc error type is read from the top level instead of nested",
        '    error.vcType = typeof error.body?.error?.type === "string"\n'
        "      ? error.body.error.type\n      : null;",
        '    error.vcType = typeof error.body?.type === "string"\n'
        "      ? error.body.type\n      : null;",
    ),
    (
        "identifier counter counts the derived runId instead of the raw one",
        "        rawRunId: cleanInboundField(ctx?.runId),",
        "        rawRunId: contextRunId,",
    ),
    (
        "turns without an identifier are not counted at all",
        "  stats.turnsSeen += 1;",
        "  if (!sessionId) return;\n  stats.turnsSeen += 1;",
    ),
    (
        "ingest-retry gate defaults to ARMED instead of off",
        "  return { enabled: raw?.enabled === true };",
        "  return { enabled: raw?.enabled !== false };",
    ),
    (
        "ingest-retry gate accepts any truthy value",
        "  return { enabled: raw?.enabled === true };",
        "  return { enabled: Boolean(raw?.enabled) };",
    ),
    (
        "ingest-retry gate removed entirely",
        "      if (!ingestRetryCfg.enabled) {\n        return vcPost(baseUrl, path, vcKey, convId, payload, 15000, log);\n      }",
        "",
    ),
    (
        "gated-off path swallows the error instead of returning it",
        "        return vcPost(baseUrl, path, vcKey, convId, payload, 15000, log);",
        "        return vcPost(baseUrl, path, vcKey, convId, payload, 15000, log).catch(() => null);",
    ),
    (
        "over-accounting clamped back into silence",
        "    else if (balance < 0) stats.ackOverAccounted += -balance;",
        "",
    ),
    (
        "over- and under-accounting netted into one counter",
        "    else if (balance < 0) stats.ackOverAccounted += -balance;",
        "    else if (balance < 0) stats.ackUnaccounted += -balance;",
    ),
    (
        "exact-path acknowledgement never read",
        "    noteOutboundIdAck(\n      outboundIdStats, readOutboundIdAck(ingestResult), ackIdentities, log,\n    );",
        "",
    ),
    (
        "exact-path ack skipped when delivery is dead-lettered",
        "  if (ackIdentities > 0) {",
        "  if (ackIdentities > 0 && ingestResult?.status !== \"permanent_conflict\") {",
    ),
    (
        "exact-path ack charges one per record instead of per identity",
        "    ? record.payload[OUTBOUND_ID_EXACT_PAYLOAD_KEY].length",
        "    ? 1",
    ),
    (
        "actor id: a conflict is downgraded to a warning instead of disabling",
        "        agentActorIds.conflicted.add(platform);",
        "",
    ),
    (
        "actor id: absent corroboration reported as verified",
        '      if (verdict.state === "conflict") {',
        '      if (verdict.state === "conflict" && false) {',
    ),
    (
        "actor id: any truthy value accepted as a platform key",
        "    if (!platform || !/^[a-z0-9._-]+$/.test(platform)) continue;",
        "    if (!platform) continue;",
    ),
    (
        "actor id: a majority resolves a disagreement instead of refusing",
        "  const conflicts = list.filter((entry) => entry.id !== configuredId);\n  if (conflicts.length > 0) return { state: \"conflict\", conflicts };",
        "  const conflicts = list.filter((entry) => entry.id !== configuredId);\n  if (conflicts.length > list.length / 2) return { state: \"conflict\", conflicts };",
    ),
    (
        "actor id: empty corroboration treated as agreement",
        '  if (list.length === 0) return { state: "uncorroborated", conflicts: [] };',
        "",
    ),
    (
        "actor id: tripwire does not disable the platform",
        "  state.tripped.add(platform);",
        "",
    ),
    (
        "actor id: a tripped platform still sends its id",
        '  if (state.tripped.has(platform)) return "";',
        "",
    ),
    (
        "actor id: a conflicted platform still sends its id",
        '  if (state.conflicted.has(platform)) return "";',
        "",
    ),
    (
        "actor id: effective-state line reports the verdict instead of the value",
        "      const sendable = agentActorIdFor(agentActorIds, platform);",
        "      const sendable = agentActorIds.configured.get(platform) ?? \"\";",
    ),
    (
        "actor id: boot lines stop saying the value is not delivered",
        "`NOT DELIVERED ANYWHERE. This package sends no identity on any wire; ` +",
        "`` +",
    ),
    (
        "ack-lag warning removed from the report",
        "    `ack_lags_carry=BY_ONE_REPORT(ackAccepted is recorded when the exact-source ` +",
        "",
    ),
    (
        "ack-lag warning demoted into the limitations block",
        "    `ack_lags_carry=BY_ONE_REPORT",
        "    `LIMITATIONS_ack_lags_carry=BY_ONE_REPORT",
    ),
    (
        "algebraic-agreement caveat claimed even after declines are seen",
        "      stats.ackDeclined === 0 ? \"YES(agreement is ALGEBRAIC, not corroboration; \" +",
        "      true ? \"YES(agreement is ALGEBRAIC, not corroboration; \" +",
    ),
    (
        "algebraic-agreement caveat removed",
        "    `ack_equals_carry_while_declined_zero=${",
        "    `` + ``.slice(0) + `ack_equals_carry_while_declined_zero_removed=${",
    ),
    (
        "cap truncation counted but not warned",
        "        log.warn?.(\n          `[vc:outbound-id] CAP TRUNCATION",
        "        (() => {})?.(\n          `[vc:outbound-id] CAP TRUNCATION",
    ),
    (
        "cap truncation counter off by the cap itself",
        "  return size > limit ? size - limit : 0;",
        "  return size > limit ? size : 0;",
    ),
    (
        "cap truncation measured after the slice instead of before",
        "      const dropped = pendingOutboundIdDropCount(pendingOutboundIds, pendingKey);",
        "      const dropped = 0;",
    ),
]


def _install_restore_guard(path, original):
    """Put the file back if we are killed.

    A `timeout` on this script previously left a mutation applied to the source
    tree: the next run then aborted with "suite is not green" and the working
    tree carried a defect that looked like an edit. Restore-on-exit is not
    optional for a tool whose normal state is a corrupted file.
    """
    def _restore(signum, frame):
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original)
            print(f"\nINTERRUPTED (signal {signum}) - {path} restored.")
        finally:
            raise SystemExit(130)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _restore)


def run_suite():
    result = subprocess.run(
        ["npx", "vitest", "run", *SUITE, "--no-file-parallelism", "--pool=forks"],
        capture_output=True, text=True, timeout=300,
    )
    return result.returncode == 0, result.stdout + result.stderr


SENTINEL = "/tmp/.vc-mutation-in-progress"


MUTATION_COUNT_FILE = "/Users/yursilkidwai/.openclaw/.vc-work/.mutation-count"


def _ratchet_mutation_count():
    """Refuse to run a SMALLER mutation set than last time without saying so.

    The gap this closes: an edit that silently fails to apply leaves the set at
    its old size, and the run then reports a clean sweep for code it never
    touched. `STALE ANCHORS` cannot see it -- a mutation that was never added
    to the list cannot have an anchor that drifted. The summary line is true
    and still misleading, because the number of mutations in the file was never
    the number the author believed was in it.

    A shrink is not always wrong (a mutation can be legitimately retired), so
    this warns loudly and continues rather than aborting. Silence is the defect
    being fixed, not execution.
    """
    current = len(MUTATIONS)
    previous = None
    try:
        previous = int(io.open(MUTATION_COUNT_FILE, encoding="utf-8").read().strip())
    except Exception:
        pass
    print(f"mutation set: {current} entries" +
          (f" (previous run: {previous})" if previous is not None else " (no previous run recorded)"))
    if previous is not None and current < previous:
        print(f"*** WARNING: the mutation set SHRANK from {previous} to {current}. ***")
        print("*** If that was not deliberate, an edit failed to apply and this run "
              "will report a clean sweep for code it never mutated. ***")
    try:
        io.open(MUTATION_COUNT_FILE, "w", encoding="utf-8").write(f"{current}\n")
    except Exception:
        pass


def _validate_anchors():
    """Fail BEFORE running when any anchor does not match exactly once.

    Two stale anchors cost a full run each tonight, and one of them was the
    single most important mutation of its batch -- it never executed and the
    summary still read as a clean sweep for the file it was pointed at. A
    substring anchor is also silently non-unique: "    noteOutboundIdAck("
    matched a deeper-indented call site as well.

    Checking costs one pass over the source. Not checking costs ten minutes and
    a false result, which is the worse trade in both directions.
    """
    source = io.open(INDEX, encoding="utf-8").read()
    broken = [(title, source.count(old)) for title, old, _ in MUTATIONS
              if source.count(old) != 1]
    if not broken:
        print(f"anchors: all {len(MUTATIONS)} match exactly once")
        return True
    print("ABORT: anchors do not match the source exactly once. "
          "These mutations WOULD NOT RUN and the summary would not say so:")
    for title, count in broken:
        print(f"  - {title}  (matched {count}x)")
    return False


def main():
    _ratchet_mutation_count()
    if not _validate_anchors():
        return 1
    # A commit taken while this runs captures a MUTATED file. That happened:
    # a background run was in flight during `git add index.js`, and the
    # mutation reached the branch and was pushed. The sentinel exists so the
    # condition is checkable from outside instead of remembered.
    io.open(SENTINEL, "w", encoding="utf-8").write(
        "mutation run in progress -- index.js is being rewritten in place; "
        "DO NOT COMMIT until this file is gone\n")
    shutil.copy(INDEX, PRISTINE)
    _install_restore_guard(INDEX, io.open(INDEX, encoding="utf-8").read())
    passed, _ = run_suite()
    if not passed:
        print("ABORT: suite is not green before mutating.")
        return 1

    survivors = []
    stale = []
    for title, old, new in MUTATIONS:
        source = io.open(INDEX, encoding="utf-8").read()
        count = source.count(old)
        if count != 1:
            print(f"STALE ANCHOR (matched {count}x)  {title}")
            stale.append(title)
            continue
        io.open(INDEX, "w", encoding="utf-8").write(source.replace(old, new))
        green, output = run_suite()
        shutil.copy(PRISTINE, INDEX)
        if green:
            print(f"SURVIVED (BAD)  {title}")
            survivors.append(title)
        else:
            failed = [
                line.strip() for line in output.splitlines()
                if line.strip().startswith("×")
            ]
            print(f"caught ({len(failed)} test(s))  {title}")

    print()
    print(f"mutations run: {len(MUTATIONS)}   caught: "
          f"{len(MUTATIONS) - len(survivors) - len(stale)}   "
          f"SURVIVED: {len(survivors)}   STALE ANCHORS: {len(stale)}")
    if stale:
        # A stale anchor NEVER RAN. Counting it as a survivor overstates the
        # problem; counting it as caught hides that the property is now
        # untested. It is neither -- it is a broken check, and the mutation
        # tool has to report on its own health or it becomes another
        # instrument nobody validates.
        print("STALE ANCHORS DID NOT RUN AT ALL -- the property is UNTESTED "
              "until the anchor is repointed:")
        for name in stale:
            print(f"  - {name}")
    if survivors or stale:
        print("Survivors mean those properties are UNTESTED, not that they work:")
        for name in survivors:
            print(f"  - {name}")
        return 1
    print("Every mutation was caught. These tests discriminate.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        try:
            os.unlink(SENTINEL)
        except OSError:
            pass
