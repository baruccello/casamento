const { google } = require('googleapis');

// Remove acentos, maiúsculas e caracteres especiais para comparação justa
function normalizar(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// Distância Jaro-Winkler implementada sem dependência externa
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length, len2 = s2.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
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

// Três camadas de match: exato → substring → fuzzy
function encontrarMatch(nomeDigitado, listaConvidados) {
  const busca = normalizar(nomeDigitado);
  const palavrasBusca = busca.split(' ').filter(p => p.length >= 3);

  let melhorScore = 0;
  let melhorMatch = null;
  let melhorMetodo = '';

  for (const convidado of listaConvidados) {
    const lista = normalizar(convidado.nome);

    // Camada 1: exato
    if (busca === lista) {
      return { convidado, score: 1, metodo: 'exato' };
    }

    // Camada 2: substring (qualquer palavra com 3+ letras contida no outro)
    const palavrasLista = lista.split(' ').filter(p => p.length >= 3);
    const temSubstring = palavrasBusca.some(pb =>
      palavrasLista.some(pl => pl.includes(pb) || pb.includes(pl))
    );
    if (temSubstring && 0.9 > melhorScore) {
      melhorScore = 0.9;
      melhorMatch = convidado;
      melhorMetodo = 'substring';
    }

    // Camada 3: fuzzy Jaro-Winkler
    const score = jaroWinkler(busca, lista);
    if (score >= 0.82 && score > melhorScore) {
      melhorScore = score;
      melhorMatch = convidado;
      melhorMetodo = `fuzzy (${Math.round(score * 100)}%)`;
    }
  }

  if (melhorMatch) return { convidado: melhorMatch, score: melhorScore, metodo: melhorMetodo };
  return null;
}

module.exports = async function handler(req, res) {
  // Permite chamadas do seu site (CORS)
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
    // Autentica com a conta de serviço via variável de ambiente
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Lê a aba Família (colunas A até F)
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Família!A:F',
    });

    // Monta lista ignorando cabeçalho e linhas sem número
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

      // 1. Atualiza Status e Data na aba Família
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Família!C${convidado.linhaSheet}:D${convidado.linhaSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Confirmado', agora]] },
      });

      // 2. Pinta a linha de verde
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

      // 3. Registra na aba Confirmações (Auto)
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

    // Sem match: registra para revisão manual
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
