import { HttpsError } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import {
  DEFAULT_OUTPUT_FRAME_MS,
  DEFAULT_SIM_STEP_MS,
  hashStringToUint32,
  createSeededRandom,
  randomIntSeeded,
  pickRandomSeeded,
} from '../../shared/race-core'
import {
  getRoom,
  isHost,
  isPlayerInRoom,
  updateRoomStatus,
} from './utils'
import type { RoomStatus, Player, Augment, AugmentRarity, StatName } from './types'
import { logInfo, logWarn } from './common/logging'
import { throwInvalidSetIndex } from './common/set-index'
import { assertExactRoomPhaseAndSetIndex } from './common/room-phase'
import { createResponseBuilders } from './common/response-builders'
import { createRequestGuards } from './common/request-guards'
import { createAuthHelpers } from './common/auth-helpers'
import { createRaceReadCallables } from './domains/race-read'
import { createRaceWriteCallables } from './domains/race-write'
import { createSelectionCallables } from './domains/selection'
import { createRoomLifecycleCallables } from './domains/room-lifecycle'

initializeApp()

const db = getFirestore()
const GUEST_SESSION_TTL_DAYS = 14
const JOIN_TOKEN_TTL_HOURS = 6
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9가-힣 ]+$/
const HIDDEN_AUGMENT_CHANCE_LEGENDARY = 0.15
const HIDDEN_ABILITY_VARIANTS = 3
const HIDDEN_ABILITY_VALUE_MIN = 6
const HIDDEN_ABILITY_VALUE_MAX = 10
const AUGMENT_CHOICES_COUNT = 3
const AUGMENT_GENERATION_MAX_ATTEMPTS = 256

function normalizePlayerName(rawName: string): string {
  return rawName.trim()
}

function isValidPlayerName(name: string): boolean {
  return name.length >= 2 && name.length <= 12 && PLAYER_NAME_PATTERN.test(name)
}

const STAT_NAMES: StatName[] = ['Speed', 'Stamina', 'Power', 'Guts', 'Start', 'Luck']
const AUGMENT_RARITIES: Array<Exclude<AugmentRarity, 'hidden'>> = [
  'common',
  'rare',
  'epic',
  'legendary',
]

const SERVER_RACE_TRACK_LENGTH_M = 505
const SERVER_RACE_SIM_STEP_MS = DEFAULT_SIM_STEP_MS
const SERVER_RACE_OUTPUT_FRAME_MS = 50
const SERVER_RACE_SCRIPT_VERSION = 'v3-horse-core'
const SERVER_RACE_STATE_DOC_VERSION = 'v3'

const { getSortedSetSummaries, buildGetRaceStateResponse, buildSetResultRankings } =
  createResponseBuilders({
    serverRaceOutputFrameMs: SERVER_RACE_OUTPUT_FRAME_MS,
    serverRaceSimStepMs: SERVER_RACE_SIM_STEP_MS,
    serverRaceTrackLengthM: SERVER_RACE_TRACK_LENGTH_M,
    serverRaceScriptVersion: SERVER_RACE_SCRIPT_VERSION,
    serverRaceStateDocVersion: SERVER_RACE_STATE_DOC_VERSION,
  })

const {
  createGuestId,
  createSessionToken,
  hashSessionToken,
  issueRoomJoinToken,
  verifyRoomJoinToken,
  verifyGuestSession,
} = createAuthHelpers({
  db,
  timestamp: Timestamp,
  joinTokenTtlHours: JOIN_TOKEN_TTL_HOURS,
  logWarn,
})

function createServerAugment(
  rarity: Exclude<AugmentRarity, 'hidden'>,
  rng: () => number,
  seedKey: string,
  slotIndex: number,
): Augment {
  const statType = pickRandomSeeded(STAT_NAMES, rng)
  const valueRange: Record<Exclude<AugmentRarity, 'hidden'>, { min: number; max: number }> = {
    common: { min: 1, max: 2 },
    rare: { min: 3, max: 4 },
    epic: { min: 5, max: 6 },
    legendary: { min: 7, max: 10 },
  }
  const statValue = randomIntSeeded(valueRange[rarity].min, valueRange[rarity].max, rng)
  return {
    id: `${rarity}-${statType}-${statValue}-${hashStringToUint32(`${seedKey}-${slotIndex}`)}`,
    name: `${statType} +${statValue}`,
    rarity,
    statType,
    statValue,
  }
}

