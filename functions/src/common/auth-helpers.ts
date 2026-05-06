import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

type TimestampApi = {
  now: () => FirebaseFirestore.Timestamp
  fromMillis: (millis: number) => FirebaseFirestore.Timestamp
}

type LogWarnFn = (event: string, payload: Record<string, unknown>) => void

type AuthHelperDeps = {
  db: FirebaseFirestore.Firestore
  timestamp: TimestampApi
  joinTokenTtlHours: number
  logWarn: LogWarnFn
}

const MS_PER_HOUR = 60 * 60 * 1000

function createOpaqueToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqualHashHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  try {
    // 토큰 비교 시간으로 값이 새는 일을 줄이려고 해시끼리 상수 시간 비교를 쓴다.
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  } catch {
    return false
  }
}

function isExpired(expireAt: FirebaseFirestore.Timestamp | undefined, nowMillis: number): boolean {
  return expireAt != null && expireAt.toMillis() <= nowMillis
}

export function createAuthHelpers(deps: AuthHelperDeps) {
  function createGuestId(): string {
    return `guest_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  }

  function createSessionToken(): string {
    return createOpaqueToken()
  }

  function hashSessionToken(sessionToken: string): string {
    return hashToken(sessionToken)
  }

  async function issueRoomJoinToken(
    roomId: string,
    playerId: string,
    authUid: string,
  ): Promise<{ joinToken: string; expiresAtMillis: number }> {
    const joinToken = createOpaqueToken()
    const now = deps.timestamp.now()
    const expiresAt = deps.timestamp.fromMillis(now.toMillis() + deps.joinTokenTtlHours * MS_PER_HOUR)
    const authRef = deps.db.collection('rooms').doc(roomId).collection('participantAuth').doc(playerId)
    const current = await authRef.get()
    const currentVersion = (current.data()?.tokenVersion as number | undefined) ?? 0

    await authRef.set({
      tokenHash: hashToken(joinToken),
      authUid,
      tokenVersion: currentVersion + 1,
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
      status: 'active',
    })

    return {
      joinToken,
      expiresAtMillis: expiresAt.toMillis(),
    }
  }

  async function verifyRoomJoinToken(
    roomId: string,
    playerId: string,
    joinToken: string,
    authUid?: string,
  ): Promise<void> {
    const authRef = deps.db.collection('rooms').doc(roomId).collection('participantAuth').doc(playerId)
    const authDoc = await authRef.get()

    if (!authDoc.exists) {
      deps.logWarn('auth.joinToken.notFound', { roomId, playerId })
      throw new HttpsError('permission-denied', 'Room join token not found')
    }

    const authData = authDoc.data() as {
      tokenHash?: string
      authUid?: string
      expiresAt?: FirebaseFirestore.Timestamp
      status?: 'active' | 'revoked'
    }

    if (authData.status !== 'active') {
      deps.logWarn('auth.joinToken.revoked', { roomId, playerId, status: authData.status })
      throw new HttpsError('permission-denied', 'Room join token revoked')
    }

    const storedHash = authData.tokenHash
    const presentedHash = hashToken(joinToken)
    if (!storedHash || !safeEqualHashHex(storedHash, presentedHash)) {
      deps.logWarn('auth.joinToken.invalid', { roomId, playerId })
      throw new HttpsError('permission-denied', 'Invalid room join token')
    }

    const now = deps.timestamp.now()
    const nowMillis = now.toMillis()
    if (isExpired(authData.expiresAt, nowMillis)) {
      deps.logWarn('auth.joinToken.expired', { roomId, playerId })
      throw new HttpsError('permission-denied', 'Room join token expired')
    }

    if (authUid && authData.authUid && authData.authUid !== authUid) {
      deps.logWarn('auth.joinToken.authUidMismatch', {
        roomId,
        playerId,
        expectedAuthUid: authData.authUid,
      })
      throw new HttpsError('permission-denied', 'Room join token owner mismatch')
    }

    await authRef.update({ lastSeenAt: now })
  }

  async function verifyGuestSession(playerId: string, sessionToken: string): Promise<void> {
    const sessionRef = deps.db.collection('guestSessions').doc(playerId)
    const sessionDoc = await sessionRef.get()

    if (!sessionDoc.exists) {
      deps.logWarn('auth.guestSession.notFound', { playerId })
      throw new HttpsError('unauthenticated', 'Guest session not found')
    }

    const session = sessionDoc.data() as {
      sessionTokenHash?: string
      sessionToken?: string
      expiresAt?: FirebaseFirestore.Timestamp
    }

    const now = deps.timestamp.now()
    if (isExpired(session.expiresAt, now.toMillis())) {
      deps.logWarn('auth.guestSession.expired', { playerId })
      throw new HttpsError('unauthenticated', 'Guest session expired')
    }

    const presentedHash = hashToken(sessionToken)
    const storedHash = session.sessionTokenHash
    const legacyToken = session.sessionToken

    if (storedHash) {
      if (!safeEqualHashHex(storedHash, presentedHash)) {
        deps.logWarn('auth.guestSession.invalid', { playerId, mode: 'hash' })
        throw new HttpsError('permission-denied', 'Invalid guest session token')
      }
      await sessionRef.update({ lastSeenAt: now })
      return
    }

    if (legacyToken) {
      // 예전 세션 문서는 평문 토큰이 남아 있을 수 있어서, 검증에 성공한 순간 해시 저장으로 갈아탄다.
      const legacyHash = hashToken(legacyToken)
      if (!safeEqualHashHex(legacyHash, presentedHash)) {
        deps.logWarn('auth.guestSession.invalid', { playerId, mode: 'legacy' })
        throw new HttpsError('permission-denied', 'Invalid guest session token')
      }

      await sessionRef.update({
        sessionTokenHash: legacyHash,
        sessionToken: FieldValue.delete(),
        lastSeenAt: now,
      })
      return
    }

    deps.logWarn('auth.guestSession.invalid', { playerId, mode: 'missing-token' })
    throw new HttpsError('permission-denied', 'Invalid guest session token')
  }

  return {
    createGuestId,
    createSessionToken,
    hashSessionToken,
    issueRoomJoinToken,
    verifyRoomJoinToken,
    verifyGuestSession,
  }
}
