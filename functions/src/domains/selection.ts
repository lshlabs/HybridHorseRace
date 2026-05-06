import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import type { Augment, AugmentRarity, Player } from '../types'
import { CALLABLE_OPTIONS } from '../common/cors-options'

type LoggerLike = {
  info: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
}

type SelectionDeps = {
  db: FirebaseFirestore.Firestore
  logger: LoggerLike
  getRoom: (roomId: string) => Promise<{ status: string }>
  updateRoomStatus: (roomId: string, status: 'horseSelection' | 'augmentSelection' | 'racing') => Promise<void>
  isPlayerInRoom: (roomId: string, playerId: string) => Promise<boolean>
  verifyGuestSession: (playerId: string, sessionToken: string) => Promise<void>
  verifyRoomJoinToken: (
    roomId: string,
    playerId: string,
    joinToken: string,
    authUid?: string,
  ) => Promise<void>
  assertAugmentSelectionRequestContext: (params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
    setIndex: number
    statusMessage: string
  }) => Promise<{ rerollLimit: number }>
  createSeededRandom: (seed: string) => () => number
  pickRandomSeeded: <T>(items: T[], rng: () => number) => T
  generateServerAugmentChoices: (
    rarity: Exclude<AugmentRarity, 'hidden'>,
    rng: () => number,
    seedKey: string,
  ) => Augment[]
  augmentRarities: Array<Exclude<AugmentRarity, 'hidden'>>
  applyAugmentToHorseStats: (horseStats: Player['horseStats'], augment?: Augment) => Player['horseStats']
  calculateLuckBonus: (luck: number) => number
  applyLuckBonusToHorseStats: (
    horseStats: Player['horseStats'],
    luckBonus: number,
  ) => Player['horseStats']
}

const authenticatedPlayerRequestSchema = {
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
}

const selectHorseSchema = z.object({
  ...authenticatedPlayerRequestSchema,
  horseStats: z.object({
    Speed: z.number().min(0),
    Stamina: z.number().min(0),
    Power: z.number().min(0),
    Guts: z.number().min(0),
    Start: z.number().min(0),
    Luck: z.number().min(0),
  }),
})

const selectAugmentSchema = z.object({
  ...authenticatedPlayerRequestSchema,
  setIndex: z.number().int().min(1),
  augmentId: z.string().min(1, 'augmentId is required'),
})

const getAugmentSelectionSchema = z.object({
  ...authenticatedPlayerRequestSchema,
  setIndex: z.number().int().min(1),
})

const rerollAugmentsSchema = z.object({
  ...authenticatedPlayerRequestSchema,
  setIndex: z.number().int().min(1),
})
const STATUS_HORSE_SELECTION = 'horseSelection' as const
const STATUS_AUGMENT_SELECTION = 'augmentSelection' as const
const STATUS_RACING = 'racing' as const

