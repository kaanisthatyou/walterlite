const { OpenAI } = require('openai');

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.INTENT_API_KEY || process.env.GROQ_API_KEY || '',
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return client;
}

async function askLLM(prompt) {
  const res = await getClient().chat.completions.create({
    model: process.env.INTENT_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.5,
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

module.exports = { askLLM };
