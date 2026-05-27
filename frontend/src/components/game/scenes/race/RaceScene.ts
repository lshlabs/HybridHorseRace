import Phaser from 'phaser'
import type { Room, Player } from '../../../../hooks/useRoom'
import {
  getAugmentSelection,
  prepareRace,
  getRaceTimeline,
  getRaceState,
  getSetResult,
  readyNextSet,
  rerollAugments,
  selectAugment,
  startRace,
} from '../../../../lib/firebase-functions'

// 플레이어 표시 화살표
import rightArrowUrl from '../../../../assets/images/etc/right-arrow.png'
// 하단 HUD 카드 배경 (능력치/현재상태 카드)
import hudPanelBgUrl from '../../../../assets/images/etc/race_hud.png'

// 시뮬레이션 시스템
import type { Stats } from '../../../../engine/race/types'

// 관리자 클래스들
import TileMapManager from '../../managers/TileMapManager'
import HorseManager from '../../managers/HorseManager'
import GUIManager from '../../managers/GUIManager'
import ProgressBarManager from '../../managers/ProgressBarManager'
import CameraScrollManager from '../../managers/CameraScrollManager'
import CountdownManager from '../../managers/CountdownManager'
import { tileMapAssetLoaders } from '../../assets/tilemaps/tileMapAssets'
import { horseSpriteSheetUrls } from '../../assets/horses/horseSpritesheets'
import { applyPixelArtFilter } from '../../assets/filters/pixelArtFilter'
import { playFinishSequence } from '../../effects/FinishSequence'

// 증강 시스템
import type { Augment, AugmentRarity } from '../../../../engine/race'
import { generateRandomRarity } from '../../../../engine/race'
import { computeRoundRankings } from '../../../../utils/raceRanking'
import { createFireworks } from '../../../../utils/fireworks'
import type { RoundRankingEntry } from '../../../../utils/raceRanking'
import AugmentSelectionScene from '../augment/AugmentSelectionScene'
import RaceResultScene from '../result/RaceResultScene'
import RaceDataSync, { type RaceGameData } from './controllers/RaceDataSync'
import RaceRuntimeController, { type RaceRuntimeState } from './controllers/RaceRuntimeController'
import RaceFlowUI from './controllers/RaceFlowUI'
import { computeAuthoritativeRenderElapsedMs as computeAuthoritativeRenderElapsedMsHelper } from './helpers/authoritative-sync'
import {
  buildNextSetSyncRequestContext as buildNextSetSyncRequestContextHelper,
  resolveReadyNextSetResponseAction,
  resolveRoomStatusNextSetAction,
  resolveWaitingNextSetRoomUpdateAction,
  shouldResumeAfterAugmentSelectionWait,
  type NextSetTransitionAction,
} from './helpers/augment-wait-flow'
import {
  AUTHORITATIVE_DEBUG_HOTKEYS,
  buildAuthoritativeDebugOverlayText as buildAuthoritativeDebugOverlayTextHelper,
  buildAuthoritativeDebugSnapshotLine as buildAuthoritativeDebugSnapshotLineHelper,
  shouldRenderAuthoritativeDebugOverlay as shouldRenderAuthoritativeDebugOverlayHelper,
} from './helpers/debug-overlay'
import {
  buildRaceFinalResultEventDetail,
  hasAuthoritativeRoundResultContext,
  getMissingRoundResultIndexes as getMissingRoundResultIndexesHelper,
  mapAuthoritativeRankingsToRoundEntries as mapAuthoritativeRankingsToRoundEntriesHelper,
  resolveFinalResultBackfillAction,
} from './helpers/result-recovery'
import {
  buildRaceStartBootstrapDebugPayload,
  shouldMarkInitialAuthoritativeFrameReceived,
  shouldReleaseRaceStartOverlay,
} from './helpers/race-start-bootstrap'

type AuthoritativeRaceFrame = {
  elapsedMs: number
  positions: Record<string, number>
  speeds: Record<string, number>
  stamina: Record<string, number>
  finished: Record<string, boolean>
}

type AuthoritativeRaceEvent =
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

type AuthoritativeTimeline = {
  keyframes: AuthoritativeRaceFrame[]
  events: AuthoritativeRaceEvent[]
  rankings: Array<{ playerId: string; position: number; time: number }>
  startedAtMillis: number | null
  scriptVersion: string
  raceStateDocVersion: string
  outputFrameMs: number
  simStepMs: number
  trackLengthM: number
  snapshotHash: string
  slowmoTriggerMs: number | null
}

/** 물리 계산용 고정 스텝(초). 기록 시간은 서버 결과를 쓰지만 움직임 느낌에는 영향이 있다. */
const PHYSICS_DT_SEC = 0.02
const AUTHORITATIVE_POLL_INTERVAL_PREPARED_MS = 420
const AUTHORITATIVE_POLL_INTERVAL_RUNNING_MS = 180
const AUTHORITATIVE_POLL_INTERVAL_COMPLETED_MS = 320
const AUTHORITATIVE_POLL_INTERVAL_HIDDEN_TAB_MS = 650
const AUTHORITATIVE_POLL_FAILURE_BACKOFF_MULTIPLIER = 1.6
const AUTHORITATIVE_POLL_FAILURE_MAX_MS = 1800
const AUTHORITATIVE_EVENTS_WINDOW_OVERLAP_MS = 1600
const SET_RESULT_POLL_INITIAL_DELAY_MS = 280
const SET_RESULT_POLL_MAX_DELAY_MS = 1100
const SET_RESULT_POLL_BACKOFF_MULTIPLIER = 1.55
// 서버 상태 polling은 running 중 180ms + 응답 지연 간격으로 도착한다.
// 렌더를 더 늦춰 보유한 keyframe 범위 안에서 재생해야 말이 멈췄다가 점프하지 않는다.
const AUTHORITATIVE_RENDER_DELAY_MS = 320
// 서버 시간으로 바로 점프하지 않고 조금씩 따라가게 해서 시간축이 튀는 느낌을 줄인다.
const AUTHORITATIVE_TIME_SOFT_CORRECTION_ALPHA = 0.15
// 탭 복귀/폴링 지연으로 차이가 너무 커지면 바로 맞춘다. 천천히 맞추면 더 어색할 수 있다.
const AUTHORITATIVE_TIME_HARD_SNAP_MS = 600
// 위치 오차가 큰 경우만 hard snap을 쓰고, 보통은 부드럽게 따라가게 한다.
// 값은 현재 튜닝값이라서 DEV 오버레이 보고 다시 조절할 수 있다.
const AUTHORITATIVE_POSITION_HARD_SNAP_M = 2.5
// 일반 구간에서는 한 프레임에 일부만 보정해서 갑자기 튀는 느낌을 줄인다.
const AUTHORITATIVE_POSITION_SOFT_BLEND = 0.28
const AUTHORITATIVE_FINISH_ZONE_M = 12
const AUTHORITATIVE_FINISH_ZONE_HARD_SNAP_M = 4.5
const AUTHORITATIVE_FINISH_ZONE_SOFT_BLEND = 0.4
const AUTHORITATIVE_FINISH_ZONE_MAX_CORRECTION_M = 0.85
const AUTHORITATIVE_FINISH_SLOWMO_HARD_SNAP_M = 6.0
const AUTHORITATIVE_FINISH_SLOWMO_SOFT_BLEND = 0.12
const AUTHORITATIVE_FINISH_SLOWMO_MAX_CORRECTION_M = 0.45
// 평소 구간에서는 서버 시간 따라잡기 보정을 조금 더 크게 준다.
const AUTHORITATIVE_DRIFT_CORRECTION_NORMAL = { gain: 0.16, min: -3, max: 14 }
// 슬로모 구간은 보정이 더 눈에 보여서 보정량을 작게 제한한다.
const AUTHORITATIVE_DRIFT_CORRECTION_SLOWMO = { gain: 0.04, min: -1.5, max: 1.2 }
const AUTHORITATIVE_EVENT_CONSUME_TOLERANCE_MS = 24
const AUTHORITATIVE_VISUAL_FINISH_EPSILON_M = 0.08
const AUTHORITATIVE_VISUAL_FINISH_FALLBACK_MS = 1200
const FINAL_RESULT_BACKFILL_RETRY_MAX = 3
const FINAL_RESULT_SET_FETCH_DEDUPE_WINDOW_MS = 1400
const RACE_START_BOOTSTRAP_MIN_DURATION_MS = 700
const RACE_START_BOOTSTRAP_MAX_WAIT_MS = 3000
const AUTHORITATIVE_TIMELINE_PRELOAD_RETRY_MS = 320
const AUTHORITATIVE_TIMELINE_PRELOAD_MAX_WAIT_MS = 15000
const RACE_SCENE_KEY = 'RaceScene'
const AUGMENT_SELECTION_SCENE_KEY = 'AugmentSelectionScene'
const RACE_RESULT_SCENE_KEY = 'RaceResultScene'
const ROOM_STATUS_RACING: Room['status'] = 'racing'
const ROOM_STATUS_AUGMENT_SELECTION: Room['status'] = 'augmentSelection'
const DEFAULT_PLAYER_COUNT = 8
const DEFAULT_ROUND_COUNT = 3
const DEFAULT_REROLL_LIMIT = 3
const RACE_SCENE_EVENTS = {
  FINISH_SEQUENCE_SLOWMO: 'finish-sequence-slowmo',
  FINISH_SEQUENCE_SLOWMO_RESTORE: 'finish-sequence-slowmo-restore',
  FINISH_SEQUENCE_HORSE_CROSSED: 'finish-sequence-horse-crossed',
  FINISH_SEQUENCE_DONE: 'finish-sequence-done',
} as const

export default class RaceScene extends Phaser.Scene {
  /** 씬 전환 사이에 공통으로 보여주는 대기 오버레이 시간 */
  private static readonly WAITING_DURATION_MS = 3000

  // ─── 레이스 상태 ─────────────────────────────────────────────
  private isRaceFinished = false
  private isRaceStarted = false
  private isCountdownActive = false

  // fixed-step 계산용 누적 시간(초). 프레임마다 쌓아뒀다가 물리 계산에 사용한다.
  private simTimeAccumulatorSec = 0
  // 레이스 재생 속도(1 = 정상). 슬로모는 이 값만 바꾼다.
  private simPlaybackScale = 1
  // 슬로모 적용 중인지 체크
  private simSlowmoActive = false
  // 슬로모를 켠 같은 프레임에는 crossed 이벤트를 무시해서 바로 복귀하지 않게 한다.
  private simSlowmoStartedThisFrame = false
  // 슬로모에서 정상 속도로 돌아올 때 쓰는 트윈 시간(ms)
  private simSlowmoRestoreMs = 300

  // ─── 레이스 종료 연출 ───────────────────────────────────────
  private isResultSceneShown = false
  /** 레이스 전체 축하 연출(FINISH 배너/컨페티) 시작 여부 */
  private isFinishSequenceTriggered = false
  /** FINISH 배너/파티클이 끝났는지. 결과 집계 오버레이는 이 뒤에 보여준다. */
  private finishSequenceDone = false
  /** 결과 집계 오버레이(“결과를 집계하는 중...”)를 이미 시작했는지 */
  private isResultAggregationStarted = false
  // ─── 게임 영역 (전체 화면, HUD는 오버레이) ────────────────────
  private gameAreaHeight = 0

  private mapManager!: TileMapManager
  private horseManager!: HorseManager
  private hud!: GUIManager
  private progressBarManager!: ProgressBarManager
  private cameraScrollManager!: CameraScrollManager
  private countdownManager!: CountdownManager

  /** 증강 선택 중 레이스 씬 위에 깔리는 반투명 오버레이 (HUD 카드보다 아래 뎁스) */
  private augmentDimOverlay?: Phaser.GameObjects.Rectangle

  // ─── 시뮬레이션 ──────────────────────────────────────────────
  // 레이스 재생 경과 시간(초). 말 step/finishTime 계산에 사용한다.
  private simElapsedSec = 0
  // 실제 시작 시각(ms). 로컬 기준 경과시간 계산이 필요할 때만 사용한다.
  private raceStartTimestampMs = 0

  // 현재 플레이어 말 인덱스 (0 = 1번 말, 1 = 2번 말 ...)
  private playerHorseIndex = 0

  // 세트 관련
  private currentSet = 1 // 현재 세트 (1부터 시작)
  private roundResults: RoundRankingEntry[][] = []

  // 증강 관련
  private selectedAugments: Augment[] = []
  private remainingRerolls = DEFAULT_REROLL_LIMIT // 현재 플레이어 남은 리롤 횟수
  private augmentSelectionActive = false

  // Firebase 데이터 저장
  private roomId?: string
  private playerId?: string
  private sessionToken?: string
  private roomJoinToken?: string | null
  private room?: Room
  private players?: Player[]
  private waitingOverlayHandle?: { close: (shouldComplete: boolean) => void }
  private isWaitingForOtherAugmentSelections = false
  private isWaitingForNextSetTransition = false
  private nextSetSyncPollEvent?: Phaser.Time.TimerEvent
  private isSyncingNextSetTransition = false
  private isServerRaceRequested = false
  private isServerRacePrepared = false
  private isPollingServerRaceResult = false
  private isBootstrappingRaceStart = false
  private raceStartBootstrapReadyForCountdown = false
  private raceStartBootstrapBeganAtMs: number | null = null
  private raceStartBootstrapMinReadyAtMs = 0
  private hasReceivedInitialAuthoritativeFrame = false
  private hasReceivedAnyAuthoritativePollResponse = false
  private raceStartBootstrapTimeoutEvent?: Phaser.Time.TimerEvent
  private serverRacePollEvent?: Phaser.Time.TimerEvent
  private authoritativeKeyframe?: AuthoritativeRaceFrame
  private authoritativeNextKeyframe?: AuthoritativeRaceFrame
  private authoritativeFrameBuffer: AuthoritativeRaceFrame[] = []
  private authoritativeTimeline?: AuthoritativeTimeline
  private authoritativeTimelineFrameCursorIndex = 0
  private isAuthoritativeTimelinePreloaded = false
  private isAuthoritativeTimelinePreloading = false
  private authoritativeTimelinePreloadError: string | null = null
  private authoritativeEventsWindow: Array<{
    id: string
    type: string
    elapsedMs: number
    rank?: number
    playerId?: string
  }> = []
  private consumedRaceEventIds = new Set<string>()
  private authoritativeFinishedPlayerIds = new Set<string>()
  private authoritativeElapsedMs: number = 0
  private authoritativeNowMs: number = 0
  private smoothedElapsedMs: number | null = null
  private lastRenderedElapsedMs: number = 0
  private lastAuthoritativePollClientTimeMs: number = 0
  private authoritativeWinnerFinishedEventSeen = false
  private authoritativeRaceStateStatus: 'prepared' | 'running' | 'completed' | null = null
  private authoritativeFinishPendingSinceMs: number | null = null
  private lastAuthoritativeEventWindowMaxElapsedMs = 0
  private consecutiveAuthoritativePollFailureCount = 0
  private authoritativeMetrics = {
    frameCount: 0,
    hardSnapCount: 0,
    softCorrectionCount: 0,
    timeHardSnapCount: 0,
    positionErrorSum: 0,
    positionErrorMax: 0,
  }
  private authoritativeDebugText?: Phaser.GameObjects.Text
  private authoritativeDebugLastRenderMs = 0
  private authoritativeDebugOverlayEnabled = true
  private readonly handleAuthoritativeDebugHotkey = (event: KeyboardEvent) => {
    if (!import.meta.env.DEV || event.repeat) return
    if (event.key === AUTHORITATIVE_DEBUG_HOTKEYS.TOGGLE_OVERLAY) {
      event.preventDefault()
      this.toggleAuthoritativeDebugOverlay()
      return
    }
    if (event.key === AUTHORITATIVE_DEBUG_HOTKEYS.COPY_SNAPSHOT) {
      event.preventDefault()
      void this.copyAuthoritativeDebugOverlaySnapshot()
    }
  }
  private authoritativeRacePlan:
    | {
        rankings: Array<{ playerId: string; position: number; time: number }>
        startedAtMillis: number | null
      }
    | undefined