export function createSelectionCallables(deps: SelectionDeps) {
  function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    const parsed = schema.safeParse(data)
    if (parsed.success) {
      return parsed.data
    }
    throw new HttpsError('invalid-argument', 'Invalid arguments', {
      errors: parsed.error.flatten().fieldErrors,
    })
  }

  function rethrowUnexpected(error: unknown, publicMessage: string): never {
    if (error instanceof HttpsError) {
      throw error
    }
    throw new HttpsError('internal', publicMessage)
  }

  function requireAuthUid(request: { auth?: { uid?: string } | null }): string {
    const authUid = request.auth?.uid
    if (!authUid) {
      throw new HttpsError('unauthenticated', 'Authentication required')
    }
    return authUid
  }

  const selectHorse = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, horseStats } = parseOrThrow(
          selectHorseSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.verifyGuestSession(playerId, sessionToken)
        await deps.verifyRoomJoinToken(roomId, playerId, joinToken, authUid)

        const room = await deps.getRoom(roomId)
        if (room.status !== STATUS_HORSE_SELECTION) {
          throw new HttpsError(
            'failed-precondition',
            'Horse can only be selected during horseSelection phase',
          )
        }

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const playerRef = deps.db.collection('rooms').doc(roomId).collection('players').doc(playerId)
        const selectionResult = await deps.db.runTransaction(async (tx) => {
          const now = Timestamp.now()
          const [roomDoc, playerDoc, playersSnapshot] = await Promise.all([
            tx.get(roomRef),
            tx.get(playerRef),
            tx.get(roomRef.collection('players')),
          ])

          if (!roomDoc.exists) {
            throw new HttpsError('not-found', `Room ${roomId} not found`)
          }
          const roomData = roomDoc.data() as { status?: string } | undefined
          if (roomData?.status !== STATUS_HORSE_SELECTION) {
            throw new HttpsError(
              'failed-precondition',
              'Horse can only be selected during horseSelection phase',
            )
          }

          if (!playerDoc.exists) {
            throw new HttpsError('not-found', 'Player not found in room')
          }

          const player = playerDoc.data() as Player
          if (player.horseStats) {
            throw new HttpsError('failed-precondition', 'Horse has already been selected for this player')
          }

          tx.update(playerRef, {
            horseStats,
            currentSetLuckBonus: 0,
            updatedAt: now,
          })

          const allSelected = playersSnapshot.docs.every((doc) => {
            if (doc.id === playerId) return true
            return (doc.data() as Player).horseStats !== undefined
          })

          if (allSelected) {
            tx.update(roomRef, {
              status: STATUS_AUGMENT_SELECTION,
              updatedAt: now,
            })
          }

          return { allSelected, playerCount: playersSnapshot.size }
        })

        if (selectionResult.allSelected) {
          deps.logger.info('All players selected horse, moving to augment selection', {
            roomId,
            playerCount: selectionResult.playerCount,
          })
        }

        deps.logger.info('Horse selected', { roomId, playerId, horseStats })
        return {
          success: true,
          allPlayersSelected: selectionResult.allSelected,
          nextStatus: selectionResult.allSelected ? STATUS_AUGMENT_SELECTION : STATUS_HORSE_SELECTION,
        }
      } catch (error) {
        deps.logger.error('selectHorse error', error)
        rethrowUnexpected(error, 'Failed to select horse')
      }
    },
  )

  const getAugmentSelection = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex } = parseOrThrow(
          getAugmentSelectionSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertAugmentSelectionRequestContext({
          roomId,
          playerId,
          sessionToken,
          joinToken,
          authUid,
          setIndex,
          statusMessage: 'Augment can only be requested during augmentSelection phase',
        })

        const playersSnapshot = await deps.db.collection('rooms').doc(roomId).collection('players').get()
        const playerIds = playersSnapshot.docs.map((doc) => doc.id).sort()
        const setDocRef = deps.db.collection('rooms').doc(roomId).collection('sets').doc(`set-${setIndex}`)

        const setDoc = await deps.db.runTransaction(async (tx) => {
          const current = await tx.get(setDocRef)
          if (current.exists) {
            const data = current.data() as {
              rarity?: Exclude<AugmentRarity, 'hidden'>
              availableAugmentsByPlayer?: Record<string, Augment[]>
              selections?: Record<string, string>
            }
            if (data.rarity && data.availableAugmentsByPlayer?.[playerId]) return data
          }

          // 같은 방/세트에서는 모든 플레이어가 같은 등급 풀을 보도록 등급 seed를 세트 단위로 고정한다.
          const raritySeedKey = `augment-rarity|room:${roomId}|set:${setIndex}`
          const rarityRng = deps.createSeededRandom(raritySeedKey)
          const rarity = deps.pickRandomSeeded(deps.augmentRarities, rarityRng)
          const availableAugmentsByPlayer: Record<string, Augment[]> = {}

          playerIds.forEach((id) => {
            const seedKey = `augment|room:${roomId}|set:${setIndex}|player:${id}|reroll:0`
            const rng = deps.createSeededRandom(seedKey)
            availableAugmentsByPlayer[id] = deps.generateServerAugmentChoices(rarity, rng, seedKey)
          })

          const nextDoc = {
            setIndex,
            rarity,
            availableAugmentsByPlayer,
            selections: {},
            status: STATUS_AUGMENT_SELECTION,
            updatedAt: Timestamp.now(),
          }
          tx.set(setDocRef, nextDoc, { merge: true })
          return nextDoc
        })

        const availableAugments = setDoc.availableAugmentsByPlayer?.[playerId] ?? []
        const selections = setDoc.selections ?? {}
        const selectedCount = Object.keys(selections).length

        return {
          success: true,
          rarity: setDoc.rarity ?? 'common',
          availableAugments,
          selectedCount,
          totalPlayers: playerIds.length,
        }
      } catch (error) {
        deps.logger.error('getAugmentSelection error', error)
        rethrowUnexpected(error, 'Failed to get augment selection')
      }
    },
  )

  const selectAugment = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex, augmentId } = parseOrThrow(
          selectAugmentSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertAugmentSelectionRequestContext({
          roomId,
          playerId,
          sessionToken,
          joinToken,
          authUid,
          setIndex,
          statusMessage: 'Augment can only be selected during augmentSelection phase',
        })

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const playerRef = roomRef.collection('players').doc(playerId)
        const setDocRef = roomRef.collection('sets').doc(`set-${setIndex}`)

        const transactionResult = await deps.db.runTransaction(async (tx) => {
          const now = Timestamp.now()
          const [playerDoc, setDoc, playersSnapshot] = await Promise.all([
            tx.get(playerRef),
            tx.get(setDocRef),
            tx.get(roomRef.collection('players')),
          ])

          if (!playerDoc.exists) {
            throw new HttpsError('not-found', 'Player not found in room')
          }

          const setData = setDoc.data() as
            | { availableAugmentsByPlayer?: Record<string, Augment[]>; selections?: Record<string, string> }
            | undefined
          const existingSelections = setData?.selections ?? {}
          if (existingSelections[playerId]) {
            throw new HttpsError('failed-precondition', 'Augment already selected for this set')
          }

          const availableChoices = setData?.availableAugmentsByPlayer?.[playerId] ?? []
          const selectedAugment = availableChoices.find((augment) => augment.id === augmentId)
          if (!selectedAugment) {
            throw new HttpsError('failed-precondition', 'Selected augment is not available for player')
          }

          const nextSelections = { ...existingSelections, [playerId]: augmentId }
          tx.update(playerRef, {
            selectedAugments: FieldValue.arrayUnion({ setIndex, augmentId }),
            updatedAt: now,
          })
          tx.set(
            setDocRef,
            { setIndex, selections: nextSelections, updatedAt: now },
            { merge: true },
          )

          const allSelected =
            playersSnapshot.size > 0 &&
            Object.keys(nextSelections).length >= playersSnapshot.size &&
            playersSnapshot.docs.every((doc) => !!nextSelections[doc.id])

          if (allSelected) {
            const availableAugmentsByPlayer = setData?.availableAugmentsByPlayer ?? {}
            playersSnapshot.docs.forEach((doc) => {
              const playerData = doc.data() as Player
              const selectedId = nextSelections[doc.id]
              const augment = availableAugmentsByPlayer[doc.id]?.find((entry) => entry.id === selectedId)
              const persistentStats = deps.applyAugmentToHorseStats(playerData.horseStats, augment)
              if (!persistentStats) return

              // Luck 보너스는 이번 세트에만 쓰는 임시값이라, 나중에 되돌릴 수 있게 따로 기록한다.
              const luckBonus = deps.calculateLuckBonus(persistentStats.Luck)
              const nextHorseStats = deps.applyLuckBonusToHorseStats(persistentStats, luckBonus)
              tx.update(doc.ref, {
                horseStats: nextHorseStats,
                currentSetLuckBonus: luckBonus,
                updatedAt: now,
              })
            })

            tx.update(roomRef, { status: STATUS_RACING, updatedAt: now })
          }

          return { allSelected }
        })

        deps.logger.info('Augment selected', {
          roomId,
          playerId,
          setIndex,
          augmentId,
          allSelected: transactionResult.allSelected,
        })
        return { success: true }
      } catch (error) {
        deps.logger.error('selectAugment error', error)
        rethrowUnexpected(error, 'Failed to select augment')
      }
    },
  )

  const rerollAugments = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex } = parseOrThrow(
          rerollAugmentsSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertAugmentSelectionRequestContext({
          roomId,
          playerId,
          sessionToken,
          joinToken,
          authUid,
          setIndex,
          statusMessage: 'Augments can only be rerolled during augmentSelection phase',
        })

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const playerRef = roomRef.collection('players').doc(playerId)
        const setDocRef = roomRef.collection('sets').doc(`set-${setIndex}`)

        const transactionResult = await deps.db.runTransaction(async (tx) => {
          const now = Timestamp.now()
          const [roomDoc, playerDoc, setDoc] = await Promise.all([
            tx.get(roomRef),
            tx.get(playerRef),
            tx.get(setDocRef),
          ])

          if (!roomDoc.exists) {
            throw new HttpsError('not-found', `Room ${roomId} not found`)
          }

          const roomData = roomDoc.data() as {
            status?: string
            currentSet?: number
            rerollLimit?: number
            rerollUsed?: number
          }
          if (roomData.status !== STATUS_AUGMENT_SELECTION || roomData.currentSet !== setIndex) {
            throw new HttpsError(
              'failed-precondition',
              'Augments can only be rerolled during augmentSelection phase',
            )
          }

          const playerData = playerDoc.data() as (Player & { rerollUsed?: number }) | undefined
          if (!playerData) {
            throw new HttpsError('not-found', 'Player not found in room')
          }

          const setData = setDoc.data() as
            | {
                rarity?: Exclude<AugmentRarity, 'hidden'>
                availableAugmentsByPlayer?: Record<string, Augment[]>
                selections?: Record<string, string>
              }
            | undefined
          const selections = setData?.selections ?? {}
          if (selections[playerId]) {
            throw new HttpsError('failed-precondition', 'Cannot reroll after augment is already selected')
          }

          const rerollLimit = typeof roomData.rerollLimit === 'number' ? roomData.rerollLimit : 0
          const rerollUsed = playerData.rerollUsed ?? 0
          if (rerollUsed >= rerollLimit) {
            throw new HttpsError('resource-exhausted', 'No rerolls remaining for this player')
          }

          const rerollIndex = rerollUsed + 1
          // 리롤마다 seed에 번호를 넣어 같은 요청 재시도와 새 리롤 결과가 섞이지 않게 한다.
          const seedKey = `augment|room:${roomId}|set:${setIndex}|player:${playerId}|reroll:${rerollIndex}`
          const rng = deps.createSeededRandom(seedKey)
          const rarity = setData?.rarity ?? deps.pickRandomSeeded(deps.augmentRarities, rng)
          const newAugments = deps.generateServerAugmentChoices(rarity, rng, seedKey)
          const availableAugmentsByPlayer = {
            ...(setData?.availableAugmentsByPlayer ?? {}),
            [playerId]: newAugments,
          }

          tx.update(playerRef, { rerollUsed: rerollIndex, updatedAt: now })
          tx.set(
            setDocRef,
            {
              setIndex,
              rarity,
              availableAugmentsByPlayer,
              deterministicMeta: { source: 'seeded-rng-v1', seedKey, rarity, rerollIndex },
              updatedAt: now,
            },
            { merge: true },
          )
          tx.update(roomRef, {
            rerollUsed: (typeof roomData.rerollUsed === 'number' ? roomData.rerollUsed : 0) + 1,
            updatedAt: now,
          })

          return { newAugments, rerollUsed: rerollIndex, rerollLimit, seedKey }
        })

        deps.logger.info('Augments rerolled', {
          roomId,
          playerId,
          setIndex,
          rerollUsed: transactionResult.rerollUsed,
          seedKey: transactionResult.seedKey,
        })

        return {
          success: true,
          newAugments: transactionResult.newAugments,
          rerollUsed: transactionResult.rerollUsed,
          remainingRerolls: Math.max(
            0,
            transactionResult.rerollLimit - transactionResult.rerollUsed,
          ),
        }
      } catch (error) {
        deps.logger.error('rerollAugments error', error)
        rethrowUnexpected(error, 'Failed to reroll augments')
      }
    },
  )

  return { selectHorse, getAugmentSelection, selectAugment, rerollAugments }
}
