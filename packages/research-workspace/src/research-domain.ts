import fs from 'node:fs'
import { sha256, type ContentHash, type JsonObject } from '@finance2dsh/research-core'
import { atomicWriteFile, ensureDirectoryNoSymlink, readFileSecure, withFileLock } from './fs.js'

export interface ResearchPartition {
  market: string
  securities: string[]
  start: string
  end: string
}
interface Reservation {
  owner: ContentHash
  test: ResearchPartition
  development: ResearchPartition[]
}
interface DomainEvent {
  sequence: number
  previous: ContentHash | null
  kind: 'reserve' | 'consume' | 'observe'
  reservation: Reservation
}

function validatePartition(value: ResearchPartition): void {
  if (!value || typeof value.market !== 'string' || !value.market ||
      !Array.isArray(value.securities) || !value.securities.length ||
      value.securities.some(item => typeof item !== 'string' || !item) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(value.start) || !/^\d{4}-\d{2}-\d{2}$/u.test(value.end) ||
      value.start > value.end) throw new TypeError('Invalid research partition')
}
function overlaps(left: ResearchPartition, right: ResearchPartition): boolean {
  const securities = new Set(left.securities)
  return left.market === right.market && left.start <= right.end && right.start <= left.end &&
    right.securities.some(key => securities.has(key))
}

/** Shared authority for test use; workspace indexes are never the source of this ledger. */
export class ResearchDomain {
  constructor(readonly root: string) {}

  private events(): DomainEvent[] {
    const files = fs.readdirSync(this.root).filter(name => name !== '.domain.lock').sort()
    let previous: ContentHash | null = null
    return files.map((file, sequence) => {
      if (!new RegExp(`^${String(sequence).padStart(8, '0')}-[0-9a-f]{64}\\.json$`, 'u').test(file)) {
        throw new Error('Research domain ledger is incomplete or contains unregistered files')
      }
      const event = JSON.parse(readFileSecure(this.root, file).toString('utf8')) as DomainEvent
      const digest = sha256(event)
      if (file !== `${String(sequence).padStart(8, '0')}-${digest.slice(7)}.json` ||
          event.sequence !== sequence || event.previous !== previous ||
          !['reserve', 'consume', 'observe'].includes(event.kind)) throw new Error('Research domain ledger integrity mismatch')
      validatePartition(event.reservation.test)
      event.reservation.development.forEach(validatePartition)
      previous = digest
      return event
    })
  }

  reserve(owner: ContentHash, test: ResearchPartition, development: ResearchPartition[]): void {
    validatePartition(test)
    development.forEach(validatePartition)
    if (development.some(part => overlaps(part, test))) throw new Error('Development overlaps locked test')
    const reservation = { owner, test, development }
    this.mutate(events => {
      const prior = events.find(event => event.reservation.owner === owner)
      if (prior) {
        if (sha256(prior.reservation) !== sha256(reservation)) throw new Error('Frozen reservation changed')
        return
      }
      for (const event of events.filter(item => item.kind === 'reserve' || item.kind === 'observe')) {
        const saved = event.reservation
        if (overlaps(test, saved.test) || saved.development.some(part => overlaps(test, part)) ||
            development.some(part => overlaps(part, saved.test))) {
          throw new Error('Research partition overlaps a reserved test or previously inspected samples')
        }
      }
      return { kind: 'reserve', reservation }
    })
  }

  consume(owner: ContentHash): void {
    this.mutate(events => {
      const prior = events.find(event => event.kind === 'reserve' && event.reservation.owner === owner)
      if (!prior) throw new Error('Test partition was not reserved')
      if (events.some(event => event.kind === 'consume' && event.reservation.owner === owner)) return
      return { kind: 'consume', reservation: prior.reservation }
    })
  }

  /** Migrate earlier inspected experiments conservatively; never claim their samples were unseen. */
  observe(owner: ContentHash, partition: ResearchPartition): void {
    validatePartition(partition)
    this.mutate(events => {
      if (events.some(event => event.reservation.owner === owner)) return
      return { kind: 'observe', reservation: { owner, test: partition, development: [] } }
    })
  }

  /** Used by unregistered diagnostics: no reads of another task's locked samples. */
  assertReadable(partition: ResearchPartition): void {
    validatePartition(partition)
    if (!fs.existsSync(this.root)) return
    this.mutate(events => {
      if (events.some(event => overlaps(partition, event.reservation.test))) {
        throw new Error('Requested diagnostics overlap a locked test partition')
      }
    })
  }

  private mutate(action: (events: DomainEvent[]) => Pick<DomainEvent, 'kind' | 'reservation'> | void): void {
    ensureDirectoryNoSymlink(this.root)
    withFileLock(this.root, '.domain.lock', 5_000, () => {
      const events = this.events()
      const next = action(events)
      if (!next) return
      if (events.length >= 100_000) throw new Error('Research domain event budget exceeded')
      const event: DomainEvent = { sequence: events.length, previous: events.length ? sha256(events.at(-1)) : null, ...next }
      const digest = sha256(event as unknown as JsonObject)
      atomicWriteFile(this.root, `${String(events.length).padStart(8, '0')}-${digest.slice(7)}.json`, JSON.stringify(event))
    })
  }
}
