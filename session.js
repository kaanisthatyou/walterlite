// In-memory prefix session state.
// Single-user, module-level — no persistence needed.

const DEFAULT = {
  activePrefix:   null,   // 'HBYS' or null
  activeMacro:    null,   // macro id being executed
  currentStep:    0,      // index into macro.steps[]
  waitingFor:     null,   // field name paused at a 'prompt' step
  waitingConfirm: false,  // paused at a 'confirm' step
  inputs:         {},     // collected { fieldName: value }
};

let state = { ...DEFAULT };

function get()          { return { ...state }; }
function set(updates)   { Object.assign(state, updates); }
function clear()        { state = { ...DEFAULT }; }
function isActive()     { return state.activePrefix !== null; }
function isPaused()     { return state.waitingFor !== null || state.waitingConfirm; }

module.exports = { get, set, clear, isActive, isPaused };
