import { useEffect, useRef, useState } from 'react'
import Phaser from 'phaser'
import { Smartphone } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import BootScene from './scenes/BootScene'
import RaceScene from './scenes/race/RaceScene'
import AugmentSelectionScene from './scenes/augment/AugmentSelectionScene'
import RaceResultScene from './scenes/result/RaceResultScene'
import type { Room, Player } from '../../hooks/useRoom'
import type { RaceGameData } from './scenes/race/controllers/RaceDataSync'

/** 개발 모드에서 RaceScene으로 전달하는 선택 말 스냅샷 */
interface SelectedHorseData {
  name: string
  stats: {
    Speed: number
    Stamina: number
    Power: number
    Guts: number
    Start: number
    Luck: number
  }
  totalStats: number
  selectedAt: string
}

/** Phaser 캔버스 임베딩을 위한 React wrapper props */
interface PhaserGameProps {
  aspectRatioWidth?: number // 게임 너비 (고정 크기, 기본값: 1280)
  aspectRatioHeight?: number // 게임 높이 (고정 크기, 기본값: 720)
  roomId?: string // Firebase 룸 ID
  playerId?: string // 플레이어 ID
  sessionToken?: string
  roomJoinToken?: string | null
  room?: Room // Firebase 룸 데이터
  players?: Player[] // 플레이어 목록
  selectedHorse?: SelectedHorseData // 개발 모드: 선택한 말 데이터
}

type DevWindow = Window & { __phaserGame?: Phaser.Game }
const DEFAULT_ASPECT_RATIO_WIDTH = 1280
const DEFAULT_ASPECT_RATIO_HEIGHT = 720
const PORTRAIT_OVERLAY_BREAKPOINT = 1
const RACE_SCENE_KEY = 'RaceScene'
const ROOM_DATA_UPDATED_EVENT = 'room-data-updated'
const RESIZE_EVENT = 'resize'
const ORIENTATION_CHANGE_EVENT = 'orientationchange'
const SCREEN_ORIENTATION_CHANGE_EVENT = 'change'
const RACE_SCENE_MISSING_WARNING =
  '[PhaserGame] RaceScene not found. Scene may not be initialized yet.'

function applyPixelRendering(el: HTMLCanvasElement): void {
  el.style.imageRendering = 'pixelated'
  el.style.imageRendering = 'crisp-edges'
}

function isPortraitMode(): boolean {
  return window.innerHeight > window.innerWidth * PORTRAIT_OVERLAY_BREAKPOINT
}

function addOrientationListener(handler: () => void): void {
  if ('orientation' in screen && 'addEventListener' in screen.orientation) {
    screen.orientation.addEventListener(SCREEN_ORIENTATION_CHANGE_EVENT, handler)
  }
}

function removeOrientationListener(handler: () => void): void {
  if ('orientation' in screen && 'removeEventListener' in screen.orientation) {
    screen.orientation.removeEventListener(SCREEN_ORIENTATION_CHANGE_EVENT, handler)
  }
}

/**
 * Phaser 인스턴스 생성/파괴와 React 상태(레이아웃, room 데이터)를 연결한다.
 * 게임 내부 로직은 각 Scene에서 처리하고, 이 컴포넌트는 "호스트 컨테이너" 역할만 맡는다.
 */
