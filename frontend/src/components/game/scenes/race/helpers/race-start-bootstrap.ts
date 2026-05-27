// 레이스 시작 전 "게임을 시작하는 중..." 부트스트랩 단계에서 쓰는 helper
export type RaceStateBootstrapResponseData = {
  hasRaceState?: boolean
  elapsedMs?: number
  keyframe?: unknown
  nextKeyframe?: unknown
}

export type RaceStartBootstrapReleaseParams = {
  hasReceivedInitialAuthoritativeFrame: boolean
  nowMs: number
  minReadyAtMs: number
}

export type RaceStartBootstrapDebugReason =
  | 'first-frame'
  | 'timeout'
  | 'already-ready'
  | 'timeline-preloaded'

function hasRaceState(data: RaceStateBootstrapResponseData): boolean {
  return data.hasRaceState === true
}

function hasBootstrapFrameData(data: RaceStateBootstrapResponseData): boolean {
  return Boolean(data.keyframe || data.nextKeyframe || typeof data.elapsedMs === 'number')
}

export function shouldMarkInitialAuthoritativeFrameReceived(
  data: RaceStateBootstrapResponseData,
): boolean {
  if (!hasRaceState(data)) return false
  return hasBootstrapFrameData(data)
}

export function shouldReleaseRaceStartOverlay(params: RaceStartBootstrapReleaseParams): boolean {
  return params.hasReceivedInitialAuthoritativeFrame && params.nowMs >= params.minReadyAtMs
}

export function buildRaceStartBootstrapDebugPayload(params: {
  roomId?: string
  setIndex: number
  elapsedMs?: number
  hasKeyframe: boolean
  hasNextKeyframe: boolean
  reason: RaceStartBootstrapDebugReason
  hasAnyPollResponse?: boolean
}): Record<string, unknown> {
  return {
    roomId: params.roomId,
    setIndex: params.setIndex,
    elapsedMs: params.elapsedMs,
    hasKeyframe: params.hasKeyframe,
    hasNextKeyframe: params.hasNextKeyframe,
    hasAnyPollResponse: params.hasAnyPollResponse,
    clientTime: Date.now(),
    reason: params.reason,
  }
}
