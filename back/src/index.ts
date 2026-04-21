// index.ts — COMPLETO
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import cron from 'node-cron'
import { logger } from './utils/logger.js'
import { launchBrowser, closeBrowser } from './browser/launcher.js'
import { login } from './browser/login.js'
import { navigateToAviator } from './browser/navigator.js'
import { startInterception } from './browser/interceptor.js'
import { setupWebSocket } from './server/websocket.js'
import { candleService } from './services/candleService.js'
import { initBotUser, resetSaveState, clearCandles } from './services/supabaseService.js'
import { ServerStatus } from './types/index.js'
import apiRouter from './server/api.js'
import fs from 'fs'

if (!fs.existsSync('logs')) fs.mkdirSync('logs')

const app    = express()
const server = createServer(app)
let serverStarted = false

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',
    'https://aviatorpro.vercel.app',
    'https://gory-survivor-entourage.ngrok-free.dev',
  ],
}))

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true')
  next()
})

app.use(express.json())
app.use('/api/v1', apiRouter)

let status: ServerStatus = {
  connected:      false,
  loggedIn:       false,
  gameOpen:       false,
  totalCaptured:  0,
  lastCandle:     null,
  uptime:         0,
  lastError:      null,
}

const startTime = Date.now()

export function getStatus(): ServerStatus {
  return {
    ...status,
    totalCaptured: candleService.getTotalCaptured(),
    lastCandle:    candleService.getLastCandle(),
    uptime:        Math.floor((Date.now() - startTime) / 1000),
  }
}

async function initialize() {
  try {
    logger.info('='.repeat(50))
    logger.info('🛩️  AVIATOR CAPTURE SERVER iniciando...')
    logger.info('='.repeat(50))

    if (!serverStarted) {
      const port = process.env.PORT || 3001
      server.listen(port, () => {
        logger.info(`🌐 API rodando em http://localhost:${port}`)
        logger.info(`🔌 WebSocket em ws://localhost:${port}`)
      })
      setupWebSocket(server)
      serverStarted = true
    }

    await initBotUser()
    await startCapture()

    // Watchdog: reinicia se ficar sem velas por mais de 5 minutos
    cron.schedule('*/2 * * * *', async () => {
      const lastCandle = candleService.getLastCandle()
      if (lastCandle) {
        const minutos = (Date.now() - new Date(lastCandle.timestamp).getTime()) / 1000 / 60
        if (minutos > 5) {
          logger.warn(`⚠️  Sem velas há ${minutos.toFixed(1)} minutos — reiniciando captura...`)
          status.lastError = `Sem velas há ${minutos.toFixed(1)} min`
          await restartCapture()
        }
      }
    })
  } catch (err) {
    logger.error(`Erro fatal na inicialização: ${err}`)
    logger.warn('🔄 Tentando reiniciar em 15 segundos...')
    setTimeout(() => startCapture(), 15_000)
  }
}

async function startCapture() {
  try {
    status.connected = false
    status.loggedIn  = false
    status.gameOpen  = false

    const page = await launchBrowser()
    status.connected = true

    const loggedIn = await login(page)
    if (!loggedIn) throw new Error('Login falhou')
    status.loggedIn = true

    await navigateToAviator(page)
    status.gameOpen = true

    await startInterception(page)

    status.lastError = null
    logger.info('✅ Captura ativa! Aguardando velas...')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    status.lastError = msg
    logger.error(`Erro na captura: ${msg}`)
    throw err
  }
}

async function restartCapture() {
  try {
    await closeBrowser()
    await new Promise(r => setTimeout(r, 5_000))

    // Reseta tudo antes de reiniciar:
    // 1. Estado de inserção do supabase (insertedRodadaIds)
    // 2. Buffer local de velas
    // 3. Banco limpo — evita duplicatas entre sessões
    resetSaveState()
    candleService.clear()
    await clearCandles()

    await startCapture()
  } catch (err) {
    logger.error(`Erro ao reiniciar: ${err}`)
    setTimeout(restartCapture, 30_000)
  }
}

process.on('SIGINT', async () => {
  logger.info('🛑 Encerrando servidor...')
  await closeBrowser()
  process.exit(0)
})

initialize()