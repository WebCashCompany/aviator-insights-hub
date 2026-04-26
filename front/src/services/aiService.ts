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
      maxOutputTokens: 2048,
    },
    systemInstruction: `
      Você é um analista especializado em Aviator Crash Game.
      Sua função é identificar padrões estatísticos nas velas (multiplicadores) e
      fornecer recomendações operacionais baseadas em probabilidade.
      
      Regras do sistema:
      - Alvo padrão: 1.99x
      - Azul  = multiplicador < 1.99x (perdeu o alvo)
      - Roxo  = multiplicador entre 1.99x e 9.99x
      - Rosa  = multiplicador >= 10x
      - Entrada base: R$5 | Gale 1: R$10 (MÁXIMO — sem Gale 2)
      - Gestão: máximo 1 entrada + 1 martingale. Se perder os dois, PARAR.
      
      Sempre responda APENAS com JSON válido, sem markdown, sem comentários.
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
      Você é um assistente estratégico especialista em Aviator Crash Game.
      Responda de forma direta, concisa e em português.
      Foque em análise probabilística e gestão de banca.
      Gestão: máximo 1 entrada + 1 martingale. Se perder os dois, PARAR.
      Máximo 3 parágrafos curtos por resposta.
    `.trim(),
  });
}

function buildCandleStats(candles: Candle[]) {
  const last60  = candles.slice(0, 60);
  const last20  = candles.slice(0, 20);
  const last10  = candles.slice(0, 10);

  const count  = (arr: Candle[], fn: (c: Candle) => boolean) => arr.filter(fn).length;
  const pct    = (n: number, total: number) => total ? ((n / total) * 100).toFixed(1) : '0';
  const avg    = (arr: Candle[]) =>
    arr.length ? (arr.reduce((s, c) => s + c.multiplicador, 0) / arr.length).toFixed(2) : '0';

  const azul60  = count(last60,  c => c.cor === 'blue');
  const roxo60  = count(last60,  c => c.cor === 'purple');
  const rosa60  = count(last60,  c => c.cor === 'pink');
  const azul20  = count(last20,  c => c.cor === 'blue');
  const maxMult = Math.max(...candles.slice(0, 100).map(c => c.multiplicador));
  const minMult = Math.min(...candles.slice(0, 100).map(c => c.multiplicador));

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
    janela60: {
      total: last60.length,
      azul:  { count: azul60,  pct: pct(azul60,  last60.length) },
      roxo:  { count: roxo60,  pct: pct(roxo60,  last60.length) },
      rosa:  { count: rosa60,  pct: pct(rosa60,  last60.length) },
      media: avg(last60),
    },
    janela20: {
      azul: { count: azul20, pct: pct(azul20, last20.length) },
      media: avg(last20),
    },
    ultimas10: last10.map(c => ({ mult: c.multiplicador, cor: c.cor })),
    streakAtual:     { cor: streakCor, quantidade: streak },
    maiorStreakAzul: maxAzulStreak,
    extremos:        { max: maxMult.toFixed(2), min: minMult.toFixed(2) },
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

  const stats  = buildCandleStats(candles);
  const model  = getAnalysisModel();

  const prompt = `
Analise os dados das velas do Aviator abaixo e retorne uma análise completa.

DADOS ESTATÍSTICOS:
${JSON.stringify(stats, null, 2)}

RETORNE EXATAMENTE este JSON (sem campos extras, sem markdown):
{
  "resumo": "<resumo operacional em 2-3 frases, mencione o % de azuis e tendência>",
  "padrao": "<nome do padrão identificado, ex: 'Vácuo de Azuis', 'Saturação Roxa', 'Neutro'>",
  "estrategiaRecomendada": "<ENTRAR | AGUARDAR | ABORTAR>",
  "confianca": <número entre 0.0 e 1.0>,
  "nivelRisco": "<BAIXO | MÉDIO | ALTO>",
  "melhorMomento": "<descrição de quando entrar, ex: 'Após próxima azul' ou 'Imediatamente'>",
  "gestaoGale": "<'Sem gale' | 'Até 1 gale'>",
  "insights": [
    "<insight 1 relevante>",
    "<insight 2 relevante>",
    "<insight 3 relevante>"
  ],
  "alertas": [
    "<alerta 1 se houver risco, ou null>"
  ]
}
  `.trim();

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
  const model   = getChatModel();
  const stats   = buildCandleStats(candles);

  const context = `
Contexto atual (últimas 20 velas):
- Sequência: ${stats.ultimas10.map(c => `${c.mult}x`).join(', ')}
- Janela 60 velas: ${stats.janela60.azul.pct}% azuis | ${stats.janela60.roxo.pct}% roxas | ${stats.janela60.rosa.pct}% rosas
- Média: ${stats.janela60.media}x
- Streak atual: ${stats.streakAtual.quantidade}x "${stats.streakAtual.cor}"
  `.trim();

  const chatHistory = history.slice(-6).map(msg => ({
    role: msg.role as 'user' | 'model',
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
    resumo:                 mensagem,
    padrao:                 'Erro',
    estrategiaRecomendada:  'AGUARDAR',
    confianca:              0,
    nivelRisco:             'ALTO',
    melhorMomento:          'Indisponível',
    gestaoGale:             'Sem gale',
    insights:               ['Verifique o arquivo .env', 'Confirme a chave VITE_GEMINI_API_KEY'],
    alertas:                [mensagem],
  };
}