import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { Navigate, Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function AnimatedBg() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const ctx = cv.getContext('2d')!
    let W = 0, H = 0, af = 0
    const resize = () => {
      W = window.innerWidth; H = window.innerHeight
      cv.width = W; cv.height = H
    }
    resize()
    window.addEventListener('resize', resize)
    const orbs = [
      { x: W*.15, y: H*.2,  r: 260, vx: .18,  vy: .12,  h: 210, a: .12 },
      { x: W*.82, y: H*.7,  r: 320, vx: -.14, vy: -.09, h: 220, a: .09 },
      { x: W*.5,  y: H*.95, r: 220, vx: .1,   vy: -.15, h: 230, a: .07 },
      { x: W*.9,  y: H*.08, r: 200, vx: -.12, vy: .18,  h: 215, a: .08 },
    ]
    const pts = Array.from({ length: 70 }, () => ({
      x: Math.random()*W, y: Math.random()*H,
      vx: (Math.random()-.5)*.4, vy: (Math.random()-.5)*.4,
      r: .7 + Math.random()*1.5, a: .08 + Math.random()*.38
    }))
    const draw = (t: number) => {
      ctx.clearRect(0,0,W,H)
      ctx.fillStyle = '#07090f'; ctx.fillRect(0,0,W,H)
      orbs.forEach(o => {
        o.x += o.vx; o.y += o.vy
        if (o.x < -o.r) o.x = W+o.r; if (o.x > W+o.r) o.x = -o.r
        if (o.y < -o.r) o.y = H+o.r; if (o.y > H+o.r) o.y = -o.r
        const g = ctx.createRadialGradient(o.x,o.y,0,o.x,o.y,o.r)
        g.addColorStop(0, `hsla(${o.h},75%,52%,${o.a})`)
        g.addColorStop(1, `hsla(${o.h},75%,30%,0)`)
        ctx.beginPath(); ctx.arc(o.x,o.y,o.r,0,Math.PI*2)
        ctx.fillStyle = g; ctx.fill()
      })
      const ga = .038 + Math.sin(t*.0005)*.012
      ctx.fillStyle = `rgba(147,197,253,${ga})`
      for (let gx=0; gx<W; gx+=52) for (let gy=0; gy<H; gy+=52) {
        ctx.beginPath(); ctx.arc(gx,gy,1,0,Math.PI*2); ctx.fill()
      }
      pts.forEach(p => {
        p.x += p.vx; p.y += p.vy
        if (p.x<0) p.x=W; if (p.x>W) p.x=0
        if (p.y<0) p.y=H; if (p.y>H) p.y=0
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2)
        ctx.fillStyle = `rgba(190,210,255,${p.a})`; ctx.fill()
      })
      const sx = ((t*.03) % (W+H)) - H
      const sg = ctx.createLinearGradient(sx,0,sx+H,H)
      sg.addColorStop(0,'rgba(66,153,225,0)')
      sg.addColorStop(.5,'rgba(66,153,225,0.03)')
      sg.addColorStop(1,'rgba(66,153,225,0)')
      ctx.fillStyle = sg; ctx.fillRect(0,0,W,H)
      af = requestAnimationFrame(draw)
    }
    af = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(af); window.removeEventListener('resize', resize) }
  }, [])
  return <canvas ref={ref} style={{ position:'fixed', inset:0, width:'100%', height:'100%', zIndex:0 }} />
}

