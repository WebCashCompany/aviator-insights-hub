import { v4 as uuidv4 } from 'uuid'
import { Candle } from '../types/index.js'
import { calcularCor } from '../utils/colorCalc.js'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'
import { alertMarketPaying, getPayThreshold, isConfigured as wppConfigured } from './whatsappService.js'

const MAX_CANDLES = 1000

// ─── JANELAS DE DEDUPLICAÇÃO ──────────────────────────────────────────────────
//
// PROBLEMA RAIZ IDENTIFICADO:
// O histórico (35 velas) é salvo no início com markEmitted() — isso poluía a
// emittedValues e bloqueava rounds legítimos com o mesmo multiplicador que
// chegavam logo depois (ex: 1.24x no hist → 1.24x real bloqueado 60s depois).
//
// SOLUÇÃO:
// - emittedValues só é atualizada por velas AO VIVO (não pelo histórico).
// - A janela de dedup por valor é CURTA (15s): suficiente para absorver o
//   double-fire WS + DOM polling, mas sem bloquear rounds legítimos.
// - O histórico usa apenas emittedRoundIds (por id sintético de posição).

const DEDUP_ROUND_ID_MS = 30 * 60 * 1000  // 30 min — dedup por ID exato (reconexões)
const DEDUP_VALUE_MS    = 15_000           // 15 s   — dedup por valor AO VIVO apenas

class CandleService extends EventEmitter {
  private candles: Candle[] = []
  private totalCaptured = 0

  // Camada 1: por rodada_id exato
  private emittedRoundIds = new Map<string, number>()

  // Camada 2: por valor — apenas velas AO VIVO (não histórico)
  private emittedValues = new Map<string, number>()

  // ── isSyntheticId ────────────────────────────────────────────────────────────
  isSyntheticId(id: string): boolean {
    return (
      id.startsWith('ws_') ||
      id.startsWith('ws_json_') ||
      id.startsWith('dom_') ||
      id.startsWith('hist_')
    )
  }

  // ── isHistoryId ──────────────────────────────────────────────────────────────
  // IDs do histórico inicial — não devem poluir emittedValues
  private isHistoryId(id: string): boolean {
    return id.startsWith('hist_')
  }

  // ── isDuplicate ──────────────────────────────────────────────────────────────
  isDuplicate(multiplicador: number, rodada_id?: string): boolean {
    const now = Date.now()

    // Camada 1: ID exato já visto (cobre reconexões com mesmo round_id real)
    if (rodada_id) {
      const lastById = this.emittedRoundIds.get(rodada_id)
      if (lastById !== undefined && now - lastById < DEDUP_ROUND_ID_MS) {
        return true
      }
    }

    // Camada 2: mesmo valor ao vivo nos últimos 15s
    // Histórico NÃO entra aqui — isHistoryId é excluído no markEmitted
    const key = multiplicador.toFixed(2)
    const lastByValue = this.emittedValues.get(key)
    if (lastByValue !== undefined && now - lastByValue < DEDUP_VALUE_MS) {
      return true
    }

    return false
  }

  // ── markEmitted ──────────────────────────────────────────────────────────────
  markEmitted(multiplicador: number, rodada_id?: string): void {
    const now = Date.now()

    if (rodada_id) {
      this.emittedRoundIds.set(rodada_id, now)
      this.cleanupMap(this.emittedRoundIds, DEDUP_ROUND_ID_MS)
    }

    // ⚠️ HISTÓRICO NÃO POLUI emittedValues
    // Apenas velas ao vivo (dom_, ws_, ws_json_ e IDs reais) entram aqui
    if (!rodada_id || !this.isHistoryId(rodada_id)) {
      const key = multiplicador.toFixed(2)
      this.emittedValues.set(key, now)
      this.cleanupMap(this.emittedValues, DEDUP_VALUE_MS * 2)
    }
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
      alertMarketPaying().catch(err =>
        logger.error(`[WhatsApp] Erro no alerta de pagamento: ${err.message}`)
      )
    }

    return candle
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

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