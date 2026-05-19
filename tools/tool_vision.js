const { captureScreen } = require('../system');
const { askGeminiVision } = require('../ai');
const { runPS } = require('../ps-utils');
const { mouseMove, mouseClick } = require('../mouse');

async function analyzeScreen(question) {
  const tmpPath = await captureScreen();
  const answer = await askGeminiVision(question, tmpPath);
  if (answer === null) return '[Vision not available — set GEMINI_API_KEY in settings]';
  return answer;
}

async function visionClick(description) {
  const tmpPath = await captureScreen();

  const dimOutput = await runPS(`
    Add-Type -AssemblyName System.Windows.Forms
    $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Output "$($s.Width),$($s.Height)"
  `);
  const [screenW, screenH] = dimOutput.trim().split(',').map(Number);

  const prompt =
    'Return ONLY valid JSON with no markdown: {"x": <number>, "y": <number>} where x and y are percentages (0-100) of screen width/height for the center of: ' +
    description;

  const raw = await askGeminiVision(prompt, tmpPath);
  if (raw === null) throw new Error('vision_click requires GEMINI_API_KEY');

  const cleaned = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
  const coords = JSON.parse(cleaned);

  if (
    typeof coords.x !== 'number' || typeof coords.y !== 'number' ||
    coords.x < 0 || coords.x > 100 || coords.y < 0 || coords.y > 100
  ) {
    throw new Error('vision_click: Gemini returned invalid coordinates for: ' + description);
  }

  const px = Math.round((coords.x / 100) * screenW);
  const py = Math.round((coords.y / 100) * screenH);

  await mouseMove(px, py);
  await mouseClick();

  return `clicked ${description} at (${px}, ${py})`;
}

module.exports = { analyzeScreen, visionClick };
