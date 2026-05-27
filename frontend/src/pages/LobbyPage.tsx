import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Copy, Check, Crown, SquarePen } from 'lucide-react'
import clsx from 'clsx'
import { withGuestSessionRetry } from '../lib/user-id'
import { useRoom, type Player, type RoomStatus } from '../hooks/useRoom'
import { getFirebaseApp } from '../lib/firebase'
import {
  joinRoom as joinRoomCallable,
  leaveRoom as leaveRoomCallable,
  setPlayerReady as setPlayerReadyCallable,
  startGame as startGameCallable,
  updatePlayerName as updatePlayerNameCallable,
} from '../lib/firebase-functions'
import { getRoomJoinToken, setRoomJoinToken } from '../lib/room-join-token'
import { resolvePlayerDisplayName } from '../lib/player-name'
import { Spinner } from '../components/ui/Spinner'
import { Badge } from '../components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

function registerWaitingRoomExitLeaveHandlers(onLeave: () => void): () => void {
  window.addEventListener('pagehide', onLeave)
  window.addEventListener('beforeunload', onLeave)

  return () => {
    window.removeEventListener('pagehide', onLeave)
    window.removeEventListener('beforeunload', onLeave)
  }
}

const RELOAD_REDIRECT_KEY = 'lobby.reload.redirect'
const RELOAD_REDIRECT_WINDOW_MS = 10000

const ROOM_STATUS_WAITING: RoomStatus = 'waiting'
const ROOM_STATUS_HORSE_SELECTION: RoomStatus = 'horseSelection'
const ROOM_STATUS_AUGMENT_SELECTION: RoomStatus = 'augmentSelection'
const ROOM_STATUS_RACING: RoomStatus = 'racing'
const ROOM_STATUS_SET_RESULT: RoomStatus = 'setResult'
const ROOM_STATUS_FINISHED: RoomStatus = 'finished'

const NAME_MIN_LENGTH = 2
const NAME_MAX_LENGTH = 12
const NAME_PATTERN = /^[a-zA-Z0-9가-힣\s]+$/
const AUTO_JOIN_DEDUPE_WINDOW_MS = 2000

function validatePlayerName(name: string): boolean {
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) return false
  return NAME_PATTERN.test(name)
}

function getPlayerNameErrorMessage(name: string): string | null {
  const trimmedName = name.trim()
  if (!trimmedName) return null
  if (validatePlayerName(trimmedName)) return null
  if (trimmedName.length < NAME_MIN_LENGTH) {
    return `이름은 최소 ${NAME_MIN_LENGTH}자 이상이어야 합니다.`
  }
  if (trimmedName.length > NAME_MAX_LENGTH) {
    return `이름은 최대 ${NAME_MAX_LENGTH}자까지 입력할 수 있습니다.`
  }
  return '숫자, 영어, 한글, 공백만 사용할 수 있습니다.'
}

type LobbyConnectionState =
  | 'bootstrapping'
  | 'syncing'
  | 'joining'
  | 'reconnecting'
  | 'joined'
  | 'left'
  | 'error'