function createServerHiddenAbilityAugment(
  rng: () => number,
  seedKey: string,
  slotIndex: number,
): Augment {
  const roll = rng()
  const abilityValue = randomIntSeeded(HIDDEN_ABILITY_VALUE_MIN, HIDDEN_ABILITY_VALUE_MAX, rng)
  const baseId = hashStringToUint32(`${seedKey}-hidden-${slotIndex}`)
  if (roll < 1 / HIDDEN_ABILITY_VARIANTS) {
    return {
      id: `hidden-lastSpurt-${abilityValue}-${baseId}`,
      name: 'Last Spurt',
      rarity: 'hidden',
      specialAbility: 'lastSpurt',
      specialAbilityValue: abilityValue,
    }
  }
  if (roll < 2 / HIDDEN_ABILITY_VARIANTS) {
    return {
      id: `hidden-overtake-${abilityValue}-${baseId}`,
      name: 'Overtake',
      rarity: 'hidden',
      specialAbility: 'overtake',
      specialAbilityValue: abilityValue,
    }
  }
  return {
    id: `hidden-escapeCrisis-${abilityValue}-${baseId}`,
    name: 'Escape Crisis',
    rarity: 'hidden',
    specialAbility: 'escapeCrisis',
    specialAbilityValue: abilityValue,
  }
}

function generateServerAugmentChoices(
  rarity: Exclude<AugmentRarity, 'hidden'>,
  rng: () => number,
  seedKey: string,
): Augment[] {
  const choices: Augment[] = []
  const uniqueCategoryKeys = new Set<string>()
  let attempt = 0

  if (rarity === 'legendary') {
    const hiddenRoll = rng()
    if (hiddenRoll < HIDDEN_AUGMENT_CHANCE_LEGENDARY) {
      const hiddenAugment = createServerHiddenAbilityAugment(rng, seedKey, attempt)
      const categoryKey = `ability:${hiddenAugment.specialAbility ?? 'hidden'}`
      uniqueCategoryKeys.add(categoryKey)
      choices.push(hiddenAugment)
      attempt += 1
    }
  }

  while (choices.length < AUGMENT_CHOICES_COUNT && attempt < AUGMENT_GENERATION_MAX_ATTEMPTS) {
    const augment = createServerAugment(rarity, rng, seedKey, attempt)
    const categoryKey = augment.specialAbility
      ? `ability:${augment.specialAbility}`
      : `stat:${augment.statType ?? 'none'}`

    if (!uniqueCategoryKeys.has(categoryKey)) {
      uniqueCategoryKeys.add(categoryKey)
      choices.push(augment)
    }
    attempt += 1
  }

  if (choices.length < AUGMENT_CHOICES_COUNT) {
    throw new HttpsError('internal', 'Failed to generate unique augment choices')
  }

  return choices
}

function applyAugmentToHorseStats(
  horseStats: Player['horseStats'],
  augment?: Augment,
): Player['horseStats'] {
  if (!horseStats) return horseStats
  const nextStats = { ...horseStats }

  if (augment?.statType && typeof augment.statValue === 'number') {
    nextStats[augment.statType] += augment.statValue
  }

  return nextStats
}

function calculateLuckBonus(luck: number): number {
  return Math.max(0, Math.min(5, Math.floor(luck / 10)))
}

function applyLuckBonusToHorseStats(
  horseStats: Player['horseStats'],
  luckBonus: number,
): Player['horseStats'] {
  if (!horseStats) return horseStats
  const nextStats = { ...horseStats }
  for (const stat of STAT_NAMES) {
    if (stat === 'Luck') continue
    nextStats[stat] += luckBonus
  }
  return nextStats
}

