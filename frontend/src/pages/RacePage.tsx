import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PhaserGame } from '../components/game/PhaserGame'
import { Spinner } from '../components/ui/Spinner'
import { useRoom, type Room, type Player } from '../hooks/useRoom'
import type { Stats } from '../engine/race/types'
import { formatNickname, type NicknameData } from '../utils/nickname-generator'
import { getGuestSession } from '../lib/user-id'
import { getRoomJoinToken } from '../lib/room-join-token'

interface SavedHorseData {
  name: string
  stats: Stats
  totalStats: number
  selectedAt: string
}

interface RaceFinalResultDetail {
  roundResults: Array<
    Array<{
      rank: number
      name: string
      time: number
      finished: boolean
      augments?: unknown[]
    }>
  >
  playerCount: number
  roomId?: string
  playerId?: string
  playerName?: string
}

type DevRoomConfig = {
  playerCount: number
  roundCount: number
  rerollLimit: number
}

const DEFAULT_ROOM_CONFIG: DevRoomConfig = {
  playerCount: 4,
  roundCount: 3,
  rerollLimit: 2,
}
const HORSE_POLL_INTERVAL_MS = 2000
const RACE_FINAL_RESULT_EVENT = 'race-final-result'
const ROOM_STATUS_WAITING = 'waiting'
const ROOM_STATUS_HORSE_SELECTION = 'horseSelection'
const ROOM_STATUS_FINISHED = 'finished'

function readJsonRecord<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function loadRoomConfig(): DevRoomConfig {
  return readJsonRecord<DevRoomConfig>('dev_room_config', DEFAULT_ROOM_CONFIG)
}