export default function RegisterPage() {
  const { user, signUp, loading: authLoading } = useAuth()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)
  const [visible, setVisible]   = useState(false)

  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t) }, [])

  if (authLoading) return null
  if (user) return <Navigate to="/dashboard" replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    if (password !== confirm) { setError('As senhas não coincidem'); return }
    if (password.length < 6)  { setError('Senha deve ter no mínimo 6 caracteres'); return }
    setLoading(true)
    const { error } = await signUp(email, password)
    if (error) setError(error.message)
    else setSuccess(true)
    setLoading(false)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&family=Outfit:wght@400;600;700&display=swap');
        .lp-scene { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem; position:relative; z-index:1; background:#07090f; }
        .lp-card {
          width:100%; max-width:400px; position:relative; z-index:2;
          background:rgba(255,255,255,0.032); border:1px solid rgba(255,255,255,0.08);
          border-radius:24px; padding:44px 40px 38px; backdrop-filter:blur(40px) saturate(150%);
          opacity:0; transform:translateY(22px) scale(0.98);
          transition:opacity .65s cubic-bezier(.22,1,.36,1), transform .65s cubic-bezier(.22,1,.36,1);
        }
        .lp-card.in { opacity:1; transform:translateY(0) scale(1); }
        .lp-card::before { content:''; position:absolute; inset:0; border-radius:24px; pointer-events:none; background:linear-gradient(145deg,rgba(255,255,255,0.06) 0%,transparent 55%); }
        .lp-top-line { position:absolute; top:0; left:48px; right:48px; height:1px; border-radius:1px; background:linear-gradient(90deg,transparent,rgba(99,179,237,.55),transparent); }

        .lp-logo { display:flex; flex-direction:column; align-items:center; gap:13px; margin-bottom:28px; }
        .lp-logo-ring { width:86px; height:86px; position:relative; display:flex; align-items:center; justify-content:center; }
        .lp-logo-ring::before { content:''; position:absolute; inset:-12px; border-radius:50%; background:radial-gradient(circle,rgba(66,153,225,.26) 0%,transparent 70%); animation:lglow 3.2s ease-in-out infinite; }
        @keyframes lglow { 0%,100%{opacity:.5;transform:scale(.93)} 50%{opacity:1;transform:scale(1.07)} }
        .lp-logo img { width:86px; height:86px; object-fit:contain; border-radius:20px; position:relative; z-index:1; }
        .lp-name { font-family:'Outfit',sans-serif; font-size:21px; font-weight:700; color:#fff; letter-spacing:-.3px; }
        .lp-tagline { font-family:'Inter',sans-serif; font-size:12px; font-weight:300; color:rgba(160,174,192,.65); letter-spacing:.4px; }

        .lp-sep { height:1px; background:rgba(255,255,255,0.06); margin-bottom:24px; }

        .lp-fields { display:flex; flex-direction:column; gap:12px; margin-bottom:10px; }
        .lp-field { position:relative; }
        .lp-field input {
          width:100%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.09);
          border-radius:12px; color:#e2e8f0; font-family:'Inter',sans-serif; font-size:14px; font-weight:400;
          padding:14px 16px; outline:none;
          transition:border-color .2s, background .2s, box-shadow .2s;
        }
        .lp-field input::placeholder { color:rgba(160,174,192,.38); }
        .lp-field input:focus { border-color:rgba(66,153,225,.6); background:rgba(66,153,225,.05); box-shadow:0 0 0 3px rgba(66,153,225,.11); }
        .lp-field input.err { border-color:rgba(245,101,101,.5); background:rgba(245,101,101,.04); }

        .lp-hint { font-family:'Inter',sans-serif; font-size:11.5px; color:rgba(113,128,150,.55); padding:0 2px; margin-top:-4px; }

        .lp-error { font-family:'Inter',sans-serif; font-size:13px; color:#fc8181; background:rgba(245,101,101,.08); border:1px solid rgba(245,101,101,.18); border-radius:10px; padding:10px 14px; margin-bottom:8px; display:flex; align-items:center; gap:8px; }
        .lp-error-dot { width:6px; height:6px; background:#fc8181; border-radius:50%; flex-shrink:0; }

        .lp-btn {
          width:100%; background:linear-gradient(135deg,#3182ce,#2b6cb0);
          border:none; border-radius:12px; color:#fff; font-family:'Outfit',sans-serif;
          font-size:14px; font-weight:600; letter-spacing:.3px; padding:15px;
          cursor:pointer; transition:transform .18s, box-shadow .18s, filter .18s;
          margin-top:6px; position:relative; overflow:hidden;
        }
        .lp-btn::after { content:''; position:absolute; inset:0; background:linear-gradient(135deg,rgba(255,255,255,.1),transparent); pointer-events:none; }
        .lp-btn:not(:disabled):hover { transform:translateY(-1px); box-shadow:0 14px 36px rgba(49,130,206,.4); filter:brightness(1.08); }
        .lp-btn:not(:disabled):active { transform:translateY(0); }
        .lp-btn:disabled { opacity:.55; cursor:not-allowed; }

        .lp-footer { text-align:center; margin-top:20px; font-family:'Inter',sans-serif; font-size:12.5px; color:rgba(113,128,150,.65); }
        .lp-footer a { color:rgba(99,179,237,.8); text-decoration:none; transition:color .2s; }
        .lp-footer a:hover { color:#90cdf4; }

        .lp-secure { text-align:center; margin-top:18px; font-family:'Inter',sans-serif; font-size:10.5px; color:rgba(74,85,104,.55); letter-spacing:.8px; text-transform:uppercase; display:flex; align-items:center; justify-content:center; gap:6px; }
        .lp-secure-dot { width:5px; height:5px; background:rgba(72,187,120,.5); border-radius:50%; flex-shrink:0; }

        /* ── Success state ── */
        .lp-success { display:flex; flex-direction:column; align-items:center; gap:18px; text-align:center; }
        .lp-success-icon { width:64px; height:64px; border-radius:50%; background:rgba(72,187,120,0.1); border:1px solid rgba(72,187,120,0.25); display:flex; align-items:center; justify-content:center; animation:popIn .5s cubic-bezier(.34,1.56,.64,1) forwards; }
        @keyframes popIn { from{opacity:0;transform:scale(.6)} to{opacity:1;transform:scale(1)} }
        .lp-success-icon svg { width:28px; height:28px; }
        .lp-success-title { font-family:'Outfit',sans-serif; font-size:18px; font-weight:700; color:#fff; }
        .lp-success-msg { font-family:'Inter',sans-serif; font-size:13.5px; font-weight:300; color:rgba(160,174,192,.75); line-height:1.6; max-width:280px; }
        .lp-success-email { font-family:'Inter',sans-serif; font-size:13px; font-weight:500; color:rgba(99,179,237,.9); word-break:break-all; }
        .lp-btn-outline { width:100%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.12); border-radius:12px; color:rgba(226,232,240,.85); font-family:'Outfit',sans-serif; font-size:14px; font-weight:600; letter-spacing:.3px; padding:14px; cursor:pointer; transition:transform .18s, background .18s, border-color .18s; text-decoration:none; display:block; text-align:center; margin-top:4px; }
        .lp-btn-outline:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.2); transform:translateY(-1px); }
      `}</style>

      <AnimatedBg />

      <div className="lp-scene">
        <div className={`lp-card${visible ? ' in' : ''}`}>
          <div className="lp-top-line" />

          <div className="lp-logo">
            <div className="lp-logo-ring">
              <img src="/CrashVision.png" alt="CrashVision" />
            </div>
            <div className="lp-tagline">
              {success ? 'Cadastro concluído' : 'Crie sua conta'}
            </div>
          </div>

          <div className="lp-sep" />

          {success ? (
            <div className="lp-success">
              <div className="lp-success-icon">
                <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 14.5L11 20.5L23 8" stroke="rgba(72,187,120,0.9)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="lp-success-title">Conta criada!</div>
              <div className="lp-success-msg">
                Enviamos um email de confirmação para
              </div>
              <div className="lp-success-email">{email}</div>
              <div className="lp-success-msg" style={{ marginTop: '-6px' }}>
                Verifique sua caixa de entrada para ativar o acesso.
              </div>
              <Link to="/login" className="lp-btn-outline">
                Ir para o login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="lp-fields">
                <div className="lp-field">
                  <Input
                    type="email"
                    placeholder="seu@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    className="lp-field"
                  />
                </div>
                <div className="lp-field">
                  <Input
                    type="password"
                    placeholder="Senha"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    className={`lp-field${error && password.length < 6 ? ' err' : ''}`}
                  />
                </div>
                <div className="lp-field">
                  <Input
                    type="password"
                    placeholder="Confirmar senha"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    required
                    className={`lp-field${error && password !== confirm ? ' err' : ''}`}
                  />
                </div>
                <p className="lp-hint">Mínimo de 6 caracteres</p>
              </div>

              {error && (
                <p className="lp-error">
                  <span className="lp-error-dot" />
                  {error}
                </p>
              )}

              <Button type="submit" disabled={loading} className="lp-btn">
                {loading ? 'Criando conta...' : 'Criar conta'}
              </Button>

              <p className="lp-footer" style={{ marginTop: '18px' }}>
                Já tem conta?{' '}
                <Link to="/login">Fazer login</Link>
              </p>
            </form>
          )}

          <div className="lp-secure">
            <div className="lp-secure-dot" />
            Conexão segura e criptografada
          </div>
        </div>
      </div>
    </>
  )
}