import * as logger from 'firebase-functions/logger'

export type LogContext = Record<string, unknown>

type LogLevel = 'info' | 'warn'

function log(level: LogLevel, event: string, context: LogContext): void {
  logger[level](event, context)
}

export function logInfo(event: string, context: LogContext = {}): void {
  log('info', event, context)
}

export function logWarn(event: string, context: LogContext = {}): void {
  log('warn', event, context)
}
