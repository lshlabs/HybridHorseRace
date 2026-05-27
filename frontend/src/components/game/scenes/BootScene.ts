import Phaser from 'phaser'
import type { RaceGameData } from './race/controllers/RaceDataSync'

const BOOT_SCENE_KEY = 'Boot'
const NEXT_SCENE_KEY = 'RaceScene'
const FONT_FAMILY = 'NeoDunggeunmo'
const FONT_PRELOAD_SIZES = [14, 16, 20, 24, 28, 32, 36, 48, 64, 120] as const

function buildFontFaceLoadRequests(): Promise<FontFace[]>[] {
  return FONT_PRELOAD_SIZES.map((size) => document.fonts.load(`${size}px "${FONT_FAMILY}"`))
}

function canLoadDocumentFonts(): boolean {
  return typeof document !== 'undefined' && 'fonts' in document
}

/**
 * 게임 시작 시 가장 먼저 실행되는 부트 씬.
 * UI에서 공통으로 쓰는 폰트를 먼저 로드한 뒤 RaceScene으로 넘어간다.
 */
export default class BootScene extends Phaser.Scene {
  private readonly initialRaceData?: RaceGameData

  constructor(initialRaceData?: RaceGameData) {
    super(BOOT_SCENE_KEY)
    this.initialRaceData = initialRaceData
  }

  async create() {
    if (canLoadDocumentFonts()) {
      await Promise.all(buildFontFaceLoadRequests())
    }

    this.scene.start(NEXT_SCENE_KEY, this.initialRaceData)
  }
}
