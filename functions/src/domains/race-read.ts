import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import type { Augment, Player, Room } from '../types'
import { CALLABLE_OPTIONS } from '../common/cors-options'
import type {
  GetRaceStateSetDocData,
  ServerRaceEvent,
  ServerRaceKeyframe,
  GetSetResultRaceRanking,
  GetSetResultSetSummary,
} from '../common/response-builders'

type AssertJoinedRoomPlayerRequest = (params: {
  roomId: string
  playerId: string
  sessionToken: string
  joinToken: string
  authUid?: string
}) => Promise<void>

type LoggerLike = {
  info?: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
}

type RaceReadDeps = {
  db: FirebaseFirestore.Firestore
  logger: LoggerLike
  getRoom: (roomId: string) => Promise<Room>
  assertJoinedRoomPlayerRequest: AssertJoinedRoomPlayerRequest
  throwInvalidSetIndex: (params: {
    roomId: string
    playerId: string
    action: string
    requestedSetIndex: number
    currentSetIndex: number
  }) => never
  buildGetRaceStateResponse: (params: {
    setIndex: number
    setData: GetRaceStateSetDocData | undefined
    nowMillis?: number
    eventWindowStartElapsedMs?: number
  }) => unknown
  getSortedSetSummaries: (
    snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>,
  ) => GetSetResultSetSummary[]
  buildSetResultRankings: (params: {
    raceRankings: GetSetResultRaceRanking[]
    playersById: Record<string, Player>
    allSets: GetSetResultSetSummary[]
  }) => Array<{
    playerId: string
    name: string
    position: number
    time: number
    selectedAugments: Augment[]
  }>
}

const authenticatedSetRequestSchema = {
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
  setIndex: z.number().int().min(1),
}

const getRaceStateSchema = z.object({
  ...authenticatedSetRequestSchema,
  eventsSinceElapsedMs: z.number().min(0).optional(),
  includeObservability: z.boolean().optional(),
})
const getRaceTimelineSchema = z.object({
  ...authenticatedSetRequestSchema,
  chunkCursor: z
    .object({
      keyframeChunkIndex: z.number().int().min(0).optional(),
      eventBucketStartElapsedMs: z.number().int().min(0).optional(),
    })
    .optional(),
})
const getSetResultWithObservabilitySchema = z.object({
  ...authenticatedSetRequestSchema,
  includeObservability: z.boolean().optional(),
})
const DEFAULT_RACE_STATE_PAYLOAD_DOC_ID = 'payload'
const RACE_STATE_PAYLOAD_FORMAT_CHUNKED_V2 = 'chunked-v2'
const DEFAULT_KEYFRAME_CHUNK_SIZE = 32
const DEFAULT_EVENT_BUCKET_MS = 1000
const RACE_TIMELINE_KEYFRAME_CHUNKS_PER_PAGE = 4
const RACE_TIMELINE_EVENT_BUCKETS_PER_PAGE = 4
const MIN_OUTPUT_FRAME_MS = 1
const RACE_STATE_PAYLOAD_CACHE_MAX_ENTRIES = 64
const RACE_STATE_PAYLOAD_CACHE_TTL_MS = 15_000
const READ_PERF_LOG_SAMPLE_MOD = 20
const READ_OBSERVABILITY_EXPOSE_ENV_KEY = 'FUNCTIONS_EXPOSE_READ_OBSERVABILITY'
const SHOULD_EXPOSE_READ_OBSERVABILITY = process.env[READ_OBSERVABILITY_EXPOSE_ENV_KEY] === 'true'
let raceStateReadCount = 0
let raceTimelineReadCount = 0
let setResultReadCount = 0

type CachedRaceStatePayload = {
  keyframes: ServerRaceKeyframe[]
  events: ServerRaceEvent[]
  slowmoTriggerMs?: number
  cachedAtMs: number
}

const raceStatePayloadCache = new Map<string, CachedRaceStatePayload>()

function buildRaceStatePayloadCacheKey(params: {
  roomId: string
  setIndex: number
  payloadDocId: string
  setData: GetRaceStateSetDocData | undefined
}): string {
  // 같은 세트라도 raceState가 갱신되면 이전 payload를 쓰면 안 돼서 갱신 시각/개수를 키에 섞는다.
  const updatedAtMillis = params.setData?.raceState?.updatedAt?.toMillis?.() ?? 'na'
  const keyframeCount = params.setData?.raceState?.keyframeCount ?? 'na'
  const eventCount = params.setData?.raceState?.eventCount ?? 'na'
  return `${params.roomId}:${params.setIndex}:${params.payloadDocId}:${updatedAtMillis}:${keyframeCount}:${eventCount}`
}

