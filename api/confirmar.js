const { google } = require('googleapis');

// ─── NORMALIZAÇÃO ─────────────────────────────────────────────────────────────

function normalizar(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/pe\./g, 'pe ')        // Pe.Deivisson → pe deivisson
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── LEVENSHTEIN ──────────────────────────────────────────────────────────────

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
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

// ─── NÍVEL DE MATCH EXATO ────────────────────────────────────────────────────
// Retorna o nível de precisão do match (0 = nenhum, 3 = perfeito).
// Prioridade garante que "João" não confirme "João Pedro" se "João" está na lista.

function nivelExato(busca, candidato) {
  // Nível 3: idêntico após normalização → máxima prioridade
  if (busca === candidato) return 3;

  // Nível 2: busca é prefixo do candidato ("joao pedro" bate "joao pedro oliveira")
  if (candidato.startsWith(busca + ' ')) return 2;

  // Nível 1: busca é um token isolado dentro do candidato ("franciele" em "franciele sena")
  //          só entra se não houver match de nível superior
  const tokens = candidato.split(' ');
  if (tokens.includes(busca) && busca.length >= 3) return 1;

  return 0;
}

// ─── SCORE FUZZY ─────────────────────────────────────────────────────────────

function scoreFuzzy(busca, candidato) {
  const scores = [];

  // Similaridade global
  scores.push(similaridade(busca, candidato));

  // Busca contida no candidato
  if (candidato.includes(busca) && busca.length >= 3) {
    scores.push(0.5 + (busca.length / candidato.length) * 0.5);
  }

  // Token a token
  const tokensBusca = busca.split(' ').filter(t => t.length >= 2);
  const tokensCandidato = candidato.split(' ');
  if (tokensBusca.length > 0) {
    let soma = 0;
    for (const tb of tokensBusca) {
      const melhor = Math.max(...tokensCandidato.map(tc => similaridade(tb, tc)));
      soma += melhor;
    }
    scores.push(soma / tokensBusca.length);
  }

  // Primeiro nome com match forte
  const pb = busca.split(' ')[0];
  const pc = candidato.split(' ')[0];
  const simPrimeiro = similaridade(pb, pc);
  if (simPrimeiro >= 0.85) scores.push(simPrimeiro);

  return Math.min(1, Math.max(...scores));
}

// ─── ENCONTRAR MATCHES ────────────────────────────────────────────────────────
// Retorna um array com todos os convidados que batem (pode ser mais de um
// quando há homônimos, ex: dois "Lucas" ou dois "Márcio").

function encontrarMatches(nomeDigitado, listaConvidados) {
  const busca = normalizar(nomeDigitado);

  // 1ª PASSAGEM: exato por nível de prioridade
  const comNivel = listaConvidados
    .map(c => ({ convidado: c, nivel: nivelExato(busca, normalizar(c.nome)) }))
    .filter(x => x.nivel > 0);

  if (comNivel.length > 0) {
    // Usa apenas o nível mais alto encontrado
    const maxNivel = Math.max(...comNivel.map(x => x.nivel));
    const matches = comNivel
      .filter(x => x.nivel === maxNivel)
      .map(x => x.convidado);
    return { matches, metodo: 'exato', score: 1 };
  }

  // 2ª PASSAGEM: fuzzy — retorna apenas o melhor match
  let melhor = null;
  for (const convidado of listaConvidados) {
    const score = scoreFuzzy(busca, normalizar(convidado.nome));
    if (!melhor || score > melhor.score) {
      melhor = { convidado, score };
    }
  }

  if (melhor && melhor.score >= 0.65) {
    return {
      matches: [melhor.convidado],
      score: melhor.score,
      metodo: `fuzzy (${(melhor.score * 100).toFixed(0)}%)`,
    };
  }

  return null;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

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
    const resultado = encontrarMatches(nome.trim(), convidados);

    // ── MATCH ENCONTRADO ────────────────────────────────────────────────────
    if (resultado) {
      const { matches, metodo } = resultado;
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const abaFamilia = meta.data.sheets.find(s => s.properties.title === 'Família');

      for (const convidado of matches) {
        // Atualiza status e data
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Família!C${convidado.linhaSheet}:D${convidado.linhaSheet}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['Confirmado', agora]] },
        });

        // Pinta de verde
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
      }

      // Log na aba de confirmações
      const nomesConfirmados = matches.map(c => c.nome).join(', ');
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Confirmações (Auto)'!A:D",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[agora, nome.trim(), telefone || '', `Match: ${nomesConfirmados} via ${metodo}`]],
        },
      });

      const nomeExibido = matches.length === 1 ? matches[0].nome : nomesConfirmados;
      return res.status(200).json({
        sucesso: true,
        mensagem: `Presença de ${nomeExibido} confirmada! Nos vemos no dia 17 de outubro 💍`,
        match: nomesConfirmados,
        metodo,
      });
    }

    // ── SEM MATCH ───────────────────────────────────────────────────────────
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
