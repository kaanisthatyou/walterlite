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

async function extractValue(text, what) {
  const res = await getClient().chat.completions.create({
    model: process.env.INTENT_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Extract the requested value from the text. Return ONLY the extracted value — no explanation, no punctuation around it.',
      },
      {
        role: 'user',
        content: `Text:\n${text}\n\nExtract: ${what}`,
      },
    ],
    max_tokens: 256,
    temperature: 0,
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

module.exports = { extractValue };
