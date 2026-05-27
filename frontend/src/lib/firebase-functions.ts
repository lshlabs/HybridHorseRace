import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
  type HttpsCallable,
  type Functions,
} from 'firebase/functions'
import { getFirebaseApp } from './firebase'

const FUNCTIONS_REGION = 'asia-northeast3'
const DEFAULT_FUNCTIONS_EMULATOR_HOST = '127.0.0.1'
const DEFAULT_FUNCTIONS_EMULATOR_PORT = 5001
const IS_DEV = import.meta.env.DEV
const USE_FUNCTIONS_EMULATOR = IS_DEV && import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'

let functionsInstance: ReturnType<typeof getFunctions> | null = null
let isEmulatorConnected = false

function resolveEmulatorHost(envHost?: string): string {
  if (envHost && envHost.trim().length > 0) return envHost.trim()
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.hostname
  }
  return DEFAULT_FUNCTIONS_EMULATOR_HOST
}

function isFunctionsEmulatorEnabled(): boolean {
  return USE_FUNCTIONS_EMULATOR
}

function resolveEmulatorPort(rawPort?: string): number {
  const parsedPort = Number(rawPort || DEFAULT_FUNCTIONS_EMULATOR_PORT)
  return Number.isFinite(parsedPort) ? parsedPort : DEFAULT_FUNCTIONS_EMULATOR_PORT
}

function isAlreadyConnectedFunctionsError(error: unknown): boolean {
  const err = error as { message?: string; code?: string }
  return (
    err?.message?.includes('already connected') === true ||
    err?.code === 'functions/already-initialized'
  )
}

function logDebug(message: string, context?: Record<string, unknown>): void {
  if (IS_DEV) {
    if (context) {
      console.info(message, context)
      return
    }
    console.info(message)
  }
}

function connectFunctionsEmulatorIfNeeded(instance: Functions): void {
  if (!isFunctionsEmulatorEnabled()) {
    logDebug('Using Firebase Functions in production mode', { region: FUNCTIONS_REGION })
    return
  }

  logDebug('Functions Emulator enabled', { enabled: true })

  if (isEmulatorConnected) {
    logDebug('Functions Emulator already connected')
    return
  }

  try {
    const emulatorHost = resolveEmulatorHost(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST)
    const emulatorPort = resolveEmulatorPort(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT)
    connectFunctionsEmulator(instance, emulatorHost, emulatorPort)
    isEmulatorConnected = true
    logDebug('Connected to Functions Emulator', {
      emulatorHost,
      emulatorPort,
      region: FUNCTIONS_REGION,
    })
  } catch (error: unknown) {
    if (isAlreadyConnectedFunctionsError(error)) {
      isEmulatorConnected = true
      logDebug('Functions Emulator already connected')
      return
    }

    console.warn('⚠️ Functions Emulator connection error:', error)
  }
}

function createFunctionsInstance(): ReturnType<typeof getFunctions> {
  const app = getFirebaseApp()
  logDebug('Initializing Firebase Functions', { projectId: app.options.projectId })

  const useEmulator = isFunctionsEmulatorEnabled()
  logDebug('Functions Emulator enabled', { enabled: useEmulator })

  const instance = getFunctions(app, FUNCTIONS_REGION)
  connectFunctionsEmulatorIfNeeded(instance)
  return instance
}

function getFunctionsInstance() {
  if (functionsInstance) return functionsInstance

  try {
    functionsInstance = createFunctionsInstance()
    return functionsInstance
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Functions:', error)
    throw error
  }
}

function createCallable<TRequest, TResponse>(name: string): HttpsCallable<TRequest, TResponse> {
  const functions = getFunctionsInstance()
  const callable = httpsCallable<TRequest, TResponse>(functions, name)

  if (isFunctionsEmulatorEnabled()) {
    logDebug('Created callable function', { name })
  }

  return callable
}