export function LobbyPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const roomId = searchParams.get('roomId')

  const [playerId, setPlayerId] = useState<string>('')
  const [sessionToken, setSessionToken] = useState<string>('')
  const [roomJoinToken, setRoomJoinTokenState] = useState<string | null>(
    roomId ? getRoomJoinToken(roomId) : null,
  )
  const [isJoiningRoom, setIsJoiningRoom] = useState(false)
  const [joinAttemptCount, setJoinAttemptCount] = useState(0)
  const [isTogglingReady, setIsTogglingReady] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isCopied, setIsCopied] = useState(false)
  const [isUrlVisible, setIsUrlVisible] = useState(false)
  const [isNameEditDialogOpen, setIsNameEditDialogOpen] = useState(false)
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [newPlayerName, setNewPlayerName] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [lobbyConnectionState, setLobbyConnectionState] =
    useState<LobbyConnectionState>('bootstrapping')
  const [optimisticJoinedPlayerId, setOptimisticJoinedPlayerId] = useState<string | null>(null)
  const canSubscribeRoom = !!playerId && !!sessionToken
  const canSubscribePlayers = !!roomJoinToken || optimisticJoinedPlayerId === playerId
  const { room, players, loading, error: roomError } = useRoom(roomId, {
    enabled: canSubscribeRoom,
    subscribePlayers: canSubscribePlayers,
  })

  const hasLeaveSentRef = useRef(false)
  const roomIdRef = useRef<string | null>(null)
  const playerIdRef = useRef<string>('')
  const sessionTokenRef = useRef<string>('')
  const roomJoinTokenRef = useRef<string | null>(null)
  const roomStatusRef = useRef<RoomStatus | null>(null)
  const lastAutoJoinAttemptRef = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    const navigationEntry = performance
      .getEntriesByType('navigation')
      .find(
        (entry): entry is PerformanceNavigationTiming =>
          entry instanceof PerformanceNavigationTiming,
      )

    if (navigationEntry?.type !== 'reload') return
    const raw = sessionStorage.getItem(RELOAD_REDIRECT_KEY)
    if (!raw) return
    sessionStorage.removeItem(RELOAD_REDIRECT_KEY)
    try {
      const parsed = JSON.parse(raw) as { roomId?: string; at?: number }
      const isRecent =
        typeof parsed.at === 'number' && Date.now() - parsed.at <= RELOAD_REDIRECT_WINDOW_MS
      const isSameRoom =
        typeof parsed.roomId === 'string' && parsed.roomId.length > 0 && parsed.roomId === roomId
      if (isRecent && isSameRoom) {
        navigate('/', { replace: true })
      }
    } catch {
      // 세션 스토리지가 깨져도 로비 진입 자체는 막지 않는다.
    }
  }, [navigate, roomId])

  useEffect(() => {
    void withGuestSessionRetry(async (session) => {
      setPlayerId(session.guestId)
      setSessionToken(session.sessionToken)
      return null
    })
  }, [])

  useEffect(() => {
    setRoomJoinTokenState(roomId ? getRoomJoinToken(roomId) : null)
  }, [roomId])

  useEffect(() => {
    setJoinAttemptCount(0)
    setOptimisticJoinedPlayerId(null)
  }, [roomId, playerId])

  useEffect(() => {
    roomIdRef.current = roomId
  }, [roomId])

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  useEffect(() => {
    sessionTokenRef.current = sessionToken
  }, [sessionToken])

  useEffect(() => {
    roomJoinTokenRef.current = roomJoinToken
  }, [roomJoinToken])

  useEffect(() => {
    roomStatusRef.current = room?.status ?? null
  }, [room?.status])

  const getLeaveRoomUrl = useCallback((): string | null => {
    const projectId = getFirebaseApp().options.projectId
    if (!projectId) return null

    const region = 'asia-northeast3'
    const useEmulator = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'
    if (useEmulator) {
      const emulatorHost = import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST || '127.0.0.1'
      const emulatorPort = Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001)
      return `http://${emulatorHost}:${emulatorPort}/${projectId}/${region}/leaveRoomOnUnload`
    }

    return `https://${region}-${projectId}.cloudfunctions.net/leaveRoomOnUnload`
  }, [])

  const postLeaveKeepalive = useCallback(
    (payload: {
      roomId: string
      playerId: string
      sessionToken: string
      joinToken: string
    }): void => {
      const url = getLeaveRoomUrl()
      if (!url) return

      const body = JSON.stringify(payload)

      if (typeof navigator.sendBeacon === 'function') {
        // unload 순간에는 일반 fetch가 끊길 수 있어 sendBeacon을 먼저 시도한다.
        const sent = navigator.sendBeacon(url, body)
        if (sent) return
      }

      void fetch(url, {
        method: 'POST',
        body,
        keepalive: true,
        mode: 'no-cors',
      }).catch(() => {
        // 페이지가 닫히는 중이라 실패를 사용자에게 보여줄 방법도 없고, 서버 정리 작업이 한 번 더 확인한다.
      })
    },
    [getLeaveRoomUrl],
  )

  const getWaitingRoomLeavePayload = useCallback((): {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
  } | null => {
    if (roomStatusRef.current !== ROOM_STATUS_WAITING) return null

    const rid = roomIdRef.current
    const pid = playerIdRef.current
    const st = sessionTokenRef.current
    const jt = roomJoinTokenRef.current

    if (!rid || !pid || !st || !jt) return null

    return {
      roomId: rid,
      playerId: pid,
      sessionToken: st,
      joinToken: jt,
    }
  }, [])

  const tryLeaveRoomOnExit = useCallback((): void => {
    if (hasLeaveSentRef.current) return
    const payload = getWaitingRoomLeavePayload()
    if (!payload) return

    hasLeaveSentRef.current = true
    sessionStorage.setItem(
      RELOAD_REDIRECT_KEY,
      JSON.stringify({ roomId: payload.roomId, at: Date.now() }),
    )
    postLeaveKeepalive(payload)
  }, [getWaitingRoomLeavePayload, postLeaveKeepalive])

  useEffect(() => {
    return registerWaitingRoomExitLeaveHandlers(tryLeaveRoomOnExit)
  }, [tryLeaveRoomOnExit])

  useEffect(() => {
    const handleDocumentClickCapture = (event: MouseEvent) => {
      const target = event.target as Element | null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return
      try {
        const destination = new URL(anchor.href, window.location.href)
        if (destination.origin !== window.location.origin) {
          tryLeaveRoomOnExit()
        }
      } catch {
        // 잘못된 href 하나 때문에 전체 클릭 흐름이 막히면 안 된다.
      }
    }

    document.addEventListener('click', handleDocumentClickCapture, true)
    return () => {
      document.removeEventListener('click', handleDocumentClickCapture, true)
    }
  }, [tryLeaveRoomOnExit])

  useEffect(() => {
    return () => {
      if (hasLeaveSentRef.current) return
      const payload = getWaitingRoomLeavePayload()
      if (!payload) return
      hasLeaveSentRef.current = true
      void leaveRoomCallable(payload).catch(() => {
        // 라우트 전환 중 실패해도 pending leave 정리 흐름과 다음 접속에서 다시 맞춰진다.
      })
    }
  }, [getWaitingRoomLeavePayload])

  const shouldAutoJoinRoom = useCallback((): boolean => {
    if (!roomId || !room || isJoiningRoom) return false
    if (room.status !== ROOM_STATUS_WAITING) return false
    if (!playerId || !sessionToken) return false
    if (joinAttemptCount >= 2) return false
    return true
  }, [isJoiningRoom, joinAttemptCount, playerId, room, roomId, sessionToken])

  const handleAutoJoinRoomFailure = useCallback(
    (error: unknown) => {
      setJoinAttemptCount((count) => count + 1)
      setErrorMessage(t('navigation.createFailed'))
      console.warn('[LobbyPage] joinRoom callable failed:', error)
    },
    [t],
  )

  const reportLobbyActionError = (logMessage: string, error: unknown, messageKey: string) => {
    console.error(logMessage, error)
    setErrorMessage(t(messageKey))
  }

  const requireRealtimeRoomActionRoomId = (): string => {
    if (!roomId || !room) {
      throw new Error('Room is not ready for realtime actions')
    }
    return roomId
  }

  const requireSessionToken = (): string => {
    if (!sessionToken) {
      throw new Error('Missing session token')
    }
    return sessionToken
  }

  const runAutoJoinRoom = useCallback(async () => {
    if (!roomId) return

    await withGuestSessionRetry(async (session) => {
      const activePlayerId = session.guestId

      if (playerId !== activePlayerId) {
        setPlayerId(activePlayerId)
      }
      if (sessionToken !== session.sessionToken) {
        setSessionToken(session.sessionToken)
      }

      const isAlreadyInRoom = players.some((player) => player.id === activePlayerId)
      if (isAlreadyInRoom && roomJoinToken) {
        return null
      }

      const autoJoinAttemptKey = `${roomId}:${activePlayerId}:${session.sessionToken}`
      const previousAttempt = lastAutoJoinAttemptRef.current
      const now = Date.now()
      const isDuplicateInWindow =
        previousAttempt?.key === autoJoinAttemptKey &&
        now - previousAttempt.at < AUTO_JOIN_DEDUPE_WINDOW_MS
      if (isDuplicateInWindow) {
        // room snapshot과 세션 초기화가 거의 동시에 끝나면 자동 참가가 두 번 돌 수 있어 짧게 막는다.
        return null
      }
      lastAutoJoinAttemptRef.current = { key: autoJoinAttemptKey, at: now }

      const playerName = resolvePlayerDisplayName(activePlayerId)
      const response = await joinRoomCallable({
        roomId,
        playerId: activePlayerId,
        sessionToken: session.sessionToken,
        playerName,
      })

      setRoomJoinToken(roomId, response.data.joinToken, response.data.joinTokenExpiresAtMillis)
      setRoomJoinTokenState(response.data.joinToken)
      setOptimisticJoinedPlayerId(activePlayerId)
      setJoinAttemptCount(0)
      return null
    })
  }, [playerId, players, roomId, roomJoinToken, sessionToken])

  const executeJoinRoomAttempt = useCallback(async () => {
    setIsJoiningRoom(true)
    try {
      await runAutoJoinRoom()
    } catch (error) {
      handleAutoJoinRoomFailure(error)
    } finally {
      setIsJoiningRoom(false)
    }
  }, [handleAutoJoinRoomFailure, runAutoJoinRoom])

  useEffect(() => {
    if (!shouldAutoJoinRoom()) return

    void executeJoinRoomAttempt()
  }, [
    roomId,
    room,
    players,
    playerId,
    sessionToken,
    isJoiningRoom,
    roomJoinToken,
    joinAttemptCount,
    executeJoinRoomAttempt,
    shouldAutoJoinRoom,
  ])

  useEffect(() => {
    if (!roomId) {
      setLobbyConnectionState('left')
      return
    }
    if (roomError) {
      setLobbyConnectionState('error')
      return
    }
    if (!playerId || !sessionToken) {
      setLobbyConnectionState('bootstrapping')
      return
    }
    if (loading) {
      setLobbyConnectionState(joinAttemptCount > 0 ? 'reconnecting' : 'syncing')
      return
    }
    if (!room) {
      setLobbyConnectionState('error')
      return
    }
    if (room.status !== ROOM_STATUS_WAITING) {
      setLobbyConnectionState('joined')
      return
    }

    const hasCurrentPlayerInRoom =
      players.some((player) => player.id === playerId) || optimisticJoinedPlayerId === playerId
    if (hasCurrentPlayerInRoom) {
      setLobbyConnectionState('joined')
      return
    }
    if (isJoiningRoom) {
      setLobbyConnectionState(joinAttemptCount > 0 ? 'reconnecting' : 'joining')
      return
    }
    if (joinAttemptCount < 2) {
      setLobbyConnectionState(joinAttemptCount > 0 ? 'reconnecting' : 'joining')
      return
    }
    setLobbyConnectionState('error')
  }, [
    roomId,
    roomError,
    playerId,
    sessionToken,
    loading,
    room,
    players,
    isJoiningRoom,
    joinAttemptCount,
    optimisticJoinedPlayerId,
  ])

  const shouldRefreshJoinToken = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false
    const maybe = error as { code?: string; message?: string }
    if (maybe.code !== 'functions/permission-denied') return false
    return typeof maybe.message === 'string' && maybe.message.includes('Room join token')
  }

  const resolveRejoinPlayerName = (): string => {
    const currentName = players.find((p) => p.id === playerId)?.name
    if (currentName && currentName.trim().length > 0) {
      return currentName
    }
    return resolvePlayerDisplayName(playerId)
  }

  const withJoinTokenRetry = async <T,>(
    operation: (joinToken: string) => Promise<T>,
  ): Promise<T> => {
    if (!roomId || !playerId || !sessionToken) {
      throw new Error('Missing room join context')
    }
    if (!roomJoinToken) {
      throw new Error('Missing room join token')
    }

    try {
      return await operation(roomJoinToken)
    } catch (error) {
      if (!shouldRefreshJoinToken(error)) {
        throw error
      }

      const rejoinResponse = await joinRoomCallable({
        roomId,
        playerId,
        sessionToken,
        playerName: resolveRejoinPlayerName(),
      })
      setRoomJoinToken(
        roomId,
        rejoinResponse.data.joinToken,
        rejoinResponse.data.joinTokenExpiresAtMillis,
      )
      setRoomJoinTokenState(rejoinResponse.data.joinToken)
      return operation(rejoinResponse.data.joinToken)
    }
  }

  useEffect(() => {
    if (roomError) {
      setErrorMessage(t('navigation.createFailed'))
    }
  }, [t, roomError])

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

    if (room.status === ROOM_STATUS_HORSE_SELECTION) {
      const params = new URLSearchParams({ roomId, playerId })
      navigate(`/horse-selection?${params.toString()}`, { replace: true })
      return
    }

    if (
      room.status === ROOM_STATUS_AUGMENT_SELECTION ||
      room.status === ROOM_STATUS_RACING ||
      room.status === ROOM_STATUS_SET_RESULT
    ) {
      const params = new URLSearchParams({ roomId, playerId })
      navigate(`/race?${params.toString()}`, { replace: true })
      return
    }

    if (room.status === ROOM_STATUS_FINISHED) {
      const params = new URLSearchParams({ roomId, playerId })
      navigate(`/race-result?${params.toString()}`, { replace: true })
    }
  }, [navigate, playerId, room, roomId])

  const currentPlayer = players.find((p) => p.id === playerId) ?? null
  const hostPlayer = players.find((p) => p.isHost) ?? null
  const guestPlayers = players.filter((p) => !p.isHost)

  const displayRoom = room
  const effectiveMaxPlayers = displayRoom?.maxPlayers ?? 8
  const isCurrentUserHost = !!currentPlayer?.isHost
  const isAllGuestsReady = guestPlayers.length >= 1 && guestPlayers.every((p) => p.isReady)

  const inviteUrl = roomId ? `${window.location.origin}/lobby?roomId=${roomId}` : ''

  const handleToggleReady = async () => {
    if (!currentPlayer || isTogglingReady) return
    if (!currentPlayer.id) return

    setIsTogglingReady(true)
    setErrorMessage(null)

    try {
      const activeRoomId = requireRealtimeRoomActionRoomId()
      await withJoinTokenRetry(async (joinToken) => {
        await setPlayerReadyCallable({
          roomId: activeRoomId,
          playerId: currentPlayer.id as string,
          sessionToken,
          joinToken,
          isReady: !currentPlayer.isReady,
        })
      })
    } catch (err) {
      reportLobbyActionError('Failed to toggle ready status:', err, 'lobby.readyToggleFailed')
    } finally {
      setIsTogglingReady(false)
    }
  }

  const handleStart = async () => {
    if (!roomId || !playerId || !sessionToken || !roomJoinToken || isStarting || !isAllGuestsReady)
      return

    setIsStarting(true)
    setErrorMessage(null)

    try {
      requireRealtimeRoomActionRoomId()
      await withJoinTokenRetry(async (joinToken) => {
        await startGameCallable({ roomId, playerId, sessionToken, joinToken })
      })
    } catch (err) {
      reportLobbyActionError('Failed to start game:', err, 'lobby.startFailed')
      setIsStarting(false)
    }
  }

  const showCopiedState = () => {
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const tryCopyWithClipboardApi = async (text: string): Promise<boolean> => {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      return false
    }

    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (error) {
      console.warn('Clipboard API failed, trying fallback:', error)
      return false
    }
  }

  const tryCopyWithExecCommand = (text: string): boolean => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-999999px'
    textarea.style.top = '-999999px'

    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()

    try {
      return document.execCommand('copy')
    } finally {
      document.body.removeChild(textarea)
    }
  }

  const showInviteUrlAndSelectText = () => {
    setIsUrlVisible(true)

    const urlElement = document.querySelector('[data-invite-url]') as HTMLSpanElement | null
    if (!urlElement) return

    const range = document.createRange()
    range.selectNodeContents(urlElement)
    const selection = window.getSelection()
    if (!selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const handleCopy = async () => {
    if (!inviteUrl) return

    const copiedWithClipboardApi = await tryCopyWithClipboardApi(inviteUrl)
    if (copiedWithClipboardApi) {
      showCopiedState()
      return
    }

    try {
      const copiedWithExecCommand = tryCopyWithExecCommand(inviteUrl)
      if (!copiedWithExecCommand) throw new Error('execCommand failed')
      showCopiedState()
    } catch (error) {
      console.error('All copy methods failed:', error)
      showInviteUrlAndSelectText()
    }
  }

  const handleOpenNameEdit = (player: Player) => {
    setEditingPlayerId(player.id ?? null)
    setNewPlayerName(player.name ?? '')
    setIsComposing(false)
    setIsNameEditDialogOpen(true)
  }

  const getValidatedEditedPlayerName = (): { playerId: string; trimmedName: string } | null => {
    if (!editingPlayerId) return null

    const trimmedName = newPlayerName.trim()
    if (!trimmedName) return null
    if (!validatePlayerName(trimmedName)) return null

    return { playerId: editingPlayerId, trimmedName }
  }

  const saveRealtimePlayerName = async (targetPlayerId: string, trimmedName: string) => {
    const activeRoomId = requireRealtimeRoomActionRoomId()
    const activeSessionToken = requireSessionToken()

    await withJoinTokenRetry(async (joinToken) => {
      await updatePlayerNameCallable({
        roomId: activeRoomId,
        playerId: targetPlayerId,
        sessionToken: activeSessionToken,
        joinToken,
        name: trimmedName,
      })
    })
  }

  const closeNameEditDialog = () => {
    setIsNameEditDialogOpen(false)
    setEditingPlayerId(null)
    setNewPlayerName('')
  }

  const handleSaveName = async () => {
    const nameEditInput = getValidatedEditedPlayerName()
    if (!nameEditInput) return

    const { playerId: targetPlayerId, trimmedName } = nameEditInput

    try {
      await saveRealtimePlayerName(targetPlayerId, trimmedName)
    } catch (err) {
      reportLobbyActionError('Failed to update player name:', err, 'navigation.createFailed')
      return
    }

    closeNameEditDialog()
  }

  const nameError = getPlayerNameErrorMessage(newPlayerName)
  const isInteractionLocked = lobbyConnectionState !== 'joined'
  const canRetryConnection =
    (lobbyConnectionState === 'reconnecting' || lobbyConnectionState === 'error') &&
    !isJoiningRoom &&
    joinAttemptCount < 2
  const shouldShowConnectionBanner = lobbyConnectionState !== 'joined'

  const connectionBannerClassName =
    lobbyConnectionState === 'error'
      ? 'mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400'
      : 'mb-4 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-200'

  const connectionStatusText = (() => {
    switch (lobbyConnectionState) {
      case 'bootstrapping':
        return '세션을 복구하는 중입니다.'
      case 'syncing':
        return '로비 상태를 동기화하는 중입니다.'
      case 'joining':
        return '로비에 참가하는 중입니다.'
      case 'reconnecting':
        return '연결이 불안정합니다. 재연결을 시도 중입니다.'
      case 'error':
        return '로비 연결에 실패했습니다. 재시도를 눌러 복구해 주세요.'
      case 'left':
        return '로비를 벗어났습니다.'
      default:
        return ''
    }
  })()

  const handleReconnectRetry = () => {
    if (!roomId || isJoiningRoom || joinAttemptCount >= 2) return
    setJoinAttemptCount(0)
    setErrorMessage(null)
    void executeJoinRoomAttempt()
  }

  if (!roomId) {
    return null
  }

  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-surface/80 p-6 shadow-surface backdrop-blur-lg">
        <header className="mb-6 text-center">
          <h1 className="mt-2 text-2xl font-display text-foreground">{t('lobby.title')}</h1>
          <p className="mt-2 text-xs text-muted-foreground">{t('lobby.subtitle')}</p>
          {displayRoom?.title && (
            <p className="mt-1 text-xs text-foreground0">{displayRoom.title}</p>
          )}
        </header>

        {errorMessage && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
            {errorMessage}
          </div>
        )}

        {shouldShowConnectionBanner && (
          <div className={connectionBannerClassName}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {lobbyConnectionState !== 'error' && <Spinner className="text-current" size={14} />}
                <p>{connectionStatusText}</p>
              </div>
              {canRetryConnection && (
                <button
                  type="button"
                  onClick={handleReconnectRetry}
                  className="rounded-md border border-current/40 px-2 py-1 text-xs font-semibold transition hover:bg-current/10"
                >
                  재시도
                </button>
              )}
            </div>
          </div>
        )}

        <ul className="space-y-3">
          {hostPlayer && (
            <li className="flex items-center gap-2 sm:gap-3 rounded-2xl bg-surface-muted/80 px-3 sm:px-4 py-3">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-white/5 text-lg text-muted-foreground">
                1
              </div>
              <div className="flex flex-1 min-w-0 items-center gap-1.5 sm:gap-2">
                <span className="flex items-center justify-center flex-shrink-0">
                  <Crown className="h-4 w-4 text-yellow-400" />
                </span>
                <div className="flex flex-1 min-w-0 items-center gap-2">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {hostPlayer.name || 'Host'}
                  </p>
                  {hostPlayer.id === playerId &&
                    !isInteractionLocked &&
                    (editingPlayerId !== hostPlayer.id || !isNameEditDialogOpen) && (
                      <button
                        type="button"
                        onClick={() => handleOpenNameEdit(hostPlayer)}
                        className="flex-shrink-0 text-muted-foreground transition hover:text-foreground"
                        aria-label={t('lobby.editName', { defaultValue: '이름 수정' })}
                      >
                        <SquarePen className="h-3.5 w-3.5" />
                      </button>
                    )}
                </div>
              </div>
            </li>
          )}

          {Array.from({ length: Math.max(0, effectiveMaxPlayers - 1) }).map((_, idx) => {
            const player = guestPlayers[idx]
            const isConnected = player !== undefined
            const isCurrentUser = !!player && player.id === playerId

            return (
              <li
                key={`slot-${idx}`}
                className={`flex items-center gap-2 sm:gap-3 rounded-2xl px-3 sm:px-4 py-3 ${
                  isConnected
                    ? 'bg-surface-muted/80'
                    : 'bg-surface-muted/40 border-2 border-dashed border-border'
                }`}
              >
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-white/5 text-lg text-muted-foreground">
                  {idx + 2}
                </div>
                <div className="flex flex-1 min-w-0 items-center gap-1.5 sm:gap-2">
                  {isCurrentUser && isConnected && (
                    <Badge
                      variant="outline"
                      className="border-primary/50 bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary flex-shrink-0"
                    >
                      {t('lobby.me', { defaultValue: '나' })}
                    </Badge>
                  )}
                  <div className="flex flex-1 min-w-0 items-center gap-2">
                    {isConnected ? (
                      <>
                        <p className="text-sm font-semibold text-foreground truncate">
                          {player.name || `Player ${idx + 2}`}
                        </p>
                        {isCurrentUser &&
                          !isInteractionLocked &&
                          !player.isReady &&
                          (editingPlayerId !== player.id || !isNameEditDialogOpen) && (
                            <button
                              type="button"
                              onClick={() => handleOpenNameEdit(player)}
                              className="flex-shrink-0 text-muted-foreground transition hover:text-foreground"
                              aria-label={t('lobby.editName', { defaultValue: '이름 수정' })}
                            >
                              <SquarePen className="h-3.5 w-3.5" />
                            </button>
                          )}
                      </>
                    ) : (
                      <p className="text-sm font-semibold text-muted-foreground truncate"> </p>
                    )}
                  </div>
                </div>
                {isConnected ? (
                  <Badge
                    variant="outline"
                    className={
                      player.isReady
                        ? 'inline-flex items-center gap-1 border-success/40 bg-success/10 px-2 py-0.5 text-[10px] text-success flex-shrink-0'
                        : 'inline-flex items-center gap-1 border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning flex-shrink-0'
                    }
                  >
                    {player.isReady ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    ) : (
                      <Spinner className="text-warning" size={12} />
                    )}
                    {player.isReady ? t('lobby.status.ready') : t('lobby.status.preparing')}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="inline-flex items-center gap-1 border-muted-foreground/40 bg-muted-foreground/10 px-2 py-0.5 text-[10px] text-muted-foreground flex-shrink-0"
                  >
                    연결 중
                  </Badge>
                )}
              </li>
            )
          })}
        </ul>

        <div className="mt-6 space-y-3 rounded-2xl border border-dashed border-white/15 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">
            {t('lobby.invite')}
          </p>
          <div className="flex gap-2">
            <div className="flex flex-1 items-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-background/80 px-4 py-3 text-sm text-foreground">
              <span
                data-invite-url
                className="block flex-1 whitespace-nowrap select-text overflow-x-auto scrollbar-hide"
              >
                {isUrlVisible ? inviteUrl : '••••••••••••••••••••••••••••••••'}
              </span>
              <button
                type="button"
                onClick={() => setIsUrlVisible(!isUrlVisible)}
                className="flex-shrink-0 text-muted-foreground transition hover:text-foreground"
                aria-label={isUrlVisible ? t('lobby.urlHide') : t('lobby.urlShow')}
              >
                {isUrlVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={isInteractionLocked || !inviteUrl}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:bg-primary/80"
              aria-label={t('lobby.copy')}
            >
              {isCopied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {currentPlayer && !isCurrentUserHost && (
          <div className="mt-6">
            <button
              type="button"
              onClick={handleToggleReady}
              disabled={isTogglingReady || isInteractionLocked}
              className={`w-full rounded-full px-8 py-3 text-base font-semibold transition ${
                currentPlayer.isReady
                  ? 'border border-success/40 bg-success/10 text-success hover:bg-success/20'
                  : 'border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {isTogglingReady
                ? t('lobby.processing')
                : currentPlayer.isReady
                  ? t('lobby.readyCancel')
                  : t('lobby.readyToggle')}
            </button>
          </div>
        )}

        {isCurrentUserHost && (
          <div className="mt-6 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleStart}
              disabled={
                !isAllGuestsReady || isStarting || guestPlayers.length < 1 || isInteractionLocked
              }
              className="w-full rounded-full border border-transparent bg-primary px-8 py-3 text-base font-semibold text-primary-foreground shadow-neon transition hover:bg-primary/80 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-muted-foreground"
            >
              {isStarting ? t('lobby.starting') : t('lobby.startGame')}
            </button>
            {!isAllGuestsReady && (
              <p className="text-center text-xs text-muted-foreground">{t('lobby.startWaiting')}</p>
            )}
          </div>
        )}
      </div>

      <Dialog open={isNameEditDialogOpen} onOpenChange={setIsNameEditDialogOpen}>
        <DialogContent className="max-w-md w-[90%] rounded-3xl border-none bg-surface [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>{t('lobby.editName', { defaultValue: '이름 수정' })}</DialogTitle>
            <DialogDescription>
              {t('lobby.editNameDescription', {
                defaultValue: '플레이어 이름을 변경할 수 있습니다.',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="relative">
              <Input
                value={newPlayerName}
                onChange={(e) => {
                  const value = e.target.value
                  if (isComposing) {
                    setNewPlayerName(value)
                    return
                  }
                  if (value.length <= NAME_MAX_LENGTH) {
                    setNewPlayerName(value)
                  } else {
                    setNewPlayerName(value.slice(0, NAME_MAX_LENGTH))
                  }
                }}
                onCompositionStart={() => {
                  setIsComposing(true)
                }}
                onCompositionEnd={() => {
                  setIsComposing(false)
                }}
                placeholder={t('lobby.playerNamePlaceholder', {
                  defaultValue: '플레이어 이름',
                })}
                maxLength={NAME_MAX_LENGTH}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveName()
                  }
                }}
                autoFocus
                className={clsx(
                  'pr-12',
                  nameError && 'border-destructive focus-visible:ring-destructive',
                )}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {Math.min(newPlayerName.length, NAME_MAX_LENGTH)}/{NAME_MAX_LENGTH}
              </span>
            </div>
            {nameError && <p className="mt-2 text-sm text-destructive">{nameError}</p>}
            <p className="mt-2 text-xs text-muted-foreground">
              숫자, 영어, 한글, 공백만 사용 가능합니다. (2-12자)
            </p>
          </div>
          <DialogFooter className="!flex-row justify-end gap-2">
            <Button variant="outline" onClick={closeNameEditDialog}>
              {t('common.cancel', { defaultValue: '취소' })}
            </Button>
            <Button
              onClick={handleSaveName}
              disabled={!newPlayerName.trim() || !validatePlayerName(newPlayerName.trim())}
            >
              {t('common.save', { defaultValue: '저장' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
