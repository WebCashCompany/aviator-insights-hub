import { v4 as uuidv4 } from 'uuid'
import { Candle } from '../types/index.js'
import { calcularCor } from '../utils/colorCalc.js'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'
import { alertPayingCandle, getPayThreshold, isConfigured as wppConfigured } from './whatsappService.js'

const MAX_CANDLES    = 1000
const DEDUP_WINDOW_MS = 3000

class CandleService extends EventEmitter {
  private candles: Candle[] = []
  private totalCaptured     = 0
  private lastEmitted       = new Map<string, number>()

  isDuplicate(multiplicador: number): boolean {
    const key  = multiplicador.toFixed(2)
    const last = this.lastEmitted.get(key)
    return last !== undefined && Date.now() - last < DEDUP_WINDOW_MS
  }

  markEmitted(multiplicador: number): void {
    const key = multiplicador.toFixed(2)
    const now = Date.now()
    this.lastEmitted.set(key, now)
    for (const [k, ts] of this.lastEmitted) {
      if (now - ts > DEDUP_WINDOW_MS * 10) this.lastEmitted.delete(k)
    }
  }

  addCandle(multiplicador: number, rodada_id: string): Candle {
    const now = new Date().toISOString()

    const candle: Candle = {
      id: uuidv4(),
      multiplicador,
      cor: calcularCor(multiplicador),
      rodada_id,
      timestamp: now,
      created_at: now,
      fonte: 'auto',
    }

    if (this.candles.length >= MAX_CANDLES) this.candles.shift()

    this.candles.push(candle)
    this.totalCaptured++

    logger.info(`🕯️  Nova vela: ${multiplicador}x [${candle.cor.toUpperCase()}] | Total: ${this.totalCaptured}`)

    this.emit('new_candle', candle)

    // ── Alerta WhatsApp: gráfico pagando ──────────────────────────────────────
    if (wppConfigured() && multiplicador >= getPayThreshold()) {
      alertPayingCandle(candle).catch(err =>
        logger.error(`[WhatsApp] Erro no alerta de pagamento: ${err.message}`)
      )
    }

    return candle
  }

  getCandles(limit = 100): Candle[] {
    return this.candles.slice(-limit)
  }

  getLastCandle(): Candle | null {
    return this.candles[this.candles.length - 1] || null
  }

  getTotalCaptured(): number {
    return this.totalCaptured
  }

  getStats() {
    const total = this.candles.length
    if (total === 0) return null

    const blue   = this.candles.filter(c => c.cor === 'blue').length
    const purple = this.candles.filter(c => c.cor === 'purple').length
    const pink   = this.candles.filter(c => c.cor === 'pink').length
    const mults  = this.candles.map(c => c.multiplicador)

    return {
      total,
      blue:   { count: blue,   percent: ((blue   / total) * 100).toFixed(1) },
      purple: { count: purple, percent: ((purple / total) * 100).toFixed(1) },
      pink:   { count: pink,   percent: ((pink   / total) * 100).toFixed(1) },
      maior:  Math.max(...mults),
      menor:  Math.min(...mults),
      media:  (mults.reduce((a, b) => a + b, 0) / total).toFixed(2),
    }
  }

  clear() {
    this.candles = []
    logger.warn('Buffer de velas limpo')
  }
}

export const candleService = new CandleService()