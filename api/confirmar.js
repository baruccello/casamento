const { google } = require('googleapis');

function normalizar(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const VARIACOES = {
  'ze': 'jose', 'ze': 'jose', 'beth': 'elizabete', 'bete': 'elizabete',
  'lili': 'liliane', 'nanda': 'fernanda', 'rafa': 'rafael', 'rafa': 'rafaela',
  'gabi': 'gabriela', 'gabi': 'gabriel', 'gui': 'guilherme',
  'vini': 'vinicius', 'leo': 'leonardo', 'leo': 'leandro',
  'mari': 'maria', 'ju': 'juliana', 'ju': 'julia',
  'nati': 'natalia', 'bia': 'beatriz', 'bel': 'isabel',
  'tata': 'tatiane', 'dani': 'daniela', 'dani': 'daniel',
  'fer': 'fernanda', 'fer': 'fernando', 'pat': 'patricia',
  'val': 'valeria', 'quel': 'raquel', 'tio': '', 'tia': '',
};

function expandirVariacoes(palavras) {
  const expandido = new Set(palavras);
  for (const p of palavras) {
    if (VARIACOES[p]) expandido.add(VARIACOES[p]);
  }
  return [...expandido].filter(p => p.length >= 2);
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function palavrasSimilares(p1, p2) {
  if (p1 === p2) return true;
  if (p1.includes(p2) || p2.includes(p1)) return true;
  const minScore = p1.length <= 4 ? 0.92 : 0.85;
  return jaroWinkler(p1, p2) >= minScore;
}

function encontrarMatch(nomeDigitado, listaConvidados) {
  const busca = normalizar(nomeDigitado);
  const palavrasBuscaRaw = busca.split(' ').filter(p => p.length >= 2);
  const palavrasBusca = expandirVariacoes(palavrasBuscaRaw);

  const candidatos = [];

  for (const convidado of listaConvidados) {
    const lista = normalizar(convidado.nome);
    const palavrasListaRaw = lista.split(' ').filter(p => p.length >= 2);
    const palavrasLista = expandirVariacoes(palavrasListaRaw);

    // Camada 1: exato
    if (busca === lista) {
      return { convidado, score: 1, metodo: 'exato' };
    }

    // Camada 2: conta palavras em comum
    let palavrasEmComum = 0;
    for (const pb of palavrasBusca) {
      for (const pl of palavrasLista) {
        if (palavrasSimilares(pb, pl)) {
          palavrasEmComum++;
          break;
        }
      }
    }

    if (palavrasEmComum > 0) {
      const scorePalavras = palavrasEmComum / Math.max(palavrasBusca.length, palavrasLista.length);
      candidatos.push({
        convidado,
        score: 0.7 + scorePalavras * 0.25,
        palavrasEmComum,
        metodo: `${palavrasEmComum} palavra(s) em comum`,
      });
      continue;
    }

    // Camada 3: fuzzy nome completo — só se não houve palavras em comum
    const scoreFull = jaroWinkler(busca, lista);
    if (scoreFull >= 0.82) {
      candidatos.push({
        convidado,
        score: scoreFull,
        palavrasEmComum: 0,
        metodo: `fuzzy (${Math.round(scoreFull * 100)}%)`,
      });
    }
  }

  if (candidatos.length === 0) return null;

  // Prioriza quem tem mais palavras em comum, depois maior score
  candidatos.sort((a, b) => {
    if (b.palavrasEmComum !== a.palavrasEmComum) return b.palavrasEmComum - a.palavrasEmComum;
    return b.score - a.score;
  });

  return candidatos[0];
}

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