function removeLuckBonusFromHorseStats(
  horseStats: Player['horseStats'],
  luckBonus: number,
): Player['horseStats'] {
  if (!horseStats) return horseStats
  if (luckBonus <= 0) return horseStats
  const nextStats = { ...horseStats }
  for (const stat of STAT_NAMES) {
    if (stat === 'Luck') continue
    nextStats[stat] = Math.max(0, nextStats[stat] - luckBonus)
  }
  return nextStats
}

const {
  assertJoinedRoomPlayerRequest,
  assertJoinedRoomHostRequest,
  assertAugmentSelectionRequestContext,
} = createRequestGuards({
  verifyGuestSession,
  verifyRoomJoinToken,
  isPlayerInRoom,
  isHost,
  getRoom,
})
const raceReadCallables = createRaceReadCallables({
  db,
  logger,
  getRoom,
  assertJoinedRoomPlayerRequest,
  throwInvalidSetIndex,
  buildGetRaceStateResponse,
  getSortedSetSummaries,
  buildSetResultRankings,
})
const raceWriteCallables = createRaceWriteCallables({
  db,
  logger,
  getRoom,
  updateRoomStatus,
  assertJoinedRoomHostRequest,
  assertJoinedRoomPlayerRequest,
  assertExactRoomPhaseAndSetIndex,
  getSortedSetSummaries,
  removeLuckBonusFromHorseStats,
  createSeededRandom,
  serverRaceTrackLengthM: SERVER_RACE_TRACK_LENGTH_M,
  serverRaceSimStepMs: SERVER_RACE_SIM_STEP_MS,
  serverRaceOutputFrameMs: SERVER_RACE_OUTPUT_FRAME_MS,
  serverRaceScriptVersion: SERVER_RACE_SCRIPT_VERSION,
  serverRaceStateDocVersion: SERVER_RACE_STATE_DOC_VERSION,
})
const roomLifecycleCallables = createRoomLifecycleCallables({
  db,
  logger,
  logInfo,
  logWarn,
  guestSessionTtlDays: GUEST_SESSION_TTL_DAYS,
  normalizePlayerName,
  isValidPlayerName,
  createGuestId,
  createSessionToken,
  hashSessionToken,
  issueRoomJoinToken,
  verifyGuestSession,
  getRoom,
  assertJoinedRoomPlayerRequest,
})
const selectionCallables = createSelectionCallables({
  db,
  logger,
  getRoom,
  updateRoomStatus,
  isPlayerInRoom,
  verifyGuestSession,
  verifyRoomJoinToken,
  assertAugmentSelectionRequestContext,
  createSeededRandom,
  pickRandomSeeded,
  generateServerAugmentChoices,
  augmentRarities: AUGMENT_RARITIES,
  applyAugmentToHorseStats,
  calculateLuckBonus,
  applyLuckBonusToHorseStats,
})
export const createGuestSession = roomLifecycleCallables.createGuestSession
export const createRoom = roomLifecycleCallables.createRoom
export const joinRoom = roomLifecycleCallables.joinRoom
export const updatePlayerName = roomLifecycleCallables.updatePlayerName
export const setPlayerReady = roomLifecycleCallables.setPlayerReady
export const leaveRoom = roomLifecycleCallables.leaveRoom
export const leaveRoomOnUnload = roomLifecycleCallables.leaveRoomOnUnload
export const cleanupPendingLeaves = roomLifecycleCallables.cleanupPendingLeaves
export const startGame = roomLifecycleCallables.startGame

export const selectHorse = selectionCallables.selectHorse
export const getAugmentSelection = selectionCallables.getAugmentSelection
export const selectAugment = selectionCallables.selectAugment
export const rerollAugments = selectionCallables.rerollAugments

export const prepareRace = raceWriteCallables.prepareRace
export const startRace = raceWriteCallables.startRace

export const readyNextSet = raceWriteCallables.readyNextSet

export const getRaceState = raceReadCallables.getRaceState
export const getRaceTimeline = raceReadCallables.getRaceTimeline
export const getSetResult = raceReadCallables.getSetResult
