import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoomLifecycleCallables } from '../src/domains/room-lifecycle'
import { createSelectionCallables } from '../src/domains/selection'
import type { Augment, HorseStats } from '../src/types'

type DocData = Record<string, unknown>

function createTimestamp(millis: number): FirebaseFirestore.Timestamp {
  return { toMillis: () => millis } as FirebaseFirestore.Timestamp
}

function millisOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis()
  }
  return 0
}

function isDeleteTransform(value: unknown): boolean {
  return !!value && (value as { constructor?: { name?: string } }).constructor?.name === 'DeleteTransform'
}

function isArrayUnionTransform(value: unknown): value is { elements: unknown[] } {
  return !!value && (value as { constructor?: { name?: string } }).constructor?.name === 'ArrayUnionTransform'
}

function isIncrementTransform(value: unknown): value is { operand: number } {
  return !!value && (value as { constructor?: { name?: string } }).constructor?.name === 'NumericIncrementTransform'
}

function cloneData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneData(entry)) as T
  }
  if (value && typeof value === 'object') {
    if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
      return value
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneData(entry)
    }
    return out as T
  }
  return value
}

function applyPatch(base: DocData, patch: DocData): DocData {
  const next = cloneData(base)
  for (const [key, rawValue] of Object.entries(patch)) {
    if (isDeleteTransform(rawValue)) {
      delete next[key]
      continue
    }
    if (isArrayUnionTransform(rawValue)) {
      const current = Array.isArray(next[key]) ? (next[key] as unknown[]) : []
      const serialized = new Set(current.map((entry) => JSON.stringify(entry)))
      const merged = [...current]
      for (const entry of rawValue.elements) {
        const encoded = JSON.stringify(entry)
        if (serialized.has(encoded)) continue
        serialized.add(encoded)
        merged.push(cloneData(entry))
      }
      next[key] = merged
      continue
    }
    if (isIncrementTransform(rawValue)) {
      const current = typeof next[key] === 'number' ? (next[key] as number) : 0
      next[key] = current + rawValue.operand
      continue
    }
    next[key] = cloneData(rawValue)
  }
  return next
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

class InMemoryFirestore {
  private readonly docs = new Map<string, DocData>()
  private idCounter = 0

  seed(path: string, data: DocData): void {
    this.docs.set(path, cloneData(data))
  }

  read(path: string): DocData | undefined {
    const current = this.docs.get(path)
    return current ? cloneData(current) : undefined
  }

  collection(path: string) {
    return new FakeCollectionRef(this, path)
  }

  runTransaction<T>(operation: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this)
    return operation(tx)
  }

  nextId(): string {
    this.idCounter += 1
    return `doc-${this.idCounter}`
  }

  listCollectionDocs(collectionPath: string): Array<{ path: string; data: DocData }> {
    const targetDepth = splitPath(collectionPath).length + 1
    return [...this.docs.entries()]
      .filter(([path]) => {
        if (!path.startsWith(`${collectionPath}/`)) return false
        return splitPath(path).length === targetDepth
      })
      .map(([path, data]) => ({ path, data: cloneData(data) }))
  }

  setDoc(path: string, data: DocData, options?: { merge?: boolean }): void {
    const current = this.docs.get(path)
    if (options?.merge && current) {
      this.docs.set(path, applyPatch(current, data))
      return
    }
    this.docs.set(path, applyPatch({}, data))
  }

  updateDoc(path: string, patch: DocData): void {
    const current = this.docs.get(path)
    if (!current) {
      throw new Error(`Document does not exist: ${path}`)
    }
    this.docs.set(path, applyPatch(current, patch))
  }

  deleteDoc(path: string): void {
    this.docs.delete(path)
  }

  toFirestore(): FirebaseFirestore.Firestore {
    return this as unknown as FirebaseFirestore.Firestore
  }
}

class FakeCollectionRef {
  constructor(
    private readonly store: InMemoryFirestore,
    readonly path: string,
  ) {}

  doc(id?: string): FakeDocumentRef {
    const resolvedId = id ?? this.store.nextId()
    return new FakeDocumentRef(this.store, `${this.path}/${resolvedId}`)
  }

  get(): Promise<FirebaseFirestore.QuerySnapshot> {
    const docs = this.store.listCollectionDocs(this.path).map(({ path, data }) => {
      const ref = new FakeDocumentRef(this.store, path)
      return new FakeDocumentSnapshot(ref, data)
    })
    return Promise.resolve(new FakeQuerySnapshot(docs) as unknown as FirebaseFirestore.QuerySnapshot)
  }

