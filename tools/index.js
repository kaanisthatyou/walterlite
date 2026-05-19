const { askLLM }                             = require('./tool_llm');
const { openFile }                           = require('./tool_files');
const { extractValue }                        = require('./tool_extract');
const { readClipboard, writeClipboard }       = require('./tool_clipboard');
const { webSearch }                           = require('./tool_web_search');
const { openUrl, browserSearch, browserClickFirst } = require('./tool_browser');
const { youtubeFirstVideo }                   = require('./tool_youtube_search');
const { recall, learn }                       = require('./tool_memory');
const { scanPath, scanPage }                  = require('./tool_scan');
const {
  startSession, executeStep, saveRecording, replayRecording, stopSession, domInspect,
} = require('../playwright-session');
const { switchTo }                            = require('../windows');
const { sendHotkey }                          = require('../keyboard');
const { injectText }                          = require('../inject');
const { openApp, takeScreenshot, setupFirefoxCDP } = require('../system');

const TOOL_REGISTRY = {
  open_file:            ({ name })          => openFile(name),
  web_search:           ({ query })        => webSearch(query),
  extract_value:        ({ text, what })   => extractValue(text, what),
  ask_llm:              ({ prompt })       => askLLM(prompt),
  open_url:             ({ url })          => openUrl(url),
  browser_search:       ({ site, query })  => browserSearch(site, query),
  browser_click_first:  ()                 => browserClickFirst(),
  youtube_first_video:  ({ query })        => youtubeFirstVideo(query),
  recall:               ({ key })           => recall({ key }),
  learn:                ({ key, value })   => learn({ key, value }),
  scan_path:            ({ directory })    => scanPath(directory),
  scan_page:            ({ url, hint })    => scanPage(url, hint),
  switch_to:            ({ app })          => switchTo(app),
  open_app:             ({ name })         => openApp(name),
  type_text:            ({ text })         => injectText(text, { submit: false }),
  send_hotkey:          ({ combo })        => sendHotkey(combo),
  take_screenshot:      ()                 => takeScreenshot(),
  read_clipboard:       ()                 => readClipboard(),
  write_clipboard:      ({ text })         => writeClipboard(text),
  wait:                 ({ ms })           => new Promise(r => setTimeout(r, Number(ms) || 500)),
  start_session:        ({ url })          => startSession({ url }),
  session_step:         ({ instruction })  => executeStep({ instruction }),
  save_recording:       ({ name })         => saveRecording({ name }),
  replay_recording:     ({ name })         => replayRecording({ name }),
  stop_session:         ()                 => stopSession(),
  setup_firefox_cdp:    ()                 => setupFirefoxCDP(),
  dom_inspect:          ()                 => domInspect(),
  dom_scan_prefix:      ({ name })         => domInspect({ save_as_prefix: name }),
};

module.exports = { TOOL_REGISTRY };
