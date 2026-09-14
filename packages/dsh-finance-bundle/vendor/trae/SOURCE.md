# Vendored TRAE adapter provenance

This directory contains the verified `@ad/dsh-llm-trae-plugin` snapshot used by
NGFI. It was imported on 2026-09-14 from
`mle-agent-reccore/.agents/dsh-plugins/dsh-llm-trae-plugin` at Git commit
`3033d63806e8edb99fb0ee0f129cb9980988d3d1`.

- Package version: `0.1.3-local.1`
- `index.js` SHA-256: `b7771324e0181d7f6d7a252f14b9008f31aa472a13b73fe2355da6282f82766e`
- `upstream-package.json` SHA-256: `4141672a3b5289110c75b5fcebd85cf4916e86d8b794d2d1be8526a23ca3c7a1`
- `LICENSE` SHA-256: `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`
- License: MIT

`index.js`, `upstream-package.json`, and `LICENSE` are byte-for-byte copies of
the verified reference snapshot. `index.d.ts` and this provenance record are
NGFI additions. Runtime configuration pins a reviewed static model route and
does not invoke the adapter's optional model-discovery helpers.