export function RacePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const roomId = searchParams.get('roomId')
  const queryPlayerId = searchParams.get('playerId')
  const [sessionPlayerId, setSessionPlayerId] = useState('')
  const playerId = roomId
    ? queryPlayerId || sessionPlayerId
    : queryPlayerId || localStorage.getItem('dev_player_id') || 'player-0'
  const [sessionToken, setSessionToken] = useState('')
  const roomJoinToken = roomId ? getRoomJoinToken(roomId) : null
  const canSubscribeRealtimeRoom = !roomId || (!!playerId && !!sessionToken)
  const canSubscribeRealtimePlayers = !roomId || !!roomJoinToken
  const { room, players, loading } = useRoom(roomId, {
    enabled: canSubscribeRealtimeRoom,
    subscribePlayers: canSubscribeRealtimePlayers,
  })
  const isDev = import.meta.env.DEV

  const navigateWithRoomAndPlayer = (pathname: '/lobby' | '/horse-selection' | '/race-result') => {
    if (!roomId || !playerId) return
    const params = new URLSearchParams({ roomId, playerId })
    navigate(`${pathname}?${params.toString()}`, { replace: true })
  }

  const handleRoomStatusRedirect = (status: string) => {
    if (status === ROOM_STATUS_WAITING) {
      navigateWithRoomAndPlayer('/lobby')
      return
    }

    if (status === ROOM_STATUS_HORSE_SELECTION) {
      navigateWithRoomAndPlayer('/horse-selection')
      return
    }

    if (status === ROOM_STATUS_FINISHED) {
      navigateWithRoomAndPlayer('/race-result')
    }
  }

  const buildRaceResultNavigationState = (detail: RaceFinalResultDetail) => {
    return {
      roundResults: detail.roundResults,
      playerCount: detail.playerCount,
      roomId: detail.roomId || roomId || '',
      playerId: detail.playerId || playerId,
      playerName: detail.playerName,
    }
  }

  useEffect(() => {
    void getGuestSession().then((session) => {
      setSessionPlayerId(session.guestId)
      setSessionToken(session.sessionToken)
    })
  }, [])

  const roomConfig = loadRoomConfig()
  const isRealtimeRoom = !!roomId
  const currentRealtimePlayer = isRealtimeRoom
    ? players.find((player) => player.id === playerId) ?? null
    : null
  const isRealtimeGameDataReady =
    !!room &&
    !!playerId &&
    !!sessionToken &&
    !!roomJoinToken &&
    players.length > 0 &&
    !!currentRealtimePlayer
  const playerCount = isRealtimeRoom ? players.length : players.length || roomConfig.playerCount
  const roundCount = room?.roundCount ?? roomConfig.roundCount
  const rerollLimit = room?.rerollLimit ?? roomConfig.rerollLimit

  const [storageSelectedHorse, setStorageSelectedHorse] = useState<SavedHorseData | null>(null)

  // RaceScene에서 보내는 최종 결과 커스텀 이벤트를 받아 결과 페이지로 이동한다.
  useEffect(() => {
    const handleFinalResult = (event: Event) => {
      const customEvent = event as CustomEvent<RaceFinalResultDetail>
      navigate('/race-result', {
        state: buildRaceResultNavigationState(customEvent.detail),
      })
    }

    window.addEventListener(RACE_FINAL_RESULT_EVENT, handleFinalResult)

    return () => {
      window.removeEventListener(RACE_FINAL_RESULT_EVENT, handleFinalResult)
    }
  }, [navigate, roomId, playerId])

  useEffect(() => {
    if (!roomId) {
      navigate('/', { replace: true })
      return
    }
    if (!loading && !room) {
      navigate('/', { replace: true })
    }
  }, [loading, navigate, room, roomId])

  useEffect(() => {
    if (!roomId || !room || !playerId) return
    handleRoomStatusRedirect(room.status)
  }, [navigate, playerId, room, roomId])

  useEffect(() => {
    if (!isDev || !playerId) return

    const loadHorseData = () => {
      try {
        const saved = localStorage.getItem('dev_selected_horses')
        if (saved) {
          const horsesData = JSON.parse(saved) as Record<string, SavedHorseData>
          const horseData = horsesData[playerId]
          if (horseData) {
            setStorageSelectedHorse((prev) => {
              if (
                prev &&
                prev.name === horseData.name &&
                prev.selectedAt === horseData.selectedAt
              ) {
                return prev
              }
              return horseData
            })
          }
        }
      } catch (err) {
        console.warn('[RacePageTest] Failed to read from localStorage:', err)
      }
    }

    loadHorseData()

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'dev_selected_horses') {
        loadHorseData()
      }
    }

    window.addEventListener('storage', handleStorageChange)
    const interval = setInterval(loadHorseData, HORSE_POLL_INTERVAL_MS)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      clearInterval(interval)
    }
  }, [isDev, playerId])

  const selectedHorseFromPlayers = (() => {
    if (!playerId || players.length === 0) return null
    const currentPlayer = players.find((p) => p.id === playerId)
    if (!currentPlayer?.horseStats) return null

    const totalStats =
      currentPlayer.horseStats.Speed +
      currentPlayer.horseStats.Stamina +
      currentPlayer.horseStats.Power +
      currentPlayer.horseStats.Guts +
      currentPlayer.horseStats.Start +
      currentPlayer.horseStats.Luck

    return {
      name: currentPlayer.name,
      stats: currentPlayer.horseStats,
      totalStats,
      selectedAt: new Date().toISOString(),
    }
  })()

  const selectedHorse = selectedHorseFromPlayers ?? storageSelectedHorse

  const mockRoom: Room = {
    title: `테스트 룸 (${roomId || 'test-room-123'})`,
    maxPlayers: playerCount,
    roundCount,
    rerollLimit,
    rerollUsed: 0,
    status: 'racing',
    currentSet: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const { i18n } = useTranslation()
  const currentLanguage = i18n.language

  const loadMockPlayersFromStorage = (): Player[] => {
    try {
      const playerIds = readJsonRecord<string[]>('dev_player_ids', [])
      const nicknameDataMap = readJsonRecord<Record<string, NicknameData>>(
        'dev_player_nickname_data',
        {},
      )
      const customNames = readJsonRecord<Record<string, string>>('dev_player_custom_names', {})
      const selectedHorses = readJsonRecord<Record<string, SavedHorseData>>(
        'dev_selected_horses',
        {},
      )

      if (playerIds.length === 0) {
        return []
      }

      return playerIds.map(
        (id, index): Player => ({
          id,
          name:
            customNames[id] ||
            (nicknameDataMap[id] ? formatNickname(nicknameDataMap[id]) : `플레이어 ${index + 1}`),
          isHost: index === 0,
          isReady: true,
          selectedAugments: [] as Player['selectedAugments'],
          horseStats: selectedHorses[id]?.stats || undefined,
          joinedAt: new Date(),
        }),
      )
    } catch (err) {
      console.warn('[RacePageTest] Failed to load players from localStorage:', err)
      return []
    }
  }

  const [mockPlayers] = useState<Player[]>(() => (isDev ? loadMockPlayersFromStorage() : []))

  const localizedMockPlayers = (() => {
    try {
      void currentLanguage
      const nicknameDataMap = readJsonRecord<Record<string, NicknameData>>(
        'dev_player_nickname_data',
        {},
      )
      const customNames = readJsonRecord<Record<string, string>>('dev_player_custom_names', {})

      return mockPlayers.map((player) => {
        if (!player.id) return player

        if (customNames[player.id]) {
          return { ...player, name: customNames[player.id] }
        }

        if (nicknameDataMap[player.id]) {
          return { ...player, name: formatNickname(nicknameDataMap[player.id]) }
        }

        return player
      })
    } catch (err) {
      console.warn('[RacePageTest] Failed to update player names on language change:', err)
      return mockPlayers
    }
  })()

  if (isRealtimeRoom && !isRealtimeGameDataReady) {
    return (
      <div className="flex w-full flex-1 items-center justify-center overflow-hidden">
        <Spinner className="text-primary" size={24} />
      </div>
    )
  }

  const phaserRoom: Room = isRealtimeRoom ? room! : mockRoom
  const phaserPlayers = isRealtimeRoom ? players : localizedMockPlayers
  const phaserSelectedHorse = isRealtimeRoom ? selectedHorseFromPlayers : selectedHorse

  return (
    <div className="flex w-full flex-1 items-center justify-center overflow-hidden">
      <div className="flex w-full flex-1 items-center justify-center overflow-hidden">
        <div className="max-w-full">
          <PhaserGame
            aspectRatioWidth={1280}
            aspectRatioHeight={720}
            roomId={roomId || undefined}
            playerId={playerId}
            sessionToken={sessionToken}
            roomJoinToken={roomJoinToken}
            room={phaserRoom}
            players={phaserPlayers}
            selectedHorse={phaserSelectedHorse ?? undefined}
          />
        </div>
      </div>
    </div>
  )
}