function readCachedRaceStatePayload(cacheKey: string, nowMillis: number): CachedRaceStatePayload | null {
  const cached = raceStatePayloadCache.get(cacheKey)
  if (!cached) {
    return null
  }
  if (nowMillis - cached.cachedAtMs > RACE_STATE_PAYLOAD_CACHE_TTL_MS) {
    raceStatePayloadCache.delete(cacheKey)
    return null
  }
  return cached
}

function writeCachedRaceStatePayload(cacheKey: string, payload: Omit<CachedRaceStatePayload, 'cachedAtMs'>) {
  if (raceStatePayloadCache.size >= RACE_STATE_PAYLOAD_CACHE_MAX_ENTRIES) {
    // 함수 인스턴스 메모리 캐시라 단순 FIFO로 충분하고, 너무 커져서 오래 붙잡지 않게 한다.
    const oldestKey = raceStatePayloadCache.keys().next().value
    if (oldestKey) {
      raceStatePayloadCache.delete(oldestKey)
    }
  }
  raceStatePayloadCache.set(cacheKey, {
    ...payload,
    cachedAtMs: Date.now(),
  })
}

function countReadyForNextPlayers(readyForNext?: Record<string, boolean>): number {
  return Object.keys(readyForNext ?? {}).filter((id) => readyForNext?.[id] === true).length
}

type SetResultSummaryRanking = {
  playerId: string
  name: string
  position: number
  time: number
  selectedAugments: Augment[]
}

type SetResultSummary = {
  rankings?: SetResultSummaryRanking[]
  startedAtMillis?: number | null
  generatedAt?: FirebaseFirestore.Timestamp
}

function shouldSampleRead(action: 'getRaceState' | 'getRaceTimeline' | 'getSetResult'): boolean {
  // 자주 호출되는 callable이라 모든 요청을 로그로 남기지 않고 고정 비율로만 찍는다.
  if (action === 'getRaceState') {
    raceStateReadCount += 1
    return raceStateReadCount % READ_PERF_LOG_SAMPLE_MOD === 0
  }
  if (action === 'getRaceTimeline') {
    raceTimelineReadCount += 1
    return raceTimelineReadCount % READ_PERF_LOG_SAMPLE_MOD === 0
  }
  setResultReadCount += 1
  return setResultReadCount % READ_PERF_LOG_SAMPLE_MOD === 0
}

function resolveRaceStateStatus(params: {
  isPrepared: boolean
  keyframeIndex: number
  keyframeCount: number
}): 'prepared' | 'running' | 'completed' {
  if (params.isPrepared) return 'prepared'
  if (params.keyframeIndex >= params.keyframeCount - 1) return 'completed'
  return 'running'
}

