import { canonicalInstrumentId } from '@finance2dsh/core'
import { canonicalJson, sha256, type ContentHash } from '@finance2dsh/research-core'

import type { HoldingPosition, HoldingPositionInput, HoldingsSnapshotStatus } from './contracts.js'

export { canonicalJson }

export function portfolioHash(value: unknown): ContentHash {
  return sha256(value)
}

function normalizedAccount(account: string | undefined): string {
  const value = account?.trim() ?? 'default'
  if (value === '') throw new TypeError('holding account must be non-empty')
  return value
}

export function holdingKey(position: Pick<HoldingPositionInput, 'instrument' | 'account'>): string {
  return `${canonicalInstrumentId(position.instrument)}|${normalizedAccount(position.account)}`
}

export function holdingId(
  portfolioId: string,
  position: Pick<HoldingPositionInput, 'instrument' | 'account'>,
): ContentHash {
  return portfolioHash({ portfolioId, holdingKey: holdingKey(position) })
}

export function holdingsSnapshotHash(input: {
  readonly portfolioId: string
  readonly asOf: string
  readonly baseCurrency: string
  readonly inputHash: ContentHash
  readonly positions: readonly HoldingPosition[]
  readonly status?: HoldingsSnapshotStatus
}): ContentHash {
  return portfolioHash({
    portfolioId: input.portfolioId,
    asOf: input.asOf,
    baseCurrency: input.baseCurrency,
    positions: [...input.positions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(position => ({
        id: position.id,
        instrument: position.instrument,
        quantity: position.quantity,
        marketValue: position.marketValue,
        currency: position.currency,
        account: position.account,
        ...(position.name === undefined ? {} : { name: position.name }),
      })),
  })
}
