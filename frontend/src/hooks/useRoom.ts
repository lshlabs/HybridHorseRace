import { useEffect, useState } from 'react'
import {
  doc,
  onSnapshot,
  collection,
  query,
  orderBy,
  type FirestoreError,
  type Timestamp,
} from 'firebase/firestore'
import { getFirebaseDb } from '../lib/firebase'
import type { Stats } from '../engine/race/types'

const DEFAULT_ROOM_MAX_PLAYERS = 8

export type RoomStatus =
  | 'waiting'
  | 'horseSelection'
  | 'augmentSelection'
  | 'racing'
  | 'setResult'
  | 'finished'

export interface Room {
  title: string
  maxPlayers: number
  roundCount: number
  rerollLimit: number
  rerollUsed: number
  status: RoomStatus
  currentSet: number
  createdAt: Date | Timestamp
  updatedAt: Date | Timestamp
}

export interface Player {
  id?: string
  name: string
  avatar?: string
  isHost: boolean
  isReady: boolean
  rerollUsed?: number
  currentSetLuckBonus?: number
  selectedAugments: Array<{
    setIndex: number
    augmentId: string
  }>
  horseStats?: Stats
  joinedAt: Date | Timestamp
}

interface UseRoomResult {
  room: Room | null
  players: Player[]
  loading: boolean
  error: FirestoreError | null
}

interface UseRoomOptions {
  enabled?: boolean
  subscribePlayers?: boolean
}

function toDateIfFirestoreTimestamp(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const maybeTimestamp = value as { toDate?: () => Date }
  return typeof maybeTimestamp.toDate === 'function' ? maybeTimestamp.toDate() : value
}

function mapRoomData(data: Record<string, unknown>): Room {
  return {
    ...data,
    maxPlayers: typeof data.maxPlayers === 'number' ? data.maxPlayers : DEFAULT_ROOM_MAX_PLAYERS,
    createdAt: toDateIfFirestoreTimestamp(data.createdAt) as Date | Timestamp,
    updatedAt: toDateIfFirestoreTimestamp(data.updatedAt) as Date | Timestamp,
  } as Room
}

function mapPlayerData(playerId: string, data: Record<string, unknown>): Player {
  return {
    id: playerId,
    ...data,
    joinedAt: toDateIfFirestoreTimestamp(data.joinedAt) as Date | Timestamp,
  } as Player
}

export function useRoom(roomId: string | null, options: UseRoomOptions = {}): UseRoomResult {
  const enabled = options.enabled ?? true
  const subscribePlayers = options.subscribePlayers ?? true
  const [room, setRoom] = useState<Room | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<FirestoreError | null>(null)

  useEffect(() => {
    if (!roomId || !enabled) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setRoom(null)
      setPlayers([])
      setLoading(!!roomId && !enabled)
      setError(null)
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }

    const db = getFirebaseDb()
    setLoading(true)
    setError(null)

    const subscribeRoomDocument = () => {
      const roomDocRef = doc(db, 'rooms', roomId)
      return onSnapshot(
        roomDocRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            setRoom(null)
            setLoading(false)
            return
          }

          setRoom(mapRoomData(snapshot.data() as Record<string, unknown>))
          setLoading(false)
        },
        (err) => {
          console.warn('Room subscription error:', err)
          setError(err)
          setLoading(false)
        },
      )
    }

    const subscribePlayersCollection = () => {
      const playersCollectionRef = collection(db, 'rooms', roomId, 'players')
      const playersQuery = query(playersCollectionRef, orderBy('joinedAt', 'asc'))
      return onSnapshot(
        playersQuery,
        (snapshot) => {
          const nextPlayers = snapshot.docs.map((playerDoc) =>
            mapPlayerData(playerDoc.id, playerDoc.data() as Record<string, unknown>),
          )
          setPlayers(nextPlayers)
        },
        (err) => {
          console.warn('Players subscription error:', err)
        },
      )
    }

    const unsubscribeRoom = subscribeRoomDocument()
    const unsubscribePlayers = subscribePlayers ? subscribePlayersCollection() : undefined
    if (!subscribePlayers) {
      setPlayers([])
    }

    return () => {
      unsubscribeRoom()
      unsubscribePlayers?.()
    }
  }, [enabled, roomId, subscribePlayers])

  return { room, players, loading, error }
}
