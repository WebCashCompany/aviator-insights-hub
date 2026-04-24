// src/server/api.ts
import express from 'express'
import { candleService } from '../services/candleService.js'
import { getRawFrames } from '../browser/interceptor.js'
import { getStatus } from '../index.js'
import {
  alertStrategySignal,
  alertMarketPaying,
  alertWarning,
  alertConfirmed,
  alertGale,
  alertResult,
  testConnection,
  isConfigured,
  setSavedTargets,
  getSavedTargets,
  startConnection,
  disconnect,
  getConnState,
  getQrBase64,
  getGroups,
  getContacts,
} from '../services/whatsappService.js'

const router = express.Router()

interface BotConfig {
  enabled:         boolean
  selectedStratId: string | null
}

let botConfig: BotConfig = {
  enabled:         false,
  selectedStratId: null,
}

// ── Candles ────────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => res.json(getStatus()))

router.get('/candles', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000)
  const candles = candleService.getCandles(limit)
  res.json({ candles, total: candles.length })
})

router.get('/candles/stats', (_req, res) => res.json(candleService.getStats()))
router.get('/candles/last',  (_req, res) => res.json(candleService.getLastCandle()))

router.post('/candles/manual', (req, res) => {
  const { multiplicador } = req.body
  if (!multiplicador || isNaN(multiplicador)) {
    res.status(400).json({ error: 'Multiplicador inválido' }); return
  }
  res.json(candleService.addCandle(parseFloat(multiplicador), `manual_${Date.now()}`))
})

router.delete('/candles', (_req, res) => {
  candleService.clear()
  res.json({ message: 'Buffer limpo' })
})

router.get('/debug/frames', (req, res) => {
  res.json(getRawFrames().slice(0, parseInt(req.query.limit as string) || 20))
})

// ── Bot Config ─────────────────────────────────────────────────────────────────

router.get('/bot/config', (_req, res) => {
  res.json(botConfig)
})

router.post('/bot/config', (req, res) => {
  const { enabled, selectedStratId } = req.body
  if (enabled         !== undefined) botConfig.enabled         = Boolean(enabled)
  if (selectedStratId !== undefined) botConfig.selectedStratId = selectedStratId ?? null
  res.json({ ok: true, config: botConfig })
})

// ── WhatsApp — config & sinal ──────────────────────────────────────────────────

router.get('/whatsapp/status', (_req, res) => {
  res.json({
    configured: isConfigured(),
    provider:   'baileys',
    targets:    getSavedTargets(),
  })
})

router.post('/whatsapp/test', async (_req, res) => {
  const result = await testConnection()
  result.ok
    ? res.json({ ok: true, message: 'Mensagem de teste enviada com sucesso!' })
    : res.status(400).json({ ok: false, error: result.error })
})

router.post('/whatsapp/signal', async (req, res) => {
  const { strategyName, signalMsg, targets } = req.body
  if (!strategyName || !signalMsg) {
    res.status(400).json({ error: 'strategyName e signalMsg são obrigatórios' }); return
  }
  if (!isConfigured()) {
    res.status(503).json({ error: 'WhatsApp não conectado' }); return
  }
  try {
    await alertStrategySignal(strategyName, signalMsg, targets)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── WhatsApp — Targets ────────────────────────────────────────────────────────

router.get('/whatsapp/targets', (_req, res) => {
  res.json({ targets: getSavedTargets() })
})

router.post('/whatsapp/targets', (req, res) => {
  const { targets } = req.body
  if (!Array.isArray(targets)) {
    res.status(400).json({ error: 'targets deve ser um array' }); return
  }
  setSavedTargets(targets)
  res.json({ ok: true, count: targets.length })
})

// ── WhatsApp — Instância & QR (Baileys) ───────────────────────────────────────

router.get('/whatsapp/instance/state', (_req, res) => {
  res.json({ state: getConnState() })
})

router.post('/whatsapp/instance/connect', async (_req, res) => {
  const current = getConnState()

  if (current === 'open') {
    res.json({ state: 'open', qr: null }); return
  }
  if (current === 'connecting') {
    res.json({ state: 'connecting', qr: getQrBase64() }); return
  }

  startConnection().catch(() => {})

  let waited = 0
  while (waited < 8000) {
    await new Promise(r => setTimeout(r, 300))
    waited += 300
    const s = getConnState()
    if (s === 'open')  { res.json({ state: 'open', qr: null }); return }
    if (getQrBase64()) { res.json({ state: 'connecting', qr: getQrBase64() }); return }
  }

  res.json({ state: getConnState(), qr: getQrBase64() })
})

router.post('/whatsapp/instance/disconnect', async (_req, res) => {
  try {
    await disconnect()
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── WhatsApp — Grupos & Contatos ───────────────────────────────────────────────

router.get('/whatsapp/groups', (_req, res) => {
  res.json({ groups: getGroups() })
})

router.get('/whatsapp/contacts', (_req, res) => {
  res.json({ contacts: getContacts() })
})

// ── WhatsApp — Alertas de Mercado & Trade ─────────────────────────────────────

router.post('/whatsapp/market-paying', async (req, res) => {
  const { targets } = req.body
  if (!isConfigured()) { res.status(503).json({ error: 'WhatsApp não conectado' }); return }
  try {
    await alertMarketPaying(targets)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.post('/whatsapp/warning', async (req, res) => {
  const { strategyName, targets } = req.body
  if (!strategyName) { res.status(400).json({ error: 'strategyName obrigatório' }); return }
  if (!isConfigured()) { res.status(503).json({ error: 'WhatsApp não conectado' }); return }
  try {
    await alertWarning(strategyName, targets)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.post('/whatsapp/confirmed', async (req, res) => {
  const { strategyName, targets } = req.body
  if (!strategyName) { res.status(400).json({ error: 'strategyName obrigatório' }); return }
  if (!isConfigured()) { res.status(503).json({ error: 'WhatsApp não conectado' }); return }
  try {
    await alertConfirmed(strategyName, targets)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.post('/whatsapp/gale', async (req, res) => {
  const { strategyName, targets } = req.body
  if (!strategyName) { res.status(400).json({ error: 'strategyName obrigatório' }); return }
  if (!isConfigured()) { res.status(503).json({ error: 'WhatsApp não conectado' }); return }
  try {
    await alertGale(strategyName, targets)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.post('/whatsapp/result', async (req, res) => {
  const { strategyName, result, multiplier, targets, score } = req.body
  if (!strategyName || !result || multiplier === undefined) {
    res.status(400).json({ error: 'strategyName, result e multiplier são obrigatórios' }); return
  }
  if (!isConfigured()) { res.status(503).json({ error: 'WhatsApp não conectado' }); return }
  try {
    await alertResult(strategyName, result, multiplier, targets, score ?? undefined)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router