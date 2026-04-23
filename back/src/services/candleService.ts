import { v4 as uuidv4 } from 'uuid'
import { calcularCor } from '../utils/colorCalc.js'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'

// ─── REMOVIDO: alertMarketPaying, getPayThreshold, isConfigured ───────────────
// O alerta de mercado pagando é responsabilidade EXCLUSIVA do frontend
// (StrategiesPage.tsx), que analisa a janela de 60 velas e a % de azuis.
// O backend NÃO deve disparar alertas baseados em multiplicador individual —
// isso causava falsos positivos toda vez que qualquer vela chegasse com mult ≥ 2.

// Janela de tempo para considerar que uma vela WS "é a mesma" que uma histórica.
const HIST_REPLACE_WINDOW_MS = 90_000 // 90 segundos de tolerância por posição

class CandleService extends EventEmitter {
  private candles: any[]
  private totalCaptured: number
  private emittedRoundIds: Set<string>
  private historicalByValue: Map<string, any[]>

  constructor() {
    super()
    this.candles           = []
    this.totalCaptured     = 0
    this.emittedRoundIds   = new Set()
    this.historicalByValue = new Map()
  }

  // ─── Deduplicação apenas por rodada_id ──────────────────────────────────────
  isDuplicate(
    _multiplicador: number,
    rodada_id?: string | null,
    _customTime?: string,
  ): boolean {
    if (rodada_id && this.emittedRoundIds.has(rodada_id)) return true
    return false
  }

  // ─── Verifica se uma vela WS substitui uma histórica ────────────────────────
  private findHistoricalMatch(mult: number, wsTimestamp: number): number {
    const key = Number(mult).toFixed(2)
    const candidates = this.historicalByValue.get(key)
    if (!candidates || candidates.length === 0) return -1

    let bestIdx  = -1
    let bestDiff = Infinity

    for (const hist of candidates) {
      const histTs = new Date(hist.timestamp).getTime()
      const diff   = Math.abs(wsTimestamp - histTs)
      if (diff < HIST_REPLACE_WINDOW_MS && diff < bestDiff) {
        bestDiff = diff
        bestIdx  = this.candles.indexOf(hist)
      }
    }

    return bestIdx
  }

  addCandle(
    multiplicador: number,
    rodada_id?: string | null,
    customTime?: string,
  ): any {
    const timestamp    = customTime || new Date().toISOString()
    const isHistorical = !!customTime

    // Vela WS real chegando — verifica se substitui uma histórica
    if (!isHistorical && rodada_id) {
      const wsTs     = Date.now()
      const matchIdx = this.findHistoricalMatch(multiplicador, wsTs)

      if (matchIdx !== -1) {
        const old = this.candles[matchIdx]

        // Remove do índice de histórico
        const key = Number(multiplicador).toFixed(2)
        const arr = this.historicalByValue.get(key)
        if (arr) {
          const i = arr.indexOf(old)
          if (i !== -1) arr.splice(i, 1)
          if (arr.length === 0) this.historicalByValue.delete(key)
        }

        if (old.rodada_id) this.emittedRoundIds.delete(old.rodada_id)

        const candle = {
          ...old,
          rodada_id,
          timestamp,
          created_at: timestamp,
        }

        this.candles[matchIdx] = candle
        this.emittedRoundIds.add(rodada_id)
        this.totalCaptured++
        this.emit('new_candle', candle)

        // ✅ REMOVIDO: alertMarketPaying() — não é papel do backend decidir isso

        return candle
      }
    }

    const candle = {
      id:            uuidv4(),
      multiplicador: Number(multiplicador),
      cor:           calcularCor(multiplicador),
      rodada_id,
      timestamp,
      created_at:    timestamp,
      fonte:         'auto',
    }

    if (isHistorical) {
      const t = new Date(timestamp).getTime()
      let lo = 0, hi = this.candles.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (new Date(this.candles[mid].timestamp).getTime() <= t) lo = mid + 1
        else hi = mid
      }
      this.candles.splice(lo, 0, candle)

      const key = Number(multiplicador).toFixed(2)
      if (!this.historicalByValue.has(key)) this.historicalByValue.set(key, [])
      this.historicalByValue.get(key)!.push(candle)

      setTimeout(() => {
        const arr = this.historicalByValue.get(key)
        if (arr) {
          const i = arr.indexOf(candle)
          if (i !== -1) arr.splice(i, 1)
          if (arr.length === 0) this.historicalByValue.delete(key)
        }
      }, 10 * 60_000)
    } else {
      this.candles.push(candle)
    }

    if (this.candles.length > 1000) this.candles.shift()
    this.totalCaptured++

    if (rodada_id) this.emittedRoundIds.add(rodada_id)

    this.emit('new_candle', candle)

    // ✅ REMOVIDO: alertMarketPaying() — não é papel do backend decidir isso

    return candle
  }

  getCandles(limit = 100): any[] {
    return this.candles.slice(-limit).reverse()
  }

  getLastCandle(): any | null {
    return this.candles[this.candles.length - 1] || null
  }

  getTotalCaptured(): number {
    return this.totalCaptured
  }

  getStats() {
    const total = this.candles.length
    if (total === 0) return null
    const mults = this.candles.map(c => c.multiplicador)
    return {
      total,
      blue:   { count: this.candles.filter(c => c.cor === 'blue').length },
      purple: { count: this.candles.filter(c => c.cor === 'purple').length },
      pink:   { count: this.candles.filter(c => c.cor === 'pink').length },
      media:  (mults.reduce((a, b) => a + b, 0) / total).toFixed(2),
    }
  }

  clear() {
    this.candles           = []
    this.emittedRoundIds.clear()
    this.historicalByValue.clear()
    logger.warn('Buffer local limpo')
  }
}

export const candleService = new CandleService()