type StatType = 'Speed' | 'Stamina' | 'Power' | 'Guts' | 'Start' | 'Luck'
type AugmentRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'hidden'
type SpecialAbilityType = 'lastSpurt' | 'overtake' | 'escapeCrisis'
type NextStatus = 'setResult' | 'augmentSelection' | 'finished'

type AugmentResponse = {
  id: string
  name: string
  rarity: AugmentRarity
  statType?: StatType
  statValue?: number
  specialAbility?: SpecialAbilityType
  specialAbilityValue?: number
  description?: string
}

export const createGuestSession = createCallable<
  { guestId?: string },
  { authUid: string; guestId: string; sessionToken: string; expiresAtMillis: number }
>('createGuestSession')

export const createRoom = createCallable<
  {
    playerId: string
    sessionToken: string
    hostName: string
    title: string
    maxPlayers: number
    roundCount: number
    rerollLimit: number
  },
  { roomId: string; status: string; joinToken: string; joinTokenExpiresAtMillis: number }
>('createRoom')

export const joinRoom = createCallable<
  { roomId: string; playerId: string; sessionToken: string; playerName: string },
  {
    playerId: string
    success: boolean
    joinToken: string
    joinTokenExpiresAtMillis: number
    rejoined: boolean
  }
>('joinRoom')

export const leaveRoom = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string },
  { success: boolean }
>('leaveRoom')

export const startGame = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string },
  { success: boolean; status: string }
>('startGame')

export const selectHorse = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    horseStats: {
      Speed: number
      Stamina: number
      Power: number
      Guts: number
      Start: number
      Luck: number
    }
  },
  { success: boolean; allPlayersSelected: boolean; nextStatus: string }
>('selectHorse')

export const selectAugment = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    setIndex: number
    augmentId: string
  },
  { success: boolean; allPlayersSelected: boolean; nextStatus: string }
>('selectAugment')

export const getAugmentSelection = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    setIndex: number
  },
  {
    success: boolean
    rarity: 'common' | 'rare' | 'epic' | 'legendary'
    availableAugments: AugmentResponse[]
    selectedCount: number
    totalPlayers: number
  }
>('getAugmentSelection')

export const rerollAugments = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; setIndex: number },
  {
    success: boolean
    newAugments: AugmentResponse[]
    rerollUsed: number
    remainingRerolls: number
  }
>('rerollAugments')

export const startRace = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; setIndex: number },
  {
    success: boolean
    startedAtMillis: number
    alreadyStarted?: boolean
    scriptVersion: string
    simStepMs: number
    outputFrameMs: number
    tickIntervalMs: number
    raceStateDocVersion: string
  }
>('startRace')

export const prepareRace = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; setIndex: number },
  {
    success: boolean
    prepared: boolean
    alreadyPrepared?: boolean
    scriptVersion: string
    simStepMs: number
    outputFrameMs: number
    tickIntervalMs: number
    raceStateDocVersion: string
    keyframeCount?: number
  }
>('prepareRace')

export const readyNextSet = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; setIndex: number },
  {
    success: boolean
    allReady: boolean
    nextStatus: NextStatus
    currentSet: number
  }
>('readyNextSet')

export const getSetResult = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    setIndex: number
    includeObservability?: boolean
  },
  {
    success: boolean
    hasResult: boolean
    rankings: Array<{
      playerId: string
      name: string
      position: number
      time: number
      selectedAugments: AugmentResponse[]
    }>
    startedAtMillis: number | null
    readyCount: number
    cacheHit?: boolean
    observability?: {
      source: 'set-result-summary-cache' | 'set-result-unavailable' | 'set-result-computed'
      cacheHit: boolean
      rankingCount: number
      cacheWriteBack?: boolean
    }
  }
>('getSetResult')

