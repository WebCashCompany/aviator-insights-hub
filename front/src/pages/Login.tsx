import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { Navigate, Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function LoginPage() {
  const { user, signIn, loading: authLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t) }, [])

  if (authLoading) return null
  if (user) return <Navigate to="/dashboard" replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&family=Outfit:wght@400;600;700&display=swap');

        .lp-scene {
          min-height:100vh; display:flex; align-items:center; justify-content:center;
          padding:1.5rem; position:relative; z-index:1; overflow:hidden;
        }

        .lp-video-wrap {
          position:fixed; inset:0; z-index:0; overflow:hidden;
        }
        .lp-video-wrap video {
          width:100%; height:100%; object-fit:cover; display:block;
        }
        .lp-video-wrap::after {
          content:''; position:absolute; inset:0;
          background:rgba(4,6,12,0.62);
        }

        .lp-card {
          width:100%; max-width:400px; position:relative; z-index:2;
          background:rgba(255,255,255,0.033);
          border:1px solid rgba(255,255,255,0.08);
          border-radius:24px; padding:44px 40px 38px;
          backdrop-filter:blur(40px) saturate(150%);
          opacity:0; transform:translateY(22px) scale(0.98);
          transition:opacity .65s cubic-bezier(.22,1,.36,1), transform .65s cubic-bezier(.22,1,.36,1);
        }
        .lp-card.in { opacity:1; transform:translateY(0) scale(1); }
        .lp-card::before {
          content:''; position:absolute; inset:0; border-radius:24px; pointer-events:none;
          background:linear-gradient(145deg,rgba(255,255,255,0.065) 0%,transparent 55%);
        }
        .lp-top-line {
          position:absolute; top:0; left:48px; right:48px; height:1px; border-radius:1px;
          background:linear-gradient(90deg,transparent,rgba(99,179,237,0.55),transparent);
        }

        .lp-logo { display:flex; flex-direction:column; align-items:center; gap:13px; margin-bottom:30px; }
        .lp-logo-ring {
          width:82px; height:82px; position:relative; display:flex; align-items:center; justify-content:center;
        }
        .lp-logo-ring::before {
          content:''; position:absolute; inset:-10px; border-radius:50%;
          background:radial-gradient(circle,rgba(66,153,225,0.28) 0%,transparent 68%);
          animation:lglow 3.2s ease-in-out infinite;
        }
        @keyframes lglow { 0%,100%{opacity:.5;transform:scale(.94)} 50%{opacity:1;transform:scale(1.06)} }
        .lp-logo img { width:82px; height:82px; object-fit:contain; border-radius:20px; position:relative; z-index:1; }
        .lp-tagline { font-family:'Inter',sans-serif; font-size:12px; font-weight:300; color:rgba(160,174,192,.65); letter-spacing:.4px; }

        .lp-sep { height:1px; background:rgba(255,255,255,0.06); margin-bottom:26px; }

        .lp-fields { display:flex; flex-direction:column; gap:13px; margin-bottom:12px; }
        .lp-field { position:relative; }
        .lp-field input {
          width:100%; background:rgba(255,255,255,0.038); border:1px solid rgba(255,255,255,0.09);
          border-radius:12px; color:#e2e8f0; font-family:'Inter',sans-serif; font-size:14px; font-weight:400;
          padding:14px 16px; outline:none;
          transition:border-color .2s, background .2s, box-shadow .2s;
        }
        .lp-field input::placeholder { color:rgba(160,174,192,.4); }
        .lp-field input:focus {
          border-color:rgba(66,153,225,.6); background:rgba(66,153,225,.05);
          box-shadow:0 0 0 3px rgba(66,153,225,.11);
        }

        .lp-error { font-family:'Inter',sans-serif; font-size:13px; color:#fc8181; background:rgba(245,101,101,.08); border:1px solid rgba(245,101,101,.18); border-radius:10px; padding:10px 14px; margin-bottom:8px; }

        .lp-btn {
          width:100%; background:linear-gradient(135deg,#3182ce 0%,#2b6cb0 100%);
          border:none; border-radius:12px; color:#fff; font-family:'Outfit',sans-serif;
          font-size:14px; font-weight:600; letter-spacing:.3px; padding:15px;
          cursor:pointer; transition:transform .18s, box-shadow .18s, filter .18s;
          margin-top:6px; position:relative; overflow:hidden;
        }
        .lp-btn:not(:disabled):hover { transform:translateY(-1px); box-shadow:0 14px 36px rgba(49,130,206,.38); filter:brightness(1.08); }
        .lp-btn:not(:disabled):active { transform:translateY(0); }
        .lp-btn::after { content:''; position:absolute; inset:0; background:linear-gradient(135deg,rgba(255,255,255,.1),transparent); pointer-events:none; }
        .lp-btn:disabled { opacity:.55; cursor:not-allowed; }

        .lp-links { text-align:center; margin-top:22px; display:flex; flex-direction:column; gap:9px; }
        .lp-link { font-family:'Inter',sans-serif; font-size:13px; color:rgba(99,179,237,.8); text-decoration:none; transition:color .2s; }
        .lp-link:hover { color:#90cdf4; }
        .lp-link-muted { font-family:'Inter',sans-serif; font-size:12.5px; color:rgba(113,128,150,.65); }
        .lp-link-muted a { color:rgba(99,179,237,.75); text-decoration:none; transition:color .2s; }
        .lp-link-muted a:hover { color:#90cdf4; }

        .lp-secure { text-align:center; margin-top:18px; font-family:'Inter',sans-serif; font-size:10.5px; color:rgba(74,85,104,.55); letter-spacing:.8px; text-transform:uppercase; display:flex; align-items:center; justify-content:center; gap:6px; }
        .lp-secure-dot { width:5px; height:5px; background:rgba(72,187,120,.5); border-radius:50%; flex-shrink:0; }
      `}</style>

      {/* ── Vídeo background ── */}
      <div className="lp-video-wrap">
        <video
          src="/CrashVision.mp4"
          autoPlay
          loop
          muted
          playsInline
        />
      </div>

      <div className="lp-scene">
        <div className={`lp-card${visible ? ' in' : ''}`}>
          <div className="lp-top-line" />

          <div className="lp-logo">
            <div className="lp-logo-ring">
              <img src="/CrashVision.png" alt="CrashVision" />
            </div>
            <div className="lp-tagline">Faça login para continuar</div>
          </div>

          <div className="lp-sep" />

          <form onSubmit={handleSubmit}>
            <div className="lp-fields">
              <div className="lp-field">
                <Input type="email" placeholder="seu@email.com" value={email}
                  onChange={e => setEmail(e.target.value)} required className="lp-field" />
              </div>
              <div className="lp-field">
                <Input type="password" placeholder="Senha" value={password}
                  onChange={e => setPassword(e.target.value)} required className="lp-field" />
              </div>
            </div>

            {error && <p className="lp-error">{error}</p>}

            <Button type="submit" disabled={loading} className="lp-btn">
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>

          <div className="lp-links">
            <Link to="/forgot-password" className="lp-link">Esqueci minha senha</Link>
            <p className="lp-link-muted">
              Não tem conta?{' '}
              <Link to="/register">Criar conta</Link>
            </p>
          </div>

          <div className="lp-secure">
            <div className="lp-secure-dot" />
            Conexão segura e criptografada
          </div>
        </div>
      </div>
    </>
  )
}