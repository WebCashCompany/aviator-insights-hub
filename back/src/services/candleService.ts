import { v4 as uuidv4 } from 'uuid'
import { Candle } from '../types/index.js'
import { calcularCor } from '../utils/colorCalc.js'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'
import { alertPayingCandle, getPayThreshold, isConfigured as wppConfigured } from './whatsappService.js'

const MAX_CANDLES = 1000

// ─── JANELAS DE DEDUPLICAÇÃO ──────────────────────────────────────────────────
//
// Problema real observado nos logs:
// O servidor dispara o mesmo evento duas vezes via WS com IDs diferentes (diferença
// de ~7ms), e o DOM polling emite por cima logo em seguida. Resultado: 3 cópias
// da mesma vela salvas no banco.
//
// Estratégia de 3 camadas:
//
// 1. Por rodada_id (IDs reais do WS):
//    Janela longa de 30 min — cobre reconexões. Bloqueia o MESMO id chegando de novo.
//    NÃO resolve o problema atual pois os dois frames do servidor têm IDs distintos.
//
// 2. Por valor + janela curtíssima para WS real (50ms):
//    Resolve o double-fire do servidor (~7ms entre os dois frames).
//    50ms é seguro: rounds do Aviator duram no mínimo vários segundos.
//
// 3. Por valor + janela curta para fontes sintéticas (dom_ / hist_) (800ms):
//    Evita que o DOM polling emita logo depois que o WS já emitiu.
//    800ms = mesmo intervalo do poll, suficiente para absorver o tick seguinte.

const DEDUP_ROUND_ID_MS  = 30 * 60 * 1000   // 30 min  — dedup por ID exato
const DEDUP_WS_VALUE_MS  = 5_000            // 5 s     — dedup por valor entre frames WS
const DEDUP_DOM_VALUE_MS = 5_000            // 5 s     — dedup por valor para DOM/hist

class CandleService extends EventEmitter {
  private candles: Candle[] = []
  private totalCaptured = 0

  // Camada 1: por rodada_id exato
  private emittedRoundIds = new Map<string, number>()

  // Camada 2+3: por valor (compartilhado — WS e DOM usam a mesma chave)
  // Assim WS emitido bloqueia DOM, e DOM emitido bloqueia WS tardio.
  private emittedValues = new Map<string, number>()

  // ── isDuplicate ─────────────────────────────────────────────────────────────
  isDuplicate(multiplicador: number, rodada_id?: string): boolean {
    const now = Date.now()

    // Camada 1: ID exato já visto
    if (rodada_id && !this.isSyntheticId(rodada_id)) {
      const lastById = this.emittedRoundIds.get(rodada_id)
      if (lastById !== undefined && now - lastById < DEDUP_ROUND_ID_MS) return true
    }

    // Camada 2/3: mesmo valor já emitido recentemente (qualquer fonte)
    const key = multiplicador.toFixed(2)
    const lastByValue = this.emittedValues.get(key)
    const windowMs = this.isSyntheticId(rodada_id ?? '') ? DEDUP_DOM_VALUE_MS : DEDUP_WS_VALUE_MS
    if (lastByValue !== undefined && now - lastByValue < windowMs) return true

    return false
  }

  // ── markEmitted ─────────────────────────────────────────────────────────────
  markEmitted(multiplicador: number, rodada_id?: string): void {
    const now = Date.now()

    if (rodada_id && !this.isSyntheticId(rodada_id)) {
      this.emittedRoundIds.set(rodada_id, now)
      this.cleanupMap(this.emittedRoundIds, DEDUP_ROUND_ID_MS)
    }

    // Sempre marca por valor também (cobre o double-fire e bloqueia o DOM)
    const key = multiplicador.toFixed(2)
    this.emittedValues.set(key, now)
    this.cleanupMap(this.emittedValues, Math.max(DEDUP_WS_VALUE_MS, DEDUP_DOM_VALUE_MS) * 2)
  }

  // ── addCandle ────────────────────────────────────────────────────────────────
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

    if (wppConfigured() && multiplicador >= getPayThreshold()) {
      alertPayingCandle(candle).catch(err =>
        logger.error(`[WhatsApp] Erro no alerta de pagamento: ${err.message}`)
      )
    }

    return candle
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private isSyntheticId(id: string): boolean {
    return id.startsWith('dom_') || id.startsWith('hist_') || id.startsWith('ws_json_')
  }

  private cleanupMap(map: Map<string, number>, maxAgeMs: number): void {
    const now = Date.now()
    for (const [k, ts] of map) {
      if (now - ts > maxAgeMs) map.delete(k)
    }
  }

  // ── Consultas ─────────────────────────────────────────────────────────────────

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
    this.emittedRoundIds.clear()
    this.emittedValues.clear()
    logger.warn('Buffer de velas limpo')
  }
}

export const candleService = new CandleService()