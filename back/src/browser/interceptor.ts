import { Page, Frame } from 'playwright'
import { logger } from '../utils/logger.js'
import { candleService } from '../services/candleService.js'
import { saveCandle } from '../services/supabaseService.js'

let GLOBAL_LAST_ROUND_ID = ''

// ─── CONTROLE DE INICIALIZAÇÃO ────────────────────────────────────────────────
let historyReady = false
const wsQueue: Array<{ mult: number; rId: string }> = []

let lastWSEmitTime = 0
let lastKnownValue: number | null = null

const DOM_FALLBACK_SILENCE_MS = 12_000

// ─── LIMITE MÁXIMO REALISTA DO AVIATOR ───────────────────────────────────────
const MAX_VALID_MULTIPLIER = 200

// ─── SET DE IDS JÁ SALVOS NO BANCO (evita duplo INSERT) ──────────────────────
// Inclui tanto round_ids reais quanto os gerados localmente.
const savedRoundIds = new Set<string>()

// ─── CANDLE PENDENTE (aguardando confirmação do DOM) ─────────────────────────
let _pendingWSCandle: {
  mult: number
  rId: string
  timer: ReturnType<typeof setTimeout>
} | null = null

function cancelPending(reason: string): void {
  if (_pendingWSCandle) {
    logger.warn(`🚫 Pendente cancelado (${reason}): ${_pendingWSCandle.mult.toFixed(2)}x`)
    clearTimeout(_pendingWSCandle.timer)
    _pendingWSCandle = null
  }
}

function flushWSQueue() {
  if (wsQueue.length === 0) return
  logger.info(`📬 Processando ${wsQueue.length} vela(s) enfileiradas do WS...`)
  for (const { mult, rId } of wsQueue) {
    emitCandle(mult, rId)
  }
  wsQueue.length = 0
}

export function getRawFrames() { return [] }
export function getDetectedWSUrls() { return [] }

// ─── VALIDAÇÃO CENTRAL DE MULTIPLICADOR ──────────────────────────────────────
function isValidMultiplier(val: number): boolean {
  if (!isFinite(val) || isNaN(val)) return false
  if (val < 1.00 || val > MAX_VALID_MULTIPLIER) return false
  const rounded = Math.round(val * 100) / 100
  if (Math.abs(rounded - val) > 0.0001) return false
  return true
}

export async function startInterception(page: Page): Promise<void> {
  logger.info('🔍 Iniciando interceptação Híbrida FINAL...')

  historyReady = false
  wsQueue.length = 0
  GLOBAL_LAST_ROUND_ID = ''
  lastWSEmitTime = 0
  lastKnownValue = null
  savedRoundIds.clear()
  cancelPending('reinício da interceptação')

  page.on('websocket', ws => {
    const url = ws.url()
    if (!url.includes('aviator') && !url.includes('p-j-0-h')) return

    logger.info(`🔌 WebSocket conectado: ${url}`)

    ws.on('framereceived', f => {
      const payload = Buffer.isBuffer(f.payload)
        ? f.payload
        : Buffer.from(f.payload as string, 'binary')
      tryParseCandle(payload)
    })

    ws.on('close', () => logger.info('🔌 WebSocket fechado'))
  })

  const frame = await forceReloadGameIframe(page)

  if (frame) {
    await scrapeHistory(frame)
    historyReady = true
    flushWSQueue()
    startDOMPolling(frame)
  }

  page.on('framenavigated', async (f) => {
    const url = f.url()
    if (!url.includes('p-j-0-h') && !url.includes('aviator')) return
    if ((f as any)._isDOMPolling) return
    logger.info('🔄 Navegação detectada, reativando DOM polling...')
    setTimeout(() => startDOMPolling(f), 2000)
  })

  logger.info('✅ Monitoramento total ativo!')
}

// ─── HISTÓRICO VISUAL ─────────────────────────────────────────────────────────
// IMPORTANTE: velas do histórico são apenas marcadas como emitidas localmente.
// NÃO são salvas no banco — evita duplicar com velas que chegarem pelo WS.

async function scrapeHistory(frame: Frame) {
  logger.info('📜 Sincronizando histórico visual da barra...')
  try {
    await frame.waitForTimeout(5000)
    const historyData = await frame.evaluate(() => {
      const selectors = '.payouts-block .payout, .stats-list .payout, .bubble-multiplier'
      const items = Array.from(document.querySelectorAll(selectors))
      return items.map((el, index) => {
        const text = el.textContent?.trim() || ''
        const val = parseFloat(text.replace('x', ''))
        return (!isNaN(val) && val > 0)
          ? { val, id: `hist_pos${index}_${val}` }
          : null
      }).filter(Boolean)
    })

    if (historyData.length > 0) {
      const cleanHistory = historyData
        .filter(item => isValidMultiplier(item!.val))
        .slice(0, 35)

      logger.info(`📦 Sucesso! ${cleanHistory.length} velas sincronizadas do histórico.`)

      for (const item of cleanHistory.reverse()) {
        // Apenas marca como emitido — NÃO salva no banco.
        // O banco já tem essas velas de sessões anteriores.
        // Registrar novamente causaria duplicatas.
        candleService.markEmitted(item!.val, item!.id)
        // Também registra o valor arredondado no set de salvos
        // para bloquear eventuais WS duplicados que cheguem logo após.
        savedRoundIds.add(`hist_${item!.val.toFixed(2)}`)
      }

      const newest = cleanHistory[cleanHistory.length - 1]
      if (newest) {
        lastKnownValue = newest.val
      }
    }
  } catch (err) {
    logger.warn(`⚠️ Erro no scrape do histórico: ${err}`)
  }
}

