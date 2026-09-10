# Bug fixes

## BUG-004 — Verified reply parents disappear before memory preparation

The model-facing reply boundary retained the target's parent, but memory preparation received only the direct target. A third-party follow-up therefore lacked the participant identity needed to select relevant continuity.

The adapter forwards the verified parent as separate provenance, preserving the current sender and direct subject. Missing, edited, unavailable and self-linked parents are omitted. Parent text never enters the canonical user body.

Regression: the missing provenance builder first failed synthetic parent transport checks. Focused builder and registered-hook cases cover valid parent transport, unchanged requester identity, unavailable parents and malformed native references.

## BUG-003 — Source claims lose bound message occurrence time

Exact dispatch binding retained the transport timestamp locally but omitted it from the source claim. Delayed delivery and replay consequently preserved identity without preserving when the message occurred.

The adapter sends the bound UTC occurrence timestamp when the server advertises support. Capability state stays scoped to the invocation; missing timestamps and older servers retain the existing claim shape. Replay carries the original value and never substitutes the delivery clock. Reply-only invocations freeze the source immediately and obtain capability plus exact admission after generation, preserving native reply behavior during cloud outages.

Regression: the timestamp serialization and capability-negative hook cases failed before their fixes. Focused source serialization and registered native dispatch tests cover valid and unusable times, missing source identity, and supported versus older servers. Post-generation reply-only capture passes the original user/assistant pair and the exact receipt into the durable completion path; unsupported or unavailable capability never fabricates occurrence metadata.

## BUG-001 — Server memory fragments across channels

Opt-in server grouping could not resolve channel membership when an account allowed several servers. Hooks and tools fell back to separate channel memory identities, and tool factories read an unavailable channel field.

The server-memory policy resolves membership from trusted native metadata or an authenticated channel lookup, validates configured group membership, and shares one resolver across memory entry points. Invocation routes remain fixed through completion, native session progress stays separate, and unresolved membership bypasses memory visibly. Tool source channels use the native delivery context. Existing completion outbox destinations remain unchanged. Legacy prepare URLs and main-session direct messages retain their previous behavior; unavailable channel lookups use bounded retry backoff.

Regression: synthetic routing tests first reproduced distinct channel conversation IDs and successful tool access with unresolved server scope. Focused regressions are indexed in `tests/REGRESSION_MAP.md`.

## BUG-002 — Host schema changes bypass current-turn identity and history attribution

Marked inbound headers were not recognized as current-turn envelopes, so exact dispatch binding could not admit otherwise valid group messages. Native message metadata also moved under `__openclaw`, leaving historical authors unavailable to the attribution adapter. The native context-engine contract additionally requires a current-turn transcript fence declaration before assembly can run.

The adapter recognizes both supported header formats in source order, strips only the leading generated scaffold, and preserves literal user examples. Dispatch-bound sender, message, account, channel, and body checks remain mandatory. Reply-only handling uses the admitted body so literal metadata examples cannot redirect a substantive request. Speaker metadata reads support both native row formats and reject conflicting immutable identities. Context assembly retains per-message attribution and uses the native current-turn fence contract. Embedded hosts that omit the runtime target use their canonical session identifiers to look up the same admission, with full receipt identity checks.

Regression: anonymous marked-envelope fixtures first reproduced lost provenance, skipped prepare, and a quoted reply target replacing the actual reply chain. Mixed-format message fixtures reproduced missing author labels. Focused regressions are indexed in `tests/REGRESSION_MAP.md`.
