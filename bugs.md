# Bug fixes

## BUG-001 — Server memory fragments across channels

Opt-in server grouping could not resolve channel membership when an account allowed several servers. Hooks and tools fell back to separate channel memory identities, and tool factories read an unavailable channel field.

The server-memory policy resolves membership from trusted native metadata or an authenticated channel lookup, validates configured group membership, and shares one resolver across memory entry points. Invocation routes remain fixed through completion, native session progress stays separate, and unresolved membership bypasses memory visibly. Tool source channels use the native delivery context. Existing completion outbox destinations remain unchanged. Legacy prepare URLs and main-session direct messages retain their previous behavior; unavailable channel lookups use bounded retry backoff.

Regression: synthetic routing tests first reproduced distinct channel conversation IDs and successful tool access with unresolved server scope. Focused regressions are indexed in `tests/REGRESSION_MAP.md`.
