const { OpenAI } = require('openai');

const ENTITY_PROMPT = `Extract structured entities from this command. Return ONLY valid JSON, nothing else.
Schema: { "url": string|null, "app": string|null, "file": string|null, "channel": string|null, "query": string|null }
- url: any URL, IP address (like 10.16.40.250:8000), or domain name found in the text
- app: application name if the user wants to open/switch to/close an app
- file: filename or path if mentioned
- channel: YouTube channel name or @handle if mentioned
- query: the core search/action query if present
Return null for any field not clearly present. Return null (not {}) if no entities found at all.`;

async function extractEntities(text) {
  const apiKey = process.env.GROQ_API_KEY || '';
  if (!apiKey) return null;

  try {
    const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
    const res = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: ENTITY_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 150,
      temperature: 0,
    });
    const raw = res.choices[0]?.message?.content?.trim() || '';
    if (raw === 'null') return null;
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || 'null');
    if (!parsed) return null;
    // Return null if all values are null
    if (Object.values(parsed).every(v => v === null || v === '')) return null;
    return parsed;
  } catch {
    return null; // entity extraction is best-effort, never block the pipeline
  }
}

module.exports = { extractEntities };
