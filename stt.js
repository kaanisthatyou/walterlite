const { OpenAI } = require('openai');
const { createReadStream } = require('fs');

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return client;
}

function resetClient() {
  client = null;
}

async function transcribeAudio(filePath) {
  const res = await getClient().audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-large-v3',
  });
  return res.text;
}

module.exports = { transcribeAudio, resetClient };
