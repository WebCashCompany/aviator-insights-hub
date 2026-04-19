/**
 * WppModal.tsx — adaptado para Baileys (sem Evolution API)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  X, MessageCircle, RefreshCw, WifiOff,
  Users, User, Check, Search, Loader2,
} from 'lucide-react'

const API = import.meta.env.VITE_BOT_API_URL || 'http://localhost:3001/api/v1'

// Header necessário para o ngrok não bloquear as requisições
const NGROK_HEADERS: HeadersInit = API.includes('ngrok')
  ? { 'ngrok-skip-browser-warning': 'true' }
  : {}

function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...NGROK_HEADERS,
      ...(options.headers ?? {}),
    },
  })
}

const C = {
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
  purple: 'hsl(263,70%,58%)',
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

type ConnState = 'unknown' | 'connecting' | 'open' | 'close' | 'error'
type Step      = 'loading' | 'qr' | 'connected' | 'error'
type Tab       = 'groups' | 'contacts'

interface WaTarget {
  id:    string
  name:  string
  type:  'group' | 'contact'
  size?: number
}

interface Props {
  onClose:         () => void
  onTargetsChange: (targets: string[]) => void
  initialTargets:  string[]
}

// ── WppModal ──────────────────────────────────────────────────────────────────

export default function WppModal({ onClose, onTargetsChange, initialTargets }: Props) {
  const [step,      setStep]      = useState<Step>('loading')
  const [connState, setConnState] = useState<ConnState>('unknown')
  const [qrBase64,  setQrBase64]  = useState<string | null>(null)
  const [qrExpired, setQrExpired] = useState(false)
  const [groups,    setGroups]    = useState<WaTarget[]>([])
  const [contacts,  setContacts]  = useState<WaTarget[]>([])
  const [selected,  setSelected]  = useState<Set<string>>(new Set(initialTargets))
  const [search,    setSearch]    = useState('')
  const [tab,       setTab]       = useState<Tab>('groups')
  const [saving,    setSaving]    = useState(false)
  const [saveMsg,   setSaveMsg]   = useState<string | null>(null)

  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const qrTimer  = useRef<ReturnType<typeof setTimeout>  | null>(null)

  // ── Verifica estado ──────────────────────────────────────────────────────────
  const checkState = useCallback(async (): Promise<ConnState> => {
    try {
      const r = await apiFetch(`${API}/whatsapp/instance/state`)
      const d = await r.json()
      const s = (d.state ?? 'close') as ConnState
      setConnState(s)
      return s
    } catch {
      setConnState('error')
      return 'error'
    }
  }, [])

  // ── Carrega grupos/contatos ──────────────────────────────────────────────────
  const loadTargets = useCallback(async () => {
    try {
      const [gRes, cRes] = await Promise.all([
        apiFetch(`${API}/whatsapp/groups`),
        apiFetch(`${API}/whatsapp/contacts`),
      ])
      const gData = await gRes.json()
      const cData = await cRes.json()

      setGroups(   (gData.groups   ?? []).map((g: any) => ({ ...g, type: 'group'   as const })))
      setContacts( (cData.contacts ?? []).map((c: any) => ({ ...c, type: 'contact' as const })))
    } catch { /* lista vazia */ }
  }, [])

  // ── Inicia conexão / obtém QR via Baileys ────────────────────────────────────
  const startConnect = useCallback(async () => {
    setStep('loading')
    setQrBase64(null)
    setQrExpired(false)
    clearInterval(pollRef.current!)
    clearTimeout(qrTimer.current!)

    try {
      const r = await apiFetch(`${API}/whatsapp/instance/connect`, { method: 'POST' })
      const d = await r.json()

      if (d.state === 'open') {
        setStep('connected')
        setConnState('open')
        await loadTargets()
        return
      }

      if (d.qr) {
        setQrBase64(d.qr)
        setStep('qr')
        setConnState('connecting')
        qrTimer.current = setTimeout(() => setQrExpired(true), 60_000)
      } else {
        setStep('qr')
        setConnState('connecting')
        qrTimer.current = setTimeout(() => setQrExpired(true), 60_000)
      }

      pollRef.current = setInterval(async () => {
        const stateNow = await checkState()

        if (stateNow === 'open') {
          clearInterval(pollRef.current!)
          clearTimeout(qrTimer.current!)
          setStep('connected')
          setConnState('open')
          await loadTargets()
          return
        }

        if (stateNow === 'connecting' && !qrBase64) {
          try {
            const qrRes  = await apiFetch(`${API}/whatsapp/instance/connect`, { method: 'POST' })
            const qrData = await qrRes.json()
            if (qrData.qr) {
              setQrBase64(qrData.qr)
              setStep('qr')
            }
          } catch { /* ignorar */ }
        }
      }, 3_000)

    } catch {
      setStep('error')
      setConnState('error')
    }
  }, [checkState, loadTargets, qrBase64])

  // ── Desconectar ──────────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
    clearInterval(pollRef.current!)
    clearTimeout(qrTimer.current!)
    await apiFetch(`${API}/whatsapp/instance/disconnect`, { method: 'POST' }).catch(() => {})
    setGroups([])
    setContacts([])
    setConnState('close')
    await startConnect()
  }, [startConnect])

  // ── Init ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    checkState().then(s => {
      if (s === 'open') {
        setStep('connected')
        loadTargets()
      } else {
        startConnect()
      }
    })
    return () => {
      clearInterval(pollRef.current!)
      clearTimeout(qrTimer.current!)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Toggle seleção ───────────────────────────────────────────────────────────
  function toggleTarget(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Salvar ───────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    setSaveMsg(null)
    const targets = Array.from(selected)
    try {
      await apiFetch(`${API}/whatsapp/targets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ targets }),
      })
      onTargetsChange(targets)
      setSaveMsg('Salvo!')
      setTimeout(onClose, 700)
    } catch {
      setSaveMsg('Erro ao salvar')
    } finally {
      setSaving(false)
    }
  }

  // ── Lista filtrada ───────────────────────────────────────────────────────────
  const list: WaTarget[] = (tab === 'groups' ? groups : contacts).filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase())
  )

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(0,0,0,0.80)', backdropFilter: 'blur(8px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative w-full sm:max-w-md flex flex-col overflow-hidden"
        style={{
          background:   'hsl(235,16%,10%)',
          borderRadius: 'clamp(0px, 2vw, 24px) clamp(0px, 2vw, 24px) 0 0',
          maxHeight:    '92vh',
          boxShadow:    '0 -8px 60px rgba(0,0,0,0.5)',
          border:       '1px solid rgba(255,255,255,0.08)',
          borderBottom: 'none',
        }}
      >
        {/* Handle mobile */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.07]">
          <div
            className="h-9 w-9 rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: connState === 'open' ? C.green + '20' : 'rgba(255,255,255,0.06)' }}
          >
            <MessageCircle
              className="h-4.5 w-4.5"
              style={{ color: connState === 'open' ? C.green : 'rgba(255,255,255,0.35)', width: 18, height: 18 }}
            />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white/90 leading-tight">WhatsApp</p>
            <p className="text-[11px] leading-tight mt-0.5" style={{
              color: connState === 'open'
                ? C.green
                : connState === 'connecting'
                ? C.amber
                : 'rgba(255,255,255,0.3)',
            }}>
              {connState === 'open'         ? '● Conectado (Baileys)'
               : connState === 'connecting' ? '● Aguardando leitura do QR...'
               : connState === 'error'      ? '● Erro de conexão'
               :                             '● Desconectado'}
            </p>
          </div>

          {connState === 'open' && (
            <button
              onClick={handleDisconnect}
              className="text-[11px] px-3 py-1.5 rounded-xl border border-white/10 text-white/35 hover:text-white/60 hover:bg-white/5 transition-colors"
            >
              Desconectar
            </button>
          )}

          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-white/8 transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <X className="h-4 w-4 text-white/40" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Loader2 className="h-8 w-8 text-white/20 animate-spin" />
              <p className="text-sm text-white/25">Iniciando conexão Baileys...</p>
            </div>
          )}

          {step === 'qr' && (
            <div className="flex flex-col items-center py-8 px-6 gap-5">
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-white/70">Escaneie o QR Code</p>
                <p className="text-[12px] text-white/35 leading-relaxed">
                  WhatsApp → <strong className="text-white/55">Dispositivos Conectados</strong> → <strong className="text-white/55">Conectar Dispositivo</strong>
                </p>
              </div>

              <div
                className="relative rounded-3xl overflow-hidden p-4"
                style={{ background: '#fff', boxShadow: '0 0 0 1px rgba(255,255,255,0.1)' }}
              >
                {qrBase64 && !qrExpired ? (
                  <img src={qrBase64} alt="QR Code" className="w-52 h-52 object-contain" />
                ) : (
                  <div className="w-52 h-52 flex flex-col items-center justify-center gap-3">
                    <RefreshCw className="h-10 w-10 text-gray-300" />
                    <p className="text-sm text-gray-400 font-medium">
                      {qrBase64 ? 'QR expirado' : 'Gerando QR...'}
                    </p>
                  </div>
                )}

                {qrExpired && (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                    style={{ background: 'rgba(255,255,255,0.92)' }}
                  >
                    <RefreshCw className="h-10 w-10 text-gray-400" />
                    <p className="text-sm text-gray-500 font-medium">QR expirado</p>
                  </div>
                )}
              </div>

              <button
                onClick={startConnect}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-medium border border-white/10 text-white/45 hover:bg-white/5 hover:text-white/70 transition-all"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {qrExpired ? 'Gerar novo QR Code' : 'Atualizar QR Code'}
              </button>

              {!qrExpired && (
                <div className="flex items-center gap-2 text-[11px] text-white/25">
                  <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: C.amber }} />
                  Aguardando leitura...
                </div>
              )}
            </div>
          )}

          {step === 'connected' && (
            <>
              <div className="flex gap-0 border-b border-white/[0.07] px-4 pt-1">
                {(['groups', 'contacts'] as Tab[]).map(t => (
                  <button
                    key={t}
                    onClick={() => { setTab(t); setSearch('') }}
                    className="flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-all"
                    style={{
                      borderColor: tab === t ? C.green : 'transparent',
                      color:       tab === t ? C.green : 'rgba(255,255,255,0.35)',
                    }}
                  >
                    {t === 'groups'
                      ? <><Users className="h-3.5 w-3.5" /> Grupos <span className="ml-1 opacity-50">({groups.length})</span></>
                      : <><User  className="h-3.5 w-3.5" /> Contatos <span className="ml-1 opacity-50">({contacts.length})</span></>
                    }
                  </button>
                ))}
              </div>

              <div className="px-4 py-3">
                <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/10 bg-white/[0.04] focus-within:border-white/20 transition-colors">
                  <Search className="h-3.5 w-3.5 text-white/20 shrink-0" />
                  <input
                    type="text"
                    placeholder={tab === 'groups' ? 'Buscar grupo...' : 'Buscar contato...'}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-xs text-white placeholder:text-white/20 focus:outline-none"
                  />
                </label>
              </div>

              <div className="px-4 pb-3 space-y-1.5">
                {list.length === 0 && (
                  <div className="flex flex-col items-center py-10 gap-2 text-white/15">
                    {tab === 'groups' ? <Users className="h-10 w-10" /> : <User className="h-10 w-10" />}
                    <p className="text-xs">
                      {tab === 'groups' ? 'Nenhum grupo encontrado' : 'Nenhum contato disponível'}
                    </p>
                    {tab === 'contacts' && (
                      <p className="text-[10px] text-white/10 text-center px-6">
                        Contatos são carregados conforme mensagens chegam ao bot
                      </p>
                    )}
                  </div>
                )}

                {list.map(t => {
                  const isSel = selected.has(t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleTarget(t.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl border text-left transition-all active:scale-[0.99]"
                      style={{
                        borderColor: isSel ? C.green + '45' : 'rgba(255,255,255,0.06)',
                        background:  isSel ? C.green + '0d' : 'rgba(255,255,255,0.02)',
                      }}
                    >
                      <div
                        className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold"
                        style={{
                          background: isSel ? C.green + '25' : 'rgba(255,255,255,0.07)',
                          color:      isSel ? C.green         : 'rgba(255,255,255,0.35)',
                        }}
                      >
                        {t.name.charAt(0).toUpperCase()}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-white/85 truncate">{t.name}</p>
                        <p className="text-[10px] text-white/25">
                          {t.type === 'group'
                            ? t.size ? `${t.size} participantes` : 'Grupo'
                            : 'Contato'}
                        </p>
                      </div>

                      <div
                        className="flex items-center justify-center rounded-md border transition-all shrink-0"
                        style={{
                          width:       18,
                          height:      18,
                          borderColor: isSel ? C.green : 'rgba(255,255,255,0.18)',
                          background:  isSel ? C.green : 'transparent',
                        }}
                      >
                        {isSel && <Check className="h-3 w-3 text-black" strokeWidth={3} />}
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {step === 'error' && (
            <div className="flex flex-col items-center py-14 gap-4 px-6">
              <div className="h-16 w-16 rounded-3xl flex items-center justify-center" style={{ background: C.red + '15' }}>
                <WifiOff className="h-8 w-8" style={{ color: C.red + '90' }} />
              </div>
              <div className="text-center space-y-1.5">
                <p className="text-sm font-medium text-white/60">Erro ao iniciar conexão</p>
                <p className="text-[12px] text-white/25 leading-relaxed">
                  Verifique se o servidor backend está rodando e se a pasta de sessão tem permissão de escrita.
                </p>
              </div>
              <button
                onClick={startConnect}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-medium border border-white/10 text-white/45 hover:bg-white/5 hover:text-white/70 transition-all"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Tentar novamente
              </button>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        {step === 'connected' && (
          <div
            className="flex items-center justify-between gap-3 px-5 py-4 border-t border-white/[0.07]"
            style={{ background: 'rgba(0,0,0,0.2)' }}
          >
            <p className="text-[11px] text-white/30">
              {selected.size > 0
                ? `${selected.size} destino${selected.size > 1 ? 's' : ''} selecionado${selected.size > 1 ? 's' : ''}`
                : 'Selecione ao menos um destino'}
            </p>
            <button
              onClick={handleSave}
              disabled={saving || selected.size === 0}
              className="flex items-center gap-2 px-5 py-2 rounded-2xl text-xs font-semibold transition-all active:scale-95 disabled:opacity-35"
              style={{ background: C.green, color: '#000' }}
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Check   className="h-3.5 w-3.5" strokeWidth={3} />
              }
              {saveMsg ?? 'Salvar destinos'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}