  orderBy(field: string, direction: 'asc' | 'desc'): FakeQuery {
    return new FakeQuery(this.store, this.path, field, direction)
  }
}

class FakeDocumentRef {
  readonly id: string

  constructor(
    private readonly store: InMemoryFirestore,
    readonly path: string,
  ) {
    const segments = splitPath(path)
    this.id = segments[segments.length - 1] ?? ''
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, `${this.path}/${name}`)
  }

  async get(): Promise<FirebaseFirestore.DocumentSnapshot> {
    const current = this.store.read(this.path)
    return new FakeDocumentSnapshot(this, current) as unknown as FirebaseFirestore.DocumentSnapshot
  }

  async set(data: DocData, options?: { merge?: boolean }): Promise<void> {
    this.store.setDoc(this.path, data, options)
  }

  async update(patch: DocData): Promise<void> {
    this.store.updateDoc(this.path, patch)
  }

  async delete(): Promise<void> {
    this.store.deleteDoc(this.path)
  }
}

class FakeQuery {
  constructor(
    private readonly store: InMemoryFirestore,
    private readonly collectionPath: string,
    private readonly field: string,
    private readonly direction: 'asc' | 'desc',
  ) {}

  async get(): Promise<FirebaseFirestore.QuerySnapshot> {
    const sorted = this.store
      .listCollectionDocs(this.collectionPath)
      .sort((left, right) => {
        const leftValue = millisOf(left.data[this.field])
        const rightValue = millisOf(right.data[this.field])
        return this.direction === 'asc' ? leftValue - rightValue : rightValue - leftValue
      })
      .map(({ path, data }) => new FakeDocumentSnapshot(new FakeDocumentRef(this.store, path), data))
    return new FakeQuerySnapshot(sorted) as unknown as FirebaseFirestore.QuerySnapshot
  }
}

class FakeDocumentSnapshot {
  readonly exists: boolean
  readonly id: string

  constructor(
    readonly ref: FakeDocumentRef,
    private readonly stored: DocData | undefined,
  ) {
    this.exists = stored !== undefined
    this.id = ref.id
  }

  data(): DocData | undefined {
    return this.stored ? cloneData(this.stored) : undefined
  }
}

class FakeQuerySnapshot {
  readonly docs: FakeDocumentSnapshot[]
  readonly size: number

  constructor(docs: FakeDocumentSnapshot[]) {
    this.docs = docs
    this.size = docs.length
  }
}

class FakeTransaction {
  constructor(private readonly store: InMemoryFirestore) {}

  async get(target: FakeDocumentRef | FakeCollectionRef | FakeQuery): Promise<unknown> {
    return target.get()
  }

  set(ref: FakeDocumentRef, data: DocData, options?: { merge?: boolean }): void {
    this.store.setDoc(ref.path, data, options)
  }

  update(ref: FakeDocumentRef, patch: DocData): void {
    this.store.updateDoc(ref.path, patch)
  }

  delete(ref: FakeDocumentRef): void {
    this.store.deleteDoc(ref.path)
  }
}

function createHorseStats(seed: number): HorseStats {
  return {
    Speed: seed,
    Stamina: seed,
    Power: seed,
    Guts: seed,
    Start: seed,
    Luck: seed,
  }
}

function createRoomLifecycleSut(store: InMemoryFirestore) {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  return createRoomLifecycleCallables({
    db: store.toFirestore(),
    logger,
    logInfo: () => {},
    logWarn: () => {},
    guestSessionTtlDays: 14,
    normalizePlayerName: (name) => name.trim(),
    isValidPlayerName: (name) => name.length >= 2 && name.length <= 12,
    createGuestId: () => 'guest-fixed',
    createSessionToken: () => 'session-fixed',
    hashSessionToken: (token) => `hash-${token}`,
    issueRoomJoinToken: async (roomId, playerId, _authUid) => ({
      joinToken: `join-${roomId}-${playerId}`,
      expiresAtMillis: 9_999_999_999_999,
    }),
    verifyGuestSession: async () => {},
    getRoom: async (roomId) => {
      const room = store.read(`rooms/${roomId}`)
      if (!room) throw new Error(`room not found in test setup: ${roomId}`)
      return {
        status: (room.status as 'waiting' | 'horseSelection' | 'augmentSelection' | 'racing') ?? 'waiting',
        currentSet: (room.currentSet as number) ?? 1,
        roundCount: (room.roundCount as number) ?? 1,
      }
    },
    assertJoinedRoomPlayerRequest: async () => {},
    assertHostWaitingRoomActionRequest: async ({ roomId }) => {
      const room = store.read(`rooms/${roomId}`)
      return {
        status: (room?.status as 'waiting' | 'horseSelection' | 'augmentSelection' | 'racing') ?? 'waiting',
        currentSet: (room?.currentSet as number) ?? 1,
        roundCount: (room?.roundCount as number) ?? 1,
      }
    },
  })
}

