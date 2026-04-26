import { GoogleGenerativeAI, GenerativeModel, ChatSession } from "@google/generative-ai";
import { Candle, AIAnalysis } from '@/types';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';

if (!API_KEY) {
  console.error('[aiService] VITE_GEMINI_API_KEY não configurada no .env');
}

const genAI = new GoogleGenerativeAI(API_KEY);

function getAnalysisModel(): GenerativeModel {
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 8192,
    },
    systemInstruction: `
      Você é um analista de Aviator Crash Game.
      Regras: Alvo 1.99x. Azul < 1.99x. Roxo 1.99x-9.99x. Rosa >= 10x.
      Entrada R$5, Gale máximo R$10. Máximo 1 martingale.
      Responda APENAS JSON válido, sem markdown.
    `.trim(),
  });
}

function getChatModel(): GenerativeModel {
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.6,
      topP: 0.9,
      maxOutputTokens: 1024,
    },
    systemInstruction: `
      Assistente estratégico de Aviator Crash Game.
      Responda direto, conciso, em português.
      Máximo 1 entrada + 1 martingale. Se perder os dois, PARAR.
      Máximo 3 parágrafos curtos.
    `.trim(),
  });
}

function buildCandleStats(candles: Candle[]) {
  // Velas chegam antiga→recente. Invertemos para ter recente→antiga
  const reversed = [...candles].reverse()

  const last60 = reversed.slice(0, 60)
  const last20 = reversed.slice(0, 20)
  const last10 = reversed.slice(0, 10)

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
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();
}

export async function analyzeCandles(candles: Candle[]): Promise<AIAnalysis> {
  if (candles.length < 10) {
    return buildErrorAnalysis('Dados insuficientes. Aguarde pelo menos 10 velas.');
  }

  const stats = buildCandleStats(candles);
  const model = getAnalysisModel();

  const prompt = `Dados: ${JSON.stringify(stats)}

Retorne este JSON exato:
{"resumo":"...","padrao":"...","estrategiaRecomendada":"ENTRAR ou AGUARDAR ou ABORTAR","confianca":0.0,"nivelRisco":"BAIXO ou MEDIO ou ALTO","melhorMomento":"...","gestaoGale":"Sem gale ou Ate 1 gale","insights":["...","...","..."],"alertas":["..."]}`;

  try {
    const result = await model.generateContent(prompt);
    const text   = cleanJSON(result.response.text());
    const parsed = JSON.parse(text) as AIAnalysis;
    return parsed;
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
  const model = getChatModel();
  const stats = buildCandleStats(candles);

  const context = `Última vela: ${stats.ultimaVela} | Sequência recente: ${stats.u10} | 60v: ${stats.j60.azul.p}% azuis ${stats.j60.roxo.p}% roxas ${stats.j60.rosa.p}% rosas | Média: ${stats.j60.avg}x | Streak atual: ${stats.streak.n}x ${stats.streak.cor}`;

  const chatHistory = history.slice(-6).map(msg => ({
    role: (msg.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
    parts: [{ text: msg.content }],
  }));

  try {
    const chat: ChatSession = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(`${context}\n\nPergunta: ${question}`);
    return result.response.text().trim();
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