import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import { buildRaceScript, rollConditionFromSeed } from '../../../shared/race-core'
import type { Augment, Player, Room, RoomStatus } from '../types'
import { CALLABLE_OPTIONS } from '../common/cors-options'
import type { GetSetResultSetSummary } from '../common/response-builders'

type LoggerLike = {
  info: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
}

type RaceWriteDeps = {
  db: FirebaseFirestore.Firestore
  logger: LoggerLike
  getRoom: (roomId: string) => Promise<Room>
  updateRoomStatus: (roomId: string, status: RoomStatus) => Promise<void>
  assertJoinedRoomHostRequest: (params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
    hostErrorMessage?: string
  }) => Promise<void>
  assertJoinedRoomPlayerRequest: (params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
  }) => Promise<void>
  assertExactRoomPhaseAndSetIndex: (params: {
    roomId: string
    playerId: string
    action: string
    roomStatus: string
    expectedStatus: string
    statusMessage: string
    requestedSetIndex: number
    currentSetIndex: number
  }) => void
  getSortedSetSummaries: (
    snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>,
  ) => GetSetResultSetSummary[]
  removeLuckBonusFromHorseStats: (
    horseStats: Player['horseStats'],
    luckBonus: number,
  ) => Player['horseStats']
  createSeededRandom: (seed: string) => () => number
  serverRaceTrackLengthM: number
  serverRaceSimStepMs: number
  serverRaceOutputFrameMs: number
  serverRaceScriptVersion: string
  serverRaceStateDocVersion: string
}

const authenticatedSetRequestSchema = {
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
  setIndex: z.number().int().min(1),
}

const startRaceSchema = z.object(authenticatedSetRequestSchema)
const prepareRaceSchema = startRaceSchema

const readyNextSetSchema = z.object(authenticatedSetRequestSchema)
const STATUS_RACING: RoomStatus = 'racing'
const STATUS_SET_RESULT: RoomStatus = 'setResult'
const STATUS_AUGMENT_SELECTION: RoomStatus = 'augmentSelection'
const STATUS_FINISHED: RoomStatus = 'finished'
const RACE_STATE_PAYLOAD_DOC_ID = 'payload'
const RACE_STATE_PAYLOAD_FORMAT_CHUNKED_V2 = 'chunked-v2'
const RACE_STATE_KEYFRAME_CHUNK_SIZE = 32
const RACE_STATE_EVENT_BUCKET_MS = 1000

