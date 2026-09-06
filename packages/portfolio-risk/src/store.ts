import type { ContentHash } from '@finance2dsh/research-core'

import type {
  HoldingPosition,
  HoldingsBookSnapshot,
  HoldingsImportResult,
  HoldingsMutationResult,
  HoldingsSnapshot,
  HoldingsSnapshotStatus,
  HoldingsStore,
  ReadyHoldingsImport,
} from './contracts.js'
import { holdingsSnapshotHash } from './identity.js'

export type HoldingsStoreErrorCode =
  | 'invalid-import'
  | 'revision-conflict'
  | 'no-staged-holdings'
  | 'snapshot-conflict'

export class HoldingsStoreError extends Error {
  constructor(readonly code: HoldingsStoreErrorCode, message: string) {
    super(message)
    this.name = 'HoldingsStoreError'
  }
}

function clonePosition(position: HoldingPosition): HoldingPosition {
  return { ...position, instrument: { ...position.instrument } }
}

function snapshotCopy(snapshot: HoldingsSnapshot | null): HoldingsSnapshot | null {
  if (snapshot === null) return null
  return { ...snapshot, positions: snapshot.positions.map(clonePosition) }
}

function createSnapshot(input: ReadyHoldingsImport, status: HoldingsSnapshotStatus): HoldingsSnapshot {
  const positions = input.positions.map(clonePosition).sort((left, right) => left.id.localeCompare(right.id))
  const totalMarketValue = positions.reduce((total, position) => total + position.marketValue, 0)
  const semantic = {
    portfolioId: input.portfolioId,
    asOf: input.asOf,
    baseCurrency: input.baseCurrency,
    inputHash: input.inputHash,
    positions,
  }
  return { status, ...semantic, totalMarketValue, snapshotHash: holdingsSnapshotHash(semantic) }
}

function assertRevision(current: number, expected: number): void {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new HoldingsStoreError('revision-conflict', 'expectedRevision must be a non-negative integer')
  }
  if (current !== expected) {
    throw new HoldingsStoreError('revision-conflict', `holdings revision conflict: expected ${expected}, found ${current}`)
  }
}

/** In-memory reference store. Persistence adapters can implement the same CAS contract. */
export class InMemoryHoldingsStore implements HoldingsStore {
  #revision = 0
  #staged: HoldingsSnapshot | null = null
  #confirmed: HoldingsSnapshot | null = null

  snapshot(): HoldingsBookSnapshot {
    return {
      revision: this.#revision,
      staged: snapshotCopy(this.#staged),
      confirmed: snapshotCopy(this.#confirmed),
    }
  }

  stage(input: ReadyHoldingsImport, expectedRevision: number): HoldingsMutationResult {
    assertRevision(this.#revision, expectedRevision)
    if ((input as HoldingsImportResult).status !== 'ready' || input.positions.length === 0) {
      throw new HoldingsStoreError('invalid-import', 'only a non-empty ready import can be staged')
    }
    const next = createSnapshot(input, 'staged')
    if (this.#staged?.snapshotHash === next.snapshotHash) {
      return { revision: this.#revision, changed: false, snapshot: snapshotCopy(this.#staged) }
    }
    this.#staged = next
    this.#revision += 1
    return { revision: this.#revision, changed: true, snapshot: snapshotCopy(next) }
  }

  confirm(expectedRevision: number, expectedSnapshotHash: ContentHash): HoldingsMutationResult {
    assertRevision(this.#revision, expectedRevision)
    if (this.#staged === null) {
      throw new HoldingsStoreError('no-staged-holdings', 'there are no staged holdings to confirm')
    }
    if (this.#staged.snapshotHash !== expectedSnapshotHash) {
      throw new HoldingsStoreError(
        'snapshot-conflict',
        `staged holdings snapshot conflict: expected ${expectedSnapshotHash}, found ${this.#staged.snapshotHash}`,
      )
    }
    this.#confirmed = { ...this.#staged, status: 'confirmed', positions: this.#staged.positions.map(clonePosition) }
    this.#staged = null
    this.#revision += 1
    return { revision: this.#revision, changed: true, snapshot: snapshotCopy(this.#confirmed) }
  }

  discard(expectedRevision: number): HoldingsMutationResult {
    assertRevision(this.#revision, expectedRevision)
    if (this.#staged === null) return { revision: this.#revision, changed: false, snapshot: null }
    const discarded = snapshotCopy(this.#staged)
    this.#staged = null
    this.#revision += 1
    return { revision: this.#revision, changed: true, snapshot: discarded }
  }
}
