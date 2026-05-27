import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import type { Player, RoomStatus } from '../types'
import { CALLABLE_OPTIONS } from '../common/cors-options'

type LoggerLike = {
  info: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: unknown) => void
  error: (message: string, error: unknown) => void
}

type LogFn = (event: string, context: Record<string, unknown>) => void

type RoomLifecycleDeps = {
  db: FirebaseFirestore.Firestore
  logger: LoggerLike
  logInfo: LogFn
  logWarn: LogFn
  guestSessionTtlDays: number
  normalizePlayerName: (name: string) => string
  isValidPlayerName: (name: string) => boolean
  createGuestId: () => string
  createSessionToken: () => string
  hashSessionToken: (sessionToken: string) => string
  issueRoomJoinToken: (
    roomId: string,
    playerId: string,
    authUid: string,
  ) => Promise<{ joinToken: string; expiresAtMillis: number }>
  verifyGuestSession: (playerId: string, sessionToken: string) => Promise<void>
  getRoom: (roomId: string) => Promise<{
    status: RoomStatus
    currentSet: number
    roundCount: number
  }>
  assertJoinedRoomPlayerRequest: (params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
  }) => Promise<void>
  leaveGracePeriodMs?: number
  pendingLeaveCleanupBatchSize?: number
}

const createRoomSchema = z.object({
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  hostName: z.string().min(1, 'hostName is required').max(20, 'hostName is too long'),
  title: z.string().min(1).max(48),
  maxPlayers: z.number().int().min(2).max(8),
  roundCount: z.number().int().min(1).max(3),
  rerollLimit: z.number().int().min(0).max(5),
})

const joinRoomSchema = z.object({
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  playerName: z.string().min(1).max(20, 'Player name must be 1-20 characters'),
})

const updatePlayerNameSchema = z.object({
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
  name: z.string().min(1, 'name is required').max(32, 'name is too long'),
})

const setPlayerReadySchema = z.object({
  roomId: z.string().min(1),
  playerId: z.string().min(1),
  sessionToken: z.string().min(1),
  joinToken: z.string().min(1),
  isReady: z.boolean(),
})

const leaveRoomSchema = z.object({
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
})