export function createRaceWriteCallables(deps: RaceWriteDeps) {
  function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    const parsed = schema.safeParse(data)
    if (parsed.success) {
      return parsed.data
    }
    throw new HttpsError('invalid-argument', 'Invalid arguments', {
      errors: parsed.error.flatten().fieldErrors,
    })
  }

  function rethrowUnexpected(error: unknown, message: string): never {
    if (error instanceof HttpsError) {
      throw error
    }
    throw new HttpsError('internal', message)
  }

  function requireAuthUid(request: { auth?: { uid?: string } | null }): string {
    const authUid = request.auth?.uid
    if (!authUid) {
      throw new HttpsError('unauthenticated', 'Authentication required')
    }
    return authUid
  }

  function buildPreparedRaceAck(alreadyPrepared: boolean, keyframeCount?: number) {
    return {
      success: true,
      prepared: true,
      alreadyPrepared,
      scriptVersion: deps.serverRaceScriptVersion,
      simStepMs: deps.serverRaceSimStepMs,
      outputFrameMs: deps.serverRaceOutputFrameMs,
      tickIntervalMs: deps.serverRaceOutputFrameMs,
      raceStateDocVersion: deps.serverRaceStateDocVersion,
      ...(typeof keyframeCount === 'number' ? { keyframeCount } : {}),
    }
  }

  function chunkKeyframes(keyframes: ReturnType<typeof buildRaceScript>['keyframes']) {
    // 조회 시 필요한 구간만 읽을 수 있도록 고정 크기 chunk로 분할 저장한다.
    const chunks: Array<{
      chunkIndex: number
      startIndex: number
      keyframes: ReturnType<typeof buildRaceScript>['keyframes']
    }> = []
    for (let start = 0; start < keyframes.length; start += RACE_STATE_KEYFRAME_CHUNK_SIZE) {
      const chunkIndex = Math.floor(start / RACE_STATE_KEYFRAME_CHUNK_SIZE)
      chunks.push({
        chunkIndex,
        startIndex: start,
        keyframes: keyframes.slice(start, start + RACE_STATE_KEYFRAME_CHUNK_SIZE),
      })
    }
    return chunks
  }

  function bucketEventsByElapsed(events: ReturnType<typeof buildRaceScript>['events']) {
    // 이벤트는 시간 버킷 단위로 저장해 이벤트 윈도우 조회 fan-out을 낮춘다.
    const bucketMap = new Map<number, typeof events>()
    events.forEach((event) => {
      const bucketStartElapsedMs =
        Math.floor(event.elapsedMs / RACE_STATE_EVENT_BUCKET_MS) * RACE_STATE_EVENT_BUCKET_MS
      const existing = bucketMap.get(bucketStartElapsedMs) ?? []
      existing.push(event)
      bucketMap.set(bucketStartElapsedMs, existing)
    })
    return Array.from(bucketMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketStartElapsedMs, bucketEvents]) => ({
        bucketStartElapsedMs,
        bucketEndElapsedMs: bucketStartElapsedMs + RACE_STATE_EVENT_BUCKET_MS,
        eventBucketMs: RACE_STATE_EVENT_BUCKET_MS,
        events: bucketEvents,
      }))
  }

  async function buildPreparedRaceForSet(params: {
    roomId: string
    setIndex: number
  }) {
    const { roomId, setIndex } = params
    const roomRef = deps.db.collection('rooms').doc(roomId)
    const playersSnapshot = await roomRef.collection('players').select('horseStats').get()
    if (playersSnapshot.size < 2) {
      throw new HttpsError('failed-precondition', 'At least 2 players are required for race')
    }

    const raceSeedKey = `race|room:${roomId}|set:${setIndex}`
    const allSetSnapshot = await roomRef
      .collection('sets')
      .where('setIndex', '<=', setIndex)
      .select('setIndex', 'selections', 'availableAugmentsByPlayer')
      .get()
    const allSets = deps.getSortedSetSummaries(allSetSnapshot)

    const raceInputs = playersSnapshot.docs.map((doc) => {
      const player = doc.data() as Player
      const playerIdForInput = doc.id
      const baseStats = player.horseStats ?? {
        Speed: 10,
        Stamina: 10,
        Power: 10,
        Guts: 10,
        Start: 10,
        Luck: 10,
      }

      const abilityAugments: Augment[] = []
      allSets.forEach((setEntry) => {
        const augmentId = setEntry.selections?.[playerIdForInput]
        if (!augmentId) return

        const augment = setEntry.availableAugmentsByPlayer?.[playerIdForInput]?.find(
          (item) => item.id === augmentId,
        )
        if (augment?.specialAbility) {
          abilityAugments.push(augment)
        }
      })

      const conditionSeed = `condition|${raceSeedKey}|player:${playerIdForInput}`
      const conditionRoll = rollConditionFromSeed(baseStats.Luck, deps.createSeededRandom(conditionSeed))

      return {
        playerId: playerIdForInput,
        stats: baseStats,
        augments: abilityAugments,
        conditionRoll,
      }
    })

    const replayScript = buildRaceScript(raceInputs, {
      trackLengthM: deps.serverRaceTrackLengthM,
      simStepMs: deps.serverRaceSimStepMs,
      outputFrameMs: deps.serverRaceOutputFrameMs,
    })

    const rankingsPayload = replayScript.rankings
    const now = Timestamp.now()
    const raceResult = {
      rankings: rankingsPayload,
      startedAt: now,
      finishedAt: now,
      deterministicMeta: {
        source: 'seeded-rng-v1',
        seedKey: raceSeedKey,
      },
    }
    const raceState = {
      status: 'prepared' as const,
      scriptVersion: deps.serverRaceScriptVersion,
      raceStateDocVersion: deps.serverRaceStateDocVersion,
      simStepMs: replayScript.simStepMs,
      outputFrameMs: replayScript.outputFrameMs,
      tickIntervalMs: replayScript.outputFrameMs,
      trackLengthM: deps.serverRaceTrackLengthM,
      keyframes: replayScript.keyframes,
      events: replayScript.events,
      slowmoTriggerMs: replayScript.slowmoTriggerMs,
      seedBundle: {
        raceSeedKey,
        conditionRollByPlayer: replayScript.conditionRollByPlayer,
      },
      inputsSnapshotHash: replayScript.snapshotHash,
      deterministicMeta: {
        source: 'horse-core-v1',
        seedKey: raceSeedKey,
        engineVersion: deps.serverRaceScriptVersion,
        configHash: `${deps.serverRaceTrackLengthM}-${replayScript.simStepMs}-${replayScript.outputFrameMs}`,
      },
      updatedAt: now,
    }

    return {
      roomRef,
      raceSeedKey,
      rankingsPayload,
      replayScript,
      raceResult,
      raceState,
      now,
    }
  }

  const prepareRace = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex } = parseOrThrow(
          prepareRaceSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const room = await deps.getRoom(roomId)
        await deps.assertJoinedRoomHostRequest({
          roomId,
          playerId,
          sessionToken,
          joinToken,
          authUid,
          hostErrorMessage: 'Only host can prepare race',
        })

        deps.assertExactRoomPhaseAndSetIndex({
          roomId,
          playerId,
          action: 'prepareRace',
          roomStatus: room.status,
          expectedStatus: STATUS_RACING,
          statusMessage: 'Race can only be prepared during racing phase',
          requestedSetIndex: setIndex,
          currentSetIndex: room.currentSet,
        })

        const setDocRef = deps.db.collection('rooms').doc(roomId).collection('sets').doc(`set-${setIndex}`)
        const existingSetDoc = await setDocRef.get()
        const existingRaceState = (existingSetDoc.data() as { raceState?: { status?: string } } | undefined)
          ?.raceState
        if (existingRaceState?.status === 'prepared') {
          deps.logger.info('prepareRace already prepared', { roomId, setIndex, playerId })
          return buildPreparedRaceAck(true)
        }
        if (existingRaceState?.status === 'running' || existingRaceState?.status === 'completed') {
          deps.logger.info('prepareRace reused existing running/completed state', {
            roomId,
            setIndex,
            playerId,
            status: existingRaceState.status,
          })
          return buildPreparedRaceAck(true)
        }

        const prepared = await buildPreparedRaceForSet({ roomId, setIndex })
        // 레이스 재생 데이터가 커져도 callable 응답/문서 크기에 걸리지 않게 payload를 잘라 저장한다.
        const keyframeChunks = chunkKeyframes(prepared.replayScript.keyframes)
        const eventBuckets = bucketEventsByElapsed(prepared.replayScript.events)
        const raceStateMetadata = {
          status: prepared.raceState.status,
          scriptVersion: prepared.raceState.scriptVersion,
          raceStateDocVersion: prepared.raceState.raceStateDocVersion,
          payloadFormat: RACE_STATE_PAYLOAD_FORMAT_CHUNKED_V2,
          simStepMs: prepared.raceState.simStepMs,
          outputFrameMs: prepared.raceState.outputFrameMs,
          tickIntervalMs: prepared.raceState.tickIntervalMs,
          trackLengthM: prepared.raceState.trackLengthM,
          slowmoTriggerMs: prepared.raceState.slowmoTriggerMs,
          seedBundle: prepared.raceState.seedBundle,
          inputsSnapshotHash: prepared.raceState.inputsSnapshotHash,
          deterministicMeta: prepared.raceState.deterministicMeta,
          updatedAt: prepared.raceState.updatedAt,
          payloadDocId: RACE_STATE_PAYLOAD_DOC_ID,
          keyframeChunkSize: RACE_STATE_KEYFRAME_CHUNK_SIZE,
          eventBucketMs: RACE_STATE_EVENT_BUCKET_MS,
          keyframeCount: prepared.replayScript.keyframes.length,
          keyframeChunkCount: Math.ceil(
            prepared.replayScript.keyframes.length / RACE_STATE_KEYFRAME_CHUNK_SIZE,
          ),
          eventCount: prepared.replayScript.events.length,
          eventChunkCount: eventBuckets.length,
        }

        // 분리 payload와 메타 문서를 병렬 저장해 prepareRace 지연을 최소화한다.
        const writeTasks: Array<Promise<unknown>> = [
          ...keyframeChunks.map((chunk) =>
            setDocRef.collection('raceStatePayloadKeyframes').doc(`chunk-${chunk.chunkIndex}`).set({
              ...chunk,
              updatedAt: prepared.now,
            }),
          ),
          ...eventBuckets.map((bucket) =>
            setDocRef
              .collection('raceStatePayloadEvents')
              .doc(`bucket-${bucket.bucketStartElapsedMs}`)
              .set({
                ...bucket,
                updatedAt: prepared.now,
              }),
          ),
          setDocRef.set(
            {
              setIndex,
              raceResult: prepared.raceResult,
              raceState: raceStateMetadata,
              status: 'prepared',
              updatedAt: prepared.now,
            },
            { merge: true },
          ),
        ]

        await Promise.all(writeTasks)

        deps.logger.info('Race prepared', {
          roomId,
          setIndex,
          playerCount: prepared.rankingsPayload.length,
          seedKey: prepared.raceSeedKey,
          scriptVersion: deps.serverRaceScriptVersion,
          raceStateDocVersion: deps.serverRaceStateDocVersion,
          keyframeCount: prepared.replayScript.keyframes.length,
          payloadDocId: RACE_STATE_PAYLOAD_DOC_ID,
        })

        return buildPreparedRaceAck(false, prepared.replayScript.keyframes.length)
      } catch (error) {
        deps.logger.error('prepareRace error', error)
        rethrowUnexpected(error, 'Failed to prepare race')
      }
    },
  )

  const startRace = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex } = parseOrThrow(
          startRaceSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const room = await deps.getRoom(roomId)
        await deps.assertJoinedRoomHostRequest({
          roomId,
          playerId,
          sessionToken,
          joinToken,
          authUid,
          hostErrorMessage: 'Only host can start race',
        })

        deps.assertExactRoomPhaseAndSetIndex({
          roomId,
          playerId,
          action: 'startRace',
          roomStatus: room.status,
          expectedStatus: STATUS_RACING,
          statusMessage: 'Race can only be started during racing phase',
          requestedSetIndex: setIndex,
          currentSetIndex: room.currentSet,
        })

        const setDocRef = deps.db.collection('rooms').doc(roomId).collection('sets').doc(`set-${setIndex}`)
        const setDoc = await setDocRef.get()
        if (!setDoc.exists) {
          throw new HttpsError('failed-precondition', 'Race must be prepared before start')
        }

        const setData = setDoc.data() as
          | {
              raceState?: {
                status?: 'prepared' | 'running' | 'completed'
                startedAt?: FirebaseFirestore.Timestamp
                scriptVersion?: string
                raceStateDocVersion?: string
                simStepMs?: number
                outputFrameMs?: number
                tickIntervalMs?: number
              }
            }
          | undefined
        const raceState = setData?.raceState
        if (!raceState) {
          throw new HttpsError('failed-precondition', 'Race state is unavailable')
        }

        const existingStartedAtMillis = raceState.startedAt?.toMillis?.()
        if (existingStartedAtMillis) {
          deps.logger.info('startRace already started', { roomId, setIndex, playerId })
          return {
            success: true,
            startedAtMillis: existingStartedAtMillis,
            alreadyStarted: true,
            scriptVersion: raceState.scriptVersion ?? deps.serverRaceScriptVersion,
            simStepMs: raceState.simStepMs ?? deps.serverRaceSimStepMs,
            outputFrameMs: raceState.outputFrameMs ?? deps.serverRaceOutputFrameMs,
            tickIntervalMs:
              raceState.tickIntervalMs ?? raceState.outputFrameMs ?? deps.serverRaceOutputFrameMs,
            raceStateDocVersion: raceState.raceStateDocVersion ?? deps.serverRaceStateDocVersion,
          }
        }
        if (raceState.status && raceState.status !== 'prepared') {
          throw new HttpsError(
            'failed-precondition',
            `Race cannot be started from status ${raceState.status}`,
          )
        }

        const now = Timestamp.now()
        // 결과는 prepare 때 이미 확정되어 있고, startRace는 모든 클라가 같은 시작 시각으로 재생하게만 만든다.
        await setDocRef.set(
          {
            setIndex,
            raceResult: {
              startedAt: now,
            },
            raceState: {
              startedAt: now,
              status: 'running',
              updatedAt: now,
            },
            status: 'completed',
            updatedAt: now,
          },
          { merge: true },
        )
        await deps.updateRoomStatus(roomId, STATUS_SET_RESULT)

        deps.logger.info('Race started (prepared -> running)', {
          roomId,
          setIndex,
          playerId,
          scriptVersion: raceState.scriptVersion ?? deps.serverRaceScriptVersion,
          raceStateDocVersion: raceState.raceStateDocVersion ?? deps.serverRaceStateDocVersion,
        })

        return {
          success: true,
          startedAtMillis: now.toMillis(),
          alreadyStarted: false,
          scriptVersion: raceState.scriptVersion ?? deps.serverRaceScriptVersion,
          simStepMs: raceState.simStepMs ?? deps.serverRaceSimStepMs,
          outputFrameMs: raceState.outputFrameMs ?? deps.serverRaceOutputFrameMs,
          tickIntervalMs:
            raceState.tickIntervalMs ?? raceState.outputFrameMs ?? deps.serverRaceOutputFrameMs,
          raceStateDocVersion: raceState.raceStateDocVersion ?? deps.serverRaceStateDocVersion,
        }
      } catch (error) {
        deps.logger.error('startRace error', error)
        rethrowUnexpected(error, 'Failed to start race')
      }
    },
  )

  const readyNextSet = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex } = parseOrThrow(
          readyNextSetSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const room = await deps.getRoom(roomId)
        deps.logger.info('readyNextSet request received', {
          roomId,
          playerId,
          setIndex,
          roomCurrentSet: room.currentSet,
          roomStatus: room.status,
        })
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        deps.assertExactRoomPhaseAndSetIndex({
          roomId,
          playerId,
          action: 'readyNextSet',
          roomStatus: room.status,
          expectedStatus: STATUS_SET_RESULT,
          statusMessage: 'Next set can only be prepared during setResult',
          requestedSetIndex: setIndex,
          currentSetIndex: room.currentSet,
        })

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const setDocRef = roomRef.collection('sets').doc(`set-${setIndex}`)
        const playersSnapshot = await roomRef.collection('players').get()
        const playerIds = playersSnapshot.docs.map((doc) => doc.id)
        const now = Timestamp.now()

        const allReady = await deps.db.runTransaction(async (tx) => {
          const setDoc = await tx.get(setDocRef)
          const setData = setDoc.data() as { readyForNext?: Record<string, boolean> } | undefined
          const existingReadyForNext = setData?.readyForNext ?? {}
          if (existingReadyForNext[playerId] === true) {
            // 같은 버튼 요청이 두 번 와도 ready 상태를 다시 쓰지 않고 현재 합의 상태만 돌려준다.
            return playerIds.every((id) => existingReadyForNext[id] === true)
          }
          const readyForNext = { ...existingReadyForNext, [playerId]: true }
          tx.set(
            setDocRef,
            {
              setIndex,
              readyForNext,
              updatedAt: now,
            },
            { merge: true },
          )
          return playerIds.every((id) => readyForNext[id] === true)
        })

        const updatedSetSnapshot = await setDocRef.get()
        const updatedSetData = updatedSetSnapshot.data() as { readyForNext?: Record<string, boolean> } | undefined
        deps.logger.info('readyNextSet readiness transaction committed', {
          roomId,
          playerId,
          setIndex,
          roomCurrentSet: room.currentSet,
          roomStatus: room.status,
          playerIds,
          readyForNext: updatedSetData?.readyForNext ?? null,
          allReady,
        })

        if (!allReady) {
          deps.logger.info('readyNextSet waiting for other players', {
            roomId,
            playerId,
            setIndex,
            nextStatus: STATUS_SET_RESULT,
            currentSet: setIndex,
            allReady: false,
          })
          return {
            success: true,
            allReady: false,
            nextStatus: STATUS_SET_RESULT,
            currentSet: setIndex,
          }
        }

        const isLastSet = setIndex >= room.roundCount
        const nextStatus: RoomStatus = isLastSet ? STATUS_FINISHED : STATUS_AUGMENT_SELECTION
        const nextSet = isLastSet ? setIndex : setIndex + 1

        // 모든 플레이어가 준비되면 다음 세트 진입 전에 라운드 임시 효과(행운 보너스)를 정리한다.
        const batch = deps.db.batch()
        playersSnapshot.docs.forEach((doc) => {
          const player = doc.data() as Player & { currentSetLuckBonus?: number }
          const luckBonus = player.currentSetLuckBonus ?? 0
          const nextStats = deps.removeLuckBonusFromHorseStats(player.horseStats, luckBonus)
          batch.update(doc.ref, {
            horseStats: nextStats,
            currentSetLuckBonus: 0,
            updatedAt: now,
          })
        })
        batch.update(roomRef, {
          status: nextStatus,
          currentSet: nextSet,
          updatedAt: now,
        })
        batch.set(
          setDocRef,
          {
            setIndex,
            status: 'completed',
            updatedAt: now,
          },
          { merge: true },
        )
        await batch.commit()

        deps.logger.info('Set advanced by readiness sync', { roomId, setIndex, nextStatus, nextSet })

        return {
          success: true,
          allReady: true,
          nextStatus,
          currentSet: nextSet,
        }
      } catch (error) {
        deps.logger.error('readyNextSet error', error)
        rethrowUnexpected(error, 'Failed to process next set readiness')
      }
    },
  )

  return { prepareRace, startRace, readyNextSet }
}
