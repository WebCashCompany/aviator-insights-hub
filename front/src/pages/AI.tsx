import { useState, useRef, useEffect } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { analyzeCandles, askAIAboutPatterns } from '@/services/aiService'
import { AIAnalysis } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Brain, Send, Sparkles, TrendingUp, AlertTriangle, ShieldCheck, ShieldAlert, Loader2, ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type ChatMessage = {
  id:      string
  role:    'user' | 'assistant'
  content: string
  ts:      string
}

function ConfidenceBar({ value }: { value: number }) {
  const pct   = Math.round(value * 100)
  const color = pct >= 70 ? 'bg-emerald-500' : pct >= 45 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Confiança</span>
        <span className="font-bold">{pct}%</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-700', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function SignalBadge({ strategy, risk }: { strategy: string; risk?: string }) {
  const config = {
    ENTRAR:   { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    AGUARDAR: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30',       icon: <ShieldAlert  className="w-3.5 h-3.5" /> },
    ABORTAR:  { cls: 'bg-red-500/15 text-red-400 border-red-500/30',             icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  }[strategy] ?? { cls: 'bg-muted text-muted-foreground border-border', icon: null }

  return (
    <div className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-bold uppercase', config.cls)}>
      {config.icon}
      {strategy}
      {risk && <span className="ml-1 opacity-60 text-xs font-medium normal-case">· Risco {risk}</span>}
    </div>
  )
}

function QuickPrompt({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-3 py-1.5 rounded-full border border-border hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 shrink-0"
    >
      <ChevronRight className="w-3 h-3 opacity-50" />
      {label}
    </button>
  )
}

export default function AIPage() {
  const { candles } = useCandles({ limit: 1000 })

  const [analysis,   setAnalysis]   = useState<AIAnalysis | null>(null)
  const [analyzing,  setAnalyzing]  = useState(false)
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null)

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput,    setChatInput]    = useState('')
  const [isTyping,     setIsTyping]     = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, isTyping])

  const handleAnalyze = async () => {
    if (candles.length < 10) {
      setAnalyzeErr('Aguarde pelo menos 10 velas para executar a análise.')
      return
    }
    setAnalyzing(true)
    setAnalyzeErr(null)
    try {
      const result = await analyzeCandles(candles)
      setAnalysis(result)
    } catch {
      setAnalyzeErr('Falha na conexão com a API. Verifique sua chave.')
    } finally {
      setAnalyzing(false)
    }
  }

  const sendChat = async (text: string) => {
    if (!text.trim() || isTyping) return
    setChatInput('')

    const userMsg: ChatMessage = {
      id:      crypto.randomUUID(),
      role:    'user',
      content: text,
      ts:      new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    }
    setChatMessages(prev => [...prev, userMsg])
    setIsTyping(true)

    const history = chatMessages.map(m => ({ role: m.role, content: m.content }))

    try {
      const aiText = await askAIAboutPatterns(text, candles, history)
      const aiMsg: ChatMessage = {
        id:      crypto.randomUUID(),
        role:    'assistant',
        content: aiText,
        ts:      new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      }
      setChatMessages(prev => [...prev, aiMsg])
    } catch {
      setChatMessages(prev => [...prev, {
        id:      crypto.randomUUID(),
        role:    'assistant',
        content: 'Erro ao processar sua pergunta. Tente novamente.',
        ts:      new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      }])
    } finally {
      setIsTyping(false)
    }
  }

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendChat(chatInput)
  }

  const QUICK_PROMPTS = [
    'Qual a chance de vir roxo agora?',
    'Devo usar gale neste momento?',
    'Existe vácuo de retenção?',
    'Quando parar de operar?',
  ]

  return (
    <div className="p-4 space-y-5 max-w-5xl mx-auto">

      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10">
            <Brain className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-none">AI Predictor</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Motor IA · {candles.length} velas</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-widest">Banca</p>
          <p className="text-lg font-mono font-bold text-primary">$500.00</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        <div className="glass-card p-5 flex flex-col items-center justify-center text-center space-y-3 border border-primary/20 bg-primary/5">
          <Sparkles className="w-10 h-10 text-primary" />
          <div>
            <h2 className="font-semibold text-sm">Motor de Probabilidade</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Analisa as últimas {Math.min(candles.length, 60)} velas
            </p>
          </div>
          <Button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="w-full font-bold h-11"
          >
            {analyzing
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />PROCESSANDO...</>
              : 'EXECUTAR ANÁLISE'
            }
          </Button>
          {analyzeErr && (
            <p className="text-xs text-destructive flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{analyzeErr}
            </p>
          )}
        </div>

        <div className="md:col-span-2">
          {analyzing ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full rounded-xl" />
              <div className="grid grid-cols-3 gap-3">
                <Skeleton className="h-16 rounded-xl" />
                <Skeleton className="h-16 rounded-xl" />
                <Skeleton className="h-16 rounded-xl" />
              </div>
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : analysis ? (
            <div className="animate-in fade-in slide-in-from-right-2 duration-500 space-y-3">

              <div className="glass-card p-4 border-l-4 border-primary bg-primary/5">
                <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-1.5">Resumo Operacional</p>
                <p className="text-sm leading-relaxed">{analysis.resumo}</p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="glass-card p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">Padrão</p>
                  <p className="text-xs font-semibold mt-1 leading-tight">{analysis.padrao}</p>
                </div>
                <div className="glass-card p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">Momento</p>
                  <p className="text-xs font-semibold mt-1 leading-tight">{analysis.melhorMomento}</p>
                </div>
                <div className="glass-card p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">Gestão</p>
                  <p className="text-xs font-semibold mt-1 leading-tight">{analysis.gestaoGale}</p>
                </div>
              </div>

              <div className="glass-card p-3 flex items-center justify-between gap-4">
                <SignalBadge strategy={analysis.estrategiaRecomendada} risk={analysis.nivelRisco} />
                <div className="flex-1">
                  <ConfidenceBar value={analysis.confianca} />
                </div>
              </div>

              {analysis.insights?.length > 0 && (
                <div className="glass-card p-3 space-y-1.5">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Insights</p>
                  {analysis.insights.map((ins, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="text-primary mt-0.5">›</span>
                      <span>{ins}</span>
                    </div>
                  ))}
                </div>
              )}

              {analysis.alertas?.filter(Boolean).length > 0 && (
                <div className="glass-card p-3 bg-destructive/5 border-destructive/20 space-y-1">
                  {analysis.alertas.filter(Boolean).map((alerta, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-destructive">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{alerta}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="glass-card h-full min-h-[200px] flex items-center justify-center">
              <div className="text-center space-y-2">
                <Brain className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">Execute a análise para gerar insights</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card flex flex-col" style={{ height: '460px' }}>

        <div className="p-3.5 border-b bg-muted/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-xs font-bold uppercase tracking-widest">Consultoria Estratégica</span>
          </div>
          <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/30 bg-emerald-500/10">
            IA Online
          </Badge>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-black/5">
          {chatMessages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
              <Sparkles className="w-8 h-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Pergunte sobre padrões, probabilidades ou estratégias</p>
              <div className="flex flex-wrap justify-center gap-2 mt-1">
                {QUICK_PROMPTS.map(p => (
                  <QuickPrompt key={p} label={p} onClick={() => sendChat(p)} />
                ))}
              </div>
            </div>
          )}

          {chatMessages.map(msg => (
            <div
              key={msg.id}
              className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {msg.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                  <Brain className="w-3.5 h-3.5 text-primary" />
                </div>
              )}
              <div className={cn(
                'max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-tr-sm'
                  : 'bg-muted/80 border rounded-tl-sm'
              )}>
                <p>{msg.content}</p>
                <p className={cn(
                  'text-[10px] mt-1',
                  msg.role === 'user' ? 'text-primary-foreground/60' : 'text-muted-foreground'
                )}>{msg.ts}</p>
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex items-center gap-2 text-xs text-primary">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Analisando o gráfico...</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {chatMessages.length > 0 && (
          <div className="px-4 py-2 border-t bg-muted/10 flex gap-2 overflow-x-auto scrollbar-none">
            {QUICK_PROMPTS.map(p => (
              <QuickPrompt key={p} label={p} onClick={() => sendChat(p)} />
            ))}
          </div>
        )}

        <form onSubmit={handleChatSubmit} className="p-3.5 border-t flex gap-2">
          <Input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            placeholder="Ex: Qual a chance de vir roxo agora?"
            className="flex-1 bg-background text-sm h-10"
            disabled={isTyping}
          />
          <Button type="submit" size="icon" disabled={isTyping} className="h-10 w-10 shrink-0">
            {isTyping
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Send className="w-4 h-4" />
            }
          </Button>
        </form>
      </div>
    </div>
  )
}