export const getRaceState = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    setIndex: number
    eventsSinceElapsedMs?: number
    includeObservability?: boolean
  },
  {
    success: boolean
    hasRaceState: boolean
    status?: 'prepared' | 'running' | 'completed'
    setIndex?: number
    scriptVersion?: string
    startedAtMillis?: number | null
    elapsedMs?: number
    authoritativeNowMs?: number
    simStepMs?: number
    outputFrameMs?: number
    tickIntervalMs?: number
    trackLengthM?: number
    raceStateDocVersion?: string
    snapshotHash?: string
    keyframeIndex?: number
    keyframe?: {
      elapsedMs: number
      positions: Record<string, number>
      speeds: Record<string, number>
      stamina: Record<string, number>
      finished: Record<string, boolean>
    }
    nextKeyframe?: {
      elapsedMs: number
      positions: Record<string, number>
      speeds: Record<string, number>
      stamina: Record<string, number>
      finished: Record<string, boolean>
    }
    eventsWindow?: Array<
      | {
          id: string
          type: 'overtake'
          elapsedMs: number
          playerId: string
          fromRank: number
          toRank: number
        }
      | {
          id: string
          type: 'lastSpurt'
          elapsedMs: number
          playerId: string
        }
      | {
          id: string
          type: 'finish'
          elapsedMs: number
          playerId: string
          rank: number
        }
      | {
          id: string
          type: 'slowmoTrigger'
          elapsedMs: number
        }
    >
    slowmoTriggerMs?: number | null
    rankings?: Array<{ playerId: string; time: number; position: number }>
    observability?: {
      payloadSource: 'chunked-v2' | 'legacy-payload-doc' | 'inline-legacy' | 'missing-set-doc'
      keyframeChunkReads: number
      eventBucketReads: number
      eventWindowCount: number
      payloadCacheHit?: boolean
    }
  }
>('getRaceState')

export const getRaceTimeline = createCallable<
  {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
    setIndex: number
    chunkCursor?: {
      keyframeChunkIndex?: number
      eventBucketStartElapsedMs?: number
    }
  },
  {
    success: boolean
    hasTimeline: boolean
    status?: 'prepared' | 'running' | 'completed'
    setIndex?: number
    scriptVersion?: string
    raceStateDocVersion?: string
    startedAtMillis?: number | null
    simStepMs?: number
    outputFrameMs?: number
    tickIntervalMs?: number
    trackLengthM?: number
    snapshotHash?: string
    slowmoTriggerMs?: number | null
    rankings?: Array<{ playerId: string; time: number; position: number }>
    keyframeChunkSize?: number
    keyframeChunkCount?: number
    keyframeCount?: number
    eventBucketMs?: number
    eventChunkCount?: number
    eventCount?: number
    keyframeChunks?: Array<{
      chunkIndex: number
      startIndex: number
      keyframes: Array<{
        elapsedMs: number
        positions: Record<string, number>
        speeds: Record<string, number>
        stamina: Record<string, number>
        finished: Record<string, boolean>
      }>
    }>
    eventBuckets?: Array<{
      bucketStartElapsedMs: number
      bucketEndElapsedMs: number
      eventBucketMs: number
      events: Array<
        | {
            id: string
            type: 'overtake'
            elapsedMs: number
            playerId: string
            fromRank: number
            toRank: number
          }
        | {
            id: string
            type: 'lastSpurt'
            elapsedMs: number
            playerId: string
          }
        | {
            id: string
            type: 'finish'
            elapsedMs: number
            playerId: string
            rank: number
          }
        | {
            id: string
            type: 'slowmoTrigger'
            elapsedMs: number
          }
      >
    }>
    nextCursor?: {
      keyframeChunkIndex?: number
      eventBucketStartElapsedMs?: number
    } | null
  }
>('getRaceTimeline')

export const setPlayerReady = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; isReady: boolean },
  { success: boolean }
>('setPlayerReady')

export const updatePlayerName = createCallable<
  { roomId: string; playerId: string; sessionToken: string; joinToken: string; name: string },
  { success: boolean }
>('updatePlayerName')