function createSelectionSut(store: InMemoryFirestore) {
  const logger = {
    info: () => {},
    error: () => {},
  }

  return createSelectionCallables({
    db: store.toFirestore(),
    logger,
    getRoom: async (roomId) => {
      const room = store.read(`rooms/${roomId}`)
      if (!room) throw new Error(`room not found in test setup: ${roomId}`)
      return { status: (room.status as string) ?? 'waiting' }
    },
    updateRoomStatus: async (roomId, status) => {
      store.updateDoc(`rooms/${roomId}`, { status })
    },
    isPlayerInRoom: async (roomId, playerId) => !!store.read(`rooms/${roomId}/players/${playerId}`),
    verifyGuestSession: async () => {},
    verifyRoomJoinToken: async () => {},
    assertAugmentSelectionRequestContext: async ({ roomId }) => {
      const room = store.read(`rooms/${roomId}`)
      return { rerollLimit: (room?.rerollLimit as number) ?? 0 }
    },
    createSeededRandom: () => () => 0.25,
    pickRandomSeeded: <T>(items: T[]) => items[0] as T,
    generateServerAugmentChoices: (rarity, _rng, seedKey): Augment[] => [
      { id: `${seedKey}-0`, name: 'A', rarity, statType: 'Speed', statValue: 1 },
      { id: `${seedKey}-1`, name: 'B', rarity, statType: 'Power', statValue: 2 },
      { id: `${seedKey}-2`, name: 'C', rarity, statType: 'Luck', statValue: 1 },
    ],
    augmentRarities: ['common', 'rare', 'epic', 'legendary'],
    applyAugmentToHorseStats: (horseStats, augment) => {
      if (!horseStats || !augment?.statType || typeof augment.statValue !== 'number') return horseStats
      return { ...horseStats, [augment.statType]: horseStats[augment.statType] + augment.statValue }
    },
    calculateLuckBonus: (luck) => Math.max(0, Math.min(5, Math.floor(luck / 10))),
    applyLuckBonusToHorseStats: (horseStats, luckBonus) => {
      if (!horseStats) return horseStats
      return {
        ...horseStats,
        Speed: horseStats.Speed + luckBonus,
        Stamina: horseStats.Stamina + luckBonus,
        Power: horseStats.Power + luckBonus,
        Guts: horseStats.Guts + luckBonus,
        Start: horseStats.Start + luckBonus,
      }
    },
  })
}

test('joinRoom: waiting room adds new player and issues join token', async () => {
  const store = new InMemoryFirestore()
  store.seed('rooms/room-join', {
    status: 'waiting',
    maxPlayers: 4,
    roundCount: 3,
    currentSet: 1,
  })
  store.seed('rooms/room-join/players/host', {
    name: 'Host',
    isHost: true,
    isReady: false,
    selectedAugments: [],
    joinedAt: createTimestamp(1),
  })

  const sut = createRoomLifecycleSut(store)
  const result = await (sut.joinRoom as { run: (request: unknown) => Promise<unknown> }).run({
    auth: { uid: 'guest-1' },
    data: {
      roomId: 'room-join',
      playerId: 'guest-1',
      sessionToken: 'session',
      playerName: '  PlayerOne  ',
    },
  })

  assert.deepEqual(result, {
    success: true,
    playerId: 'guest-1',
    joinToken: 'join-room-join-guest-1',
    joinTokenExpiresAtMillis: 9_999_999_999_999,
    rejoined: false,
  })
  const savedPlayer = store.read('rooms/room-join/players/guest-1')
  assert.equal(savedPlayer?.name, 'PlayerOne')
  assert.equal(savedPlayer?.isHost, false)
})

