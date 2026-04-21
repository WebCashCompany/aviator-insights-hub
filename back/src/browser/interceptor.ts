// interceptor.ts — COMPLETO
import { Page, Frame } from 'playwright'
import { logger } from '../utils/logger.js'
import { candleService } from '../services/candleService.js'
import { saveCandle } from '../services/supabaseService.js'

if (!global.HISTORY_SYNCED)      global.HISTORY_SYNCED      = false
if (!global.INTERCEPTION_ACTIVE) global.INTERCEPTION_ACTIVE = false

const wsQueue: Array<{ mult: number; rId: string }> = []
let lastWSEmitTime  = 0
let lastKnownValue: number | null = null
let activeWSHandler: ((ws: any) => void) | null = null

let scrapeInProgress = false

export async function startInterception(page: Page) {
  logger.info('🚀 Iniciando Interceptação v12...')

  wsQueue.length        = 0
  lastWSEmitTime        = 0
  lastKnownValue        = null
  global.HISTORY_SYNCED = false
  scrapeInProgress      = false

  if (activeWSHandler) {
    page.removeListener('websocket', activeWSHandler)
    activeWSHandler = null
  }

  const wsHandler = (ws: any) => {
    if (!ws.url().includes('aviator') && !ws.url().includes('p-j-0-h')) return
    ws.on('framereceived', (f: any) => {
      const payload = Buffer.isBuffer(f.payload)
        ? f.payload
        : Buffer.from(f.payload, 'binary')
      tryParseCandle(payload)
    })
  }

  activeWSHandler = wsHandler
  page.on('websocket', wsHandler)

  const frame = await forceReloadGameIframe(page)
  if (!frame) {
    logger.error('❌ Frame do jogo não encontrado após reload')
    return
  }

  await scrapeHistory(frame)
  global.HISTORY_SYNCED = true

  // Drena fila WS acumulada durante o scrape
  // Velas WS que correspondem ao histórico serão substituídas no candleService
  while (wsQueue.length > 0) {
    const item = wsQueue.shift()
    if (item) emitCandle(item.mult, item.rId)
  }

  startDOMPolling(frame)
}

export function resetHistorySync() {
  scrapeInProgress = false
  logger.info('🔄 Reset de histórico autorizado')
}

const MAX_HISTORY_CANDLES = 60

// Tempo médio de rodada em ms. Usado para estimar o timestamp de cada vela histórica.
// O candleService aceita uma vela WS como "substituição" da histórica se ela chegar
// dentro de HIST_REPLACE_WINDOW_MS (90s) do timestamp estimado.
// Com 30s por rodada, a posição 0 (mais recente) tem erro ≤ 30s — dentro da janela.
// A posição 59 (mais antiga) tem timestamp estimado há ~30min — velas WS já foram
// emitidas por isso, então o índice histórico expira após 10min (sem risco de dupli).
const AVG_ROUND_DURATION_MS = 30_000

async function scrapeHistory(frame: Frame) {
  if (scrapeInProgress) {
    logger.info('⏭️  scrapeHistory ignorado — já em progresso')
    return
  }

  scrapeInProgress = true
  logger.info('📜 Sincronizando histórico inicial...')

  try {
    await frame.waitForTimeout(5000)

    // DOM: índice 0 = mais recente, último = mais antiga
    const history: number[] = await frame.evaluate((max: number) => {
      const nodes = Array.from(document.querySelectorAll('.payouts-block .payout'))
      return nodes
        .slice(0, max)
        .map(el => { const raw = (el.textContent || '').replace('x', '').trim(); const normalized = raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(',', '.'); return parseFloat(normalized) || 0; })
        .filter(v => v > 0)
    }, MAX_HISTORY_CANDLES)

    if (history.length === 0) {
      logger.warn('⚠️  Histórico do DOM vazio')
      return
    }

    logger.info(`📋 DOM retornou ${history.length} velas`)
    logger.info(`📥 Inserindo ${history.length} velas históricas...`)

    const now     = Date.now()
    let inserted  = 0

    // Insere da mais antiga (índice last) para a mais recente (índice 0)
    for (let i = history.length - 1; i >= 0; i--) {
      const val        = history[i]
      const pos        = i  // posição 0 = mais recente
      const fakeTimeMs = now - pos * AVG_ROUND_DURATION_MS
      const fakeTime   = new Date(fakeTimeMs).toISOString()

      // rId único por timestamp estimado — garante unicidade para 1.00x repetidos
      const rId = `hist_${fakeTimeMs}_${val.toFixed(2)}`

      if (!candleService.isDuplicate(val, rId, fakeTime)) {
        const candle = candleService.addCandle(val, rId, fakeTime)
        await saveCandle(candle)
        inserted++
      }
    }

    lastKnownValue = history[0]
    lastWSEmitTime = Date.now()
    logger.info(`✅ Histórico sincronizado: ${inserted} velas inseridas`)
  } catch (err: any) {
    logger.error(`❌ Erro no Histórico: ${err.message}`)
  } finally {
    scrapeInProgress = false
  }
}

