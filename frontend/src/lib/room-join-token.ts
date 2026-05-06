const ROOM_JOIN_TOKEN_KEY = 'hybrid-horse-race-room-join-tokens'
const TOKEN_EXPIRY_BUFFER_MS = 30_000

interface StoredRoomJoinToken {
  joinToken: string
  expiresAtMillis: number
}

type RoomJoinTokenMap = Record<string, StoredRoomJoinToken>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeTokenMap(input: unknown): RoomJoinTokenMap {
  if (!isRecord(input)) {
    return {}
  }

  return Object.entries(input).reduce<RoomJoinTokenMap>((acc, [roomId, value]) => {
    if (!isRecord(value)) {
      return acc
    }
    const joinToken = value.joinToken
    const expiresAtMillis = value.expiresAtMillis
    if (typeof joinToken !== 'string' || joinToken.length === 0) {
      return acc
    }
    if (typeof expiresAtMillis !== 'number' || !Number.isFinite(expiresAtMillis)) {
      return acc
    }
    acc[roomId] = { joinToken, expiresAtMillis }
    return acc
  }, {})
}

function readMap(): RoomJoinTokenMap {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ROOM_JOIN_TOKEN_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    return sanitizeTokenMap(JSON.parse(raw))
  } catch {
    return {}
  }
}

function writeMap(map: RoomJoinTokenMap): void {
  try {
    localStorage.setItem(ROOM_JOIN_TOKEN_KEY, JSON.stringify(map))
  } catch {
    // 초대 토큰 캐시는 다시 발급받을 수 있으니 저장 실패만으로 화면을 막지 않는다.
  }
}

export function setRoomJoinToken(roomId: string, joinToken: string, expiresAtMillis: number): void {
  if (!roomId) return
  const map = readMap()
  map[roomId] = {
    joinToken,
    expiresAtMillis,
  }
  writeMap(map)
}

export function getRoomJoinToken(roomId: string): string | null {
  if (!roomId) return null
  const map = readMap()
  const entry = map[roomId]
  if (!entry) return null
  if (entry.expiresAtMillis <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    delete map[roomId]
    writeMap(map)
    return null
  }
  return entry.joinToken
}

export function clearRoomJoinToken(roomId: string): void {
  if (!roomId) return
  const map = readMap()
  delete map[roomId]
  writeMap(map)
}