const startGameSchema = z.object({
  roomId: z.string().min(1, 'roomId is required'),
  playerId: z.string().min(1, 'playerId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  joinToken: z.string().min(1, 'joinToken is required'),
})

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_MAX_PLAYERS = 8
const STATUS_WAITING: RoomStatus = 'waiting'
const STATUS_HORSE_SELECTION: RoomStatus = 'horseSelection'
const AUTH_STATUS_ACTIVE = 'active'
const AUTH_STATUS_PENDING_LEAVE = 'pending_leave'
const DEFAULT_LEAVE_GRACE_PERIOD_MS = 90 * 1000
const DEFAULT_PENDING_LEAVE_CLEANUP_BATCH_SIZE = 200

export function createRoomLifecycleCallables(deps: RoomLifecycleDeps) {
  function parseOrThrow<T extends z.ZodTypeAny>(
    schema: T,
    data: unknown,
    options?: { warnMessage?: string },
  ): z.infer<T> {
    const parsed = schema.safeParse(data)
    if (parsed.success) {
      return parsed.data
    }
    if (options?.warnMessage) {
      deps.logger.warn(options.warnMessage, parsed.error.flatten().fieldErrors)
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

  function decodeUnloadBody(body: unknown, rawBody: Buffer): unknown {
    if (typeof body === 'string') {
      return JSON.parse(body)
    }
    if (Buffer.isBuffer(body)) {
      return JSON.parse(body.toString('utf8'))
    }
    if (!body && Buffer.isBuffer(rawBody)) {
      const raw = rawBody.toString('utf8')
      return raw ? JSON.parse(raw) : undefined
    }
    return body
  }

  function mapUnloadErrorToResponse(error: unknown): {
    status: number
    body: { ok: false; error: string; retryable: boolean }
    logLevel: 'warn' | 'error'
    logEvent: string
  } {
    if (error instanceof SyntaxError) {
      return {
        status: 400,
        body: { ok: false, error: 'invalid-json', retryable: false },
        logLevel: 'warn',
        logEvent: 'leaveRoomOnUnload.invalidJson',
      }
    }

    if (error instanceof HttpsError) {
      const nonRetryableCodes = new Set([
        'invalid-argument',
        'unauthenticated',
        'permission-denied',
        'not-found',
        'failed-precondition',
        'already-exists',
        'resource-exhausted',
      ])
      const retryable = !nonRetryableCodes.has(error.code)
      return {
        // unload 요청은 대부분 브라우저 종료 직전에 발생하므로 기능 오류는 200으로 수렴시켜
        // 기존 클라이언트 동작을 유지하되, 본문에 명시적 error code를 넣어 운영 추적성을 높인다.
        status: 200,
        body: { ok: false, error: error.code, retryable },
        logLevel: retryable ? 'error' : 'warn',
        logEvent: `leaveRoomOnUnload.httpsError.${error.code}`,
      }
    }

    return {
      status: 500,
      body: { ok: false, error: 'internal', retryable: true },
      logLevel: 'error',
      logEvent: 'leaveRoomOnUnload.internal',
    }
  }

  async function markPendingLeaveOnUnload(params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
  }): Promise<void> {
    const { roomId, playerId, sessionToken, joinToken, authUid } = params
    await deps.getRoom(roomId)
    await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

    const roomRef = deps.db.collection('rooms').doc(roomId)
    const playerRef = roomRef.collection('players').doc(playerId)
    const participantAuthRef = roomRef.collection('participantAuth').doc(playerId)
    const gracePeriodMs = Math.max(5_000, deps.leaveGracePeriodMs ?? DEFAULT_LEAVE_GRACE_PERIOD_MS)

    // 탭 닫기/앱 전환은 진짜 퇴장인지 애매해서, 바로 삭제하지 않고 짧게 복귀 시간을 준다.
    const markResult = await deps.db.runTransaction(async (tx) => {
      const [roomDoc, playerDoc, authDoc] = await Promise.all([
        tx.get(roomRef),
        tx.get(playerRef),
        tx.get(participantAuthRef),
      ])

      if (!roomDoc.exists || !playerDoc.exists || !authDoc.exists) {
        return { marked: false as const, reason: 'already-removed' as const }
      }

      const room = roomDoc.data() as { status?: RoomStatus }
      if (room.status !== STATUS_WAITING) {
        return { marked: false as const, reason: 'room-not-waiting' as const, status: room.status }
      }

      const now = Timestamp.now()
      const leaveGraceExpiresAt = Timestamp.fromMillis(now.toMillis() + gracePeriodMs)
      tx.update(participantAuthRef, {
        status: AUTH_STATUS_PENDING_LEAVE,
        leaveRequestedAt: now,
        leaveGraceExpiresAt,
        updatedAt: now,
      })

      return { marked: true as const, leaveGraceExpiresAtMillis: leaveGraceExpiresAt.toMillis() }
    })

    if (!markResult.marked) {
      deps.logInfo('room.leave.pending.skip', { roomId, playerId, reason: markResult.reason })
      return
    }

    deps.logInfo('room.leave.pending.marked', {
      roomId,
      playerId,
      leaveGraceExpiresAtMillis: markResult.leaveGraceExpiresAtMillis,
    })
  }

  async function executeLeaveRoom(params: {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    authUid?: string
  }): Promise<void> {
    const { roomId, playerId, sessionToken, joinToken, authUid } = params
    await deps.getRoom(roomId)
    await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })
    const roomRef = deps.db.collection('rooms').doc(roomId)
    const playersRef = roomRef.collection('players')
    const playerRef = playersRef.doc(playerId)
    const participantAuthRef = roomRef.collection('participantAuth').doc(playerId)

    const leaveResult = await deps.db.runTransaction(async (tx) => {
      const [roomDoc, playerDoc, playersSnapshot] = await Promise.all([
        tx.get(roomRef),
        tx.get(playerRef),
        tx.get(playersRef.orderBy('joinedAt', 'asc')),
      ])

      if (!roomDoc.exists) {
        throw new HttpsError('not-found', `Room ${roomId} not found`)
      }
      if (!playerDoc.exists) {
        throw new HttpsError('not-found', 'Player not found in room')
      }

      const now = Timestamp.now()
      const player = playerDoc.data() as { isHost?: boolean }
      const wasHost = player.isHost === true
      const remainingPlayerDocs = playersSnapshot.docs.filter((doc) => doc.id !== playerId)
      const remainingPlayers = remainingPlayerDocs.length

      tx.delete(playerRef)
      tx.delete(participantAuthRef)

      if (remainingPlayers === 0) {
        tx.delete(roomRef)
        return {
          wasHost,
          remainingPlayers,
          roomDeleted: true as const,
          deleteReason: wasHost ? ('emptyAfterHostLeave' as const) : ('lastPlayerLeft' as const),
        }
      }

      if (wasHost) {
        const newHostDoc = remainingPlayerDocs[0]
        const newHostId = newHostDoc?.id
        if (!newHostId) {
          throw new HttpsError('internal', 'Failed to resolve new host')
        }
        const newHostAuthUid = (newHostDoc.data() as { authUid?: string }).authUid
        if (!newHostAuthUid) {
          throw new HttpsError('internal', 'Failed to resolve new host auth identity')
        }

        tx.update(newHostDoc.ref, { isHost: true, updatedAt: now })
        tx.update(roomRef, { hostId: newHostId, hostAuthUid: newHostAuthUid, updatedAt: now })
        return {
          wasHost,
          remainingPlayers,
          roomDeleted: false as const,
          newHostId,
        }
      }

      return {
        wasHost,
        remainingPlayers,
        roomDeleted: false as const,
      }
    })

    if (leaveResult.roomDeleted) {
      if (leaveResult.deleteReason === 'emptyAfterHostLeave') {
        deps.logInfo('room.delete.emptyAfterHostLeave', { roomId })
      } else {
        deps.logInfo('room.delete.lastPlayerLeft', { roomId })
      }
    } else if (leaveResult.wasHost && leaveResult.newHostId) {
      deps.logInfo('room.host.transferred', { roomId, newHostId: leaveResult.newHostId, reason: 'host-left' })
    }

    deps.logInfo('room.leave.success', {
      roomId,
      playerId,
      wasHost: leaveResult.wasHost,
      remainingPlayers: leaveResult.remainingPlayers,
    })
  }

  async function executePendingLeaveCleanupBatch(): Promise<{ processed: number; finalized: number }> {
    const now = Timestamp.now()
    // collectionGroup은 전체 pending_leave를 훑을 수 있어서 배치 크기를 제한해 스케줄 함수가 길게 물리지 않게 한다.
    const pendingSnapshot = await deps.db
      .collectionGroup('participantAuth')
      .where('leaveGraceExpiresAt', '<=', now)
      .limit(Math.max(1, deps.pendingLeaveCleanupBatchSize ?? DEFAULT_PENDING_LEAVE_CLEANUP_BATCH_SIZE))
      .get()

    if (pendingSnapshot.empty) {
      return { processed: 0, finalized: 0 }
    }

    let finalized = 0
    await Promise.all(
      pendingSnapshot.docs.map(async (authDoc) => {
        const authRef = authDoc.ref
        const playerId = authRef.id
        const roomRef = authRef.parent.parent
        const roomId = roomRef?.id
        if (!roomRef || !roomId) {
          await authRef.delete()
          return
        }

        try {
          const cleanupResult = await deps.db.runTransaction(async (tx) => {
            const playerRef = roomRef.collection('players').doc(playerId)
            const playersRef = roomRef.collection('players')

            const [roomDoc, playerDoc, authDocInTx, playersSnapshot] = await Promise.all([
              tx.get(roomRef),
              tx.get(playerRef),
              tx.get(authRef),
              tx.get(playersRef.orderBy('joinedAt', 'asc')),
            ])

            if (!authDocInTx.exists) {
              return { finalized: false as const, reason: 'auth-not-found' as const }
            }

            const authData = authDocInTx.data() as {
              status?: string
              leaveGraceExpiresAt?: FirebaseFirestore.Timestamp
            }
            if (authData.status !== AUTH_STATUS_PENDING_LEAVE) {
              return { finalized: false as const, reason: 'status-not-pending' as const }
            }
            if (!authData.leaveGraceExpiresAt || authData.leaveGraceExpiresAt.toMillis() > now.toMillis()) {
              return { finalized: false as const, reason: 'grace-not-expired' as const }
            }

            if (!roomDoc.exists) {
              tx.delete(authRef)
              return { finalized: false as const, reason: 'room-not-found' as const }
            }

            const room = roomDoc.data() as { status?: RoomStatus }
            if (room.status !== STATUS_WAITING) {
              // 게임이 이미 시작된 방은 자동 퇴장으로 건드리면 진행 중인 상태가 깨질 수 있어 복귀 처리한다.
              tx.update(authRef, {
                status: AUTH_STATUS_ACTIVE,
                leaveRequestedAt: FieldValue.delete(),
                leaveGraceExpiresAt: FieldValue.delete(),
                updatedAt: now,
              })
              return { finalized: false as const, reason: 'room-not-waiting' as const, roomStatus: room.status }
            }

            if (!playerDoc.exists) {
              tx.delete(authRef)
              return { finalized: false as const, reason: 'player-not-found' as const }
            }

            const player = playerDoc.data() as { isHost?: boolean }
            const wasHost = player.isHost === true
            const remainingPlayerDocs = playersSnapshot.docs.filter((doc) => doc.id !== playerId)
            const remainingPlayers = remainingPlayerDocs.length
            tx.delete(playerRef)
            tx.delete(authRef)

            if (remainingPlayers === 0) {
              tx.delete(roomRef)
              return {
                finalized: true as const,
                wasHost,
                remainingPlayers,
                roomDeleted: true as const,
                deleteReason: wasHost
                  ? ('emptyAfterHostLeave' as const)
                  : ('lastPlayerLeft' as const),
              }
            }

            if (wasHost) {
              const newHostDoc = remainingPlayerDocs[0]
              const newHostId = newHostDoc?.id
              if (!newHostId) {
                throw new HttpsError('internal', 'Failed to resolve new host')
              }
              const newHostAuthUid = (newHostDoc.data() as { authUid?: string }).authUid
              if (!newHostAuthUid) {
                throw new HttpsError('internal', 'Failed to resolve new host auth identity')
              }
              tx.update(newHostDoc.ref, { isHost: true, updatedAt: now })
              tx.update(roomRef, { hostId: newHostId, hostAuthUid: newHostAuthUid, updatedAt: now })
              return {
                finalized: true as const,
                wasHost,
                remainingPlayers,
                roomDeleted: false as const,
                newHostId,
              }
            }

            tx.update(roomRef, { updatedAt: now })
            return {
              finalized: true as const,
              wasHost,
              remainingPlayers,
              roomDeleted: false as const,
            }
          })

          if (!cleanupResult.finalized) {
            deps.logInfo('room.leave.pending.cleanup.skip', { roomId, playerId, reason: cleanupResult.reason })
            return
          }

          finalized += 1
          if (cleanupResult.roomDeleted) {
            if (cleanupResult.deleteReason === 'emptyAfterHostLeave') {
              deps.logInfo('room.delete.emptyAfterHostLeave', { roomId, source: 'pending-leave-cleanup' })
            } else {
              deps.logInfo('room.delete.lastPlayerLeft', { roomId, source: 'pending-leave-cleanup' })
            }
          } else if (cleanupResult.wasHost && cleanupResult.newHostId) {
            deps.logInfo('room.host.transferred', {
              roomId,
              newHostId: cleanupResult.newHostId,
              reason: 'pending-host-leave-expired',
            })
          }

          deps.logInfo('room.leave.pending.finalized', {
            roomId,
            playerId,
            wasHost: cleanupResult.wasHost,
            remainingPlayers: cleanupResult.remainingPlayers,
          })
        } catch (error) {
          deps.logger.error('cleanupPendingLeaves item error', {
            roomId,
            playerId,
            error,
          })
        }
      }),
    )

    return { processed: pendingSnapshot.size, finalized }
  }

  const createGuestSession = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const hasClientProvidedGuestId =
          request.data !== null &&
          typeof request.data === 'object' &&
          Object.prototype.hasOwnProperty.call(request.data, 'guestId')
        if (hasClientProvidedGuestId) {
          deps.logWarn('session.guest.clientGuestIdIgnored', { providedField: 'guestId' })
        }

        const guestId = authUid
        const sessionToken = deps.createSessionToken()
        const sessionTokenHash = deps.hashSessionToken(sessionToken)
        const now = Timestamp.now()
        const expiresAt = Timestamp.fromMillis(now.toMillis() + deps.guestSessionTtlDays * MS_PER_DAY)

        await deps.db.collection('guestSessions').doc(guestId).set({
          sessionTokenHash,
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
        })

        deps.logInfo('session.guest.created', { guestId })
        return { authUid, guestId, sessionToken, expiresAtMillis: expiresAt.toMillis() }
      } catch (error) {
        deps.logger.error('createGuestSession error', error)
        rethrowUnexpected(error, 'Failed to create guest session')
      }
    },
  )

  const createRoom = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(createRoomSchema, request.data, {
          warnMessage: 'Invalid createRoom payload',
        })
        const { playerId, sessionToken, hostName, title, maxPlayers, roundCount, rerollLimit } =
          parsed
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const normalizedHostName = deps.normalizePlayerName(hostName)
        if (!deps.isValidPlayerName(normalizedHostName)) {
          throw new HttpsError('invalid-argument', 'Invalid host name')
        }

        await deps.verifyGuestSession(playerId, sessionToken)
        const roomRef = deps.db.collection('rooms').doc()
        const now = Timestamp.now()

        await roomRef.set({
          title,
          maxPlayers,
          roundCount,
          rerollLimit,
          rerollUsed: 0,
          hostId: playerId,
          hostAuthUid: authUid,
          status: STATUS_WAITING,
          currentSet: 1,
          createdAt: now,
          updatedAt: now,
        })

        await roomRef.collection('players').doc(playerId).set({
          name: normalizedHostName,
          isHost: true,
          authUid,
          isReady: false,
          selectedAugments: [],
          joinedAt: now,
        })

        const issued = await deps.issueRoomJoinToken(roomRef.id, playerId, authUid)
        deps.logInfo('room.create.success', {
          roomId: roomRef.id,
          hostPlayerId: playerId,
          status: STATUS_WAITING,
          maxPlayers,
        })

        return {
          roomId: roomRef.id,
          status: STATUS_WAITING,
          joinToken: issued.joinToken,
          joinTokenExpiresAtMillis: issued.expiresAtMillis,
        }
      } catch (error) {
        deps.logger.error('createRoom error', error)
        rethrowUnexpected(error, 'Failed to create room')
      }
    },
  )

  const joinRoom = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      let roomIdForLog: string | undefined
      let playerIdForLog: string | undefined
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(joinRoomSchema, request.data)
        const { roomId, playerId, sessionToken, playerName } = parsed
        roomIdForLog = roomId
        playerIdForLog = playerId
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const normalizedPlayerName = deps.normalizePlayerName(playerName)
        if (!deps.isValidPlayerName(normalizedPlayerName)) {
          throw new HttpsError('invalid-argument', 'Invalid player name')
        }
        await deps.verifyGuestSession(playerId, sessionToken)

        const joinResult = await deps.db.runTransaction(async (tx) => {
          const roomRef = deps.db.collection('rooms').doc(roomId)
          const roomDoc = await tx.get(roomRef)
          if (!roomDoc.exists) {
            throw new HttpsError('not-found', `Room ${roomId} not found`)
          }

          const room = roomDoc.data() as { status?: RoomStatus; maxPlayers?: number }
          const playerRef = roomRef.collection('players').doc(playerId)
          const playerDoc = await tx.get(playerRef)
          if (playerDoc.exists) {
            const existingPlayer = playerDoc.data() as { authUid?: string }
            if (existingPlayer.authUid && existingPlayer.authUid !== authUid) {
              throw new HttpsError('permission-denied', 'Player identity mismatch')
            }
            if (!existingPlayer.authUid) {
              tx.update(playerRef, { authUid, updatedAt: Timestamp.now() })
            }
            return { rejoined: true as const, roomStatus: room.status ?? STATUS_WAITING }
          }

          if (room.status !== STATUS_WAITING) {
            throw new HttpsError('failed-precondition', 'Room is not accepting new players', {
              roomStatus: room.status ?? 'unknown',
            })
          }

          const playersSnapshot = await tx.get(roomRef.collection('players'))
          const maxPlayers =
            typeof room.maxPlayers === 'number' ? room.maxPlayers : DEFAULT_MAX_PLAYERS
          if (playersSnapshot.size >= maxPlayers) {
            throw new HttpsError('resource-exhausted', 'Room is full', {
              maxPlayers,
              currentPlayers: playersSnapshot.size,
            })
          }

          tx.set(playerRef, {
            name: normalizedPlayerName,
            isHost: false,
            authUid,
            isReady: false,
            selectedAugments: [],
            joinedAt: Timestamp.now(),
          })
          tx.update(roomRef, { updatedAt: Timestamp.now() })

          return {
            rejoined: false as const,
            roomStatus: room.status ?? STATUS_WAITING,
            maxPlayers,
            currentPlayers: playersSnapshot.size + 1,
          }
        })

        if (joinResult.rejoined) {
          const issued = await deps.issueRoomJoinToken(roomId, playerId, authUid)
          deps.logInfo('room.join.rejoin', { roomId, playerId })
          return {
            success: true,
            playerId,
            joinToken: issued.joinToken,
            joinTokenExpiresAtMillis: issued.expiresAtMillis,
            rejoined: true,
          }
        }

        const issued = await deps.issueRoomJoinToken(roomId, playerId, authUid)
        deps.logInfo('room.join.success', {
          roomId,
          playerId,
          currentPlayers: joinResult.currentPlayers,
          maxPlayers: joinResult.maxPlayers,
        })
        return {
          success: true,
          playerId,
          joinToken: issued.joinToken,
          joinTokenExpiresAtMillis: issued.expiresAtMillis,
          rejoined: false,
        }
      } catch (error) {
        if (error instanceof HttpsError) {
          if (error.code === 'resource-exhausted') {
            deps.logWarn('room.join.denied.full', { roomId: roomIdForLog, playerId: playerIdForLog })
          } else if (error.code === 'failed-precondition') {
            deps.logWarn('room.join.denied.status', {
              roomId: roomIdForLog,
              playerId: playerIdForLog,
              status: (error.details as { roomStatus?: string } | undefined)?.roomStatus,
            })
          }
        }
        deps.logger.error('joinRoom error', error)
        rethrowUnexpected(error, 'Failed to join room')
      }
    },
  )

  const updatePlayerName = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(updatePlayerNameSchema, request.data)
        const { roomId, playerId, sessionToken, joinToken, name } = parsed
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const normalizedName = deps.normalizePlayerName(name)
        if (!deps.isValidPlayerName(normalizedName)) {
          throw new HttpsError('invalid-argument', 'Invalid player name')
        }

        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })
        await deps.db.collection('rooms').doc(roomId).collection('players').doc(playerId).update({
          name: normalizedName,
        })
        deps.logInfo('room.playerName.updated', { roomId, playerId, nameLength: normalizedName.length })
        return { success: true }
      } catch (error) {
        deps.logger.error('updatePlayerName error', error)
        rethrowUnexpected(error, 'Failed to update player name')
      }
    },
  )

  const setPlayerReady = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(setPlayerReadySchema, request.data)
        const { roomId, playerId, sessionToken, joinToken, isReady } = parsed
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        const room = await deps.getRoom(roomId)
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        if (room.status !== STATUS_WAITING) {
          throw new HttpsError('failed-precondition', 'Ready status can only be changed before game starts')
        }

        const playerRef = deps.db.collection('rooms').doc(roomId).collection('players').doc(playerId)
        await playerRef.update({ isReady })
        deps.logger.info('Player ready status updated', { roomId, playerId, isReady })
        return { success: true }
      } catch (error) {
        deps.logger.error('setPlayerReady error', error)
        rethrowUnexpected(error, 'Failed to update ready status')
      }
    },
  )

  const leaveRoom = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(leaveRoomSchema, request.data)
        if (parsed.playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        await executeLeaveRoom({ ...parsed, authUid })
        return { success: true }
      } catch (error) {
        deps.logger.error('leaveRoom error', error)
        rethrowUnexpected(error, 'Failed to leave room')
      }
    },
  )

  const leaveRoomOnUnload = onRequest(
    CALLABLE_OPTIONS,
    async (req, res) => {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' })
        return
      }

      try {
        const body = decodeUnloadBody(req.body, req.rawBody)
        const payload =
          body && typeof body === 'object' ? ((body as { data?: unknown }).data ?? body) : undefined
        const parsed = parseOrThrow(leaveRoomSchema, payload)
        await markPendingLeaveOnUnload(parsed)
        res.status(204).send()
      } catch (error) {
        const mapped = mapUnloadErrorToResponse(error)
        if (mapped.logLevel === 'warn') {
          deps.logger.warn(mapped.logEvent, error)
        } else {
          deps.logger.error(mapped.logEvent, error)
        }
        res.status(mapped.status).json(mapped.body)
      }
    },
  )

  const cleanupPendingLeaves = onSchedule(
    {
      region: 'asia-northeast3',
      schedule: 'every 2 minutes',
      timeZone: 'UTC',
    },
    async () => {
      const result = await executePendingLeaveCleanupBatch()
      deps.logInfo('room.leave.pending.cleanup.completed', result)
    },
  )

  const startGame = onCall(
    CALLABLE_OPTIONS,
    async (request) => {
      try {
        const authUid = requireAuthUid(request)
        const parsed = parseOrThrow(startGameSchema, request.data)
        const { roomId, playerId, sessionToken, joinToken } = parsed
        if (playerId !== authUid) {
          throw new HttpsError('permission-denied', 'Player identity mismatch')
        }
        // 기존 호출자는 없는 방을 먼저 not-found로 받기 때문에, 인증 세부 검사보다 방 존재 확인을 먼저 한다.
        await deps.getRoom(roomId)
        await deps.assertJoinedRoomPlayerRequest({ roomId, playerId, sessionToken, joinToken, authUid })

        const roomRef = deps.db.collection('rooms').doc(roomId)
        const startResult = await deps.db.runTransaction(async (tx) => {
          const now = Timestamp.now()
          const requesterRef = roomRef.collection('players').doc(playerId)
          const [roomDoc, requesterDoc, playersSnapshot, setsSnapshot] = await Promise.all([
            tx.get(roomRef),
            tx.get(requesterRef),
            tx.get(roomRef.collection('players')),
            tx.get(roomRef.collection('sets')),
          ])

          if (!roomDoc.exists) {
            throw new HttpsError('not-found', `Room ${roomId} not found`)
          }
          if (!requesterDoc.exists || (requesterDoc.data() as { isHost?: boolean }).isHost !== true) {
            throw new HttpsError('permission-denied', 'Only host can start the game')
          }

          const room = roomDoc.data() as { status?: RoomStatus }
          if (room.status !== STATUS_WAITING) {
            throw new HttpsError('failed-precondition', 'Game can only be started when room is in waiting status')
          }

          const playerDocs = playersSnapshot.docs
          const playerCount = playerDocs.length
          if (playerCount < 2) {
            throw new HttpsError('failed-precondition', 'At least 2 players are required to start the game')
          }

          const guestPlayers = playerDocs.filter(
            (doc) => (doc.data() as { isHost?: boolean }).isHost !== true,
          )
          const areAllGuestsReady =
            guestPlayers.length > 0 &&
            guestPlayers.every((doc) => (doc.data() as { isReady?: boolean }).isReady === true)
          if (!areAllGuestsReady) {
            throw new HttpsError('failed-precondition', 'All players must be ready before starting the game')
          }

          // 새 게임 시작 시 이전 라운드 데이터가 섞이지 않도록 플레이어/세트 상태를 한 트랜잭션에서 초기화한다.
          playerDocs.forEach((doc) => {
            tx.update(doc.ref, {
              selectedAugments: [],
              horseStats: FieldValue.delete(),
              currentSetLuckBonus: 0,
              rerollUsed: 0,
              updatedAt: now,
            })
          })

          setsSnapshot.docs.forEach((doc) => tx.delete(doc.ref))

          tx.update(roomRef, {
            status: STATUS_HORSE_SELECTION,
            currentSet: 1,
            rerollUsed: 0,
            updatedAt: now,
          })

          return { playerCount, deletedSetCount: setsSnapshot.size }
        })

        deps.logger.info('Game started', {
          roomId,
          playerCount: startResult.playerCount,
          deletedSetCount: startResult.deletedSetCount,
          mode: 'transaction',
        })
        return { success: true, status: STATUS_HORSE_SELECTION }
      } catch (error) {
        deps.logger.error('startGame error', error)
        rethrowUnexpected(error, 'Failed to start game')
      }
    },
  )

  return {
    createGuestSession,
    createRoom,
    joinRoom,
    updatePlayerName,
    setPlayerReady,
    leaveRoom,
    leaveRoomOnUnload,
    cleanupPendingLeaves,
    startGame,
  }
}
