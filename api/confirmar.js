const { google } = require('googleapis');

// ─── NORMALIZAÇÃO ────────────────────────────────────────────────────────────

function normalizar(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── LEVENSHTEIN ─────────────────────────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similaridade(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── SCORE COMPOSTO ───────────────────────────────────────────────────────────

function calcularScore(input, candidato) {
  const normInput = normalizar(input);
  const normCandidato = normalizar(candidato);
  const scores = [];

  // A: comparação direta normalizada
  scores.push(similaridade(normInput, normCandidato));

  // B: input contido no candidato ("franciele" dentro de "franciele souza")
  if (normCandidato.includes(normInput)) {
    scores.push(0.5 + (normInput.length / normCandidato.length) * 0.5);
  }

  // C: matching por tokens (palavras individuais), tolera ordem invertida
  const tokensInput = normInput.split(' ').filter(t => t.length >= 2);
  const tokensCandidato = normCandidato.split(' ');
  let somaTokens = 0;
  let tokensExatos = 0;

  for (const ti of tokensInput) {
    const melhor = Math.max(...tokensCandidato.map(tc => {
      if (tc === ti) return 1;
      if (tc.includes(ti) && ti.length >= 3) return 0.8;
      return similaridade(ti, tc);
    }));
    if (melhor >= 0.85) tokensExatos++;
    somaTokens += melhor;
  }

  if (tokensInput.length > 0) {
    const scoreTokens = somaTokens / tokensInput.length;
    const todosExatos = tokensExatos === tokensInput.length;
    scores.push(Math.min(1, todosExatos ? scoreTokens * 1.1 : scoreTokens));
  }

  // D: primeiro nome com alto match → boost
  const primeiroInput = normInput.split(' ')[0];
  const primeiroCandidato = normCandidato.split(' ')[0];
  if (primeiroInput && primeiroCandidato) {
    const simPrimeiro = similaridade(primeiroInput, primeiroCandidato);
    if (simPrimeiro > 0.85) scores.push(simPrimeiro * 0.95);
  }

  return Math.min(1, Math.max(...scores));
}

// ─── MATCH PRINCIPAL ─────────────────────────────────────────────────────────

function encontrarMatch(nomeDigitado, listaConvidados) {
  const THRESHOLD_EXATO  = 1.0;   // match perfeito após normalização
  const THRESHOLD_FUZZY  = 0.70;  // mínimo para aceitar automaticamente
  const THRESHOLD_AMBIG  = 0.55;  // zona de ambiguidade (registra mas não confirma)

  let melhor = null;

  for (const convidado of listaConvidados) {
    const score = calcularScore(nomeDigitado, convidado.nome);

    if (!melhor || score > melhor.score) {
      melhor = { convidado, score };
    }
  }

  if (!melhor) return null;

  const { score, convidado } = melhor;

  if (score >= THRESHOLD_EXATO) {
    return { convidado, score, metodo: 'exato' };
  }

  if (score >= THRESHOLD_FUZZY) {
    return { convidado, score, metodo: `fuzzy (${(score * 100).toFixed(0)}%)` };
  }

  if (score >= THRESHOLD_AMBIG) {
    // Retorna o candidato mais próximo, mas sinaliza como ambíguo
    // A rota vai registrar e pedir revisão manual
    return { convidado, score, metodo: 'ambíguo', ambiguo: true };
  }

  return null;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { nome, telefone } = req.body;
  if (!nome || nome.trim().length < 2) {
    return res.status(400).json({ erro: 'Nome inválido' });
  }

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Família!A:F',
    });

    const linhas = data.values || [];
    const convidados = linhas
      .map((l, idx) => ({ linha: idx + 1, cols: l }))
      .filter(({ cols }) => cols[0] && !isNaN(parseFloat(cols[0])))
      .map(({ linha, cols }) => ({
        linhaSheet: linha,
        numero: cols[0],
        nome: cols[1] || '',
        status: cols[2] || '',
      }));

    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Bahia' });
    const resultado = encontrarMatch(nome.trim(), convidados);

    // ── MATCH AMBÍGUO: registra, não confirma ─────────────────────────────
    if (resultado?.ambiguo) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Confirmações (Auto)'!A:D",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            agora,
            nome.trim(),
            telefone || '',
            `⚠️ AMBÍGUO — possível match: ${resultado.convidado.nome} (${(resultado.score * 100).toFixed(0)}%) — revisar manualmente`,
          ]],
        },
      });

      return res.status(200).json({
        sucesso: false,
        mensagem: 'Não conseguimos localizar seu nome com certeza. Sua confirmação foi registrada e verificaremos manualmente. Fique tranquilo(a)! 💍',
      });
    }

    // ── MATCH ENCONTRADO (exato ou fuzzy confiável) ───────────────────────
    if (resultado) {
      const { convidado, metodo } = resultado;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Família!C${convidado.linhaSheet}:D${convidado.linhaSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Confirmado', agora]] },
      });

      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const abaFamilia = meta.data.sheets.find(s => s.properties.title === 'Família');

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId: abaFamilia.properties.sheetId,
                startRowIndex: convidado.linhaSheet - 1,
                endRowIndex: convidado.linhaSheet,
                startColumnIndex: 0,
                endColumnIndex: 6,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.714, green: 0.843, blue: 0.659 },
                },
              },
              fields: 'userEnteredFormat.backgroundColor',
            },
          }],
        },
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Confirmações (Auto)'!A:D",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[agora, nome.trim(), telefone || '', `Match: ${convidado.nome} via ${metodo}`]],
        },
      });

      return res.status(200).json({
        sucesso: true,
        mensagem: `Presença de ${convidado.nome} confirmada! Nos vemos no dia 17 de outubro 💍`,
        match: convidado.nome,
        metodo,
      });
    }

    // ── SEM MATCH ─────────────────────────────────────────────────────────
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'Confirmações (Auto)'!A:D",
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[agora, nome.trim(), telefone || '', '⚠️ NÃO ENCONTRADO — revisar manualmente']],
      },
    });

    return res.status(200).json({
      sucesso: false,
      mensagem: 'Nome não encontrado na lista. Sua confirmação foi registrada e vamos verificar manualmente.',
    });

  } catch (err) {
    console.error('Erro na API:', err);
    return res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
};