  // 개발 모드에서 직접 넣어보는 말 데이터
  private selectedHorse?: {
    name: string
    stats: Stats
    totalStats: number
    selectedAt: string
  }
  private dataSync!: RaceDataSync
  private runtimeController!: RaceRuntimeController
  private flowUI!: RaceFlowUI
  private finalResultBackfillRetryCount = 0
  private lastStartedSetTransitionTargetSet: number | null = null
  private lastSetResultFetchAttemptMsBySet = new Map<number, number>()

  private hashStringToUint32(input: string): number {
    let hash = 2166136261 >>> 0
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  private createSeededRandom(seed: string): () => number {
    let state = this.hashStringToUint32(seed)
    if (state === 0) state = 0x9e3779b9
    return () => {
      state += 0x6d2b79f5
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  private getDeterministicConditionRoll(playerKey: string, luck: number): number {
    if (!this.roomId) return 0
    const setIndex = this.room?.currentSet ?? this.currentSet
    const seed = `condition|room:${this.roomId}|set:${setIndex}|player:${playerKey}`
    const rng = this.createSeededRandom(seed)
    const normalized = luck <= 20 ? luck / 20 : 1.0 + (luck - 20) / 40
    let minBonus: number
    let maxBonus: number
    if (normalized <= 1.0) {
      minBonus = -0.1 + normalized * 0.1
      maxBonus = 0.1 + normalized * 0.1
    } else if (normalized <= 1.5) {
      const t = (normalized - 1.0) / 0.5
      minBonus = 0.0 + t * 0.1
      maxBonus = 0.2 + t * 0.3
    } else {
      minBonus = 0.1
      maxBonus = 0.5
    }
    return minBonus + rng() * (maxBonus - minBonus)
  }

  private isServerAuthoritativeRaceMode(): boolean {
    return !!(this.roomId && this.playerId && this.sessionToken && this.roomJoinToken)
  }

  private readonly handleFinishSequenceSlowmo = (scale: number, restoreMs: number) => {
    this.simPlaybackScale = scale
    this.simSlowmoActive = true
    this.simSlowmoStartedThisFrame = true
    this.simSlowmoRestoreMs = restoreMs
    this.hud.setAugmentSelectionHUD('hidden', { fadeOut: true })
    this.progressBarManager.setVisibleWithFadeOut(280)
  }

  private readonly handleFinishSequenceSlowmoRestore = () => {
    this.hud.setAugmentSelectionHUD('full', { fadeIn: true })
    this.progressBarManager.setVisibleWithFadeIn(320)
  }

  constructor() {
    super(RACE_SCENE_KEY)
    this.dataSync = new RaceDataSync({
      scene: this,
      onDataApplied: (data) => this.applyGameData(data),
      onDataUpdated: () => this.onGameDataUpdated(),
    })
    this.runtimeController = new RaceRuntimeController()
    this.flowUI = new RaceFlowUI()
  }

  /**
   * Scene 초기화 시 데이터 받기
   */
  init(data?: {
    roomId?: string
    playerId?: string
    room?: Room
    players?: Player[]
    selectedHorse?: {
      name: string
      stats: Stats
      totalStats: number
      selectedAt: string
    }
  }) {
    this.dataSync.applyInitData(data)
  }

  preload() {
    // 배경 (타일맵 에셋)
    tileMapAssetLoaders.forEach(({ key, url }) => this.load.image(key, url))

    // 말 1~8번 신규 에셋 (44x44): 대기 ready1/ready2/ready3(8프레임), 달리기 run
    const frame44 = { frameWidth: 44, frameHeight: 44 }
    horseSpriteSheetUrls.forEach((urls, i) => {
      const n = i + 1
      this.load.spritesheet(`horse${n}_ready1`, urls.ready1, frame44)
      this.load.spritesheet(`horse${n}_ready2`, urls.ready2, frame44)
      this.load.spritesheet(`horse${n}_ready3`, urls.ready3, frame44)
      this.load.spritesheet(`horse${n}_run`, urls.run, frame44)
    })

    // 플레이어 표시 화살표
    this.load.image('arrow', rightArrowUrl)
    // 하단 HUD 카드 배경
    this.load.image('hud_panel_bg', hudPanelBgUrl)
  }

  create() {
    // PhaserGame -> Scene data 채널로 들어온 최신 room/player 데이터를 먼저 동기화한다.
    this.dataSync.loadFromSceneData()
    this.dataSync.subscribe()
    this.setupGameArea()
    this.initializeFromGameData()
    this.createManagers()
    this.createHorsesAndHUD()
    this.setupAugmentSelection()
    this.createAuthoritativeDebugOverlay()
    this.registerSceneEventBridge()
    // create() 재호출/씬 재진입 시 리스너 누적을 막기 위해 shutdown/destroy에서 정리한다.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleSceneShutdown, this)
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleSceneDestroy, this)
  }

  private registerSceneEventBridge() {
    this.events.on(RACE_SCENE_EVENTS.FINISH_SEQUENCE_SLOWMO, this.handleFinishSequenceSlowmo)
    this.events.on(
      RACE_SCENE_EVENTS.FINISH_SEQUENCE_SLOWMO_RESTORE,
      this.handleFinishSequenceSlowmoRestore,
    )
  }

  private unregisterSceneEventBridge() {
    this.events.off(RACE_SCENE_EVENTS.FINISH_SEQUENCE_SLOWMO, this.handleFinishSequenceSlowmo)
    this.events.off(
      RACE_SCENE_EVENTS.FINISH_SEQUENCE_SLOWMO_RESTORE,
      this.handleFinishSequenceSlowmoRestore,
    )
  }

  /** 게임 영역 = 전체 화면 (HUD는 하단 HUD 카드/아이콘만 오버레이) */
  private setupGameArea() {
    this.gameAreaHeight = this.scale.height
    applyPixelArtFilter(this)
  }

  /** 맵, 카메라 스크롤, 진행바 매니저 생성 */
  private createManagers() {
    const gameWidth = this.scale.width
    const gameHeight = this.gameAreaHeight

    this.mapManager = new TileMapManager({
      scene: this,
      gameWidth,
      gameHeight,
      preTiles: 3,
      raceTiles: 100,
      postTiles: 5,
    })

    this.cameraScrollManager = new CameraScrollManager({
      scene: this,
      mapManager: this.mapManager,
    })

    this.progressBarManager = new ProgressBarManager({
      scene: this,
      gameAreaHeight: this.gameAreaHeight,
      getTrackLengthM: () => this.mapManager.getTrackLengthM(),
      playerHorseIndex: this.playerHorseIndex,
    })
  }

  /** 말, HUD, 진행바 생성 및 초기 HUD 업데이트 */
  private createHorsesAndHUD() {
    const gameHeight = this.gameAreaHeight
    const playerCount = this.getResolvedPlayerCount()
    const playersFromData = this.data.get('players') as Player[] | undefined
    const playerNames =
      playersFromData?.map((p, index) => p.name || `Horse_${index + 1}`) ||
      this.players?.map((p, index) => p.name || `Horse_${index + 1}`) ||
      undefined

    this.horseManager = new HorseManager({
      scene: this,
      gameHeight,
      getTrackStartWorldXPx: () => this.mapManager.getTrackStartWorldXPx(),
      getTrackLengthM: () => this.mapManager.getTrackLengthM(),
      getFinishLineOffsetM: () => this.mapManager.getFinishLineOffsetM(),
      playerHorseIndex: this.playerHorseIndex,
      arrowTextureKey: 'arrow',
      playerCount,
      playerNames,
    })

    if (this.selectedHorse && this.horseManager) {
      const simHorses = this.horseManager.getSimHorses()
      if (simHorses[this.playerHorseIndex]) {
        const playerHorse = simHorses[this.playerHorseIndex]
        playerHorse.baseStats = this.selectedHorse.stats
        // 행운 보너스는 증강 선택 직후(applyAugmentsToAllHorses 또는 onCancel→prepareAllHorsesForRace)에서만 적용
      }
    }

    this.hud = new GUIManager(this, this.scale.height, playerCount)
    this.hud.createHUD()
    this.hud.createRankingPanel()
    this.progressBarManager.create()
    this.updateHUDInitial()

    this.countdownManager = new CountdownManager({
      scene: this,
      centerX: this.scale.width / 2,
      centerY: this.gameAreaHeight / 2,
    })
  }

  /** 게임 시작 전 증강 선택 표시 */
  private setupAugmentSelection() {
    if (this.roomId && this.room?.status === ROOM_STATUS_RACING) {
      this.startInProgressAuthoritativeRaceRecovery()
      return
    }
    void this.showAugmentSelection(generateRandomRarity())
  }

  private commitRaceStartRuntime(): boolean {
    const wasStarted = this.isRaceStarted
    const nextState = this.runtimeController.startRace(this.getRuntimeState())
    this.applyRuntimeState(nextState)

    if (!this.isRaceStarted || wasStarted) return false

    this.horseManager.hidePlayerIndicator()
    this.horseManager.startAllHorses()
    return true
  }

  private beginRaceStartBootstrap() {
    if (this.isBootstrappingRaceStart) return

    // "게임을 시작하는 중..." 단계:
    // 서버 prepareRace 후 전체 timeline을 먼저 받아두고,
    // countdown은 로컬 timeline이 완성된 뒤에만 시작한다.
    this.isBootstrappingRaceStart = true
    this.raceStartBootstrapBeganAtMs = performance.now()
    this.raceStartBootstrapMinReadyAtMs =
      this.raceStartBootstrapBeganAtMs + RACE_START_BOOTSTRAP_MIN_DURATION_MS
    this.hasReceivedInitialAuthoritativeFrame = false
    this.hasReceivedAnyAuthoritativePollResponse = false
    this.authoritativeTimeline = undefined
    this.isAuthoritativeTimelinePreloaded = false
    this.isAuthoritativeTimelinePreloading = false
    this.authoritativeTimelinePreloadError = null

    this.horseManager.hidePlayerIndicator()
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
      messageKey: 'game.startingRace',
      durationMs: null,
      onComplete: () => {
        // 서버 시작 신호가 올 때까지 직접 닫지 않는다.
      },
    })

    this.raceStartBootstrapTimeoutEvent?.remove(false)
    this.raceStartBootstrapTimeoutEvent = this.time.delayedCall(
      RACE_START_BOOTSTRAP_MAX_WAIT_MS,
      () => {
        if (!this.isBootstrappingRaceStart) return
        console.warn(
          '[RaceScene] race start bootstrap timeout',
          buildRaceStartBootstrapDebugPayload({
            roomId: this.roomId,
            setIndex: this.currentSet,
            elapsedMs: this.authoritativeElapsedMs,
            hasKeyframe: !!this.authoritativeKeyframe,
            hasNextKeyframe: !!this.authoritativeNextKeyframe,
            hasAnyPollResponse: this.hasReceivedAnyAuthoritativePollResponse,
            reason: 'timeout',
          }),
        )
        this.authoritativeTimelinePreloadError = 'Timeline preload is still retrying after timeout'
      },
    )

    // bootstrap 단계에서는 prepare + timeline preload만 수행하고 startRace는 아직 호출하지 않는다.
    void this.preloadAuthoritativeTimelineForRaceStart(this.currentSet, {
      onPreloaded: 'countdown',
    })
  }

