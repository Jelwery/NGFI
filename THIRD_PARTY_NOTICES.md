# Third-Party Notices

## a-stock-data

NGFI includes portions of **a-stock-data**, authored and maintained by Simon Lin.

- Project: <https://github.com/simonlin1212/a-stock-data>
- Version: `v3.8.0`
- Annotated tag object: `9f995e66ee792255e492a15627f98615627041c6`
- Peeled commit: `2012ce7cd0e75d379c5e6cbd3115514f300f3bc8`
- License: Apache License 2.0
- License copy: `packages/finance-data-service/providers/astock/upstream/LICENSE`

The immutable audit snapshot contains the upstream `SKILL.md`, `LICENSE`,
`CHANGELOG.md`, `tests/test_official_data.py`, and
`docs/source-integration-v3.8.0.md`. Their byte-level identities are recorded in
`packages/finance-data-service/providers/astock/upstream/upstream.lock.json` and
`packages/finance-data-service/providers/astock/upstream/source-manifest.json`. The upstream
repository does not contain a `NOTICE` file at this tag; this file is NGFI's
attribution and modification notice, not a copied upstream notice.

### NGFI modification notice

The five immutable snapshot files above are preserved without modification. For
audit and upgrade review, NGFI inventories all 62 Python fences in the upstream
`SKILL.md` and records every discovered definition in the generated capability
manifest and raw-fence audit artifacts. Those audit artifacts are generated NGFI
files; they are not imported or executed by the provider at runtime.

Separately, the importable runtime module at
`packages/finance-data-service/providers/astock/python/generated/astock_upstream.py`
mechanically includes only the marked `official-data-core` and
`official-data-backups` blocks, in upstream source order, plus an NGFI generated-
file header. The runtime module and full-fence audit artifacts are modified/derived
forms of the upstream work, not upstream release artifacts. NGFI adapters,
wrappers, normalization, safety controls, manifests, tests, and any files under
`python/ngfi_overrides/` or `patches/` are also NGFI additions or modifications.
They are not endorsed by the upstream author.

The Apache-2.0 license for the software does not grant rights to third-party market
data, research reports, news, exchange files, or other content obtained through
the endpoints described by the software. Users remain responsible for applicable
provider terms, access rights, attribution, and redistribution restrictions.