// ─── RELOAD DO IFRAME ─────────────────────────────────────────────────────────

async function forceReloadGameIframe(page: Page): Promise<Frame | null> {
  try {
    logger.info('🔄 Recarregando iframe do jogo...')
    await page.evaluate(() => {
      const gameIframe = Array.from(document.querySelectorAll('iframe')).find(f =>
        f.src && (f.src.includes('p-j-0-h') || f.src.includes('aviator'))
      ) as HTMLIFrameElement | undefined
      if (gameIframe) {
        const src = gameIframe.src
        gameIframe.src = ''
        setTimeout(() => { gameIframe.src = src }, 200)
      }
    })
    await page.waitForTimeout(7000)
    const frame = page.frames().find(f =>
      f.url().includes('p-j-0-h') || f.url().includes('aviator')
    ) || null
    if (frame) logger.info(`🎮 Frame encontrado: ${frame.url().slice(0, 80)}...`)
    return frame
  } catch (err) {
    logger.error(`❌ Erro no reload: ${err}`)
    return null
  }
}

// ─── DOM POLLING ──────────────────────────────────────────────────────────────

function startDOMPolling(frame: Frame): void {
  if ((frame as any)._isDOMPolling) return
  ;(frame as any)._isDOMPolling = true
  logger.info('✅ Captura ativa! Aguardando velas...')

  const interval = setInterval(async () => {
    try {
      if (frame.isDetached()) {
        clearInterval(interval)
        ;(frame as any)._isDOMPolling = false
        return
      }

      if ((Date.now() - lastWSEmitTime) <= DOM_FALLBACK_SILENCE_MS) return

      const topValue = await frame.evaluate(() => {
        const selectors = '.payouts-block .payout, .stats-list .payout, .bubble-multiplier'
        const first = document.querySelector(selectors)
        if (!first) return null
        const text = first.textContent?.trim() || ''
        const val = parseFloat(text.replace('x', ''))
        return (!isNaN(val) && val > 0) ? val : null
      })

      if (topValue === null || !isValidMultiplier(topValue)) return
      if (topValue === lastKnownValue) return

      if (_pendingWSCandle && _pendingWSCandle.mult !== topValue) {
        logger.warn(`⚠️  DOM contradiz WS pendente — cancelando ${_pendingWSCandle.mult.toFixed(2)}x, usando DOM: ${topValue.toFixed(2)}x`)
        cancelPending('DOM confirmou valor diferente')
      }

      const rId = `dom_fallback_${topValue.toFixed(2)}_${Date.now()}`

      if (!candleService.isDuplicate(topValue, rId)) {
        logger.warn(`⚠️  WS silencioso e valor novo no DOM — fallback: ${topValue.toFixed(2)}x`)
        candleService.markEmitted(topValue, rId)
        lastKnownValue = topValue
        lastWSEmitTime = Date.now()
        const candle = candleService.addCandle(topValue, rId)
        safeSaveCandle(candle, rId)
      } else {
        lastKnownValue = topValue
      }
    } catch (_) {
      clearInterval(interval)
      ;(frame as any)._isDOMPolling = false
    }
  }, 800)
}

// ─── SAFE SAVE: garante um único INSERT por round ─────────────────────────────

function safeSaveCandle(candle: any, rId: string): void {
  if (savedRoundIds.has(rId)) {
    logger.info(`⏭️  saveCandle ignorado (já salvo): ${rId}`)
    return
  }
  savedRoundIds.add(rId)
  saveCandle(candle)
}

// ─── PARSER WS ────────────────────────────────────────────────────────────────