test('startGame: resets players, removes prior sets, and transitions room status', async () => {
  const store = new InMemoryFirestore()
  store.seed('rooms/room-start', {
    status: 'waiting',
    currentSet: 2,
    roundCount: 3,
    rerollUsed: 10,
  })
  store.seed('rooms/room-start/players/host', {
    name: 'Host',
    isHost: true,
    isReady: false,
    selectedAugments: [{ setIndex: 1, augmentId: 'old' }],
    horseStats: createHorseStats(12),
    currentSetLuckBonus: 3,
    rerollUsed: 2,
    joinedAt: createTimestamp(1),
  })
  store.seed('rooms/room-start/players/guest', {
    name: 'Guest',
    isHost: false,
    isReady: true,
    selectedAugments: [{ setIndex: 1, augmentId: 'old2' }],
    horseStats: createHorseStats(10),
    currentSetLuckBonus: 2,
    rerollUsed: 1,
    joinedAt: createTimestamp(2),
  })
  store.seed('rooms/room-start/sets/set-1', { setIndex: 1, selections: { host: 'a' } })
  store.seed('rooms/room-start/sets/set-2', { setIndex: 2, selections: { guest: 'b' } })

  const sut = createRoomLifecycleSut(store)
  const result = await (sut.startGame as { run: (request: unknown) => Promise<unknown> }).run({
    auth: { uid: 'host' },
    data: {
      roomId: 'room-start',
      playerId: 'host',
      sessionToken: 'session',
      joinToken: 'join-token',
    },
  })

  assert.deepEqual(result, { success: true, status: 'horseSelection' })
  const room = store.read('rooms/room-start')
  assert.equal(room?.status, 'horseSelection')
  assert.equal(room?.currentSet, 1)
  assert.equal(room?.rerollUsed, 0)

  const host = store.read('rooms/room-start/players/host')
  const guest = store.read('rooms/room-start/players/guest')
  assert.deepEqual(host?.selectedAugments, [])
  assert.deepEqual(guest?.selectedAugments, [])
  assert.equal(host?.horseStats, undefined)
  assert.equal(guest?.horseStats, undefined)
  assert.equal(host?.currentSetLuckBonus, 0)
  assert.equal(guest?.currentSetLuckBonus, 0)
  assert.equal(store.read('rooms/room-start/sets/set-1'), undefined)
  assert.equal(store.read('rooms/room-start/sets/set-2'), undefined)
})

test('selectAugment: final selection applies stats and moves room to racing', async () => {
  const store = new InMemoryFirestore()
  store.seed('rooms/room-select', {
    status: 'augmentSelection',
    currentSet: 1,
    rerollLimit: 2,
  })
  store.seed('rooms/room-select/players/p1', {
    name: 'P1',
    isHost: true,
    isReady: true,
    selectedAugments: [],
    horseStats: createHorseStats(20),
    joinedAt: createTimestamp(1),
  })
  store.seed('rooms/room-select/players/p2', {
    name: 'P2',
    isHost: false,
    isReady: true,
    selectedAugments: [],
    horseStats: createHorseStats(10),
    joinedAt: createTimestamp(2),
  })
  store.seed('rooms/room-select/sets/set-1', {
    setIndex: 1,
    rarity: 'common',
    selections: { p2: 'p2-aug-speed' },
    availableAugmentsByPlayer: {
      p1: [
        { id: 'p1-aug-speed', name: 'spd', rarity: 'common', statType: 'Speed', statValue: 3 },
        { id: 'p1-aug-luck', name: 'luck', rarity: 'common', statType: 'Luck', statValue: 2 },
      ],
      p2: [
        { id: 'p2-aug-speed', name: 'spd2', rarity: 'common', statType: 'Speed', statValue: 1 },
      ],
    },
  })

  const sut = createSelectionSut(store)
  const result = await (sut.selectAugment as { run: (request: unknown) => Promise<unknown> }).run({
    auth: { uid: 'p1' },
    data: {
      roomId: 'room-select',
      playerId: 'p1',
      sessionToken: 'session',
      joinToken: 'join',
      setIndex: 1,
      augmentId: 'p1-aug-speed',
    },
  })

  assert.deepEqual(result, {
    success: true,
    allPlayersSelected: true,
    nextStatus: 'racing',
  })
  const room = store.read('rooms/room-select')
  assert.equal(room?.status, 'racing')

  const p1 = store.read('rooms/room-select/players/p1')
  const p2 = store.read('rooms/room-select/players/p2')
  assert.deepEqual(p1?.selectedAugments, [{ setIndex: 1, augmentId: 'p1-aug-speed' }])
  assert.equal((p1?.horseStats as HorseStats).Speed, 25)
  assert.equal((p2?.horseStats as HorseStats).Speed, 12)
  assert.equal(p1?.currentSetLuckBonus, 2)
  assert.equal(p2?.currentSetLuckBonus, 1)
})