  private startInProgressAuthoritativeRaceRecovery() {
    if (!this.isServerAuthoritativeRaceMode() || this.isBootstrappingRaceStart || this.isRaceStarted) return

    this.prepareAllHorsesForRaceWithCurrentPlayers()
    this.horseManager.hidePlayerIndicator()
    this.flowUI.hideGUIForWaitingOverlay({
      hud: this.hud,
      progressBarManager: this.progressBarManager,
      horseManager: this.horseManager,
    })
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
      messageKey: 'game.startingRace',
      durationMs: null,
      onComplete: () => {
        // in-progress recovery가 끝나거나 결과 집계로 넘어갈 때 직접 닫는다.
      },
    })

    this.isBootstrappingRaceStart = true
    this.raceStartBootstrapBeganAtMs = performance.now()
    this.raceStartBootstrapMinReadyAtMs = performance.now()
    this.authoritativeTimeline = undefined
    this.isAuthoritativeTimelinePreloaded = false
    this.isAuthoritativeTimelinePreloading = false
    this.authoritativeTimelinePreloadError = null

    void this.preloadAuthoritativeTimelineForRaceStart(this.currentSet, {
      onPreloaded: 'recover-in-progress',
    })
  }

  private waitForAuthoritativeTimelineRetry(): Promise<void> {
    return new Promise((resolve) => {
      this.time.delayedCall(AUTHORITATIVE_TIMELINE_PRELOAD_RETRY_MS, () => resolve())
    })
  }

  private async prepareAuthoritativeTimelineIfHost(setIndex: number): Promise<void> {
    if (
      this.isServerRacePrepared ||
      !this.isCurrentPlayerHost() ||
      this.room?.status !== ROOM_STATUS_RACING ||
      !this.roomId ||
      !this.playerId ||
      !this.sessionToken ||
      !this.roomJoinToken
    ) {
      return
    }

    this.isServerRacePrepared = true
    try {
      await prepareRace({
        roomId: this.roomId,
        playerId: this.playerId,
        sessionToken: this.sessionToken,
        joinToken: this.roomJoinToken,
        setIndex,
      })
    } catch (error) {
      this.isServerRacePrepared = false
      throw error
    }
  }

  private validateAuthoritativeTimelineMetadata(
    current: Record<string, unknown> | null,
    next: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!current) return next
    const mismatchedKey = Object.keys(next).find((key) => current[key] !== next[key])
    if (mismatchedKey) {
      throw new Error(`Timeline metadata changed while preloading: ${mismatchedKey}`)
    }
    return current
  }

  private async preloadAuthoritativeTimelineForRaceStart(
    setIndex: number,
    options: { onPreloaded: 'countdown' | 'recover-in-progress' },
  ): Promise<void> {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken || !this.room) {
      return
    }

    this.isAuthoritativeTimelinePreloading = true
    this.authoritativeTimelinePreloadError = null
    const preloadStartedAtMs = performance.now()
    let hasLoggedMaxWait = false

    while (this.isBootstrappingRaceStart && this.currentSet === setIndex) {
      const keyframeChunksByIndex = new Map<number, AuthoritativeRaceFrame[]>()
      const eventBucketsByStart = new Map<number, AuthoritativeRaceEvent[]>()
      let nextCursor:
        | {
            keyframeChunkIndex?: number
            eventBucketStartElapsedMs?: number
          }
        | null
        | undefined
      let metadata: Record<string, unknown> | null = null

      try {
        await this.prepareAuthoritativeTimelineIfHost(setIndex)

        do {
          const response = await getRaceTimeline({
            roomId: this.roomId,
            playerId: this.playerId,
            sessionToken: this.sessionToken,
            joinToken: this.roomJoinToken,
            setIndex,
            ...(nextCursor ? { chunkCursor: nextCursor } : {}),
          })
          const page = response.data

          if (!page.hasTimeline) {
            break
          }

          metadata = this.validateAuthoritativeTimelineMetadata(metadata, {
            scriptVersion: page.scriptVersion ?? '',
            raceStateDocVersion: page.raceStateDocVersion ?? '',
            snapshotHash: page.snapshotHash ?? '',
            keyframeCount: page.keyframeCount ?? 0,
            eventCount: page.eventCount ?? 0,
            keyframeChunkCount: page.keyframeChunkCount ?? 0,
            eventChunkCount: page.eventChunkCount ?? 0,
          })

          for (const chunk of page.keyframeChunks ?? []) {
            keyframeChunksByIndex.set(chunk.chunkIndex, chunk.keyframes)
          }
          for (const bucket of page.eventBuckets ?? []) {
            eventBucketsByStart.set(bucket.bucketStartElapsedMs, bucket.events)
          }

          nextCursor = page.nextCursor ?? null
          if (nextCursor === null) {
            const keyframes = Array.from(keyframeChunksByIndex.entries())
              .sort((a, b) => a[0] - b[0])
              .flatMap(([, frames]) => frames)
            const events = Array.from(eventBucketsByStart.entries())
              .sort((a, b) => a[0] - b[0])
              .flatMap(([, bucketEvents]) => bucketEvents)
              .sort((a, b) => a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id))
            const expectedKeyframeCount = page.keyframeCount ?? 0
            const expectedEventCount = page.eventCount ?? 0
            if (keyframes.length !== expectedKeyframeCount || events.length !== expectedEventCount) {
              throw new Error(
                `Timeline preload count mismatch: keyframes ${keyframes.length}/${expectedKeyframeCount}, events ${events.length}/${expectedEventCount}`,
              )
            }
            if (keyframes.length === 0) {
              throw new Error('Timeline preload completed without keyframes')
            }

            this.authoritativeTimeline = {
              keyframes,
              events,
              rankings: page.rankings ?? [],
              startedAtMillis: page.startedAtMillis ?? null,
              scriptVersion: page.scriptVersion ?? '',
              raceStateDocVersion: page.raceStateDocVersion ?? '',
              outputFrameMs: page.outputFrameMs ?? 50,
              simStepMs: page.simStepMs ?? 50,
              trackLengthM: page.trackLengthM ?? this.mapManager.getTrackLengthM(),
              snapshotHash: page.snapshotHash ?? '',
              slowmoTriggerMs: page.slowmoTriggerMs ?? null,
            }
            this.isAuthoritativeTimelinePreloaded = true
            this.isAuthoritativeTimelinePreloading = false
            this.authoritativeTimelinePreloadError = null
            this.stopServerRaceStatePolling()
            this.authoritativeKeyframe = keyframes[0]
            this.authoritativeNextKeyframe = keyframes[1] ?? keyframes[0]
            this.authoritativeFrameBuffer = keyframes.slice(0, 64)
            this.authoritativeTimelineFrameCursorIndex = 0
            this.authoritativeRaceStateStatus = page.status ?? 'prepared'
            this.authoritativeRacePlan = {
              rankings: page.rankings ?? [],
              startedAtMillis: page.startedAtMillis ?? null,
            }

            if (import.meta.env.DEV) {
              console.info('[RaceScene] authoritative timeline preload complete', {
                roomId: this.roomId,
                setIndex,
                keyframeCount: keyframes.length,
                eventCount: events.length,
                snapshotHash: page.snapshotHash ?? '',
              })
            }
            const remainingMinDurationMs = this.raceStartBootstrapMinReadyAtMs - performance.now()
            if (remainingMinDurationMs > 0) {
              await new Promise<void>((resolve) => {
                this.time.delayedCall(remainingMinDurationMs, () => resolve())
              })
            }
            if (!this.isBootstrappingRaceStart || this.currentSet !== setIndex) {
              return
            }
            if (options.onPreloaded === 'recover-in-progress') {
              this.resumeInProgressAuthoritativeRaceFromTimeline(setIndex)
              return
            }
            this.releaseRaceStartBootstrap({ reason: 'timeline-preloaded' })
            return
          }
        } while (nextCursor && this.isBootstrappingRaceStart && this.currentSet === setIndex)
      } catch (error) {
        this.authoritativeTimelinePreloadError =
          error instanceof Error ? error.message : 'Timeline preload failed'
        if (import.meta.env.DEV) {
          console.warn('[RaceScene] authoritative timeline preload retrying:', error)
        }
      }

      const elapsedMs = performance.now() - preloadStartedAtMs
      if (!hasLoggedMaxWait && elapsedMs >= AUTHORITATIVE_TIMELINE_PRELOAD_MAX_WAIT_MS) {
        hasLoggedMaxWait = true
        console.warn('[RaceScene] authoritative timeline preload exceeded max wait; keeping overlay', {
          roomId: this.roomId,
          setIndex,
          elapsedMs,
          error: this.authoritativeTimelinePreloadError,
        })
      }
      await this.waitForAuthoritativeTimelineRetry()
    }

    this.isAuthoritativeTimelinePreloading = false
  }

  private releaseRaceStartBootstrap(params: {
    reason: 'first-frame' | 'timeout' | 'already-ready' | 'timeline-preloaded'
  }) {
    if (!this.isBootstrappingRaceStart) return

    this.isBootstrappingRaceStart = false
    this.raceStartBootstrapBeganAtMs = null
    this.raceStartBootstrapMinReadyAtMs = 0
    this.raceStartBootstrapTimeoutEvent?.remove(false)
    this.raceStartBootstrapTimeoutEvent = undefined
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = undefined

    if (import.meta.env.DEV) {
      console.info(
        '[RaceScene] race start bootstrap released',
        buildRaceStartBootstrapDebugPayload({
          roomId: this.roomId,
          setIndex: this.currentSet,
          elapsedMs: this.authoritativeElapsedMs,
          hasKeyframe: !!this.authoritativeKeyframe,
          hasNextKeyframe: !!this.authoritativeNextKeyframe,
          hasAnyPollResponse: this.hasReceivedAnyAuthoritativePollResponse,
          reason: params.reason,
        }),
      )
    }

    this.raceStartBootstrapReadyForCountdown = true
    // bootstrap이 끝나면 그 다음에만 3,2,1,GO 카운트다운을 시작한다.
    this.startCountdown()
  }

  private resumeInProgressAuthoritativeRaceFromTimeline(setIndex: number) {
    const timeline = this.authoritativeTimeline
    const startedAtMillis = timeline?.startedAtMillis
    if (!timeline || typeof startedAtMillis !== 'number') {
      this.releaseRaceStartBootstrap({ reason: 'timeline-preloaded' })
      return
    }

    const elapsedMs = Math.max(0, Date.now() - startedAtMillis)
    const lastFrameElapsedMs = timeline.keyframes[timeline.keyframes.length - 1]?.elapsedMs ?? 0
    this.isBootstrappingRaceStart = false
    this.raceStartBootstrapBeganAtMs = null
    this.raceStartBootstrapMinReadyAtMs = 0
    this.raceStartBootstrapTimeoutEvent?.remove(false)
    this.raceStartBootstrapTimeoutEvent = undefined

    if (elapsedMs >= lastFrameElapsedMs) {
      this.waitingOverlayHandle?.close(false)
      this.waitingOverlayHandle = undefined
      this.startResultAggregationOverlay()
      return
    }

    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = undefined
    this.flowUI.showGUIAfterWaitingOverlay({
      hud: this.hud,
      horseManager: this.horseManager,
    })
    this.applyAuthoritativeStartedAtMillis(startedAtMillis)
    this.raceStartBootstrapReadyForCountdown = false
    this.commitRaceStartRuntime()

    if (import.meta.env.DEV) {
      console.info('[RaceScene] recovered in-progress authoritative race', {
        roomId: this.roomId,
        setIndex,
        elapsedMs,
        lastFrameElapsedMs,
      })
    }
  }

  private tryReleaseRaceStartBootstrapIfReady(reason: 'first-frame' | 'already-ready') {
    if (!this.isBootstrappingRaceStart) return
    if (
      !shouldReleaseRaceStartOverlay({
        hasReceivedInitialAuthoritativeFrame: this.hasReceivedInitialAuthoritativeFrame,
        nowMs: performance.now(),
        minReadyAtMs: this.raceStartBootstrapMinReadyAtMs,
      })
    ) {
      return
    }

    this.releaseRaceStartBootstrap({ reason })
  }

  private markInitialAuthoritativeFrameReceived(params: {
    setIndex: number
    elapsedMs?: number
    hasKeyframe: boolean
    hasNextKeyframe: boolean
  }) {
    if (this.hasReceivedInitialAuthoritativeFrame) return
    this.hasReceivedInitialAuthoritativeFrame = true

    if (import.meta.env.DEV) {
      console.info(
        '[RaceScene] initial authoritative race frame received',
        buildRaceStartBootstrapDebugPayload({
          roomId: this.roomId,
          setIndex: params.setIndex,
          elapsedMs: params.elapsedMs,
          hasKeyframe: params.hasKeyframe,
          hasNextKeyframe: params.hasNextKeyframe,
          hasAnyPollResponse: this.hasReceivedAnyAuthoritativePollResponse,
          reason: 'first-frame',
        }),
      )
    }
  }

  private handleStart() {
    if (this.roomId && this.playerId && this.sessionToken && this.roomJoinToken && this.room) {
      if (!this.raceStartBootstrapReadyForCountdown) {
        this.beginRaceStartBootstrap()
        return
      }
      this.raceStartBootstrapReadyForCountdown = false
      this.beginLocalAuthoritativeTimelinePlaybackIfNeeded()
      // 서버 startRace는 실제 출발 타이밍(GO 직후)에 맞춰서 호출한다.
      void this.beginServerAuthoritativeRace({ requestStart: true })
      this.commitRaceStartRuntime()
      return
    }

    this.commitRaceStartRuntime()
  }

  private beginLocalAuthoritativeTimelinePlaybackIfNeeded() {
    if (!this.isAuthoritativeTimelinePreloaded || !this.authoritativeTimeline) return
    if (this.authoritativeRacePlan?.startedAtMillis) return
    const startedAtMillis = Date.now()
    this.authoritativeTimeline = {
      ...this.authoritativeTimeline,
      startedAtMillis,
    }
    this.authoritativeRacePlan = {
      rankings: this.authoritativeTimeline.rankings,
      startedAtMillis,
    }
    this.authoritativeRaceStateStatus = 'running'
    this.authoritativeElapsedMs = 0
    this.authoritativeNowMs = startedAtMillis
    this.lastAuthoritativePollClientTimeMs = performance.now()
  }

  private async beginServerAuthoritativeRace(options?: { requestStart?: boolean }) {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken || !this.room) {
      return
    }
    const shouldRequestStart = options?.requestStart === true

    const setIndex = this.currentSet

    if (
      shouldMarkInitialAuthoritativeFrameReceived({
        hasRaceState: !!this.authoritativeKeyframe || !!this.authoritativeNextKeyframe,
        elapsedMs: this.authoritativeElapsedMs,
        keyframe: this.authoritativeKeyframe,
        nextKeyframe: this.authoritativeNextKeyframe,
      })
    ) {
      this.markInitialAuthoritativeFrameReceived({
        setIndex,
        elapsedMs: this.authoritativeElapsedMs,
        hasKeyframe: !!this.authoritativeKeyframe,
        hasNextKeyframe: !!this.authoritativeNextKeyframe,
      })
      this.tryReleaseRaceStartBootstrapIfReady('already-ready')
    }

    // 정상 경로는 preload된 timeline으로 재생한다. getRaceState polling은 preload 실패/미사용 시
    // 임시 fallback으로만 남겨둔다.
    if (this.shouldUseServerRaceStatePollingFallback()) {
      this.startServerRaceStatePolling(setIndex)
    }

    try {
      if (
        !shouldRequestStart &&
        !this.isServerRacePrepared &&
        this.isCurrentPlayerHost() &&
        this.room.status === ROOM_STATUS_RACING
      ) {
        this.isServerRacePrepared = true
        // host만 prepareRace를 호출해서 서버 스크립트를 먼저 만든다.
        await prepareRace({
          roomId: this.roomId,
          playerId: this.playerId,
          sessionToken: this.sessionToken,
          joinToken: this.roomJoinToken,
          setIndex,
        })
      }
      if (
        shouldRequestStart &&
        !this.isServerRaceRequested &&
        this.isCurrentPlayerHost() &&
        this.room.status === ROOM_STATUS_RACING
      ) {
        this.isServerRaceRequested = true
        // 실제 출발 타이밍에 host가 startRace를 호출해서 startedAt을 확정한다.
        const response = await startRace({
          roomId: this.roomId,
          playerId: this.playerId,
          sessionToken: this.sessionToken,
          joinToken: this.roomJoinToken,
          setIndex,
        })
        this.applyAuthoritativeStartedAtMillis(response.data.startedAtMillis)
      }
    } catch (error) {
      if (!shouldRequestStart) {
        this.isServerRacePrepared = false
      } else {
        this.isServerRaceRequested = false
      }
      console.warn('[RaceScene] Failed to bootstrap server-authoritative race:', error)
    }
  }

  private applyAuthoritativeStartedAtMillis(startedAtMillis: number | null | undefined) {
    if (typeof startedAtMillis !== 'number') return
    this.authoritativeRacePlan = {
      rankings: this.authoritativeRacePlan?.rankings ?? this.authoritativeTimeline?.rankings ?? [],
      startedAtMillis,
    }
    if (this.authoritativeTimeline) {
      this.authoritativeTimeline = {
        ...this.authoritativeTimeline,
        startedAtMillis,
      }
    }
    this.authoritativeRaceStateStatus = 'running'
    this.authoritativeElapsedMs = Math.max(0, Date.now() - startedAtMillis)
    this.authoritativeNowMs = Date.now()
    this.lastAuthoritativePollClientTimeMs = performance.now()
  }

  private computeNextAuthoritativePollDelayMs(): number {
    const visibilityDelay =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? AUTHORITATIVE_POLL_INTERVAL_HIDDEN_TAB_MS
        : 0
    const status = this.authoritativeRaceStateStatus
    let baseDelay =
      status === 'prepared'
        ? AUTHORITATIVE_POLL_INTERVAL_PREPARED_MS
        : status === 'completed'
          ? AUTHORITATIVE_POLL_INTERVAL_COMPLETED_MS
          : AUTHORITATIVE_POLL_INTERVAL_RUNNING_MS

    if (this.consecutiveAuthoritativePollFailureCount > 0) {
      const multiplier = Math.pow(
        AUTHORITATIVE_POLL_FAILURE_BACKOFF_MULTIPLIER,
        this.consecutiveAuthoritativePollFailureCount,
      )
      baseDelay = Math.min(AUTHORITATIVE_POLL_FAILURE_MAX_MS, Math.round(baseDelay * multiplier))
    }

    if (visibilityDelay > 0) {
      baseDelay = Math.max(baseDelay, visibilityDelay)
    }
    return baseDelay
  }

  private scheduleNextServerRaceStatePoll(setIndex: number, delayMs: number) {
    if (!this.shouldUseServerRaceStatePollingFallback()) {
      this.stopServerRaceStatePolling()
      return
    }
    this.serverRacePollEvent?.remove(false)
    this.serverRacePollEvent = this.time.delayedCall(delayMs, () => {
      void this.pollServerRaceState(setIndex)
    })
  }

  private async pollServerRaceState(setIndex: number) {
    if (!this.shouldUseServerRaceStatePollingFallback()) {
      this.stopServerRaceStatePolling()
      return
    }
    if (
      !this.roomId ||
      !this.playerId ||
      !this.sessionToken ||
      !this.roomJoinToken ||
      this.isPollingServerRaceResult
    ) {
      this.scheduleNextServerRaceStatePoll(setIndex, this.computeNextAuthoritativePollDelayMs())
      return
    }

    this.isPollingServerRaceResult = true
    try {
      const eventsSinceElapsedMs =
        this.lastAuthoritativeEventWindowMaxElapsedMs > 0
          ? Math.max(
              0,
              this.lastAuthoritativeEventWindowMaxElapsedMs -
                AUTHORITATIVE_EVENTS_WINDOW_OVERLAP_MS,
            )
          : undefined
      const response = await getRaceState({
        roomId: this.roomId,
        playerId: this.playerId,
        sessionToken: this.sessionToken,
        joinToken: this.roomJoinToken,
        setIndex,
        eventsSinceElapsedMs,
      })

      this.hasReceivedAnyAuthoritativePollResponse = true
      if (!response.data.hasRaceState) {
        this.consecutiveAuthoritativePollFailureCount = 0
        return
      }
      this.authoritativeRaceStateStatus = response.data.status ?? this.authoritativeRaceStateStatus
      if (
        response.data.status === 'prepared' &&
        this.isRaceStarted &&
        this.isCurrentPlayerHost() &&
        !this.isServerRaceRequested
      ) {
        void this.beginServerAuthoritativeRace({ requestStart: true })
      }

      this.authoritativeElapsedMs = response.data.elapsedMs ?? this.authoritativeElapsedMs
      this.authoritativeNowMs = response.data.authoritativeNowMs ?? Date.now()
      this.lastAuthoritativePollClientTimeMs = performance.now()
      this.authoritativeKeyframe = response.data.keyframe ?? this.authoritativeKeyframe
      this.authoritativeNextKeyframe = response.data.nextKeyframe ?? this.authoritativeNextKeyframe
      this.pushAuthoritativeFrame(this.authoritativeKeyframe)
      this.pushAuthoritativeFrame(this.authoritativeNextKeyframe)
      this.authoritativeEventsWindow = (response.data.eventsWindow ?? []).map((event) => ({
        id: event.id,
        type: event.type,
        elapsedMs: event.elapsedMs,
        rank: 'rank' in event ? event.rank : undefined,
        playerId: 'playerId' in event ? event.playerId : undefined,
      }))
      this.lastAuthoritativeEventWindowMaxElapsedMs = this.authoritativeEventsWindow.reduce(
        (maxElapsed, event) => Math.max(maxElapsed, event.elapsedMs),
        this.lastAuthoritativeEventWindowMaxElapsedMs,
      )

      if (response.data.rankings && response.data.rankings.length > 0) {
        const nextStartedAtMillis =
          response.data.startedAtMillis === undefined
            ? (this.authoritativeRacePlan?.startedAtMillis ?? null)
            : response.data.startedAtMillis
        this.authoritativeRacePlan = {
          rankings: response.data.rankings.map((entry) => ({
            playerId: entry.playerId,
            position: entry.position,
            time: entry.time,
          })),
          startedAtMillis: nextStartedAtMillis,
        }
        if (this.authoritativeTimeline && typeof nextStartedAtMillis === 'number') {
          this.authoritativeTimeline = {
            ...this.authoritativeTimeline,
            startedAtMillis: nextStartedAtMillis,
          }
        }
      }

      if (shouldMarkInitialAuthoritativeFrameReceived(response.data)) {
        this.markInitialAuthoritativeFrameReceived({
          setIndex,
          elapsedMs: response.data.elapsedMs,
          hasKeyframe: !!response.data.keyframe,
          hasNextKeyframe: !!response.data.nextKeyframe,
        })
      }
      this.tryReleaseRaceStartBootstrapIfReady('first-frame')
      this.consecutiveAuthoritativePollFailureCount = 0
    } catch (error) {
      this.consecutiveAuthoritativePollFailureCount += 1
      console.warn('[RaceScene] getRaceState polling failed:', error)
    } finally {
      this.isPollingServerRaceResult = false
      if (this.shouldUseServerRaceStatePollingFallback()) {
        this.scheduleNextServerRaceStatePoll(setIndex, this.computeNextAuthoritativePollDelayMs())
      }
    }
  }

  private shouldUseServerRaceStatePollingFallback(): boolean {
    return !this.isAuthoritativeTimelinePreloaded
  }

  private stopServerRaceStatePolling() {
    this.serverRacePollEvent?.remove(false)
    this.serverRacePollEvent = undefined
  }

  private startServerRaceStatePolling(setIndex: number) {
    if (!this.shouldUseServerRaceStatePollingFallback()) return
    this.stopServerRaceStatePolling()
    this.consecutiveAuthoritativePollFailureCount = 0
    void this.pollServerRaceState(setIndex)
  }

  private pushAuthoritativeFrame(frame: AuthoritativeRaceFrame | undefined) {
    if (!frame) return
    const next = this.authoritativeFrameBuffer.filter(
      (entry) => entry.elapsedMs !== frame.elapsedMs,
    )
    next.push(frame)
    next.sort((a, b) => a.elapsedMs - b.elapsedMs)
    this.authoritativeFrameBuffer = next.slice(-64)
  }

  private resolveFramePairForElapsed(renderElapsedMs: number): {
    current: AuthoritativeRaceFrame
    next: AuthoritativeRaceFrame
  } | null {
    const frames = this.authoritativeFrameBuffer
    if (!frames.length) return null

    let current = frames[0]
    let next = frames[frames.length - 1]

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      if (frame.elapsedMs <= renderElapsedMs) {
        current = frame
      }
      if (frame.elapsedMs >= renderElapsedMs) {
        next = frame
        break
      }
    }

    if (next.elapsedMs < current.elapsedMs) {
      next = current
    }

    return { current, next }
  }

  private resolveTimelineFramePairForElapsed(renderElapsedMs: number): {
    current: AuthoritativeRaceFrame
    next: AuthoritativeRaceFrame
  } | null {
    const frames = this.authoritativeTimeline?.keyframes
    if (!this.isAuthoritativeTimelinePreloaded || !frames?.length) return null

    const firstFrame = frames[0]
    const lastFrame = frames[frames.length - 1]
    if (renderElapsedMs <= firstFrame.elapsedMs) {
      this.authoritativeTimelineFrameCursorIndex = 0
      return { current: firstFrame, next: firstFrame }
    }
    if (renderElapsedMs >= lastFrame.elapsedMs) {
      this.authoritativeTimelineFrameCursorIndex = frames.length - 1
      return { current: lastFrame, next: lastFrame }
    }

    let cursor = Math.min(
      Math.max(0, this.authoritativeTimelineFrameCursorIndex),
      frames.length - 1,
    )
    while (cursor > 0 && frames[cursor].elapsedMs > renderElapsedMs) {
      cursor -= 1
    }
    while (cursor < frames.length - 1 && frames[cursor + 1].elapsedMs <= renderElapsedMs) {
      cursor += 1
    }
    this.authoritativeTimelineFrameCursorIndex = cursor

    const current = frames[cursor]
    const next = frames[cursor + 1] ?? current
    return { current, next }
  }

  /**
   * 게임 데이터로 게임 초기화
   * PhaserGame에서 전달받은 room/player 기준으로 플레이어 인덱스, 세트, 리롤 상태를 맞춘다.
   */
  private initializeFromGameData() {
    // 세트 수 설정
    this.currentSet = this.room?.currentSet || 1

    // 현재 플레이어 리롤 횟수 설정
    this.remainingRerolls = this.getRemainingRerollsForCurrentPlayer()

    // 플레이어 말 인덱스 찾기 (playerId 기준)
    if (this.players && this.playerId) {
      const currentPlayerIndex = this.players.findIndex((p) => p.id === this.playerId)
      if (currentPlayerIndex >= 0) {
        this.playerHorseIndex = currentPlayerIndex
      }
    }
  }

  private startCountdown() {
    // 카운트다운 직전에 내 말 인디케이터(우상단 화살표) 표시 보장
    this.horseManager.showPlayerIndicator()
    if (this.isCountdownActive) return
    if (this.isServerAuthoritativeRaceMode() && !this.raceStartBootstrapReadyForCountdown) {
      this.beginRaceStartBootstrap()
      return
    }
    this.isCountdownActive = true
    this.countdownManager.start(() => {
      this.isCountdownActive = false
      this.handleStart()
    })
  }

  /** 증강 선택 반투명 오버레이 뎁스 (하단 HUD 카드 CARD_DEPTH+0.5 보다 아래) */
  private static readonly AUGMENT_DIM_DEPTH = 30

  private prepareAllHorsesForRaceWithCurrentPlayers() {
    this.horseManager.prepareAllHorsesForRace(
      () => this.mapManager.getTrackLengthM(),
      () => this.mapManager.getFinishLineOffsetM(),
      (index, horse) => {
        const key = this.players?.[index]?.id ?? horse.name ?? String(index)
        return this.getDeterministicConditionRoll(key, horse.baseStats.Luck)
      },
    )
  }

  private resumeRaceAfterAugmentSelectionWait() {
    this.isWaitingForOtherAugmentSelections = false
    this.closeWaitingOverlay()
    this.hud.setHudCardFace(false)
    this.flowUI.showGUIAfterWaitingOverlay({
      hud: this.hud,
      horseManager: this.horseManager,
    })
    this.prepareAllHorsesForRaceWithCurrentPlayers()
    this.updateHUDInitial()
    this.startCountdown()
  }

  private startWaitingForOtherAugmentSelections() {
    this.removeAugmentDimOverlay()
    this.augmentSelectionActive = false
    this.isWaitingForOtherAugmentSelections = true
    this.hud.setAugmentSelectionHUD('full')
    this.hud.setAugmentPreview(null)
    this.flowUI.hideGUIForWaitingOverlay({
      hud: this.hud,
      progressBarManager: this.progressBarManager,
      horseManager: this.horseManager,
    })
    this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
      messageKey: 'game.waitingAfterAugment',
      durationMs: null,
      onComplete: () => {
        // 다음 레이스 상태가 확인될 때까지 직접 닫지 않는다.
      },
    })

    if (this.room?.status === ROOM_STATUS_RACING) {
      this.resumeRaceAfterAugmentSelectionWait()
    }
  }

  private async fetchSynchronizedAugmentSelection(setIndex: number): Promise<{
    rarity: AugmentRarity
    availableAugments: Augment[]
  } | null> {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken) {
      return null
    }

    let response: Awaited<ReturnType<typeof getAugmentSelection>> | null = null
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        response = await getAugmentSelection({
          roomId: this.roomId,
          playerId: this.playerId,
          sessionToken: this.sessionToken,
          joinToken: this.roomJoinToken,
          setIndex,
        })
        break
      } catch (error) {
        if (attempt === 9) {
          console.error('[RaceScene] Failed to fetch synchronized augment selection:', error)
        } else {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    }

    if (!response) return null

    return {
      rarity: response.data.rarity,
      availableAugments: response.data.availableAugments as Augment[],
    }
  }

  private async handleAugmentRerollRequest(): Promise<Augment[] | null> {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken) {
      return null
    }

    const response = await rerollAugments({
      roomId: this.roomId,
      playerId: this.playerId,
      sessionToken: this.sessionToken,
      joinToken: this.roomJoinToken,
      setIndex: this.currentSet,
    })
    this.remainingRerolls = response.data.remainingRerolls
    return response.data.newAugments as Augment[]
  }

  private handleAugmentSelectionCancel() {
    this.removeAugmentDimOverlay()
    this.augmentSelectionActive = false
    this.hud.setAugmentSelectionHUD('full')
    this.hud.setHudCardFace(false) // 레이스로 돌아가면 하단 GUI 기본 = 속도/체력 등
    this.prepareAllHorsesForRaceWithCurrentPlayers()
    this.updateHUDInitial()
    this.horseManager.showPlayerIndicator()
    this.startCountdown()
  }

  private handleAugmentPreviewUpdate(augment: Augment | null) {
    this.hud.setAugmentPreview(augment)
    this.updateHUDInitial()
  }

  private ensureAugmentSelectionSceneRegistered() {
    const scenePlugin = this.scene
    if (!scenePlugin.get(AUGMENT_SELECTION_SCENE_KEY)) {
      scenePlugin.add(
        AUGMENT_SELECTION_SCENE_KEY,
        AugmentSelectionScene as typeof Phaser.Scene,
        false,
      )
    }
  }

  private stopExistingAugmentSelectionSceneIfActive() {
    const scenePlugin = this.scene
    if (scenePlugin.isActive(AUGMENT_SELECTION_SCENE_KEY)) {
      scenePlugin.stop(AUGMENT_SELECTION_SCENE_KEY)
    }
  }

  private launchAugmentSelectionScene(params: {
    rarity: AugmentRarity
    augmentChoices?: Augment[]
    totalRerollLimit: number
  }) {
    this.ensureAugmentSelectionSceneRegistered()
    this.scene.launch(AUGMENT_SELECTION_SCENE_KEY, {
      rarity: params.rarity,
      augmentChoices: params.augmentChoices,
      maxRerolls: params.totalRerollLimit,
      remainingRerolls: this.getRemainingRerollsForCurrentPlayer(),
      showTapToStart: false,
      onSelect: (augment: Augment, usedRerolls: number) =>
        this.onAugmentSelected(augment, usedRerolls),
      onReroll: async () => this.handleAugmentRerollRequest(),
      onCancel: () => this.handleAugmentSelectionCancel(),
      onPreview: (augment: Augment | null) => this.handleAugmentPreviewUpdate(augment),
      onCardsShown: () => this.hud.setAugmentSelectionHUD('bottomOnly'),
    })
  }

  private async showAugmentSelection(fallbackRarity: AugmentRarity) {
    this.augmentSelectionActive = true
    this.horseManager.hidePlayerIndicator()
    this.hud.setAugmentSelectionHUD('hidden')
    this.hud.setHudCardFace(true) // 증강 선택 중에는 하단 GUI 기본 = 능력치
    this.updateHUDInitial()

    const { width, height } = this.scale
    this.augmentDimOverlay?.destroy()
    this.augmentDimOverlay = this.add
      .rectangle(width / 2, height / 2, width, height, 0x000000, 0.8)
      .setDepth(RaceScene.AUGMENT_DIM_DEPTH)
      .setScrollFactor(0)
      .setInteractive()

    this.stopExistingAugmentSelectionSceneIfActive()

    let resolvedRarity = fallbackRarity
    let resolvedAugments: Augment[] | undefined
    const setIndex = this.currentSet

    if (this.roomId && this.playerId && this.sessionToken && this.roomJoinToken) {
      const response = await this.fetchSynchronizedAugmentSelection(setIndex)
      if (!response) {
        // 서버 권한 모드에서는 로컬 fallback으로 진행하지 않고
        // 다시 RaceScene으로 복귀시켜 상태 오염을 방지한다.
        this.removeAugmentDimOverlay()
        this.scene.stop(AUGMENT_SELECTION_SCENE_KEY)
        return
      }

      resolvedRarity = response.rarity
      resolvedAugments = response.availableAugments
    }

    const totalRerollLimit = this.room?.rerollLimit ?? DEFAULT_REROLL_LIMIT
    this.launchAugmentSelectionScene({
      rarity: resolvedRarity,
      augmentChoices: resolvedAugments,
      totalRerollLimit,
    })
  }

  private removeAugmentDimOverlay() {
    this.augmentDimOverlay?.destroy()
    this.augmentDimOverlay = undefined
  }

  private onAugmentSelected(augment: Augment, usedRerolls: number) {
    if (this.roomId && this.playerId && this.sessionToken && this.roomJoinToken) {
      void selectAugment({
        roomId: this.roomId,
        playerId: this.playerId,
        sessionToken: this.sessionToken,
        joinToken: this.roomJoinToken,
        setIndex: this.currentSet,
        augmentId: augment.id,
      })
        .then(() => {
          this.startWaitingForOtherAugmentSelections()
        })
        .catch((error) => {
          console.error('[RaceScene] selectAugment failed:', error)
        })
      return
    }

    this.onAugmentSelectedLocal(augment, usedRerolls)
  }

  private onAugmentSelectedLocal(augment: Augment, usedRerolls: number) {
    this.selectedAugments.push(augment)
    this.augmentSelectionActive = false
    this.remainingRerolls -= usedRerolls
    this.removeAugmentDimOverlay()
    this.hud.setAugmentSelectionHUD('full')

    const lastSelected = this.selectedAugments[this.selectedAugments.length - 1]
    if (lastSelected) {
      this.horseManager.assignAugmentsToAllHorses(
        augment.rarity,
        lastSelected,
        this.playerHorseIndex,
      )
    }
    this.horseManager.applyAugmentsToAllHorses(
      () => this.mapManager.getTrackLengthM(),
      () => this.mapManager.getFinishLineOffsetM(),
    )

    this.updateHUDInitial()

    // 증강 씬이 닫힌 다음 프레임에 대기 연출을 시작해서 연출이 바로 겹치지 않게 한다.
    // 여기서 show를 바로 호출하면 다음 틱 hideGUIForWaitingOverlay에서 인디케이터가 다시 숨겨진다.
    this.time.delayedCall(0, () => {
      this.startLocalAugmentSelectionWaitFlow()
    })
  }

  private startLocalAugmentSelectionWaitFlow() {
    this.hud.setAugmentPreview(null)
    this.flowUI.hideGUIForWaitingOverlay({
      hud: this.hud,
      progressBarManager: this.progressBarManager,
      horseManager: this.horseManager,
    })
    this.flowUI.showWaiting(this, {
      messageKey: 'game.waitingAfterAugment',
      onComplete: () => this.handleLocalAugmentSelectionWaitComplete(),
      durationMs: RaceScene.WAITING_DURATION_MS,
    })
  }

  private handleLocalAugmentSelectionWaitComplete() {
    this.hud.setHudCardFace(false) // 레이스 시작 시 하단 GUI 기본 = 속도/체력 등
    this.flowUI.showGUIAfterWaitingOverlay({
      hud: this.hud,
      horseManager: this.horseManager,
    })
    this.startCountdown()
  }

  update(_time: number, delta: number) {
    if (!this.mapManager) return

    if (this.isRaceStarted) {
      const allFinished = this.isServerAuthoritativeRaceMode()
        ? this.updateAuthoritativeSimulation(delta)
        : this.updateSimulation(delta)

      // 말이 실제로 움직이기 시작하면 진행바를 보여준다.
      const simHorses = this.horseManager.getSimHorses()
      const anyHorseStarted = simHorses.some((horse) => horse.position > 0)
      if (anyHorseStarted) {
        this.progressBarManager.show()
      }

      const isAuthoritativeMode = this.isServerAuthoritativeRaceMode()
      // 로컬 모드에서는 결승선 15m 전부터 FINISH 연출을 먼저 시작한다.
      // 권위 모드에서는 slowmoTrigger를 쓰지 않고 1등 완주/화면 통과 기준으로 시작한다.
      const leadingHorse = simHorses.reduce((a, b) => (a.position >= b.position ? a : b))
      if (!isAuthoritativeMode) {
        const trackLengthM = this.mapManager.getTrackLengthM()
        const finishTriggerM = Math.max(0, trackLengthM - 15)
        const leadingPosition = leadingHorse?.position ?? 0
        if (
          leadingPosition >= finishTriggerM &&
          !leadingHorse?.finished &&
          !this.isFinishSequenceTriggered
        ) {
          const leadingIndex = simHorses.indexOf(leadingHorse)
          this.triggerFinishSequence(leadingIndex >= 0 ? leadingIndex : this.playerHorseIndex)
        }
      }
      if (isAuthoritativeMode) {
        this.tryStartAuthoritativeFinishCelebrationByVisualCrossing(simHorses)
      }

      // 슬로모 복귀 조건
      // - 권위 모드: 서버 finish(rank=1) 이벤트를 받고, 화면 시간도 우승 말 완주 시점까지 왔을 때
      // - 로컬 모드: 선두 말이 finished가 되었을 때
      const authoritativeWinnerFinishMs = this.getAuthoritativeWinnerFinishMs()
      const authoritativeRenderReachedWinnerFinish =
        typeof authoritativeWinnerFinishMs === 'number' &&
        this.lastRenderedElapsedMs >= authoritativeWinnerFinishMs - 1
      const shouldRestoreSlowmo = isAuthoritativeMode
        ? this.authoritativeWinnerFinishedEventSeen && authoritativeRenderReachedWinnerFinish
        : !!leadingHorse?.finished
      if (shouldRestoreSlowmo && this.simSlowmoActive && !this.simSlowmoStartedThisFrame) {
        this.simSlowmoActive = false
        this.authoritativeWinnerFinishedEventSeen = false
        this.events.emit(RACE_SCENE_EVENTS.FINISH_SEQUENCE_HORSE_CROSSED)
        this.tweens.add({
          targets: this,
          simPlaybackScale: 1,
          duration: this.simSlowmoRestoreMs,
          ease: 'Sine.Out',
          onComplete: () => {
            this.simPlaybackScale = 1
            this.events.emit(RACE_SCENE_EVENTS.FINISH_SEQUENCE_SLOWMO_RESTORE)
          },
        })
      }

      this.cameraScrollManager.update(simHorses, this.isRaceFinished)
      this.updateHorsePositions()
      this.updateHUD()
      this.mapManager.updateStripePositions(this.cameraScrollManager.getCameraScrollPx())
      this.progressBarManager.update(simHorses)
      this.renderAuthoritativeDebugOverlay()

      if (
        !this.isRaceFinished &&
        this.shouldCommitRaceFinish({ allFinished, isAuthoritativeMode })
      ) {
        this.isRaceFinished = true
        const showGatheringOverlay = () => this.startResultAggregationOverlay()
        if (this.finishSequenceDone || !this.isFinishSequenceTriggered) {
          showGatheringOverlay()
        } else {
          this.events.once(RACE_SCENE_EVENTS.FINISH_SEQUENCE_DONE, showGatheringOverlay)
        }
      }

      this.simSlowmoStartedThisFrame = false
    }
  }

  private getAuthoritativeWinnerFinishMs(): number | null {
    const winner = this.authoritativeRacePlan?.rankings.find((entry) => entry.position === 1)
    if (!winner || typeof winner.time !== 'number') return null
    return winner.time * 1000
  }

  private updateSimulation(deltaMs: number): boolean {
    const result = this.runtimeController.updateSimulation({
      simHorses: this.horseManager.getSimHorses(),
      state: {
        simTimeAccumulatorSec: this.simTimeAccumulatorSec,
        simElapsedSec: this.simElapsedSec,
      },
      deltaMs,
      physicsDtSec: PHYSICS_DT_SEC,
      simPlaybackScale: this.simPlaybackScale,
    })

    this.simTimeAccumulatorSec = result.simTimeAccumulatorSec
    this.simElapsedSec = result.simElapsedSec
    return result.allFinished
  }

  private computeAuthoritativeRenderElapsedMs(deltaMs: number): number {
    const startedAtMs = this.authoritativeRacePlan?.startedAtMillis ?? Date.now()
    const result = computeAuthoritativeRenderElapsedMsHelper({
      deltaMs,
      clientNowMs: performance.now(),
      startedAtMs,
      authoritativeNowMs: this.authoritativeNowMs,
      authoritativeElapsedMs: this.authoritativeElapsedMs,
      lastAuthoritativePollClientTimeMs: this.lastAuthoritativePollClientTimeMs,
      smoothedElapsedMs: this.smoothedElapsedMs,
      lastRenderedElapsedMs: this.lastRenderedElapsedMs,
      simPlaybackScale: this.simPlaybackScale,
      simSlowmoActive: this.simSlowmoActive,
      renderDelayMs: AUTHORITATIVE_RENDER_DELAY_MS,
      timeHardSnapMs: AUTHORITATIVE_TIME_HARD_SNAP_MS,
      timeSoftCorrectionAlpha: AUTHORITATIVE_TIME_SOFT_CORRECTION_ALPHA,
      driftCorrectionNormal: AUTHORITATIVE_DRIFT_CORRECTION_NORMAL,
      driftCorrectionSlowmo: AUTHORITATIVE_DRIFT_CORRECTION_SLOWMO,
    })
    this.smoothedElapsedMs = result.smoothedElapsedMs
    this.lastRenderedElapsedMs = result.lastRenderedElapsedMs
    this.simElapsedSec = result.simElapsedSec
    this.authoritativeMetrics.timeHardSnapCount += result.timeHardSnapCountDelta
    return result.renderElapsedMs
  }

  private consumeAuthoritativeRaceEvents(renderElapsedMs: number) {
    const events =
      this.isAuthoritativeTimelinePreloaded && this.authoritativeTimeline
        ? this.authoritativeTimeline.events
        : this.authoritativeEventsWindow
    events.forEach((event) => {
      if (this.consumedRaceEventIds.has(event.id)) return
      if (event.elapsedMs > renderElapsedMs + AUTHORITATIVE_EVENT_CONSUME_TOLERANCE_MS) return
      this.consumedRaceEventIds.add(event.id)
      if (event.type === 'slowmoTrigger') {
        // 지금은 슬로모를 꺼둔 상태라서 slowmoTrigger 이벤트는 축하 연출 시작에 쓰지 않는다.
        return
      }
      if (event.type === 'finish') {
        if ('playerId' in event && event.playerId) {
          this.authoritativeFinishedPlayerIds.add(event.playerId)
        }
        if ('rank' in event && event.rank === 1) {
          this.authoritativeWinnerFinishedEventSeen = true
          if (!this.isFinishSequenceTriggered) {
            this.triggerFinishSequence(this.getWinnerHorseIndex() ?? undefined)
          }
        }
      }
    })
  }

  private getWinnerHorseIndex(): number | null {
    const winnerPlayerId = this.authoritativeRacePlan?.rankings.find(
      (entry) => entry.position === 1,
    )?.playerId
    if (!winnerPlayerId || !this.players) return null
    const index = this.players.findIndex((player) => player.id === winnerPlayerId)
    return index >= 0 ? index : null
  }

  private tryStartAuthoritativeFinishCelebrationByVisualCrossing(
    simHorses: ReturnType<HorseManager['getSimHorses']>,
  ) {
    if (this.isFinishSequenceTriggered) return
    const winnerIndex = this.getWinnerHorseIndex()
    if (winnerIndex == null) return
    const winnerHorse = simHorses[winnerIndex]
    if (!winnerHorse) return
    const finishTriggerM = this.mapManager.getTrackLengthM() - 0.06
    if (winnerHorse.position < finishTriggerM) return
    this.triggerFinishSequence(winnerIndex)
  }

  private applyAuthoritativeFrameToHorses(params: {
    simHorses: ReturnType<HorseManager['getSimHorses']>
    currentFrame: AuthoritativeRaceFrame
    nextFrame: AuthoritativeRaceFrame
    renderElapsedMs: number
    interpolationT: number
    frameSpanSec: number
  }): boolean {
    const {
      simHorses,
      currentFrame,
      nextFrame,
      renderElapsedMs,
      interpolationT: t,
      frameSpanSec,
    } = params
    let allFinished = true

    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    const trackLengthM = this.mapManager.getTrackLengthM()
    const finishZoneStartM = Math.max(0, trackLengthM - AUTHORITATIVE_FINISH_ZONE_M)

    simHorses.forEach((horse, index) => {
      const playerId =
        this.players?.[index]?.id ?? this.authoritativeRacePlan?.rankings[index]?.playerId
      if (!playerId) {
        allFinished = false
        return
      }
      const fromPos = currentFrame.positions[playerId]
      const toPos = nextFrame.positions[playerId]
      const fromSpeed = currentFrame.speeds[playerId]
      const toSpeed = nextFrame.speeds[playerId]
      const fromStamina = currentFrame.stamina[playerId]
      const toStamina = nextFrame.stamina[playerId]
      const fromFinished = currentFrame.finished[playerId]
      const toFinished = nextFrame.finished[playerId]
      if (
        typeof fromPos !== 'number' ||
        typeof toPos !== 'number' ||
        typeof fromSpeed !== 'number' ||
        typeof toSpeed !== 'number' ||
        typeof fromStamina !== 'number' ||
        typeof toStamina !== 'number' ||
        typeof fromFinished !== 'boolean' ||
        typeof toFinished !== 'boolean'
      ) {
        allFinished = false
        return
      }

      const hermitePos =
        h00 * fromPos + h10 * fromSpeed * frameSpanSec + h01 * toPos + h11 * toSpeed * frameSpanSec
      const minPos = Math.min(fromPos, toPos) - 0.05
      const maxPos = Math.max(fromPos, toPos) + 0.05
      const authPos = Math.max(minPos, Math.min(maxPos, hermitePos))
      const posError = Math.abs(authPos - horse.position)
      this.authoritativeMetrics.positionErrorSum += posError
      this.authoritativeMetrics.positionErrorMax = Math.max(
        this.authoritativeMetrics.positionErrorMax,
        posError,
      )
      const isNearFinishZone = authPos >= finishZoneStartM || horse.position >= finishZoneStartM
      const useFinishSlowmoCorrection = this.simSlowmoActive && isNearFinishZone
      const useFinishZoneCorrection = isNearFinishZone
      const hardSnapThreshold = useFinishSlowmoCorrection
        ? AUTHORITATIVE_FINISH_SLOWMO_HARD_SNAP_M
        : useFinishZoneCorrection
          ? AUTHORITATIVE_FINISH_ZONE_HARD_SNAP_M
          : AUTHORITATIVE_POSITION_HARD_SNAP_M
      const softBlend = useFinishSlowmoCorrection
        ? AUTHORITATIVE_FINISH_SLOWMO_SOFT_BLEND
        : useFinishZoneCorrection
          ? AUTHORITATIVE_FINISH_ZONE_SOFT_BLEND
          : AUTHORITATIVE_POSITION_SOFT_BLEND
      const softCorrectedPos = horse.position + (authPos - horse.position) * softBlend
      const cappedSoftCorrectedPos = useFinishSlowmoCorrection
        ? horse.position +
          Math.min(
            AUTHORITATIVE_FINISH_SLOWMO_MAX_CORRECTION_M,
            Math.max(0, softCorrectedPos - horse.position),
          )
        : useFinishZoneCorrection
          ? horse.position +
            Math.min(
              AUTHORITATIVE_FINISH_ZONE_MAX_CORRECTION_M,
              Math.max(0, softCorrectedPos - horse.position),
            )
          : softCorrectedPos
      const candidatePos = posError >= hardSnapThreshold ? authPos : cappedSoftCorrectedPos
      if (posError >= hardSnapThreshold) {
        this.authoritativeMetrics.hardSnapCount += 1
        horse.position = Math.max(horse.position, candidatePos)
      } else {
        this.authoritativeMetrics.softCorrectionCount += 1
        horse.position = Math.max(horse.position, candidatePos)
      }
      horse.currentSpeed = fromSpeed * (1 - t) + toSpeed * t
      horse.stamina = fromStamina * (1 - t) + toStamina * t
      const authoritativeFinishedByFrame = fromFinished || toFinished
      const authoritativeFinishedByEvent =
        this.authoritativeFinishedPlayerIds.has(playerId) &&
        (authPos >= trackLengthM - 0.35 || horse.position >= trackLengthM - 0.35)
      const plan = this.authoritativeRacePlan?.rankings.find((entry) => entry.playerId === playerId)
      const isNearFinishForPlanFinish =
        authPos >= trackLengthM - 0.35 || horse.position >= trackLengthM - 0.35
      const authoritativeFinishedByPlan =
        typeof plan?.time === 'number' &&
        isNearFinishForPlanFinish &&
        renderElapsedMs >= plan.time * 1000 - 20
      const finished =
        authoritativeFinishedByFrame ||
        authoritativeFinishedByEvent ||
        authoritativeFinishedByPlan ||
        horse.position >= trackLengthM - 0.02
      horse.finished = finished
      if (finished) {
        horse.finishTime = plan?.time ?? horse.finishTime
      }

      if (!finished) {
        allFinished = false
      }
    })

    const rankIndexByPlayerId = new Map(
      (this.authoritativeRacePlan?.rankings ?? []).map((entry) => [entry.playerId, entry.position]),
    )
    simHorses.forEach((horse, index) => {
      const playerId = this.players?.[index]?.id
      const rank = playerId ? rankIndexByPlayerId.get(playerId) : undefined
      if (rank) {
        horse.updateRank(rank)
      }
    })

    // 임시 안전장치:
    // 서버 finish 이벤트를 아직 하나도 못 받았는데 allFinished가 되면
    // 클라이언트 시간 오차 때문에 빨리 끝난 걸 수 있어서 한 번 막는다.
    if (allFinished && this.authoritativeFinishedPlayerIds.size === 0) {
      if (import.meta.env.DEV) {
        console.warn('[RaceScene] allFinished suppressed (no authoritative finish events yet)', {
          currentSet: this.currentSet,
          renderElapsedMs,
          winnerSeen: this.authoritativeWinnerFinishedEventSeen,
        })
      }
      return false
    }

    return allFinished
  }

  private updateAuthoritativeSimulation(deltaMs: number): boolean {
    if (!this.authoritativeKeyframe) return false
    if (this.authoritativeRaceStateStatus === 'prepared') {
      this.simElapsedSec = 0
      return false
    }
    if (!this.authoritativeRacePlan?.startedAtMillis) {
      return false
    }

    const simHorses = this.horseManager.getSimHorses()
    if (!simHorses.length) return false
    const renderElapsedMs = this.computeAuthoritativeRenderElapsedMs(deltaMs)

    const framePair = this.isAuthoritativeTimelinePreloaded
      ? this.resolveTimelineFramePairForElapsed(renderElapsedMs)
      : this.resolveFramePairForElapsed(renderElapsedMs)
    const currentFrame = framePair?.current ?? this.authoritativeKeyframe
    const nextFrame = framePair?.next ?? this.authoritativeNextKeyframe ?? currentFrame
    if (!currentFrame || !nextFrame) return false
    this.authoritativeKeyframe = currentFrame
    this.authoritativeNextKeyframe = nextFrame
    const frameSpan = Math.max(1, nextFrame.elapsedMs - currentFrame.elapsedMs)
    const t = Math.max(0, Math.min(1, (renderElapsedMs - currentFrame.elapsedMs) / frameSpan))
    const frameSpanSec = frameSpan / 1000

    this.consumeAuthoritativeRaceEvents(renderElapsedMs)
    const allFinished = this.applyAuthoritativeFrameToHorses({
      simHorses,
      currentFrame,
      nextFrame,
      renderElapsedMs,
      interpolationT: t,
      frameSpanSec,
    })

    this.authoritativeMetrics.frameCount += 1
    return allFinished
  }

  // 현재 시뮬레이션 말 위치를 화면 좌표로 바꿔서 스프라이트에 반영
  private updateHorsePositions() {
    const simHorses = this.horseManager.getSimHorses()
    const worldXArray: number[] = []

    for (const simHorse of simHorses) {
      const worldX = this.cameraScrollManager.getHorseWorldX(simHorse, this.simElapsedSec)
      worldXArray.push(worldX)
    }

    this.horseManager.updateHorsePositions(worldXArray)
  }

  private areAllHorsesVisuallyAtFinishLine(): boolean {
    const simHorses = this.horseManager.getSimHorses()
    if (!simHorses.length) return false
    const finishLineM = this.mapManager.getTrackLengthM() - AUTHORITATIVE_VISUAL_FINISH_EPSILON_M
    return simHorses.every((horse) => horse.position >= finishLineM)
  }

  private shouldCommitRaceFinish(params: {
    allFinished: boolean
    isAuthoritativeMode: boolean
  }): boolean {
    if (!params.allFinished) {
      this.authoritativeFinishPendingSinceMs = null
      return false
    }
    if (!params.isAuthoritativeMode) {
      return true
    }

    if (this.areAllHorsesVisuallyAtFinishLine()) {
      this.authoritativeFinishPendingSinceMs = null
      return true
    }

    const nowMs = performance.now()
    if (this.authoritativeFinishPendingSinceMs == null) {
      this.authoritativeFinishPendingSinceMs = nowMs
      if (import.meta.env.DEV) {
        console.warn('[RaceScene] allFinished waiting for visual finish alignment', {
          currentSet: this.currentSet,
          renderElapsedMs: this.lastRenderedElapsedMs,
        })
      }
      return false
    }

    if (nowMs - this.authoritativeFinishPendingSinceMs < AUTHORITATIVE_VISUAL_FINISH_FALLBACK_MS) {
      return false
    }

    if (import.meta.env.DEV) {
      console.warn('[RaceScene] visual finish fallback timeout reached; committing finish', {
        currentSet: this.currentSet,
        renderElapsedMs: this.lastRenderedElapsedMs,
        waitedMs: nowMs - this.authoritativeFinishPendingSinceMs,
      })
    }
    this.authoritativeFinishPendingSinceMs = null
    return true
  }

  private startResultAggregationOverlay() {
    if (this.isResultAggregationStarted) return
    this.isResultAggregationStarted = true
    // 결과 집계 오버레이는 finish 연출(celebration)과 분리된 단계로 관리한다.
    this.flowUI.hideGUIForWaitingOverlay({
      hud: this.hud,
      progressBarManager: this.progressBarManager,
      horseManager: this.horseManager,
    })
    this.flowUI.showWaiting(this, {
      messageKey: 'game.gatheringResults',
      onComplete: () => this.showRaceResult(),
      durationMs: RaceScene.WAITING_DURATION_MS,
    })
  }

  // 레이스 시작 전 HUD 기본값 표시
  private updateHUDInitial() {
    const simHorses = this.horseManager.getSimHorses()
    const horseData = simHorses.map((h) => ({
      name: h.name,
      position: h.position,
      finished: h.finished,
      finishTime: h.finishTime,
      currentTime: 0, // 시작 전이라서 0초
    }))
    this.hud.updateRanking(horseData, this.playerHorseIndex)
    this.hud.updateTopRight(0)

    // 레이스 시작 전에도 내 말 능력치는 HUD에 먼저 보여준다.
    if (simHorses[this.playerHorseIndex]) {
      const playerHorse = simHorses[this.playerHorseIndex]
      this.hud.updateStats({
        currentSpeed: 0, // 레이스 시작 전이므로 0
        maxSpeed_ms: playerHorse.maxSpeed_ms,
        stamina: playerHorse.stamina,
        maxStamina: playerHorse.maxStamina,
        conditionRoll: playerHorse.conditionRoll,
        baseStats: playerHorse.baseStats,
        effStats: playerHorse.effStats,
      })
    }
  }

  // HUD 업데이트
  private updateHUD() {
    const simHorses = this.horseManager.getSimHorses()
    // HUD 시간은 실제 시계 시간이 아니라 권위 재생 시간(simElapsedSec)을 쓴다.
    // 그래야 슬로모가 들어가도 화면 시간과 레이스 진행이 같이 맞는다.
    const displayTime = Math.max(0, this.simElapsedSec)

    const horseData = simHorses.map((h) => ({
      name: h.name,
      position: h.position,
      finished: h.finished,
      finishTime: h.finishTime,
      currentTime: displayTime,
    }))
    this.hud.updateRanking(horseData, this.playerHorseIndex)

    // 우상단 시간은 순위표 기록과 같은 기준을 쓴다(완주 시 finishTime, 미완주 시 currentTime)
    const playerHorseForTime = simHorses[this.playerHorseIndex]
    const recordTime =
      playerHorseForTime?.finished && playerHorseForTime.finishTime != null
        ? playerHorseForTime.finishTime
        : displayTime
    this.hud.updateTopRight(recordTime)

    // 플레이어 말의 능력치 업데이트
    if (simHorses[this.playerHorseIndex]) {
      const playerHorse = simHorses[this.playerHorseIndex]
      this.hud.updateStats({
        currentSpeed: playerHorse.currentSpeed,
        maxSpeed_ms: playerHorse.maxSpeed_ms,
        stamina: playerHorse.stamina,
        maxStamina: playerHorse.maxStamina,
        conditionRoll: playerHorse.conditionRoll,
        baseStats: playerHorse.baseStats,
        effStats: playerHorse.effStats,
        overtakeBonusActive: playerHorse.overtakeBonusActive,
        overtakeBonusValue: playerHorse.overtakeBonusValue,
        overtakeCount: playerHorse.overtakeCount,
        lastStaminaRecovery: playerHorse.lastStaminaRecovery,
      })
    }
  }

  private triggerFinishSequence(leadingHorseIndex?: number) {
    if (this.isFinishSequenceTriggered) return
    this.isFinishSequenceTriggered = true

    // FINISH 배너/파티클 시작(celebration start).
    // 레이스 완료 상태(isRaceFinished)나 결과 집계 시작과는 별도 플래그로 관리한다.
    const targetIndex = leadingHorseIndex ?? this.playerHorseIndex
    const target = this.horseManager?.getHorseSprite(targetIndex)
    playFinishSequence(this, target, {
      enableSlowmo: false,
      enableCameraZoom: false,
      onComplete: () => {
        this.finishSequenceDone = true
        this.events.emit(RACE_SCENE_EVENTS.FINISH_SEQUENCE_DONE)
      },
    })
  }

  private showRaceResult() {
    if (this.isResultSceneShown) return
    this.isResultSceneShown = true

    this.progressBarManager.hide()
    createFireworks(this)

    void this.showRaceResultAsync()
  }

  private getPlayersForResultMapping(): Player[] {
    const playersFromData = this.data.get('players') as Player[] | undefined
    return this.players ?? playersFromData ?? []
  }

  private mapAuthoritativeRankingsToRoundEntries(
    rankings: Array<{
      playerId: string
      name: string
      position: number
      time: number
      selectedAugments?: Augment[]
    }>,
  ): RoundRankingEntry[] {
    return mapAuthoritativeRankingsToRoundEntriesHelper({
      rankings,
      players: this.getPlayersForResultMapping(),
    })
  }

  private async showRaceResultAsync() {
    const isAuthoritativeMode = hasAuthoritativeRoundResultContext({
      roomId: this.roomId,
      playerId: this.playerId,
      sessionToken: this.sessionToken,
      roomJoinToken: this.roomJoinToken,
      hasRoom: !!this.room,
    })
    let rankings: RoundRankingEntry[] | null = null

    if (isAuthoritativeMode) {
      rankings = await this.resolveAuthoritativeRoundRankings()
      if (!rankings) {
        console.error('[RaceScene] Authoritative set result is unavailable; retrying.')
        this.isResultSceneShown = false
        this.waitingOverlayHandle?.close(false)
        this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
          messageKey: 'game.gatheringResults',
          durationMs: 800,
          onComplete: () => {
            this.waitingOverlayHandle = undefined
            if (!this.isResultSceneShown) {
              this.showRaceResult()
            }
          },
        })
        return
      }
    } else {
      rankings = this.computeLocalRoundRankings()
    }

    this.roundResults[this.currentSet - 1] = rankings

    const scenePlugin = this.scene
    // 결과창을 바로 띄워서 집계 오버레이가 사라질 때 맵 배경이 잠깐 비치지 않게 한다.
    if (!scenePlugin.get(RACE_RESULT_SCENE_KEY)) {
      scenePlugin.add(RACE_RESULT_SCENE_KEY, RaceResultScene as typeof Phaser.Scene, false)
    }

    const playerCount = this.getResolvedPlayerCount()
    const roundCount = this.room?.roundCount ?? DEFAULT_ROUND_COUNT
    const isLastRound = this.currentSet >= roundCount

    scenePlugin.launch(RACE_RESULT_SCENE_KEY, {
      rankings,
      playerHorseIndex: this.playerHorseIndex,
      playerCount,
      currentSet: this.currentSet,
      totalRounds: roundCount,
      onNextSet: () => {
        void this.handleReadyNextSet()
      },
      onFinalResult: isLastRound ? () => this.handleFinalResult() : undefined,
    })
  }

  private computeLocalRoundRankings(): RoundRankingEntry[] {
    const simHorses = this.horseManager.getSimHorses()
    const playersFromData = this.data.get('players') as Player[] | undefined
    const playersToUse = this.players ?? playersFromData

    return computeRoundRankings(
      simHorses.map((h) => ({
        position: h.position,
        finished: h.finished,
        finishTime: h.finishTime ?? null,
        name: h.name,
      })),
      {
        horseAugmentsByIndex: (i) => this.horseManager.getAccumulatedAugments()[i] ?? [],
        playerNameByIndex: (i) => playersToUse?.[i]?.name ?? '',
        currentTime: this.simElapsedSec,
      },
    )
  }

  private isCurrentPlayerHost(): boolean {
    if (!this.players || !this.playerId) return false
    const current = this.players.find((player) => player.id === this.playerId)
    return current?.isHost === true
  }

  private async resolveAuthoritativeRoundRankings(): Promise<RoundRankingEntry[] | null> {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken || !this.room) {
      return null
    }
    const setIndex = this.currentSet

    if (this.isCurrentPlayerHost() && this.room.status === ROOM_STATUS_RACING) {
      try {
        if (!this.isServerRacePrepared) {
          await prepareRace({
            roomId: this.roomId,
            playerId: this.playerId,
            sessionToken: this.sessionToken,
            joinToken: this.roomJoinToken,
            setIndex,
          })
          this.isServerRacePrepared = true
        }
        if (!this.isServerRaceRequested) {
          await startRace({
            roomId: this.roomId,
            playerId: this.playerId,
            sessionToken: this.sessionToken,
            joinToken: this.roomJoinToken,
            setIndex,
          })
          this.isServerRaceRequested = true
        }
      } catch (error) {
        console.warn('[RaceScene] prepare/start callable failed, continue with polling:', error)
      }
    }

    const deadline = Date.now() + 10000
    let nextDelayMs = SET_RESULT_POLL_INITIAL_DELAY_MS

    while (Date.now() < deadline) {
      try {
        const response = await getSetResult({
          roomId: this.roomId,
          playerId: this.playerId,
          sessionToken: this.sessionToken,
          joinToken: this.roomJoinToken,
          setIndex,
        })

        if (response.data.hasResult) {
          return this.mapAuthoritativeRankingsToRoundEntries(response.data.rankings)
        }
        nextDelayMs = Math.min(
          SET_RESULT_POLL_MAX_DELAY_MS,
          Math.round(nextDelayMs * SET_RESULT_POLL_BACKOFF_MULTIPLIER),
        )
      } catch (error) {
        console.warn('[RaceScene] getSetResult polling failed:', error)
        nextDelayMs = Math.min(
          SET_RESULT_POLL_MAX_DELAY_MS,
          Math.round(nextDelayMs * SET_RESULT_POLL_BACKOFF_MULTIPLIER),
        )
      }

      const remainingMs = Math.max(0, deadline - Date.now())
      const waitMs = Math.min(nextDelayMs, remainingMs)
      if (waitMs <= 0) {
        break
      }
      await new Promise((resolve) => {
        setTimeout(resolve, waitMs)
      })
    }

    return null
  }

  private handleFinalResult() {
    void this.handleFinalResultAsync()
  }

  private scheduleFinalResultBackfillRetry(missingRoundIndexes: number[]) {
    if (import.meta.env.DEV) {
      console.warn('[RaceScene] Missing round results before final result. Retrying...', {
        retry: this.finalResultBackfillRetryCount,
        missingRoundIndexes,
      })
    }
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
      messageKey: 'game.gatheringResults',
      durationMs: 600,
      onComplete: () => {
        this.waitingOverlayHandle = undefined
        void this.handleFinalResultAsync()
      },
    })
  }

  private async handleFinalResultAsync() {
    await this.fillMissingRoundResultsFromServer()
    const missingRoundIndexes = this.getMissingRoundResultIndexes()
    const backfillAction = resolveFinalResultBackfillAction({
      missingRoundIndexes,
      retryCount: this.finalResultBackfillRetryCount,
      maxRetries: FINAL_RESULT_BACKFILL_RETRY_MAX,
    })
    if (backfillAction.type === 'retry') {
      this.finalResultBackfillRetryCount += 1
      this.scheduleFinalResultBackfillRetry(missingRoundIndexes)
      return
    }
    if (backfillAction.type === 'proceedWithIncomplete') {
      console.error('[RaceScene] Round result completeness check failed', {
        missingRoundIndexes,
        roundCount: this.room?.roundCount,
        currentSet: this.currentSet,
      })
    }
    if (backfillAction.type === 'complete') {
      this.finalResultBackfillRetryCount = 0
    }
    if (this.roundResults.length === 0) return

    this.resetNextSetTransitionWaitingState()

    this.dispatchRaceFinalResultEvent()
    this.scene.stop(RACE_RESULT_SCENE_KEY)
  }

  private dispatchRaceFinalResultEvent() {
    if (typeof window === 'undefined') return

    const playersFromData = this.data.get('players') as Player[] | undefined
    const playersToUse = this.players ?? playersFromData

    window.dispatchEvent(
      new CustomEvent('race-final-result', {
        detail: buildRaceFinalResultEventDetail({
          roundResults: this.roundResults,
          players: playersToUse ?? [],
          playerId: this.playerId,
          roomId: this.roomId,
        }),
      }),
    )
  }

  private async fillMissingRoundResultsFromServer() {
    if (!this.roomId || !this.playerId || !this.sessionToken || !this.roomJoinToken || !this.room) {
      return
    }

    const targetRoundCount = this.room.roundCount ?? this.currentSet
    for (let setIndex = 1; setIndex <= targetRoundCount; setIndex++) {
      if (this.roundResults[setIndex - 1]?.length) {
        this.lastSetResultFetchAttemptMsBySet.delete(setIndex)
        continue
      }
      const previousFetchAttemptAtMs = this.lastSetResultFetchAttemptMsBySet.get(setIndex)
      const now = Date.now()
      if (
        typeof previousFetchAttemptAtMs === 'number' &&
        now - previousFetchAttemptAtMs < FINAL_RESULT_SET_FETCH_DEDUPE_WINDOW_MS
      ) {
        continue
      }
      this.lastSetResultFetchAttemptMsBySet.set(setIndex, now)

      try {
        const response = await getSetResult({
          roomId: this.roomId,
          playerId: this.playerId,
          sessionToken: this.sessionToken,
          joinToken: this.roomJoinToken,
          setIndex,
        })
        if (!response.data.hasResult) continue
        this.roundResults[setIndex - 1] = this.mapAuthoritativeRankingsToRoundEntries(
          response.data.rankings,
        )
        this.lastSetResultFetchAttemptMsBySet.delete(setIndex)
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[RaceScene] fillMissingRoundResultsFromServer failed:', { setIndex, error })
        }
      }
    }
  }

  private getMissingRoundResultIndexes(): number[] {
    return getMissingRoundResultIndexesHelper({
      roundResults: this.roundResults,
      roundCount: this.room?.roundCount ?? this.currentSet,
    })
  }

  // ==================== DEV Authoritative Debug Helpers ====================
  // create/toggle: 오버레이 라이프사이클
  // snapshot/copy: F9 측정값 수집(콘솔/클립보드)
  // render: 화면 표시(저주기 갱신)
  private createAuthoritativeDebugOverlay() {
    if (!import.meta.env.DEV) return
    this.authoritativeDebugText = this.add
      .text(12, 12, '', {
        fontSize: '12px',
        color: '#9cf7ff',
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(10000)
    window.addEventListener('keydown', this.handleAuthoritativeDebugHotkey)
  }

  private toggleAuthoritativeDebugOverlay() {
    this.authoritativeDebugOverlayEnabled = !this.authoritativeDebugOverlayEnabled
    this.authoritativeDebugText?.setVisible(this.authoritativeDebugOverlayEnabled)
    console.info(
      `[RaceScene][AuthReplay][DEV] overlay=${this.authoritativeDebugOverlayEnabled ? 'enabled' : 'hidden'} (F8 toggle / F9 copy snapshot)`,
    )
  }

  // F9 콘솔/클립보드 출력용: 한 줄 스냅샷 포맷
  private buildAuthoritativeDebugSnapshotLine(): string {
    const timeline = this.authoritativeTimeline
    return [
      buildAuthoritativeDebugSnapshotLineHelper({
        currentSet: this.currentSet,
        simElapsedSec: this.simElapsedSec,
        metrics: this.authoritativeMetrics,
      }),
      `timelinePreloaded=${this.isAuthoritativeTimelinePreloaded}`,
      `timelinePreloading=${this.isAuthoritativeTimelinePreloading}`,
      `timelineFrames=${timeline?.keyframes.length ?? 0}`,
      `timelineEvents=${timeline?.events.length ?? 0}`,
      `timelineError=${this.authoritativeTimelinePreloadError ?? 'none'}`,
    ].join(' ')
  }

  private buildAuthoritativeTimelineDebugOverlayText(): string {
    const timeline = this.authoritativeTimeline
    return [
      `timeline preloaded=${this.isAuthoritativeTimelinePreloaded} preloading=${this.isAuthoritativeTimelinePreloading}`,
      `timeline frames=${timeline?.keyframes.length ?? 0} events=${timeline?.events.length ?? 0}`,
      `timeline error=${this.authoritativeTimelinePreloadError ?? 'none'}`,
    ].join('\n')
  }

  private buildAuthoritativeDebugOverlayBaseText(): string {
    return buildAuthoritativeDebugOverlayTextHelper({
      currentSet: this.currentSet,
      simElapsedSec: this.simElapsedSec,
      metrics: this.authoritativeMetrics,
    })
  }

  private async copyAuthoritativeDebugOverlaySnapshot() {
    const snapshot = this.buildAuthoritativeDebugSnapshotLine()
    console.info(`[RaceScene][AuthReplay][DEV] snapshot ${snapshot}`)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snapshot)
        console.info('[RaceScene][AuthReplay][DEV] snapshot copied to clipboard')
      }
    } catch (error) {
      console.warn('[RaceScene][AuthReplay][DEV] snapshot clipboard copy failed:', error)
    }
  }

  private shouldRenderAuthoritativeDebugOverlay(nowMs: number): boolean {
    const result = shouldRenderAuthoritativeDebugOverlayHelper({
      nowMs,
      lastRenderMs: this.authoritativeDebugLastRenderMs,
      minIntervalMs: 250,
    })
    this.authoritativeDebugLastRenderMs = result.nextLastRenderMs
    return result.shouldRender
  }

  // 화면 오버레이용: 여러 줄 가독성 포맷
  private buildAuthoritativeDebugOverlayText(): string {
    return [
      this.buildAuthoritativeDebugOverlayBaseText(),
      this.buildAuthoritativeTimelineDebugOverlayText(),
    ].join('\n')
  }

  private resetAuthoritativeReplayState() {
    this.isBootstrappingRaceStart = false
    this.raceStartBootstrapReadyForCountdown = false
    this.raceStartBootstrapBeganAtMs = null
    this.raceStartBootstrapMinReadyAtMs = 0
    this.hasReceivedInitialAuthoritativeFrame = false
    this.hasReceivedAnyAuthoritativePollResponse = false
    this.raceStartBootstrapTimeoutEvent?.remove(false)
    this.raceStartBootstrapTimeoutEvent = undefined
    this.authoritativeRacePlan = undefined
    this.authoritativeKeyframe = undefined
    this.authoritativeNextKeyframe = undefined
    this.authoritativeFrameBuffer = []
    this.authoritativeTimeline = undefined
    this.authoritativeTimelineFrameCursorIndex = 0
    this.isAuthoritativeTimelinePreloaded = false
    this.isAuthoritativeTimelinePreloading = false
    this.authoritativeTimelinePreloadError = null
    this.authoritativeEventsWindow = []
    this.consumedRaceEventIds.clear()
    this.authoritativeFinishedPlayerIds.clear()
    this.authoritativeElapsedMs = 0
    this.authoritativeNowMs = 0
    this.smoothedElapsedMs = null
    this.lastRenderedElapsedMs = 0
    this.lastAuthoritativePollClientTimeMs = 0
    this.authoritativeWinnerFinishedEventSeen = false
    this.authoritativeFinishPendingSinceMs = null
    this.authoritativeRaceStateStatus = null
    this.lastAuthoritativeEventWindowMaxElapsedMs = 0
    this.consecutiveAuthoritativePollFailureCount = 0
    this.authoritativeMetrics = {
      frameCount: 0,
      hardSnapCount: 0,
      softCorrectionCount: 0,
      timeHardSnapCount: 0,
      positionErrorSum: 0,
      positionErrorMax: 0,
    }
    this.isServerRaceRequested = false
    this.isServerRacePrepared = false
    this.lastSetResultFetchAttemptMsBySet.clear()
    this.isPollingServerRaceResult = false
    this.stopServerRaceStatePolling()
  }

  private renderAuthoritativeDebugOverlay() {
    if (!import.meta.env.DEV || !this.authoritativeDebugText) return
    if (!this.authoritativeDebugOverlayEnabled) return
    if (!this.isServerAuthoritativeRaceMode()) {
      this.authoritativeDebugText.setText('[AuthReplay] inactive')
      return
    }
    const now = performance.now()
    if (!this.shouldRenderAuthoritativeDebugOverlay(now)) return
    this.authoritativeDebugText.setText(this.buildAuthoritativeDebugOverlayText())
  }

  private getNextSetSyncRequestContext(): {
    roomId: string
    playerId: string
    sessionToken: string
    joinToken: string
  } | null {
    return buildNextSetSyncRequestContextHelper({
      roomId: this.roomId,
      playerId: this.playerId,
      sessionToken: this.sessionToken,
      roomJoinToken: this.roomJoinToken,
      room: this.room,
    })
  }

  private logNextSetTransitionDebug(source: string, extra?: Record<string, unknown>) {
    if (!import.meta.env.DEV) return
    console.info('[RaceScene][NextSetTransition]', {
      source,
      roomId: this.roomId,
      playerId: this.playerId,
      roomStatus: this.room?.status,
      roomCurrentSet: this.room?.currentSet,
      currentSet: this.currentSet,
      isWaitingForNextSetTransition: this.isWaitingForNextSetTransition,
      isSyncingNextSetTransition: this.isSyncingNextSetTransition,
      lastStartedSetTransitionTargetSet: this.lastStartedSetTransitionTargetSet,
      ...extra,
    })
  }

  private tryResolveNextSetFromRoomStatus(): boolean {
    const action = resolveRoomStatusNextSetAction(this.room?.status)
    const resolved = this.applyNextSetTransitionAction(action, 'roomStatusResolve')
    if (resolved) {
      this.logNextSetTransitionDebug('roomStatusResolve:applied', { action })
    }
    return resolved
  }

  private applyReadyNextSetResponse(data: {
    allReady?: boolean
    nextStatus?: string
    currentSet?: number
  }): boolean {
    this.logNextSetTransitionDebug('responseApply:received', {
      allReady: data.allReady,
      nextStatus: data.nextStatus,
      responseCurrentSet: data.currentSet,
    })
    return this.applyNextSetTransitionAction(
      resolveReadyNextSetResponseAction(data),
      'responseApply',
    )
  }

  private applyNextSetTransitionAction(action: NextSetTransitionAction, source: string): boolean {
    if (action.type === 'startNewSet') {
      const targetSet = action.currentSet ?? this.room?.currentSet
      if (
        typeof targetSet === 'number' &&
        this.lastStartedSetTransitionTargetSet === targetSet &&
        !this.isWaitingForNextSetTransition
      ) {
        this.logNextSetTransitionDebug(`${source}:duplicateStartNewSetIgnored`, {
          targetSet,
          action,
        })
        return true
      }

      this.logNextSetTransitionDebug(`${source}:startNewSet`, { targetSet, action })
      if (typeof targetSet === 'number') {
        this.lastStartedSetTransitionTargetSet = targetSet
      }
      if (typeof action.currentSet === 'number') {
        this.currentSet = action.currentSet
      }
      this.startNewSet(typeof targetSet === 'number' ? targetSet : undefined)
      return true
    }
    if (action.type === 'finalResult') {
      this.logNextSetTransitionDebug(`${source}:finalResult`, { action })
      this.handleFinalResult()
      return true
    }
    return false
  }

  private async handleReadyNextSet() {
    this.logNextSetTransitionDebug('readyNextSet:clicked')
    const nextSetContext = this.getNextSetSyncRequestContext()
    if (!nextSetContext) {
      this.logNextSetTransitionDebug('readyNextSet:missingContext')
      if (this.tryResolveNextSetFromRoomStatus()) {
        return
      }
      this.beginWaitingForNextSetTransition()
      return
    }

    try {
      const response = await readyNextSet({
        ...nextSetContext,
        setIndex: this.currentSet,
      })

      if (this.applyReadyNextSetResponse(response.data)) {
        return
      }

      this.beginWaitingForNextSetTransition()
    } catch (error) {
      console.warn('[RaceScene] readyNextSet failed; keep authoritative waiting:', error)
      this.logNextSetTransitionDebug('readyNextSet:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      this.beginWaitingForNextSetTransition()
    }
  }

  private beginWaitingForNextSetTransition() {
    this.logNextSetTransitionDebug('waitingBegin')
    this.hud.setAugmentPreview(null)
    this.flowUI.hideGUIForWaitingOverlay({
      hud: this.hud,
      progressBarManager: this.progressBarManager,
      horseManager: this.horseManager,
    })
    this.isWaitingForNextSetTransition = true
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = this.flowUI.showWaiting(this, {
      messageKey: 'game.waitingAfterResult',
      durationMs: null,
      onComplete: () => {
        // 다음 세트 전환이 확인될 때까지 직접 닫지 않는다.
      },
    })

    // readyNextSet 응답 경합으로 이미 상태가 넘어간 경우를 즉시 복구한다.
    if (this.tryResolveNextSetFromRoomStatus()) {
      return
    }

    this.startNextSetSyncPolling()
  }

  private startNextSetSyncPolling() {
    this.logNextSetTransitionDebug('polling:start')
    this.nextSetSyncPollEvent?.remove(false)
    this.nextSetSyncPollEvent = this.time.addEvent({
      delay: 1500,
      loop: true,
      callback: () => {
        void this.retryNextSetTransition()
      },
    })
  }

  private stopNextSetSyncPolling() {
    this.logNextSetTransitionDebug('polling:stop')
    this.nextSetSyncPollEvent?.remove(false)
    this.nextSetSyncPollEvent = undefined
  }

  private closeWaitingOverlay() {
    this.waitingOverlayHandle?.close(false)
    this.waitingOverlayHandle = undefined
  }

  private resetNextSetTransitionWaitingState() {
    this.logNextSetTransitionDebug('waitingReset')
    this.isWaitingForNextSetTransition = false
    this.stopNextSetSyncPolling()
    this.isSyncingNextSetTransition = false
    this.closeWaitingOverlay()
  }

  private async retryNextSetTransition() {
    if (!this.isWaitingForNextSetTransition || this.isSyncingNextSetTransition) {
      return
    }

    if (this.tryResolveNextSetFromRoomStatus()) {
      return
    }

    if (this.room?.status !== 'setResult') {
      this.logNextSetTransitionDebug('polling:roomStatusNotSetResult', {
        roomStatus: this.room?.status,
      })
      return
    }

    // ready-signal 완전 전환:
    // 추가 callable 재호출 없이 room 상태 스냅샷이 넘어오기를 기다린다.
    this.logNextSetTransitionDebug('polling:waitingForRoomStatusSignal')
    this.isSyncingNextSetTransition = true
    try {
      this.tryResolveNextSetFromRoomStatus()
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[RaceScene] retryNextSetTransition failed:', error)
      }
    } finally {
      this.isSyncingNextSetTransition = false
    }
  }

  private startNewSet(targetSet?: number) {
    this.logNextSetTransitionDebug('startNewSet:begin', { targetSet })
    this.resetNextSetTransitionWaitingState()
    this.resetAuthoritativeReplayState()
    this.finalResultBackfillRetryCount = 0
    this.isResultAggregationStarted = false

    const nextState = this.runtimeController.resetForNextSet({
      state: this.getRuntimeState(),
      horseManager: this.horseManager,
      cameraScrollManager: this.cameraScrollManager,
      progressBarManager: this.progressBarManager,
      mapManager: this.mapManager,
    })
    this.applyRuntimeState(nextState)

    if (typeof targetSet === 'number') {
      this.currentSet = targetSet
    } else if (this.room?.status === ROOM_STATUS_AUGMENT_SELECTION && this.room?.currentSet) {
      this.currentSet = this.room.currentSet
    }
    this.updateHUDInitial()
    this.logNextSetTransitionDebug('startNewSet:showAugmentSelection', {
      targetSet,
      effectiveCurrentSet: this.currentSet,
      roomStatus: this.room?.status,
      roomCurrentSet: this.room?.currentSet,
    })
    void this.showAugmentSelection(generateRandomRarity())
  }

  /**
   * 게임 데이터 업데이트 시 호출
   * PhaserGame에서 데이터가 변경되어 이벤트가 발생했을 때 호출됨
   */
  private onGameDataUpdated() {
    const previousSet = this.currentSet
    this.logGameDataUpdatedDebug()
    this.syncHorseNamesFromGameData()
    this.syncRuntimeRoomDerivedState()
    this.syncHorseBaseStatsFromPlayers()
    this.tryResumeRaceAfterAugmentSelectionWait()
    this.tryResolveWaitingNextSetFromRoomUpdate(previousSet)
  }

  private logGameDataUpdatedDebug() {
    if (!import.meta.env.DEV) return

    console.log('[RaceScene] Game data updated (from PhaserGame):', {
      roomId: this.roomId,
      playerId: this.playerId,
      hasRoom: !!this.room,
      playersCount: this.players?.length || 0,
      roomStatus: this.room?.status,
      hasSelectedHorse: !!this.selectedHorse,
      selectedHorseName: this.selectedHorse?.name,
    })

    // 디버깅에 필요한 상세 payload는 DEV에서만 노출
    console.log('[RaceScene] Updated room:', this.room)
    console.log('[RaceScene] Updated players:', this.players)
    if (this.selectedHorse) {
      console.log('[RaceScene] Updated Selected Horse:', this.selectedHorse)
      console.log('[RaceScene] Updated Horse Stats:', this.selectedHorse.stats)
    }
  }

  private syncHorseNamesFromGameData() {
    if (!this.horseManager) return

    // 우선순위: 1) this.players, 2) this.data.get('players')
    const playersFromData = this.data.get('players') as Player[] | undefined
    const playersToUse = this.players || playersFromData
    if (!playersToUse || playersToUse.length === 0) return

    const simHorses = this.horseManager.getSimHorses()
    const playerNames = playersToUse.map((p, index) => p.name || `Horse_${index + 1}`)
    simHorses.forEach((horse, index) => {
      if (playerNames[index]) {
        horse.name = playerNames[index]
      }
    })
  }

  private syncRuntimeRoomDerivedState() {
    if (!this.room) return

    // roundCount는 필요한 지점에서 this.room?.roundCount로 직접 사용한다.
    this.remainingRerolls = this.getRemainingRerollsForCurrentPlayer()

    if (this.room.currentSet) {
      this.currentSet = this.room.currentSet
    }

    if (!this.players || !this.playerId) return
    const currentPlayerIndex = this.players.findIndex((p) => p.id === this.playerId)
    if (currentPlayerIndex < 0) return

    this.playerHorseIndex = currentPlayerIndex
    this.progressBarManager?.setPlayerHorseIndex(this.playerHorseIndex)
  }

  private syncHorseBaseStatsFromPlayers() {
    if (!this.horseManager || !this.players || this.players.length === 0) return

    const simHorses = this.horseManager.getSimHorses()
    this.players.forEach((player, index) => {
      if (!player.horseStats || !simHorses[index]) return
      simHorses[index].baseStats = { ...player.horseStats }
    })
  }

  private tryResumeRaceAfterAugmentSelectionWait() {
    if (
      !shouldResumeAfterAugmentSelectionWait({
        isWaitingForOtherAugmentSelections: this.isWaitingForOtherAugmentSelections,
        roomStatus: this.room?.status,
      })
    ) {
      return
    }
    this.resumeRaceAfterAugmentSelectionWait()
  }

  private tryResolveWaitingNextSetFromRoomUpdate(previousSet: number) {
    const action = resolveWaitingNextSetRoomUpdateAction({
      isWaitingForNextSetTransition: this.isWaitingForNextSetTransition,
      roomStatus: this.room?.status,
      roomCurrentSet: this.room?.currentSet,
      previousSet,
    })
    if (action.type === 'none') return
    this.logNextSetTransitionDebug('roomUpdateResolve', { previousSet, action })
    if (action.type === 'startNewSet' && typeof this.room?.currentSet === 'number') {
      this.applyNextSetTransitionAction(
        { type: 'startNewSet', currentSet: this.room.currentSet },
        'roomUpdateResolve',
      )
      return
    }
    this.applyNextSetTransitionAction(action, 'roomUpdateResolve')
  }

  private handleSceneShutdown() {
    // RaceScene 재시작 시 중복 구독/오브젝트 잔존을 막기 위한 정리 루틴.
    this.dataSync.unsubscribe()
    this.unregisterSceneEventBridge()
    this.augmentDimOverlay?.destroy()
    this.augmentDimOverlay = undefined
    this.closeWaitingOverlay()
    this.stopNextSetSyncPolling()
    this.isSyncingNextSetTransition = false
    this.isWaitingForOtherAugmentSelections = false
    this.isWaitingForNextSetTransition = false
    this.resetAuthoritativeReplayState()
    window.removeEventListener('keydown', this.handleAuthoritativeDebugHotkey)
    this.authoritativeDebugText?.destroy()
    this.authoritativeDebugText = undefined
    this.hud?.destroy()
    this.horseManager?.destroy()
  }

  private handleSceneDestroy() {
    // destroy 경로도 같은 정리 루틴을 사용한다.
    this.handleSceneShutdown()
  }

  private applyGameData(data: RaceGameData) {
    this.roomId = data.roomId
    this.playerId = data.playerId
    this.sessionToken = data.sessionToken
    this.roomJoinToken = data.roomJoinToken
    this.room = data.room
    this.players = data.players
    this.selectedHorse = data.selectedHorse
  }

  private getRemainingRerollsForCurrentPlayer(): number {
    const totalLimit = this.room?.rerollLimit ?? DEFAULT_REROLL_LIMIT
    if (!this.players || !this.playerId) return totalLimit
    const me = this.players.find((player) => player.id === this.playerId)
    const used = me?.rerollUsed ?? 0
    return Math.max(0, totalLimit - used)
  }

  private getResolvedPlayerCount(): number {
    const candidate = this.players?.length
    return candidate && candidate > 0 ? candidate : DEFAULT_PLAYER_COUNT
  }

  private getRuntimeState(): RaceRuntimeState {
    return {
      isRaceStarted: this.isRaceStarted,
      isCountdownActive: this.isCountdownActive,
      augmentSelectionActive: this.augmentSelectionActive,
      isRaceFinished: this.isRaceFinished,
      isResultSceneShown: this.isResultSceneShown,
      isFinishSequenceTriggered: this.isFinishSequenceTriggered,
      finishSequenceDone: this.finishSequenceDone,
      simTimeAccumulatorSec: this.simTimeAccumulatorSec,
      simElapsedSec: this.simElapsedSec,
      raceStartTimestampMs: this.raceStartTimestampMs,
      currentSet: this.currentSet,
    }
  }

  private applyRuntimeState(state: RaceRuntimeState) {
    this.isRaceStarted = state.isRaceStarted
    this.isCountdownActive = state.isCountdownActive
    this.augmentSelectionActive = state.augmentSelectionActive
    this.isRaceFinished = state.isRaceFinished
    this.isResultSceneShown = state.isResultSceneShown
    this.isFinishSequenceTriggered = state.isFinishSequenceTriggered
    this.finishSequenceDone = state.finishSequenceDone
    this.isResultAggregationStarted = false
    this.simTimeAccumulatorSec = state.simTimeAccumulatorSec
    this.simElapsedSec = state.simElapsedSec
    this.raceStartTimestampMs = state.raceStartTimestampMs
    this.currentSet = state.currentSet
  }
}
