import { Page, Frame } from 'playwright'
import { logger } from '../utils/logger.js'
import { candleService } from '../services/candleService.js'
import { saveCandle } from '../services/supabaseService.js'

let GLOBAL_LAST_ROUND_ID = ''
let historyLocked = false // TRAVA GLOBAL: Histórico só roda uma vez por boot
const wsQueue: Array<{ mult: number; rId: string }> = []
let lastWSEmitTime = 0
let lastKnownValue: number | null = null

export async function startInterception(page: Page): Promise<void> {
  logger.info('🚀 Iniciando Interceptação v6 (Anti-Loop)...')
  
  await candleService.initialize()

  // Evita que navegações de frame dupliquem os listeners
  page.removeAllListeners('websocket')

  page.on('websocket', ws => {
    if (!ws.url().includes('aviator') && !ws.url().includes('p-j-0-h')) return
    ws.on('framereceived', f => {
      const payload = Buffer.isBuffer(f.payload) ? f.payload : Buffer.from(f.payload as string, 'binary')
      tryParseCandle(payload)
    })
  })

  const frame = await forceReloadGameIframe(page)
  if (frame) {
    // Sincroniza histórico apenas se ainda não foi feito nesta sessão
    if (!historyLocked) {
      await scrapeHistory(frame)
      historyLocked = true
    }
    
    // Esvazia fila do WS que chegou durante o loading
    while(wsQueue.length > 0) {
      const item = wsQueue.shift()
      if (item) emitCandle(item.mult, item.rId)
    }

    startDOMPolling(frame)
  }
}

async function scrapeHistory(frame: Frame) {
  logger.info('📜 Analisando histórico da barra superior...')
  try {
    await frame.waitForTimeout(5000)
    const history = await frame.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('.payouts-block .payout'))
      return elements.map(el => parseFloat(el.textContent?.replace('x', '').replace(',', '.') || '0')).filter(v => v > 0)
    })

    if (history.length === 0) return

    // Checa se essa sequência de histórico já foi processada (assinatura digital)
    if (candleService.isSequenceDuplicate(history)) {
      logger.warn('⚠️ Sequência de histórico já conhecida. Pulando scrape redundante.')
      return
    }

    // Processa do mais antigo para o mais novo
    for (let i = history.length - 1; i >= 0; i--) {
      const val = history[i]
      // ID Gerado de forma a ser IGUAL se o bot reiniciar (Valor + Posição fixa no histórico)
      const rId = `hist_${val.toFixed(2)}_${history.length - i}`
      
      if (!candleService.isDuplicate(val, rId)) {
        // Espaçamento de 1 minuto para cada vela do histórico para não encavalar o gráfico
        const fakeTime = new Date(Date.now() - (i * 60000)).toISOString()
        const candle = candleService.addCandle(val, rId, fakeTime)
        await saveCandle(candle)
      }
    }

    lastKnownValue = history[0]
    lastWSEmitTime = Date.now()
  } catch (err) {
    logger.error(`❌ Erro no Histórico: ${err.message}`)
  }
}

function startDOMPolling(frame: Frame): void {
  if ((frame as any)._isDOMPolling) return
  ;(frame as any)._isDOMPolling = true

  setInterval(async () => {
    try {
      if (frame.isDetached()) return
      // Se o WS está ativo, o DOM polling fica em standby (evita double-fire)
      if ((Date.now() - lastWSEmitTime) < 10000) return

      const top = await frame.evaluate(() => {
        const el = document.querySelector('.payouts-block .payout')
        return el ? parseFloat(el.textContent?.replace('x', '').replace(',', '.') || '0') : null
      })

      if (top && top !== lastKnownValue) {
        const rId = `dom_${top.toFixed(2)}_${Date.now()}`
        emitCandle(top, rId)
      }
    } catch {}
  }, 2000)
}

function tryParseCandle(buf: Buffer): void {
  try {
    const str = buf.toString('utf8')
    const crashMatch = str.match(/crash[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i)
    if (crashMatch) {
      const mult = parseFloat(crashMatch[1])
      const idMatch = str.match(/(?:round_id|roundId)[^a-zA-Z0-9]*([a-zA-Z0-9\-_]{4,20})/i)
      const rId = idMatch ? idMatch[1] : `ws_${Date.now()}`
      
      if (!historyLocked) {
        wsQueue.push({ mult, rId })
      } else {
        emitCandle(mult, rId)
      }
    }
  } catch {}
}

function emitCandle(mult: number, rId: string) {
  if (rId === GLOBAL_LAST_ROUND_ID || candleService.isDuplicate(mult, rId)) return
  
  GLOBAL_LAST_ROUND_ID = rId
  lastKnownValue = mult
  lastWSEmitTime = Date.now()

  const candle = candleService.addCandle(mult, rId)
  saveCandle(candle)
}

async function forceReloadGameIframe(page: Page) {
  await page.evaluate(() => {
    const f = document.querySelector('iframe')
    if (f) { const s = f.src; f.src = ''; f.src = s }
  })
  await page.waitForTimeout(8000)
  return page.frames().find(f => f.url().includes('aviator') || f.url().includes('p-j-0-h'))
}