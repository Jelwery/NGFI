# NGFI overrides for a-stock-data

Files in this directory are NGFI modifications and are not verbatim upstream
`a-stock-data` files. Each future override must retain a prominent modification
notice and document the upstream symbol or behavior it wraps, why the override
is required, and the test that permits its removal.

Prefer wrappers here over editing the immutable files in `../../upstream/` or the
mechanically generated module in `../generated/`. The vendored upstream work is
licensed under Apache-2.0; see `../../upstream/LICENSE` and the repository-root
`THIRD_PARTY_NOTICES.md`.
