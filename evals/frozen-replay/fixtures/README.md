# Frozen replay fixtures

This directory is reserved for immutable, offline research replay fixtures produced by
`@finance2dsh/research-workspace`. A fixture is a self-contained directory with an
`_frozen-replay.json` manifest and one case directory.

Fixtures must be created from a `complete` research run with at least one non-empty
artifact. The manifest fixes every copied file by SHA-256, including the case ledger,
assumptions, claims, model runs, memo, run manifest, and selected artifacts. Verification
rejects unknown schema versions, missing or extra files, unsafe paths, symlinks, and hash
drift. Seeding is file-only and performs no network access.

Do not hand-edit a fixture or refresh hashes after a test failure. Recreate it from an
audited source run so a changed input remains an explicit review event. The manifest is
an integrity check for accidental drift, not a cryptographic signature against an actor
who can rewrite both content and manifest.