test('rerollAugments: increments counters and refreshes player choices', async () => {
  const store = new InMemoryFirestore()
  store.seed('rooms/room-reroll', {
    status: 'augmentSelection',
    currentSet: 1,
    rerollLimit: 2,
    rerollUsed: 0,
  })
  store.seed('rooms/room-reroll/players/p1', {
    name: 'P1',
    isHost: true,
    isReady: true,
    selectedAugments: [],
    rerollUsed: 0,
    horseStats: createHorseStats(10),
    joinedAt: createTimestamp(1),
  })
  store.seed('rooms/room-reroll/sets/set-1', {
    setIndex: 1,
    rarity: 'common',
    selections: {},
    availableAugmentsByPlayer: {
      p1: [{ id: 'old-augment', name: 'old', rarity: 'common', statType: 'Speed', statValue: 1 }],
    },
  })

  const sut = createSelectionSut(store)
  const result = await (sut.rerollAugments as { run: (request: unknown) => Promise<unknown> }).run({
    auth: { uid: 'p1' },
    data: {
      roomId: 'room-reroll',
      playerId: 'p1',
      sessionToken: 'session',
      joinToken: 'join',
      setIndex: 1,
    },
  })

  assert.equal((result as { success: boolean }).success, true)
  assert.equal((result as { rerollUsed: number }).rerollUsed, 1)
  assert.equal((result as { remainingRerolls: number }).remainingRerolls, 1)

  const player = store.read('rooms/room-reroll/players/p1')
  const room = store.read('rooms/room-reroll')
  const setDoc = store.read('rooms/room-reroll/sets/set-1')
  assert.equal(player?.rerollUsed, 1)
  assert.equal(room?.rerollUsed, 1)
  assert.equal(
    ((setDoc?.availableAugmentsByPlayer as Record<string, Augment[]>).p1[0]?.id ?? '').startsWith(
      'augment|room:room-reroll|set:1|player:p1|reroll:1',
    ),
    true,
  )
})

test('leaveRoom: host leave transfers host and removes participant auth', async () => {
  const store = new InMemoryFirestore()
  store.seed('rooms/room-leave', {
    status: 'waiting',
    hostId: 'host',
    currentSet: 1,
    roundCount: 3,
  })
  store.seed('rooms/room-leave/players/host', {
    name: 'Host',
    isHost: true,
    authUid: 'host',
    isReady: false,
    selectedAugments: [],
    joinedAt: createTimestamp(1),
  })
  store.seed('rooms/room-leave/players/member', {
    name: 'Member',
    isHost: false,
    authUid: 'member',
    isReady: true,
    selectedAugments: [],
    joinedAt: createTimestamp(2),
  })
  store.seed('rooms/room-leave/participantAuth/host', {
    tokenHash: 'hash-host',
    status: 'active',
    expiresAt: createTimestamp(100),
  })
  store.seed('rooms/room-leave/participantAuth/member', {
    tokenHash: 'hash-member',
    status: 'active',
    expiresAt: createTimestamp(100),
  })

  const sut = createRoomLifecycleSut(store)
  const result = await (sut.leaveRoom as { run: (request: unknown) => Promise<unknown> }).run({
    auth: { uid: 'host' },
    data: {
      roomId: 'room-leave',
      playerId: 'host',
      sessionToken: 'session',
      joinToken: 'join',
    },
  })

  assert.deepEqual(result, { success: true })
  const room = store.read('rooms/room-leave')
  const hostAfter = store.read('rooms/room-leave/players/host')
  const memberAfter = store.read('rooms/room-leave/players/member')
  const hostAuthAfter = store.read('rooms/room-leave/participantAuth/host')
  assert.equal(hostAfter, undefined)
  assert.equal(hostAuthAfter, undefined)
  assert.equal(room?.hostId, 'member')
  assert.equal(memberAfter?.isHost, true)
})
