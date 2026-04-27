import { Candle, AIAnalysis } from '@/types';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_ANALYSIS = 'gemini-2.5-flash';
const MODEL_CHAT     = 'gemini-2.5-flash';

if (!API_KEY) {
  console.error('[aiService] VITE_GEMINI_API_KEY não configurada no .env');
}

async function callGemini(model: string, body: object): Promise<string> {
  const res = await fetch(`${BASE}/${model}:generateContent?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function buildCandleStats(candles: Candle[]) {
  const reversed = [...candles].reverse();
  const last60 = reversed.slice(0, 60);
  const last20 = reversed.slice(0, 20);
  const last10 = reversed.slice(0, 10);

  const count = (arr: Candle[], fn: (c: Candle) => boolean) => arr.filter(fn).length;
  const pct   = (n: number, total: number) => total ? ((n / total) * 100).toFixed(1) : '0';
  const avg   = (arr: Candle[]) =>
    arr.length ? (arr.reduce((s, c) => s + c.multiplicador, 0) / arr.length).toFixed(2) : '0';

  const azul60 = count(last60, c => c.cor === 'blue');
  const roxo60 = count(last60, c => c.cor === 'purple');
  const rosa60 = count(last60, c => c.cor === 'pink');
  const azul20 = count(last20, c => c.cor === 'blue');
  const maxMult = Math.max(...last60.map(c => c.multiplicador));
  const minMult = Math.min(...last60.map(c => c.multiplicador));

  let streak = 0;
  const streakCor = last10[0]?.cor;
  for (const c of last10) {
    if (c.cor === streakCor) streak++;
    else break;
  }

  let maxAzulStreak = 0;
  let currentAzul   = 0;
  for (const c of last60) {
    if (c.cor === 'blue') { currentAzul++; maxAzulStreak = Math.max(maxAzulStreak, currentAzul); }
    else currentAzul = 0;
  }

  return {
    j60: {
      total: last60.length,
      azul:  { n: azul60, p: pct(azul60, last60.length) },
      roxo:  { n: roxo60, p: pct(roxo60, last60.length) },
      rosa:  { n: rosa60, p: pct(rosa60, last60.length) },
      avg:   avg(last60),
    },
    j20: { azulN: azul20, azulP: pct(azul20, last20.length), avg: avg(last20) },
    u10: last10.map(c => `${c.multiplicador}x`).join(','),
    ultimaVela: last10[0] ? `${last10[0].multiplicador}x (${last10[0].cor})` : 'N/A',
    streak: { cor: streakCor, n: streak },
    maxAzulStreak,
    max: maxMult.toFixed(2),
    min: minMult.toFixed(2),
  };
}

function cleanJSON(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();
}

export async function analyzeCandles(candles: Candle[]): Promise<AIAnalysis> {
  if (candles.length < 10) {
    return buildErrorAnalysis('Dados insuficientes. Aguarde pelo menos 10 velas.');
  }

  const stats  = buildCandleStats(candles);
  const prompt = `Você é um analista de Aviator Crash Game. Responda APENAS com um objeto JSON válido e completo, sem markdown, sem texto antes ou depois.

Dados: ${JSON.stringify(stats)}

Retorne EXATAMENTE este JSON preenchido (todos os campos obrigatórios):
{"resumo":"...","padrao":"...","estrategiaRecomendada":"ENTRAR","confianca":0.0,"nivelRisco":"BAIXO","melhorMomento":"...","gestaoGale":"Sem gale","insights":["...","...","..."],"alertas":["..."]}`;

  try {
    const text = await callGemini(MODEL_ANALYSIS, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return JSON.parse(cleanJSON(text)) as AIAnalysis;
  } catch (error) {
    console.error('[aiService] Erro na análise:', error);
    return buildErrorAnalysis('Falha ao processar análise. Verifique a chave VITE_GEMINI_API_KEY.');
  }
}

export async function askAIAboutPatterns(
  question: string,
  candles: Candle[],
  history: { role: string; content: string }[] = [],
): Promise<string> {
  const stats   = buildCandleStats(candles);

  const systemMsg = `Você é um consultor especialista em Aviator Crash Game. Regras obrigatórias:
- Responda em texto simples, SEM markdown, SEM asteriscos, SEM negrito
- Seja direto e específico com os números reais abaixo
- Máximo 3 frases curtas
- Nunca use expressões genéricas como "considerável" ou "sugerem"
- Sempre cite os números exatos dos dados fornecidos
- Estratégia máxima: 1 entrada + 1 martingale, se perder os dois PARE

Dados atuais:
- Últimas 10 velas: ${stats.u10}
- Última vela: ${stats.ultimaVela}
- Streak atual: ${stats.streak.n} velas ${stats.streak.cor} seguidas
- Últimas 60 velas: ${stats.j60.azul.p}% azuis (${stats.j60.azul.n}), ${stats.j60.roxo.p}% roxas (${stats.j60.roxo.n}), ${stats.j60.rosa.p}% rosas (${stats.j60.rosa.n})
- Últimas 20 velas: ${stats.j20.azulP}% azuis (${stats.j20.azulN})
- Média multiplicador 60v: ${stats.j60.avg}x | Média 20v: ${stats.j20.avg}x
- Maior sequência azul: ${stats.maxAzulStreak}
- Máximo: ${stats.max}x | Mínimo: ${stats.min}x`;

  const contents = [
    { role: 'user',  parts: [{ text: systemMsg }] },
    { role: 'model', parts: [{ text: 'Entendido. Vou responder com dados precisos e sem markdown.' }] },
    ...history.slice(-6).map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: question }] },
  ];

  try {
    const text = await callGemini(MODEL_CHAT, {
      contents,
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 2000,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return text.trim();
  } catch (error) {
    console.error('[aiService] Erro no chat:', error);
    return 'Erro ao processar sua pergunta. Verifique a conexão e a chave da API.';
  }
}

function buildErrorAnalysis(mensagem: string): AIAnalysis {
  return {
    resumo:                mensagem,
    padrao:                'Erro',
    estrategiaRecomendada: 'AGUARDAR',
    confianca:             0,
    nivelRisco:            'ALTO',
    melhorMomento:         'Indisponível',
    gestaoGale:            'Sem gale',
    insights:              ['Verifique o arquivo .env', 'Confirme a chave VITE_GEMINI_API_KEY'],
    alertas:               [mensagem],
  };
}