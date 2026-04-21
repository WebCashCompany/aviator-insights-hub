import { v4 as uuidv4 } from 'uuid'
import { Candle } from '../types/index.js'
import { calcularCor } from '../utils/colorCalc.js'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'
import { alertMarketPaying, getPayThreshold, isConfigured as wppConfigured } from './whatsappService.js'
import { supabase } from './supabaseService.js'

const MAX_CANDLES = 500
const DEDUP_VALUE_MS = 10_000 

class CandleService extends EventEmitter {
  private candles: Candle[] = []
  private totalCaptured = 0
  private emittedRoundIds = new Set<string>()
  private isInitialized = false

  async initialize() {
    if (this.isInitialized) return
    logger.info('🔄 Sincronizando Memória Blindada com Supabase...')
    try {
      const { data } = await supabase
        .from('candles')
        .select('rodada_id, multiplicador, timestamp')
        .order('timestamp', { ascending: false })
        .limit(200)

      if (data) {
        data.forEach(c => {
          if (c.rodada_id) this.emittedRoundIds.add(c.rodada_id)
          if (this.candles.length < 100) this.candles.push(c as Candle)
        })
        this.isInitialized = true
        logger.info(`✅ Memória pronta: ${this.emittedRoundIds.size} registros carregados.`)
      }
    } catch (err) {
      logger.error('❌ Erro no initialize:', err)
    }
  }

  // Verifica se uma sequência de valores já existe para evitar re-scrape do histórico
  isSequenceDuplicate(values: number[]): boolean {
    if (this.candles.length < 5) return false
    const currentSequence = this.candles.slice(-10).map(c => c.multiplicador.toFixed(2)).join('|')
    const incomingSequence = values.slice(-10).map(v => v.toFixed(2)).join('|')
    return currentSequence.includes(incomingSequence) || incomingSequence.includes(currentSequence)
  }

  isDuplicate(multiplicador: number, rodada_id?: string): boolean {
    if (rodada_id && this.emittedRoundIds.has(rodada_id)) return true

    const last = this.getLastCandle()
    if (last && last.multiplicador === multiplicador) {
      const diff = Date.now() - new Date(last.timestamp).getTime()
      if (diff < DEDUP_VALUE_MS) return true
    }
    return false
  }

  addCandle(multiplicador: number, rodada_id: string, customTime?: string): Candle {
    const timestamp = customTime || new Date().toISOString()
    
    const candle: Candle = {
      id: uuidv4(),
      multiplicador,
      cor: calcularCor(multiplicador),
      rodada_id,
      timestamp,
      created_at: new Date().toISOString(),
      fonte: rodada_id.startsWith('dom') ? 'dom' : (rodada_id.startsWith('ws') ? 'ws' : 'hist'),
    }

    this.emittedRoundIds.add(rodada_id)
    if (this.candles.length >= MAX_CANDLES) this.candles.shift()
    this.candles.push(candle)
    this.totalCaptured++

    logger.info(`🕯️ [${candle.fonte.toUpperCase()}] ${multiplicador}x gravado com sucesso.`)
    this.emit('new_candle', candle)

    if (wppConfigured() && multiplicador >= getPayThreshold()) {
      alertMarketPaying().catch(() => {})
    }

    return candle
  }

  getLastCandle(): Candle | null { return this.candles[this.candles.length - 1] || null }
  getTotalCaptured() { return this.totalCaptured }
  
  getStats() {
    const total = this.candles.length
    if (total === 0) return null
    const mults = this.candles.map(c => c.multiplicador)
    return {
      total,
      blue: { count: this.candles.filter(c => c.cor === 'blue').length },
      purple: { count: this.candles.filter(c => c.cor === 'purple').length },
      pink: { count: this.candles.filter(c => c.cor === 'pink').length },
      media: (mults.reduce((a, b) => a + b, 0) / total).toFixed(2)
    }
  }
}

export const candleService = new CandleService()