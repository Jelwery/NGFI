# Patches against a-stock-data

This directory is reserved for NGFI-authored modifications that cannot be
implemented as wrappers in `../python/ngfi_overrides/`. It intentionally contains
no patch at the v3.8.0 baseline.

Every future patch must carry a conspicuous modification notice and record the
reason, affected upstream tag/commit, upstream issue or replacement commit when
available, validating test, and deletion condition. Never edit the immutable
snapshot in `../upstream/` to apply a patch in place.
