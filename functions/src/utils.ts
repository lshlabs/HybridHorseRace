import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import type { Room, Player, RoomStatus } from './types'

function getDb(): FirebaseFirestore.Firestore {
  return getFirestore()
}

function getRoomRef(db: FirebaseFirestore.Firestore, roomId: string) {
  return db.collection('rooms').doc(roomId)
}

function getPlayersRef(db: FirebaseFirestore.Firestore, roomId: string) {
  return getRoomRef(db, roomId).collection('players')
}

export async function getRoom(roomId: string): Promise<Room> {
  const db = getDb()
  const roomRef = getRoomRef(db, roomId)
  const roomDoc = await roomRef.get()

  if (!roomDoc.exists) {
    throw new HttpsError('not-found', `Room ${roomId} not found`)
  }

  return roomDoc.data() as Room
}

export async function getPlayer(roomId: string, playerId: string): Promise<Player | null> {
  const db = getDb()
  const playerRef = getPlayersRef(db, roomId).doc(playerId)
  const playerDoc = await playerRef.get()

  if (!playerDoc.exists) {
    return null
  }

  return playerDoc.data() as Player
}

export async function updateRoomStatus(roomId: string, status: RoomStatus): Promise<void> {
  const db = getDb()
  const roomRef = getRoomRef(db, roomId)
  await roomRef.update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
  })
}

export async function isHost(roomId: string, playerId: string): Promise<boolean> {
  const player = await getPlayer(roomId, playerId)
  return player?.isHost === true
}

export async function isPlayerInRoom(roomId: string, playerId: string): Promise<boolean> {
  const player = await getPlayer(roomId, playerId)
  return player !== null
}