function tryParseCandle(buf: Buffer): void {
  try {
    if (buf[0] === 0x7b || buf[0] === 0x5b) {
      try {
        const data = JSON.parse(buf.toString('utf8'))
        handleParsedJSON(Array.isArray(data) ? data[0] : data)
        return
      } catch (_) {}
    }

    const jsonStart = buf.indexOf(0x7b)
    if (jsonStart > 0 && jsonStart < buf.length - 2) {
      try {
        const data = JSON.parse(buf.slice(jsonStart).toString('utf8'))
        handleParsedJSON(data)
        return
      } catch (_) {}
    }

    const str = buf.toString('utf8')
    const crashMatch = str.match(/crash[^0-9]*([0-9]+\.?[0-9]*)/i)
    if (crashMatch) {
      const mult = parseFloat(crashMatch[1])
      if (isValidMultiplier(mult)) {
        const idMatch = str.match(/(?:round_id|roundId)[^a-zA-Z0-9]*([a-zA-Z0-9\-_]{4,20})/i)
        enqueueOrEmit(mult, idMatch?.[1] || `ws_${Date.now()}`)
        return
      }
    }

    // ─── PARSING BINÁRIO ─────────────────────────────────────────────────────
    for (const marker of ['crash', 'maxMultiplier']) {
      const idx = buf.indexOf(marker, 0, 'utf8')
      if (idx === -1) continue
      for (let offset = 0; offset <= 8; offset++) {
        const pos = idx + marker.length + offset
        if (pos + 8 > buf.length) break
        try {
          const valBE = buf.readDoubleBE(pos)
          const valLE = buf.readDoubleLE(pos)

          if (!isValidMultiplier(valBE)) continue

          if (isValidMultiplier(valLE) && Math.abs(valBE - valLE) > 0.01) {
            logger.warn(`🚫 WS binário descartado (ambiguidade BE/LE): BE=${valBE} LE=${valLE}`)
            continue
          }

          if (isValidMultiplier(valLE) && valBE !== valLE) {
            logger.warn(`🚫 WS binário descartado (BE≠LE válidos): BE=${valBE} LE=${valLE}`)
            continue
          }

          const idIdx = buf.indexOf('round_id', 0, 'utf8')
          let rId = `ws_${Date.now()}`
          if (idIdx !== -1) {
            rId = buf.slice(idIdx + 8, idIdx + 24).toString('utf8')
              .replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 12)
          }
          enqueueOrEmit(Number(valBE.toFixed(2)), rId)
          return
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function handleParsedJSON(data: any): void {
  if (!data || typeof data !== 'object') return
  if (data.type === 'f' || data.type === 'stage' || data.type === 'ping') return

  const mult =
    data.crash ??
    data.multiplier ??
    data.crash_multiplier ??
    data.data?.multiplier ??
    data.data?.crash ??
    null

  const rId =
    data.round_id ??
    data.id ??
    data.data?.round_id ??
    data.data?.id ??
    null

  if (mult === null) return

  const multNum = Number(mult)

  if (!isValidMultiplier(multNum)) {
    logger.warn(`🚫 JSON descartado (valor inválido ou acima de ${MAX_VALID_MULTIPLIER}x): ${multNum}`)
    return
  }

  const resolvedRId = rId !== null ? String(rId) : `ws_json_${Date.now()}`
  enqueueOrEmit(Number(multNum.toFixed(2)), resolvedRId)
}

// ─── ENQUEUE OR EMIT ──────────────────────────────────────────────────────────

function enqueueOrEmit(mult: number, rId: string): void {
  if (!historyReady) {
    const jaNaFila = wsQueue.some(q => q.rId === rId || (q.mult === mult && rId.startsWith('ws_')))
    if (!jaNaFila) {
      logger.info(`📥 WS enfileirado (histórico pendente): ${mult.toFixed(2)}x`)
      wsQueue.push({ mult, rId })
    }
    return
  }

  const isGeneratedId = rId.startsWith('ws_') || rId.startsWith('ws_json_')

  if (isGeneratedId) {
    if (_pendingWSCandle) {
      logger.warn(`🚫 Burst: novo frame sem round_id chegou, cancelando pendente ${_pendingWSCandle.mult.toFixed(2)}x`)
      cancelPending('novo burst sem round_id')
    }

    const timer = setTimeout(() => {
      _pendingWSCandle = null
      emitCandle(mult, rId)
    }, 1000)

    _pendingWSCandle = { mult, rId, timer }
    logger.info(`⏳ WS pendente (aguardando confirmação 1s): ${mult.toFixed(2)}x`)
    return
  }

  // Round_id real do servidor → emite imediatamente
  if (_pendingWSCandle) {
    cancelPending('round_id real do servidor')
  }

  emitCandle(mult, rId)
}

// ─── EMIT CANDLE ─────────────────────────────────────────────────────────────

function emitCandle(mult: number, rId: string): void {
  if (rId === GLOBAL_LAST_ROUND_ID) return

  lastKnownValue = mult
  lastWSEmitTime = Date.now()

  if (candleService.isDuplicate(mult, rId)) {
    logger.info(`⏭️  WS ignorado (duplicado): ${mult.toFixed(2)}x (Round: ${rId})`)
    return
  }

  GLOBAL_LAST_ROUND_ID = rId
  candleService.markEmitted(mult, rId)

  logger.info(`🕯️  Nova vela (WS): ${mult.toFixed(2)}x (Round: ${rId})`)
  const candle = candleService.addCandle(mult, rId)
  safeSaveCandle(candle, rId)
}