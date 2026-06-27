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

function encontrarMatch(nomeDigitado, listaConvidados) {
  const busca = normalizar(nomeDigitado);

  for (const convidado of listaConvidados) {
    const lista = normalizar(convidado.nome);
    if (busca === lista) {
      return { convidado, score: 1, metodo: 'exato' };
    }
  }

  return null;
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