// ─── DOM Polling ──────────────────────────────────────────────────────────────
function startDOMPolling(frame: Frame) {
  if ((frame as any)._isDOMPolling) return
  ;(frame as any)._isDOMPolling = true

  setInterval(async () => {
    try {
      if (frame.isDetached()) return
      if (Date.now() - lastWSEmitTime < 12_000) return

      const top: number | null = await frame.evaluate(() => {
        const el = document.querySelector('.payouts-block .payout')
        return el
          ? (() => { const r = (el.textContent || '').replace('x','').trim(); return parseFloat(r.includes('.') ? r.replace(/,/g,'') : r.replace(',','.')); })()
          : null
      })

      if (top && top !== lastKnownValue) {
        // Bucket de 10s apenas para evitar múltiplos ticks do polling para o mesmo evento
        const rId = `dom_${top.toFixed(2)}_${Math.floor(Date.now() / 10_000)}`
        if (!candleService.isDuplicate(top, rId)) {
          emitCandle(top, rId)
        }
      }
    } catch {}
  }, 2000)
}

// ─── Parser de frames WS ─────────────────────────────────────────────────────
// Range real do Aviator: mín 1.00x, máx histórico real ~17.000x.
// Usamos 20.000 como teto conservador para não bloquear eventos raros legítimos.
// 33333x, 50000x etc são artefatos de IDs de usuário/timestamp sendo capturados
// pelo regex — o JSON parse + campo específico evita isso.
const MULT_MIN = 1.00
const MULT_MAX = 20_000

function tryParseCandle(buf: Buffer) {
  try {
    const str = buf.toString('utf8')

    // Tenta parsear como JSON primeiro — é o formato real do servidor Aviator
    // O payload tem estrutura: { "action": "finish", "data": { "crash": 1.23, "roundId": "..." } }
    // ou variações. Extraímos apenas de campos conhecidos, nunca de texto livre.
    let mult: number | null = null
    let rId:  string | null = null

    try {
      // Alguns frames são JSON puro
      const json = JSON.parse(str)
      const data = json?.data ?? json

      // Campos conhecidos onde o multiplicador de crash aparece
      const crashVal =
        data?.crash      ??
        data?.crashAt    ??
        data?.multiplier ??
        data?.coef       ??
        null

      if (crashVal !== null && crashVal !== undefined) {
        mult = parseFloat(String(crashVal))
      }

      // Campos conhecidos para o ID da rodada
      const ridVal =
        data?.roundId   ??
        data?.round_id  ??
        data?.id        ??
        json?.roundId   ??
        json?.round_id  ??
        null

      if (ridVal) rId = String(ridVal)
    } catch {
      // Não é JSON — tenta regex conservador como fallback
      // Exige que "crash" seja seguido de separador JSON (:, =, espaço) e número decimal
      const crashMatch = str.match(/["']?crash(?:At|ing)?["']?\s*[:=]\s*([0-9]{1,5}(?:\.[0-9]{1,2})?)/i)
      if (!crashMatch) return

      mult = parseFloat(crashMatch[1])

      const idMatch = str.match(/["']?(?:round_?id|roundId)["']?\s*[:=]\s*["']?([a-zA-Z0-9\-_]{4,36})["']?/i)
      if (idMatch) rId = idMatch[1]
    }

    if (mult === null || isNaN(mult) || mult < MULT_MIN || mult > MULT_MAX) {
      if (mult !== null) logger.warn(`⚠️  Multiplicador fora do range ignorado: ${mult}x`)
      return
    }

    const finalRId = rId ?? `ws_${Date.now()}`

    if (!global.HISTORY_SYNCED) {
      wsQueue.push({ mult, rId: finalRId })
    } else {
      emitCandle(mult, finalRId)
    }
  } catch {}
}

// ─── Emissão de vela ─────────────────────────────────────────────────────────
function emitCandle(mult: number, rId: string) {
  if (candleService.isDuplicate(mult, rId)) return
  lastKnownValue = mult
  lastWSEmitTime = Date.now()
  const candle   = candleService.addCandle(mult, rId)
  saveCandle(candle)
}

// ─── Reload do iframe ────────────────────────────────────────────────────────
async function forceReloadGameIframe(page: Page): Promise<Frame | null> {
  try {
    await page.evaluate(() => {
      const f = document.querySelector('iframe') as HTMLIFrameElement | null
      if (f) { const s = f.src; f.src = ''; f.src = s }
    })
    await page.waitForTimeout(8_000)
    return (
      page.frames().find(f => f.url().includes('aviator') || f.url().includes('p-j-0-h')) ?? null
    )
  } catch {
    return null
  }
}