export function PhaserGame({
  aspectRatioWidth = DEFAULT_ASPECT_RATIO_WIDTH,
  aspectRatioHeight = DEFAULT_ASPECT_RATIO_HEIGHT,
  roomId,
  playerId,
  sessionToken,
  roomJoinToken,
  room,
  players = [],
  selectedHorse,
}: PhaserGameProps) {
  // Phaser Game 인스턴스 보관
  const gameRef = useRef<Phaser.Game | null>(null)
  // Phaser가 canvas를 붙일 DOM
  const containerRef = useRef<HTMLDivElement>(null)
  // 반응형 스케일 계산 기준 컨테이너
  const wrapperRef = useRef<HTMLDivElement>(null)
  const initialRaceDataRef = useRef<RaceGameData>({
    roomId,
    playerId,
    sessionToken,
    roomJoinToken,
    room,
    players,
    selectedHorse,
  })
  const [scale, setScale] = useState(1)
  // 모바일 세로 모드 안내 오버레이 표시 여부
  const [isPortrait, setIsPortrait] = useState(false)

  useEffect(() => {
    // containerRef가 없거나 이미 게임이 생성되어 있으면 실행하지 않음
    if (!containerRef.current || gameRef.current) return

    // Phaser Game 설정
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.CANVAS, // Canvas 렌더러 강제 (WebGL은 antialias로 인해 배경이 흐릿해질 수 있음)
      width: aspectRatioWidth, // Phaser 초기 너비 (고정 크기)
      height: aspectRatioHeight, // Phaser 초기 높이 (고정 크기)
      parent: containerRef.current, // 게임이 렌더링될 부모 요소
      backgroundColor: '#000000', // 배경색 (test-phaser.html과 동일)
      scene: [
        new BootScene(initialRaceDataRef.current),
        RaceScene,
        AugmentSelectionScene,
        RaceResultScene,
      ],
      render: {
        pixelArt: true,
        antialias: false, // 픽셀 폰트 선명도 (true면 확대 시 흐림)
        roundPixels: true,
      },
      scale: { mode: Phaser.Scale.NONE },
      input: {
        // 터치 이벤트 활성화
        touch: true,
        activePointers: 1,
      },
    }

    // 인스턴스 생성은 1회만 수행
    gameRef.current = new Phaser.Game(config)

    const canvas = gameRef.current.canvas
    if (canvas) {
      applyPixelRendering(canvas)
    } else if (containerRef.current) {
      requestAnimationFrame(() => {
        const c = containerRef.current?.querySelector('canvas')
        if (c) applyPixelRendering(c)
      })
    }

    // 개발 모드에서 전역 변수로 접근 가능하도록 설정 (디버깅용)
    if (import.meta.env.DEV) {
      ;(window as DevWindow).__phaserGame = gameRef.current
    }

    // 컴포넌트 언마운트 시 Phaser 리소스 정리
    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true)
        gameRef.current = null
        // 개발 모드에서 전역 변수 정리
        if (import.meta.env.DEV && '__phaserGame' in window) {
          const win = window as DevWindow
          delete win.__phaserGame
        }
      }
    }
  }, [aspectRatioWidth, aspectRatioHeight])

  // 상위 페이지 데이터가 바뀌면 RaceScene data/events 채널로 동기화
  useEffect(() => {
    if (!gameRef.current) return

    const raceScene = gameRef.current.scene.getScene(RACE_SCENE_KEY) as RaceScene | null
    if (raceScene) {
      // Scene data 저장소 경로(초기화/재진입 모두 안전)
      raceScene.data.set('roomId', roomId)
      raceScene.data.set('playerId', playerId)
      raceScene.data.set('sessionToken', sessionToken)
      raceScene.data.set('roomJoinToken', roomJoinToken)
      raceScene.data.set('room', room)
      raceScene.data.set('players', players)

      // 개발 모드: 선택한 말 데이터 전달
      if (selectedHorse) {
        raceScene.data.set('selectedHorse', selectedHorse)
      }

      // 실행 중 Scene 즉시 반영용 이벤트 경로
      raceScene.events.emit(ROOM_DATA_UPDATED_EVENT, {
        roomId,
        playerId,
        sessionToken,
        roomJoinToken,
        room,
        players,
        selectedHorse,
      })
    } else if (import.meta.env.DEV) {
      console.warn(RACE_SCENE_MISSING_WARNING)
    }
  }, [roomId, playerId, sessionToken, roomJoinToken, room, players, selectedHorse])

  // 부모 컨테이너 크기에 맞춰 캔버스 스케일 계산
  useEffect(() => {
    const updateScale = () => {
      if (!wrapperRef.current) return

      const wrapper = wrapperRef.current
      const availableWidth = wrapper.clientWidth
      const availableHeight = wrapper.clientHeight

      // 원본 해상도 비율을 유지하면서 축소만 허용
      const scaleX = availableWidth / aspectRatioWidth
      const scaleY = availableHeight / aspectRatioHeight
      const newScale = Math.min(scaleX, scaleY, 1)
      setScale(newScale)
    }

    // 초기 계산
    updateScale()

    // 리사이즈 이벤트 리스너
    window.addEventListener(RESIZE_EVENT, updateScale)
    const resizeObserver = new ResizeObserver(updateScale)
    if (wrapperRef.current) {
      resizeObserver.observe(wrapperRef.current)
    }

    return () => {
      window.removeEventListener(RESIZE_EVENT, updateScale)
      resizeObserver.disconnect()
    }
  }, [aspectRatioWidth, aspectRatioHeight])

  // 화면 방향 감지 (세로/가로)
  useEffect(() => {
    const checkOrientation = () => {
      setIsPortrait(isPortraitMode())
    }

    // 초기 확인
    checkOrientation()

    // 리사이즈 및 방향 변경 감지
    window.addEventListener(RESIZE_EVENT, checkOrientation)
    window.addEventListener(ORIENTATION_CHANGE_EVENT, checkOrientation)
    addOrientationListener(checkOrientation)

    return () => {
      window.removeEventListener(RESIZE_EVENT, checkOrientation)
      window.removeEventListener(ORIENTATION_CHANGE_EVENT, checkOrientation)
      removeOrientationListener(checkOrientation)
    }
  }, [])

  // 게임이 렌더링될 div 반환 (고정 크기, test-phaser.html과 동일)
  // 반응형 스케일링을 위해 부모 컨테이너 크기에 맞춰 스케일 적용
  return (
    <div
      ref={wrapperRef}
      className="flex items-center justify-center overflow-hidden w-full h-full"
    >
      <div
        ref={containerRef}
        className="relative"
        style={{
          width: `${aspectRatioWidth}px`,
          height: `${aspectRatioHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      />
      {/* 세로 모드 안내 오버레이 */}
      {isPortrait && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/90 backdrop-blur-sm">
          <Card className="mx-4 max-w-md border-white/20 bg-black/80 text-center shadow-2xl">
            <CardHeader>
              <div className="mb-4 flex justify-center">
                <Smartphone className="h-16 w-16 text-primary animate-rotate-90" />
              </div>
              <CardTitle className="text-2xl">가로 모드로 전환해주세요</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-base">
                이 게임은 가로 모드에서 최적의 경험을 제공합니다.
                <br />
                기기를 가로로 회전시켜주세요.
              </CardDescription>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