export function createRaceReadCallables(deps: RaceReadDeps) {
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

  async function buildChunkedRaceStateResponse(params: {
    roomId: string
    setIndex: number
    setDocRef: FirebaseFirestore.DocumentReference
    setData: GetRaceStateSetDocData | undefined
    eventsSinceElapsedMs?: number
  }) {
    const raceState = params.setData?.raceState
    const keyframeCount = raceState?.keyframeCount ?? 0
    if (!raceState || keyframeCount <= 0) {
      return {
        response: { success: true as const, hasRaceState: false as const },
        metrics: {
          payloadSource: 'chunked-v2' as const,
          keyframeChunkReads: 0,
          eventBucketReads: 0,
          eventWindowCount: 0,
        },
      }
    }

    const startedAtMillis = raceState.startedAt?.toMillis?.()
    const nowMillis = Date.now()
    const isPrepared = !startedAtMillis || raceState.status === 'prepared'
    const elapsedMs = isPrepared ? 0 : Math.max(0, nowMillis - startedAtMillis)
    const outputFrameMs = raceState.outputFrameMs ?? raceState.tickIntervalMs ?? 120
    const simStepMs = raceState.simStepMs ?? 50
    const safeOutputFrameMs = Math.max(MIN_OUTPUT_FRAME_MS, outputFrameMs)
    const keyframeIndex = Math.min(
      keyframeCount - 1,
      Math.max(0, Math.floor(elapsedMs / safeOutputFrameMs)),
    )
    const nextKeyframeIndex = Math.min(keyframeCount - 1, keyframeIndex + 1)

    const keyframeChunkSize = Math.max(1, raceState.keyframeChunkSize ?? DEFAULT_KEYFRAME_CHUNK_SIZE)
    // 현재/다음 프레임 계산에 필요한 chunk만 읽어서 read fan-out을 제한한다.
    const requiredChunkIndexes = Array.from(
      new Set([
        Math.floor(keyframeIndex / keyframeChunkSize),
        Math.floor(nextKeyframeIndex / keyframeChunkSize),
      ]),
    ).sort((a, b) => a - b)
    const keyframeChunkRefs = requiredChunkIndexes.map((chunkIndex) =>
      params.setDocRef.collection('raceStatePayloadKeyframes').doc(`chunk-${chunkIndex}`),
    )
    const keyframeChunkSnapshots =
      keyframeChunkRefs.length > 0 ? await deps.db.getAll(...keyframeChunkRefs) : []

    const keyframeChunkByIndex = new Map<number, ServerRaceKeyframe[]>()
    keyframeChunkSnapshots.forEach((snapshot) => {
      const data = snapshot.data() as { chunkIndex?: number; keyframes?: ServerRaceKeyframe[] } | undefined
      const chunkIndex = data?.chunkIndex
      if (typeof chunkIndex !== 'number' || !Array.isArray(data?.keyframes)) return
      keyframeChunkByIndex.set(chunkIndex, data.keyframes)
    })

    const resolveKeyframeByIndex = (targetIndex: number): ServerRaceKeyframe | undefined => {
      const chunkIndex = Math.floor(targetIndex / keyframeChunkSize)
      const chunk = keyframeChunkByIndex.get(chunkIndex)
      if (!chunk) return undefined
      const offset = targetIndex - chunkIndex * keyframeChunkSize
      return chunk[offset]
    }

    const keyframe = resolveKeyframeByIndex(keyframeIndex)
    const nextKeyframe = resolveKeyframeByIndex(nextKeyframeIndex)
    if (!keyframe || !nextKeyframe) {
      return {
        response: { success: true as const, hasRaceState: false as const },
        metrics: {
          payloadSource: 'chunked-v2' as const,
          keyframeChunkReads: keyframeChunkRefs.length,
          eventBucketReads: 0,
          eventWindowCount: 0,
        },
      }
    }

    const nextElapsed = nextKeyframe.elapsedMs ?? keyframe.elapsedMs
    const eventBucketMs = Math.max(1, raceState.eventBucketMs ?? DEFAULT_EVENT_BUCKET_MS)
    const eventWindowStartElapsed = Number.isFinite(params.eventsSinceElapsedMs)
      ? Math.max(0, Number(params.eventsSinceElapsedMs))
      : 0
    // 이벤트 버킷은 윈도우 시작~다음 키프레임 시점까지만 조회한다.
    const startBucketElapsed = Math.floor(eventWindowStartElapsed / eventBucketMs) * eventBucketMs
    const endBucketElapsed = Math.floor(nextElapsed / eventBucketMs) * eventBucketMs

    const eventBucketRefs: FirebaseFirestore.DocumentReference[] = []
    for (let bucketElapsed = startBucketElapsed; bucketElapsed <= endBucketElapsed; bucketElapsed += eventBucketMs) {
      eventBucketRefs.push(
        params.setDocRef.collection('raceStatePayloadEvents').doc(`bucket-${bucketElapsed}`),
      )
    }
    const eventBucketSnapshots = eventBucketRefs.length > 0 ? await deps.db.getAll(...eventBucketRefs) : []
    const eventsWindow = eventBucketSnapshots
      .flatMap((snapshot) => {
        const data = snapshot.data() as { events?: ServerRaceEvent[] } | undefined
        return Array.isArray(data?.events) ? data.events : []
      })
      .filter((event) => event.elapsedMs <= nextElapsed && event.elapsedMs > eventWindowStartElapsed)
      .sort((a, b) => a.elapsedMs - b.elapsedMs)

    const status = resolveRaceStateStatus({
      isPrepared,
      keyframeIndex,
      keyframeCount,
    })

    return {
      response: {
        success: true as const,
        hasRaceState: true as const,
        status,
        setIndex: params.setIndex,
        scriptVersion: raceState.scriptVersion ?? '',
        raceStateDocVersion: raceState.raceStateDocVersion ?? '',
        startedAtMillis: startedAtMillis ?? null,
        elapsedMs: isPrepared ? 0 : keyframe.elapsedMs,
        simStepMs,
        outputFrameMs,
        tickIntervalMs: outputFrameMs,
        authoritativeNowMs: nowMillis,
        trackLengthM: raceState.trackLengthM ?? 0,
        keyframeIndex,
        keyframe,
        nextKeyframe,
        eventsWindow,
        slowmoTriggerMs: raceState.slowmoTriggerMs ?? null,
        snapshotHash: raceState.inputsSnapshotHash ?? '',
        rankings: params.setData?.raceResult?.rankings ?? [],
      },
      metrics: {
        payloadSource: 'chunked-v2' as const,
        keyframeChunkReads: keyframeChunkRefs.length,
        eventBucketReads: eventBucketRefs.length,
        eventWindowCount: eventsWindow.length,
      },
    }
  }

  async function buildChunkedRaceTimelineResponse(params: {
    setIndex: number
    setDocRef: FirebaseFirestore.DocumentReference
    setData: GetRaceStateSetDocData | undefined
    chunkCursor?: {
      keyframeChunkIndex?: number
      eventBucketStartElapsedMs?: number
    }
  }) {
    const raceState = params.setData?.raceState
    const keyframeCount = raceState?.keyframeCount ?? 0
    const keyframeChunkCount = raceState?.keyframeChunkCount ?? 0
    if (
      !raceState ||
      raceState.payloadFormat !== RACE_STATE_PAYLOAD_FORMAT_CHUNKED_V2 ||
      keyframeCount <= 0 ||
      keyframeChunkCount <= 0
    ) {
      return {
        success: true as const,
        hasTimeline: false as const,
      }
    }

    const keyframeChunkSize = Math.max(1, raceState.keyframeChunkSize ?? DEFAULT_KEYFRAME_CHUNK_SIZE)
    const eventBucketMs = Math.max(1, raceState.eventBucketMs ?? DEFAULT_EVENT_BUCKET_MS)
    const eventChunkCount = Math.max(0, raceState.eventChunkCount ?? 0)
    const requestedKeyframeChunkIndex =
      params.chunkCursor && typeof params.chunkCursor.keyframeChunkIndex !== 'number'
        ? keyframeChunkCount
        : params.chunkCursor?.keyframeChunkIndex ?? 0
    const keyframeChunkIndex = Math.min(
      keyframeChunkCount,
      Math.max(0, requestedKeyframeChunkIndex),
    )
    const keyframeChunkEndIndex = Math.min(
      keyframeChunkCount,
      keyframeChunkIndex + RACE_TIMELINE_KEYFRAME_CHUNKS_PER_PAGE,
    )
    const keyframeChunkRefs: FirebaseFirestore.DocumentReference[] = []
    for (let chunkIndex = keyframeChunkIndex; chunkIndex < keyframeChunkEndIndex; chunkIndex += 1) {
      keyframeChunkRefs.push(
        params.setDocRef.collection('raceStatePayloadKeyframes').doc(`chunk-${chunkIndex}`),
      )
    }
    const keyframeChunkSnapshots =
      keyframeChunkRefs.length > 0 ? await deps.db.getAll(...keyframeChunkRefs) : []
    const keyframeChunks = keyframeChunkSnapshots
      .map((snapshot) => snapshot.data() as
        | {
            chunkIndex?: number
            startIndex?: number
            keyframes?: ServerRaceKeyframe[]
          }
        | undefined)
      .filter(
        (
          chunk,
        ): chunk is {
          chunkIndex: number
          startIndex: number
          keyframes: ServerRaceKeyframe[]
        } =>
          typeof chunk?.chunkIndex === 'number' &&
          typeof chunk?.startIndex === 'number' &&
          Array.isArray(chunk?.keyframes),
      )
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
    if (keyframeChunkRefs.length > 0 && keyframeChunks.length !== keyframeChunkRefs.length) {
      return {
        success: true as const,
        hasTimeline: false as const,
      }
    }

    const shouldReadEventBuckets =
      eventChunkCount > 0 &&
      (!params.chunkCursor || typeof params.chunkCursor.eventBucketStartElapsedMs === 'number')
    const eventBucketStartElapsedMs = params.chunkCursor?.eventBucketStartElapsedMs ?? 0
    let eventBucketQuery = params.setDocRef
      .collection('raceStatePayloadEvents')
      .orderBy('bucketStartElapsedMs')
      .limit(RACE_TIMELINE_EVENT_BUCKETS_PER_PAGE)
    if (eventBucketStartElapsedMs > 0) {
      eventBucketQuery = params.setDocRef
        .collection('raceStatePayloadEvents')
        .where('bucketStartElapsedMs', '>=', eventBucketStartElapsedMs)
        .orderBy('bucketStartElapsedMs')
        .limit(RACE_TIMELINE_EVENT_BUCKETS_PER_PAGE)
    }
    const eventBuckets = shouldReadEventBuckets ? await eventBucketQuery.get() : null
    const eventBucketData = eventBuckets
      ? eventBuckets.docs
          .map((snapshot) => snapshot.data() as
            | {
                bucketStartElapsedMs?: number
                bucketEndElapsedMs?: number
                eventBucketMs?: number
                events?: ServerRaceEvent[]
              }
            | undefined)
          .filter(
            (
              bucket,
            ): bucket is {
              bucketStartElapsedMs: number
              bucketEndElapsedMs: number
              eventBucketMs: number
              events: ServerRaceEvent[]
            } =>
              typeof bucket?.bucketStartElapsedMs === 'number' &&
              typeof bucket?.bucketEndElapsedMs === 'number' &&
              typeof bucket?.eventBucketMs === 'number' &&
              Array.isArray(bucket?.events),
          )
      : []

    const nextKeyframeChunkIndex =
      keyframeChunkEndIndex < keyframeChunkCount ? keyframeChunkEndIndex : undefined
    const lastEventBucket = eventBucketData[eventBucketData.length - 1]
    const nextEventBucketStartElapsedMs =
      eventBuckets && eventBuckets.size === RACE_TIMELINE_EVENT_BUCKETS_PER_PAGE && lastEventBucket
        ? lastEventBucket.bucketStartElapsedMs + eventBucketMs
        : undefined
    const nextCursor =
      typeof nextKeyframeChunkIndex === 'number' || typeof nextEventBucketStartElapsedMs === 'number'
        ? {
            ...(typeof nextKeyframeChunkIndex === 'number'
              ? { keyframeChunkIndex: nextKeyframeChunkIndex }
              : {}),
            ...(typeof nextEventBucketStartElapsedMs === 'number'
              ? { eventBucketStartElapsedMs: nextEventBucketStartElapsedMs }
              : {}),
          }
        : null

    return {
      success: true as const,
      hasTimeline: true as const,
      setIndex: params.setIndex,
      status: raceState.status ?? 'prepared',
      scriptVersion: raceState.scriptVersion ?? '',
      raceStateDocVersion: raceState.raceStateDocVersion ?? '',
      startedAtMillis: raceState.startedAt?.toMillis?.() ?? null,
      simStepMs: raceState.simStepMs ?? 50,
      outputFrameMs: raceState.outputFrameMs ?? raceState.tickIntervalMs ?? 120,
      tickIntervalMs: raceState.tickIntervalMs ?? raceState.outputFrameMs ?? 120,
      trackLengthM: raceState.trackLengthM ?? 0,
      snapshotHash: raceState.inputsSnapshotHash ?? '',
      slowmoTriggerMs: raceState.slowmoTriggerMs ?? null,
      rankings: params.setData?.raceResult?.rankings ?? [],
      keyframeChunkSize,
      keyframeChunkCount,
      keyframeCount,
      eventBucketMs,
      eventChunkCount,
      eventCount: raceState.eventCount ?? 0,
      keyframeChunks,
      eventBuckets: eventBucketData,
      nextCursor,
    }
  }

  const getRaceState = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      const startedAtMs = Date.now()
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex, eventsSinceElapsedMs, includeObservability } =
          parseOrThrow(
          getRaceStateSchema,
          request.data,
        )
        // 운영 기본은 비공개, 서버 플래그+요청 플래그가 모두 켜질 때만 응답에 노출한다.
        const exposeObservability = SHOULD_EXPOSE_READ_OBSERVABILITY && includeObservability === true
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        const room = await deps.getRoom(roomId)
        if (room.currentSet !== setIndex) {
          deps.throwInvalidSetIndex({
            roomId,
            playerId,
            action: 'getRaceState',
            requestedSetIndex: setIndex,
            currentSetIndex: room.currentSet,
          })
        }

        const setDocRef = deps.db.collection('rooms').doc(roomId).collection('sets').doc(`set-${setIndex}`)
        const setDoc = await setDocRef.get()
        if (!setDoc.exists) {
          const result = { success: true, hasRaceState: false }
          if (deps.logger.info && shouldSampleRead('getRaceState')) {
            deps.logger.info('perf.getRaceState', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasRaceState: false,
              payloadSource: 'missing-set-doc',
            })
          }
          return exposeObservability
            ? {
                ...result,
                observability: {
                  payloadSource: 'missing-set-doc',
                  keyframeChunkReads: 0,
                  eventBucketReads: 0,
                  eventWindowCount: 0,
                },
              }
            : result
        }

        const setData = setDoc.data() as GetRaceStateSetDocData | undefined
        const hasInlinePayload = Array.isArray(setData?.raceState?.keyframes)
        const payloadFormat = setData?.raceState?.payloadFormat
        const payloadDocId = setData?.raceState?.payloadDocId ?? DEFAULT_RACE_STATE_PAYLOAD_DOC_ID

        if (hasInlinePayload) {
          // 예전 inline 문서도 아직 읽을 수 있어야 배포 직후 방이 끊기지 않는다.
          const result = deps.buildGetRaceStateResponse({
            setIndex,
            setData,
            eventWindowStartElapsedMs: eventsSinceElapsedMs,
          })
          const resultData = result as { hasRaceState?: boolean; eventsWindow?: ServerRaceEvent[] } | undefined
          if (deps.logger.info && shouldSampleRead('getRaceState')) {
            deps.logger.info('perf.getRaceState', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasRaceState: resultData?.hasRaceState ?? false,
              payloadSource: 'inline-legacy',
              eventWindowCount: resultData?.eventsWindow?.length ?? 0,
            })
          }
          return exposeObservability
            ? {
                ...(result as Record<string, unknown>),
                observability: {
                  payloadSource: 'inline-legacy',
                  keyframeChunkReads: 0,
                  eventBucketReads: 0,
                  eventWindowCount: resultData?.eventsWindow?.length ?? 0,
                },
              }
            : result
        }

        if (payloadFormat === RACE_STATE_PAYLOAD_FORMAT_CHUNKED_V2) {
          const chunked = await buildChunkedRaceStateResponse({
            roomId,
            setIndex,
            setDocRef,
            setData,
            eventsSinceElapsedMs,
          })
          if (deps.logger.info && shouldSampleRead('getRaceState')) {
            deps.logger.info('perf.getRaceState', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasRaceState: chunked.response.hasRaceState,
              payloadSource: chunked.metrics.payloadSource,
              keyframeChunkReads: chunked.metrics.keyframeChunkReads,
              eventBucketReads: chunked.metrics.eventBucketReads,
              eventWindowCount: chunked.metrics.eventWindowCount,
            })
          }
          return exposeObservability
            ? {
                ...(chunked.response as Record<string, unknown>),
                observability: {
                  payloadSource: chunked.metrics.payloadSource,
                  keyframeChunkReads: chunked.metrics.keyframeChunkReads,
                  eventBucketReads: chunked.metrics.eventBucketReads,
                  eventWindowCount: chunked.metrics.eventWindowCount,
                },
              }
            : chunked.response
        }

        const cacheKey = buildRaceStatePayloadCacheKey({ roomId, setIndex, payloadDocId, setData })
        const nowMillis = Date.now()
        let payload = readCachedRaceStatePayload(cacheKey, nowMillis)
        const payloadCacheHit = !!payload

        if (!payload) {
          const payloadDoc = await setDocRef.collection('raceStatePayload').doc(payloadDocId).get()
          const payloadData = payloadDoc.data() as
            | {
                keyframes?: ServerRaceKeyframe[]
                events?: ServerRaceEvent[]
                slowmoTriggerMs?: number
              }
            | undefined
          payload = {
            keyframes: payloadData?.keyframes ?? [],
            events: payloadData?.events ?? [],
            slowmoTriggerMs: payloadData?.slowmoTriggerMs,
            cachedAtMs: nowMillis,
          }
          writeCachedRaceStatePayload(cacheKey, payload)
        }

        const hydratedSetData: GetRaceStateSetDocData | undefined = setData
          ? {
              ...setData,
              raceState: {
                ...(setData.raceState ?? {}),
                keyframes: payload.keyframes,
                events: payload.events,
                slowmoTriggerMs: payload.slowmoTriggerMs ?? setData.raceState?.slowmoTriggerMs,
              },
            }
          : undefined

        const result = deps.buildGetRaceStateResponse({
          setIndex,
          setData: hydratedSetData,
          eventWindowStartElapsedMs: eventsSinceElapsedMs,
        })
        const resultData = result as { hasRaceState?: boolean; eventsWindow?: ServerRaceEvent[] } | undefined
        if (deps.logger.info && shouldSampleRead('getRaceState')) {
          deps.logger.info('perf.getRaceState', {
            roomId,
            playerId,
            setIndex,
            durationMs: Date.now() - startedAtMs,
            hasRaceState: resultData?.hasRaceState ?? false,
            payloadSource: 'legacy-payload-doc',
            payloadCacheHit,
            eventWindowCount: resultData?.eventsWindow?.length ?? 0,
          })
        }
        return exposeObservability
          ? {
              ...(result as Record<string, unknown>),
              observability: {
                payloadSource: 'legacy-payload-doc',
                payloadCacheHit,
                keyframeChunkReads: 0,
                eventBucketReads: 0,
                eventWindowCount: resultData?.eventsWindow?.length ?? 0,
              },
            }
          : result
      } catch (error) {
        deps.logger.error('getRaceState error', error)
        rethrowUnexpected(error, 'Failed to get race state')
      }
    },
  )

  const getRaceTimeline = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      const startedAtMs = Date.now()
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex, chunkCursor } = parseOrThrow(
          getRaceTimelineSchema,
          request.data,
        )
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        const room = await deps.getRoom(roomId)
        if (room.currentSet !== setIndex) {
          deps.throwInvalidSetIndex({
            roomId,
            playerId,
            action: 'getRaceTimeline',
            requestedSetIndex: setIndex,
            currentSetIndex: room.currentSet,
          })
        }

        const setDocRef = deps.db.collection('rooms').doc(roomId).collection('sets').doc(`set-${setIndex}`)
        const setDoc = await setDocRef.get()
        if (!setDoc.exists) {
          const result = { success: true, hasTimeline: false }
          if (deps.logger.info && shouldSampleRead('getRaceTimeline')) {
            deps.logger.info('perf.getRaceTimeline', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasTimeline: false,
              payloadSource: 'missing-set-doc',
            })
          }
          return result
        }

        const setData = setDoc.data() as GetRaceStateSetDocData | undefined
        const result = await buildChunkedRaceTimelineResponse({
          setIndex,
          setDocRef,
          setData,
          chunkCursor,
        })

        if (deps.logger.info && shouldSampleRead('getRaceTimeline')) {
          deps.logger.info('perf.getRaceTimeline', {
            roomId,
            playerId,
            setIndex,
            durationMs: Date.now() - startedAtMs,
            hasTimeline: result.hasTimeline,
            payloadSource: result.hasTimeline ? 'chunked-v2' : 'unavailable',
            keyframeChunkCount: result.hasTimeline ? result.keyframeChunks.length : 0,
            eventBucketCount: result.hasTimeline ? result.eventBuckets.length : 0,
            hasNextPage: result.hasTimeline ? result.nextCursor !== null : false,
          })
        }
        return result
      } catch (error) {
        deps.logger.error('getRaceTimeline error', error)
        rethrowUnexpected(error, 'Failed to get race timeline')
      }
    },
  )

  const getSetResult = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      const startedAtMs = Date.now()
      try {
        const authUid = requireAuthUid(request)
        const { roomId, playerId, sessionToken, joinToken, setIndex, includeObservability } = parseOrThrow(
          getSetResultWithObservabilitySchema,
          request.data,
        )
        const exposeObservability = SHOULD_EXPOSE_READ_OBSERVABILITY && includeObservability === true
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const setDocRef = roomRef.collection('sets').doc(`set-${setIndex}`)
        const setDoc = await setDocRef.get()

        if (!setDoc.exists) {
          throw new HttpsError('not-found', 'Set result not found')
        }

        const setData = setDoc.data() as
          | {
              raceResult?: {
                rankings?: GetSetResultRaceRanking[]
                startedAt?: FirebaseFirestore.Timestamp
              }
              readyForNext?: Record<string, boolean>
              selections?: Record<string, string>
              availableAugmentsByPlayer?: Record<string, Augment[]>
              setResultSummary?: SetResultSummary
            }
          | undefined
        const raceResult = setData?.raceResult

        const cachedSummary = setData?.setResultSummary
        // 결과 대기 polling 구간 비용 절감을 위해 set 요약 캐시를 최우선 사용한다.
        if (Array.isArray(cachedSummary?.rankings) && cachedSummary.rankings.length > 0) {
          const result = {
            success: true,
            hasResult: true,
            rankings: cachedSummary.rankings,
            startedAtMillis:
              cachedSummary.startedAtMillis ?? setData?.raceResult?.startedAt?.toMillis?.() ?? null,
            readyCount: countReadyForNextPlayers(setData?.readyForNext),
            cacheHit: true,
          }
          if (deps.logger.info && shouldSampleRead('getSetResult')) {
            deps.logger.info('perf.getSetResult', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasResult: true,
              cacheHit: true,
              rankingCount: cachedSummary.rankings.length,
              readyCount: result.readyCount,
            })
          }
          return exposeObservability
            ? {
                ...result,
                observability: {
                  source: 'set-result-summary-cache',
                  cacheHit: true,
                  rankingCount: cachedSummary.rankings.length,
                },
              }
            : result
        }

        if (!raceResult?.rankings || raceResult.rankings.length === 0) {
          const result = {
            success: true,
            hasResult: false,
            rankings: [],
            startedAtMillis: null,
            readyCount: countReadyForNextPlayers(setData?.readyForNext),
            cacheHit: false,
          }
          if (deps.logger.info && shouldSampleRead('getSetResult')) {
            deps.logger.info('perf.getSetResult', {
              roomId,
              playerId,
              setIndex,
              durationMs: Date.now() - startedAtMs,
              hasResult: false,
              cacheHit: false,
              rankingCount: 0,
              readyCount: result.readyCount,
            })
          }
          return exposeObservability
            ? {
                ...result,
                observability: {
                  source: 'set-result-unavailable',
                  cacheHit: false,
                  rankingCount: 0,
                },
              }
            : result
        }

        const [playersSnapshot, allSetSnapshot] = await Promise.all([
          roomRef.collection('players').select('name').get(),
          roomRef
            .collection('sets')
            .where('setIndex', '<=', setIndex)
            .select('setIndex', 'selections', 'availableAugmentsByPlayer')
            .get(),
        ])

        const playersById = playersSnapshot.docs.reduce<Record<string, Player>>((acc, doc) => {
          acc[doc.id] = doc.data() as Player
          return acc
        }, {})

        const allSets = deps.getSortedSetSummaries(allSetSnapshot)
        const rankings = deps.buildSetResultRankings({
          raceRankings: raceResult.rankings,
          playersById,
          allSets,
        })

        await setDocRef.set(
          {
            setResultSummary: {
              rankings,
              startedAtMillis: setData?.raceResult?.startedAt?.toMillis?.() ?? null,
              generatedAt: Timestamp.now(),
            },
            updatedAt: Timestamp.now(),
          },
          { merge: true },
        )

        const result = {
          success: true,
          hasResult: true,
          rankings,
          startedAtMillis: setData?.raceResult?.startedAt?.toMillis?.() ?? null,
          readyCount: countReadyForNextPlayers(setData?.readyForNext),
          cacheHit: false,
        }
        if (deps.logger.info && shouldSampleRead('getSetResult')) {
          deps.logger.info('perf.getSetResult', {
            roomId,
            playerId,
            setIndex,
            durationMs: Date.now() - startedAtMs,
            hasResult: true,
            cacheHit: false,
            rankingCount: rankings.length,
            readyCount: result.readyCount,
            cacheWriteBack: true,
          })
        }
        return exposeObservability
          ? {
              ...result,
              observability: {
                source: 'set-result-computed',
                cacheHit: false,
                rankingCount: rankings.length,
                cacheWriteBack: true,
              },
            }
          : result
      } catch (error) {
        deps.logger.error('getSetResult error', error)
        rethrowUnexpected(error, 'Failed to get set result')
      }
    },
  )

  return { getRaceState, getRaceTimeline, getSetResult }
}
