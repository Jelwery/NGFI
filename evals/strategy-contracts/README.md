# Strategy contract fixtures

This directory is reserved for frozen, provider-free fixtures that exercise the
public `@finance2dsh/strategy-core` contract. WP03 keeps the golden identity and
negative contract cases in `tests/strategy-contracts.test.ts`; later strategy
packages may add versioned JSON fixtures here.

A fixture must pin all values that affect reproducibility: strategy definition,
resolved configuration, canonical instrument, ordered bars, adjustment mode,
data snapshot id/hash, observation outputs, and execution definition. Market
regime or qualification overlays remain separate expected outputs and must not
select or rewrite a strategy inside the fixture.

Fixtures are offline inputs, not provider captures and not proof that a strategy
is profitable. A smoke-tier backtest may verify mechanics but cannot promote a
strategy to `approved`; only a separate research-grade validation package may
produce that evidence.
