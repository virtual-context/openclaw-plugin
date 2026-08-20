"""Mutation harness: flip one shipped safety property, confirm the suite fails.

A test that has never failed has not been shown to discriminate.
"""
import io
import shutil
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
        "        return vcPost(baseUrl, path, vcKeyFor(sessionKey), convId,\n"
        "          ingestPayload, 15000, log);\n"
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
        "      : \"NO_DATA\"} ` +",
        "    `sent_per_sending=${(stats.events / stats.sendingHookEvents).toFixed(2)} ` +",
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
]


def run_suite():
    result = subprocess.run(
        ["npx", "vitest", "run", *SUITE, "--no-file-parallelism", "--pool=forks"],
        capture_output=True, text=True, timeout=300,
    )
    return result.returncode == 0, result.stdout + result.stderr


def main():
    shutil.copy(INDEX, PRISTINE)
    passed, _ = run_suite()
    if not passed:
        print("ABORT: suite is not green before mutating.")
        return 1

    survivors = []
    for title, old, new in MUTATIONS:
        source = io.open(INDEX, encoding="utf-8").read()
        count = source.count(old)
        if count != 1:
            print(f"SKIP  (anchor matched {count}x)  {title}")
            survivors.append(f"{title} [ANCHOR NOT FOUND]")
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
          f"{len(MUTATIONS) - len(survivors)}   SURVIVED: {len(survivors)}")
    if survivors:
        print("Survivors mean those properties are UNTESTED, not that they work:")
        for name in survivors:
            print(f"  - {name}")
        return 1
    print("Every mutation was caught. These tests discriminate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
