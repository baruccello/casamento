const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  // Proteção por senha simples
  if (req.body.senha !== process.env.RESET_SENHA) {
    return res.status(401).json({ erro: 'Senha incorreta' });
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  // Busca quantas linhas tem na aba Família
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Família!A:D',
  });
  const totalLinhas = data.values.length;

  // Reseta Status e Data de todas as linhas de convidados
  const linhasVazias = Array(totalLinhas - 2).fill(['Pendente', '', '', '']);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Família!C3:F${totalLinhas}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: linhasVazias },
  });

  // Remove a formatação verde de todas as linhas
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const abaFamilia = meta.data.sheets.find(s => s.properties.title === 'Família');

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: abaFamilia.properties.sheetId,
            startRowIndex: 2,
            endRowIndex: totalLinhas,
            startColumnIndex: 0,
            endColumnIndex: 6,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        },
      }],
    },
  });

  // Limpa a aba Confirmações (Auto) mantendo o cabeçalho
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "'Confirmações (Auto)'!A3:D1000",
  });

  return res.status(200).json({ sucesso: true, mensagem: 'Lista zerada com sucesso.' });
};
