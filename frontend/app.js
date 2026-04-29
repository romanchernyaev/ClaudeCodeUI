// ==== Claude Code UI — frontend (multi-tab) ====
const CONTEXT_WINDOW = 200000;
const TOOL_PREVIEW_CHARS = 200;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const uid = () => "t_" + Math.random().toString(36).slice(2, 10);

// Global app state.
const state = {
  cwd: null,
  defaultCwd: null,
  slashCommands: [],
  slashFiltered: [],
  slashIndex: 0,
  tabs: [],            // [{id, title, cwd, model, effort, permissionMode, sessionId, projectId, lastUserText, attachments, messagesHTML, streaming, streamedViaDelta, currentAssistantText, unread}]
  activeTabId: null,
  allSessions: [],
  searchQuery: "",
};

// ---------- pywebview bridge ----------
function apiReady() {
  return new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) return resolve();
    window.addEventListener("pywebviewready", () => resolve());
  });
}

// Incoming events from Python. `tab_id` routes to the correct tab.
window.__onClaudeEvent = (ev) => {
  const tab = state.tabs.find(t => t.id === ev.tab_id);
  if (!tab) return;
  const isActive = tab.id === state.activeTabId;
  if (ev.type === "session") {
    tab.sessionId = ev.session_id;
  } else if (ev.type === "text") {
    if (!tab.streamedViaDelta) appendAssistantText(tab, ev.text);
  } else if (ev.type === "text_delta") {
    tab.streamedViaDelta = true;
    appendAssistantText(tab, ev.text);
  } else if (ev.type === "text_start") {
    // finalize any open thinking block
    tab.thinkingBlockEl = null;
  } else if (ev.type === "thinking_start") {
    tab.thinkingBlockEl = null; // start a new one on next delta
  } else if (ev.type === "thinking_delta") {
    appendThinkingText(tab, ev.text);
  } else if (ev.type === "thinking") {
    // Non-streamed thinking (older shape)
    appendThinkingText(tab, ev.text);
  } else if (ev.type === "tool_use") {
    addToolCall(tab, ev.name, ev.input);
  } else if (ev.type === "tool_result") {
    addToolResult(tab, ev.text);
  } else if (ev.type === "usage") {
    tab.usage = ev.usage;
    if (isActive) applyUsage(ev.usage);
  } else if (ev.type === "result") {
    // Intentionally ignore ev.usage here: the CLI's result.usage is cumulative
    // (session total) and its shape differs across versions, which was causing
    // "NaN / 200k" in the meter. The per-message `usage` events already updated
    // the meter with current context size — leave that in place.
    finishAssistantTurn(tab);
  } else if (ev.type === "error") {
    addError(tab, ev.message);
    // Heuristic: if the error smells like an auth problem, show the login banner.
    const m = (ev.message || "").toLowerCase();
    if (/(auth|login|unauthorized|401|credentials|not logged|please log in|api key)/.test(m)) {
      $("#auth-banner").classList.remove("hidden");
      state.authenticated = false;
    }
    finishAssistantTurn(tab);
  } else if (ev.type === "done") {
    finishAssistantTurn(tab);
  }
};

// ---------- Init ----------
async function init() {
  initTheme();
  await apiReady();
  const status = await window.pywebview.api.get_status();
  $("#status-line").textContent = status.cli ? "CLI: ready" : "CLI: NOT FOUND";
  state.defaultCwd = status.home;
  const saved = loadSettings();
  state.cwd = saved.cwd || status.home;
  $("#cwd-display").textContent = shortenPath(state.cwd);
  state.slashCommands = await window.pywebview.api.get_slash_commands(state.cwd);
  await refreshSessions();
  wireUI();
  initSidebarState();
  // Pre-populate selects from saved settings so the first tab inherits them
  if (saved.model !== undefined) $("#model-select").value = saved.model;
  if (saved.effort !== undefined) $("#effort-select").value = saved.effort;
  if (saved.permissionMode !== undefined && $("#permission-mode")) $("#permission-mode").value = saved.permissionMode;
  openNewTab(); // start with one empty tab
  checkAuthAndShowBanner();
  checkForUpdates();
}

const UPDATE_DISMISS_KEY = "claudecodeui.update.dismissed";

async function checkForUpdates() {
  try {
    const info = await window.pywebview.api.check_updates();
    if (!info || !info.update_available || !info.latest) return;
    let dismissed = "";
    try { dismissed = localStorage.getItem(UPDATE_DISMISS_KEY) || ""; } catch {}
    if (dismissed === info.latest) return; // user already said "no thanks" for this version
    const banner = $("#update-banner");
    const vers = $("#update-banner-versions");
    if (vers) vers.textContent = `v${info.current} → v${info.latest}`;
    banner.dataset.latest = info.latest;
    banner.dataset.url = info.release_url || "";
    banner.classList.remove("hidden");
  } catch {
    // Network failure, GitHub rate limit, etc — stay silent.
  }
}

async function checkAuthAndShowBanner() {
  try {
    const a = await window.pywebview.api.check_auth();
    state.authenticated = !!a.authenticated;
    if (!a.authenticated) {
      $("#auth-banner").classList.remove("hidden");
    } else {
      $("#auth-banner").classList.add("hidden");
    }
    const statusEl = $("#auth-status");
    if (statusEl) {
      if (a.authenticated) {
        statusEl.textContent = a.user ? `Logged in as ${a.user}` : "Logged in";
        statusEl.classList.remove("bad"); statusEl.classList.add("ok");
      } else {
        statusEl.textContent = a.error ? `Not logged in (${a.error.split("\n")[0].slice(0,80)})` : "Not logged in";
        statusEl.classList.remove("ok"); statusEl.classList.add("bad");
      }
    }
  } catch (e) {
    // Network or silent error — leave banner as-is.
  }
}

const SETTINGS_KEY = "claudecodeui.settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function patchSettings(patch) {
  try {
    const cur = loadSettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
}

const SIDEBAR_COLLAPSED_KEY = "claudecodeui.sidebar.collapsed";
function applySidebarCollapsed(collapsed) {
  document.getElementById("app").classList.toggle("sidebar-collapsed", collapsed);
  $("#expand-sidebar").classList.toggle("hidden", !collapsed);
  const btn = $("#collapse-sidebar");
  if (btn) btn.textContent = collapsed ? "⟩" : "⟨";
}
function toggleSidebar() {
  const collapsed = !document.getElementById("app").classList.contains("sidebar-collapsed");
  applySidebarCollapsed(collapsed);
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch {}
}
function initSidebarState() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch {}
  applySidebarCollapsed(collapsed);
}

async function takeScreenshot() {
  const t = activeTab(); if (!t) return;
  try {
    const res = await window.pywebview.api.take_screenshot();
    if (!res || !res.ok) {
      if (res && res.cancelled) return; // user hit Esc or clicked without dragging
      if (res && res.error) addError(t, "Screenshot failed: " + res.error);
      return;
    }
    t.attachments.push({ b64: res.data_url, name: "screenshot.png" });
    renderAttachments();
    $("#input").focus();
  } catch (e) {
    addError(t, "Screenshot failed: " + e.message);
  }
}

async function runCompact() {
  const t = activeTab();
  if (!t) return;
  if (t.streaming) { return; } // already busy
  if (!t.sessionId) {
    // Nothing to compact yet.
    addError(t, "Nothing to compact — start a conversation first.");
    return;
  }
  $("#input").value = "/compact";
  await send();
}

async function triggerAuthLogin() {
  const res = await window.pywebview.api.launch_auth_login();
  if (res && res.ok) {
    // Re-check a few seconds later — the user needs time to complete the browser flow.
    setTimeout(checkAuthAndShowBanner, 8000);
    setTimeout(checkAuthAndShowBanner, 20000);
    setTimeout(checkAuthAndShowBanner, 45000);
  } else {
    alert("Failed to launch login: " + (res?.error || "unknown error"));
  }
}

function shortenPath(p) {
  if (!p) return "~";
  const parts = p.split(/\\|\//).filter(Boolean);
  if (parts.length > 3) return ".../" + parts.slice(-2).join("/");
  return p;
}
function cwdToProjectId(cwd) {
  if (!cwd) return null;
  return cwd.replace(/[\\/:.]/g, "-");
}

// ---------- Sessions sidebar ----------
async function refreshSessions() {
  const projects = await window.pywebview.api.get_projects();
  const wantedId = cwdToProjectId(state.cwd);
  let pid = wantedId;
  let sessions = await window.pywebview.api.get_sessions(pid);
  if (!sessions.length && projects.length) {
    pid = projects[0].id;
    sessions = await window.pywebview.api.get_sessions(pid);
  }
  state.allSessions = sessions;
  renderSessionsFiltered();
}

function renderSessionsFiltered() {
  const q = state.searchQuery.trim().toLowerCase();
  const label = $("#recent-label");
  const all = state.allSessions;
  const filtered = !q ? all : all.filter(s => {
    const hay = ((s.title || "") + " " + (s.first_message || "")).toLowerCase();
    return hay.includes(q);
  });
  if (label) label.textContent = q ? `Search results (${filtered.length})` : "Recent chats";
  const list = $("#session-list");
  list.innerHTML = "";
  if (!filtered.length) {
    list.appendChild(el("div", "session-empty", q ? "No matches" : "No chats yet"));
    return;
  }
  const activeSessionId = activeTab()?.sessionId;
  filtered.forEach((s) => {
    const item = el("div", "session-item");
    if (s.id === activeSessionId) item.classList.add("active");
    if (s.pinned) item.classList.add("pinned");
    const titleRow = el("div", "title-row");
    if (s.pinned) titleRow.appendChild(el("span", "pin-icon", "📌"));
    const title = el("div", "title");
    const fullTitle = s.title || s.first_message || "(untitled)";
    title.innerHTML = highlightMatch(fullTitle, q);
    title.title = fullTitle;
    titleRow.appendChild(title);
    const meta = el("div", "meta", new Date(s.last_modified * 1000).toLocaleString());
    const del = el("button", "del-btn", "🗑");
    del.title = "Delete this chat";
    del.addEventListener("click", (e) => { e.stopPropagation(); confirmDeleteSession(s); });
    item.append(titleRow, meta, del);
    item.addEventListener("click", () => openSessionFromSidebar(s.project_id, s.id, s.title));
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); openSessionContextMenu(e, s, item); });
    list.appendChild(item);
  });
}

function openSessionContextMenu(event, s, itemEl) {
  closeSessionContextMenu();
  const menu = el("div", "ctx-menu");
  menu.id = "session-ctx-menu";
  const items = [
    { label: "Rename",               action: () => startInlineRename(s, itemEl) },
    { label: s.pinned ? "Unpin" : "Pin to top", action: () => togglePin(s) },
    { kind: "sep" },
    { label: "Delete", danger: true, action: () => confirmDeleteSession(s) },
  ];
  items.forEach(it => {
    if (it.kind === "sep") { menu.appendChild(el("div", "ctx-sep")); return; }
    const row = el("div", "ctx-item" + (it.danger ? " danger" : ""), it.label);
    row.addEventListener("click", () => { closeSessionContextMenu(); it.action(); });
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const x = Math.min(event.clientX, window.innerWidth - 180);
  const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10);
  menu.style.left = x + "px"; menu.style.top = y + "px";
  setTimeout(() => document.addEventListener("click", closeSessionContextMenu, { once: true }), 0);
}
function closeSessionContextMenu() {
  const m = document.getElementById("session-ctx-menu");
  if (m) m.remove();
}

function startInlineRename(s, itemEl) {
  const titleEl = itemEl.querySelector(".title");
  if (!titleEl) return;
  const current = s.title || "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const commit = async (save) => {
    if (finished) return; finished = true;
    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== current) {
      await window.pywebview.api.rename_session(s.project_id, s.id, newTitle);
    } else if (save && !newTitle && s.custom_title) {
      // Empty string resets to auto-title
      await window.pywebview.api.rename_session(s.project_id, s.id, "");
    }
    await refreshSessions();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

async function togglePin(s) {
  await window.pywebview.api.pin_session(s.project_id, s.id, !s.pinned);
  await refreshSessions();
}

function highlightMatch(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const idx = safe.toLowerCase().indexOf(q);
  if (idx === -1) return safe;
  return safe.slice(0, idx) +
    `<span class="search-highlight">${safe.slice(idx, idx + q.length)}</span>` +
    safe.slice(idx + q.length);
}

function confirmDeleteSession(s) {
  const bd = el("div", "confirm-backdrop");
  const modal = el("div", "confirm-modal");
  const title = el("div", "confirm-title", "Delete this chat?");
  const body = el("div", "confirm-body");
  body.innerHTML = `This will permanently delete <span class="name">${escapeHtml(s.title || s.first_message || s.id)}</span>.<br>The JSONL file and any tool-results folder are removed from disk. This cannot be undone.`;
  const actions = el("div", "confirm-actions");
  const cancel = el("button", "confirm-btn", "Cancel");
  const confirm = el("button", "confirm-btn danger", "Delete");
  cancel.addEventListener("click", () => bd.remove());
  bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true; confirm.textContent = "Deleting…";
    await window.pywebview.api.delete_session(s.project_id, s.id);
    // If a tab was showing this session, mark it as "no session" so it doesn't try to resume.
    state.tabs.forEach(t => { if (t.sessionId === s.id) { t.sessionId = null; t.projectId = null; } });
    bd.remove();
    await refreshSessions();
  });
  actions.append(cancel, confirm);
  modal.append(title, body, actions);
  bd.appendChild(modal);
  document.body.appendChild(bd);
}

// ---------- Tabs ----------
function activeTab() { return state.tabs.find(t => t.id === state.activeTabId); }

function newTabObject(init = {}) {
  return {
    id: uid(),
    title: "New chat",
    cwd: state.cwd,
    model: $("#model-select")?.value || "",
    effort: $("#effort-select")?.value || "max",
    permissionMode: $("#permission-mode")?.value || "bypassPermissions",
    sessionId: null,
    projectId: null,
    lastUserText: "",
    attachments: [],
    streaming: false,
    streamedViaDelta: false,
    currentAssistantText: "",
    usage: null,
    messagesEl: null,
    composerInputValue: "",
    unread: false,
    autoScroll: true,   // user is pinned to bottom; new content scrolls into view
    unseenReply: false, // Claude finished a turn while user was scrolled up
    ...init,
  };
}

function openNewTab() {
  const t = newTabObject();
  state.tabs.push(t);
  renderTabs();
  switchToTab(t.id);
}

function renderTabs() {
  const strip = $("#tabs");
  strip.innerHTML = "";
  state.tabs.forEach((t) => {
    const tab = el("div", "tab");
    if (t.id === state.activeTabId) tab.classList.add("active");
    if (t.streaming) tab.appendChild(el("div", "tab-dot"));
    const title = t.title || "New chat";
    const titleEl = el("div", "tab-title", title);
    titleEl.title = title;
    tab.appendChild(titleEl);
    const close = el("button", "tab-close", "×");
    close.title = "Close tab (Ctrl+W)";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    tab.appendChild(close);
    tab.addEventListener("click", () => switchToTab(t.id));
    strip.appendChild(tab);
  });
}

function switchToTab(id) {
  const prev = activeTab();
  if (prev) {
    // Save composer value for the previous tab
    prev.composerInputValue = $("#input").value;
    // Detach current messages DOM so it persists across tab switches
    const box = $("#messages");
    prev.messagesEl = box; // keep reference (we'll swap containers)
    // Remember scroll position so we can restore it on return.
    if (box) prev.scrollTop = box.scrollTop;
  }
  state.activeTabId = id;
  const t = activeTab();
  if (!t) return;
  t.unread = false;

  // Repaint UI from this tab's state
  const container = $("#messages-container");
  container.innerHTML = "";
  if (!t.messagesEl) {
    t.messagesEl = el("div", "messages");
    t.messagesEl.id = "messages";
    // Welcome placeholder
    const welcome = el("div", "welcome");
    const robot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    robot.setAttribute("viewBox", "0 0 64 48");
    robot.setAttribute("class", "welcome-robot");
    robot.setAttribute("aria-hidden", "true");
    robot.innerHTML = `
      <line x1="32" y1="4" x2="32" y2="1" stroke="#d97757" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="32" cy="1.2" r="1.2" fill="#d97757" class="antenna-blob"/>
      <rect x="24" y="4" width="16" height="12" rx="3" fill="#d97757"/>
      <circle class="eye left"  cx="28.5" cy="10" r="1.6" fill="#1a1a1a"/>
      <circle class="eye right" cx="35.5" cy="10" r="1.6" fill="#1a1a1a"/>
      <path class="smile" d="M 29 12.5 Q 32 14.5 35 12.5" stroke="#1a1a1a" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.7"/>
      <rect x="22" y="16" width="20" height="12" rx="2.5" fill="#d97757"/>
      <rect x="16" y="30" width="32" height="12" rx="1.5" fill="#2a2a2a" stroke="#444"/>
      <rect x="18" y="32" width="28" height="8" fill="#1e2636"/>
      <path d="M 10 42 L 54 42 L 58 46 L 6 46 Z" fill="#333"/>
      <rect x="30" y="43" width="4" height="1" rx="0.5" fill="#555"/>
      <rect class="arm arm-left"  x="18.5" y="22" width="3" height="10" rx="1.2" fill="#d97757"/>
      <rect class="arm arm-wave"  x="42.5" y="22" width="3" height="10" rx="1.2" fill="#d97757"/>`;
    welcome.append(robot);
    const h1 = el("h1", "", "Hi, how can I help you?");
    const sub = el("p", "welcome-sub", "Type a message to start, or pick a previous chat from the sidebar.");
    const shortcuts = el("div", "shortcuts");
    shortcuts.innerHTML = `
      <div><kbd>Ctrl</kbd>+<kbd>L</kbd> new chat</div>
      <div><kbd>Ctrl</kbd>+<kbd>T</kbd> new tab</div>
      <div><kbd>Ctrl</kbd>+<kbd>K</kbd> search chats</div>
      <div><kbd>Ctrl</kbd>+<kbd>W</kbd> close tab</div>
      <div><kbd>Ctrl</kbd>+<kbd>B</kbd> toggle sidebar</div>
      <div><kbd>Esc</kbd> stop generation</div>
      <div><kbd>↑</kbd> edit last message</div>`;
    welcome.append(h1, sub, shortcuts);
    t.messagesEl.appendChild(welcome);
  } else {
    // Re-ensure id for CSS selectors that target #messages
    t.messagesEl.id = "messages";
  }
  container.appendChild(t.messagesEl);
  attachScrollWatcher(t);

  // Restore the scroll position for this tab (detaching resets scrollTop to 0).
  // If we have no saved position yet, anchor to the bottom so the latest message is visible.
  {
    const box = t.messagesEl;
    const target = (typeof t.scrollTop === "number") ? t.scrollTop : box.scrollHeight;
    requestAnimationFrame(() => {
      box.scrollTop = target;
      requestAnimationFrame(() => {
        box.scrollTop = target;
        // Sync autoScroll and button state to what the user is actually looking at.
        t.autoScroll = isNearBottom(box);
        if (t.autoScroll) t.unseenReply = false;
        updateScrollButton();
      });
    });
  }

  // Restore chrome state from tab
  $("#input").value = t.composerInputValue || "";
  autosizeInput();
  $("#model-select").value = t.model;
  $("#effort-select").value = t.effort;
  if ($("#permission-mode")) $("#permission-mode").value = t.permissionMode;
  if (t.usage) applyUsage(t.usage); else resetUsage();
  // Send/stop button
  if (t.streaming) { $("#send-btn").classList.add("hidden"); $("#stop-btn").classList.remove("hidden"); $("#compact-btn").disabled = true; }
  else { $("#send-btn").classList.remove("hidden"); $("#stop-btn").classList.add("hidden"); $("#compact-btn").disabled = false; }
  renderTabs();
  renderAttachments();
  renderSessionsFiltered(); // refresh "active" highlighting
  updateTypingBarForActiveTab();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const t = state.tabs[idx];
  await window.pywebview.api.close_tab(id).catch(() => {});
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) switchToTab(next.id);
    else openNewTab();
  }
  renderTabs();
}

// ---------- Open a session from the sidebar ----------
// Rules:
//  1. If the session is already loaded in a tab, switch to that tab.
//  2. Else if the active tab is empty and idle, reuse it (preserves the
//     common "open app → click session" flow).
//  3. Else open in a new tab — never hijack a tab that is streaming or
//     already holds a different conversation.
async function openSessionFromSidebar(projectId, sessionId, sessionTitle) {
  const existing = state.tabs.find(t => t.sessionId === sessionId);
  if (existing) { switchToTab(existing.id); return; }
  const a = activeTab();
  const canReuse = a && !a.streaming && !a.sessionId && (!a.currentAssistantText) && (a.title === "New chat" || !a.title);
  if (!canReuse) openNewTab();
  await openSessionInActiveTab(projectId, sessionId, sessionTitle);
}

// ---------- Open a session in the active tab ----------
async function openSessionInActiveTab(projectId, sessionId, sessionTitle) {
  let t = activeTab();
  if (!t) { openNewTab(); t = activeTab(); }
  const data = await window.pywebview.api.get_session(projectId, sessionId);
  t.projectId = projectId;
  t.sessionId = sessionId;
  t.lastUserText = [...data.messages].reverse().find(m => m.role === "user")?.text || "";
  // Prefer the session title from the sidebar (respects custom renames),
  // fall back to the first user message.
  if (sessionTitle) {
    t.title = sessionTitle;
  } else {
    const firstUser = data.messages.find(m => m.role === "user");
    t.title = (firstUser?.text || "Conversation").slice(0, 40);
  }
  // Replace messages DOM with rendered history
  const newBox = el("div", "messages");
  newBox.id = "messages";
  data.messages.forEach((m) => newBox.appendChild(buildMessageNode(m)));
  t.messagesEl = newBox;
  t.usage = data.usage ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null;
  const container = $("#messages-container");
  container.innerHTML = "";
  container.appendChild(newBox);
  attachScrollWatcher(t);
  t.autoScroll = true;
  t.unseenReply = false;
  // Defer scroll until after layout so scrollHeight reflects the rendered content.
  // Double rAF covers late layout from code blocks, diffs, and avatar images.
  requestAnimationFrame(() => {
    newBox.scrollTop = newBox.scrollHeight;
    requestAnimationFrame(() => {
      newBox.scrollTop = newBox.scrollHeight;
      updateScrollButton();
    });
  });
  if (t.usage) applyUsage(t.usage); else resetUsage();
  await window.pywebview.api.resume_conversation(t.id, t.cwd, sessionId, t.model || null, t.effort || null, t.permissionMode);
  renderTabs();
  renderSessionsFiltered();
}

function buildMessageNode(m) {
  const wrap = el("div", "msg-wrap");
  const msg = el("div", `msg ${m.role}`);
  const avatar = el("div", "avatar");
  if (m.role === "assistant") {
    const img = document.createElement("img");
    img.src = "claude-logo.png"; img.alt = ""; img.className = "avatar-img";
    avatar.appendChild(img);
  } else { avatar.textContent = "U"; }
  const body = el("div", "body");
  if (m.role === "assistant" && m.tools && m.tools.length) {
    m.tools.forEach((t) => body.appendChild(renderToolCall(t.name, t.input)));
  }
  if (m.text) body.innerHTML += renderMarkdown(m.text);
  msg.append(avatar, body);
  if (m.role === "user") {
    const editBtn = el("button", "edit-btn", "Edit");
    editBtn.addEventListener("click", () => { $("#input").value = m.text; autosizeInput(); $("#input").focus(); });
    msg.append(editBtn);
  }
  wrap.appendChild(msg);
  return wrap;
}

// ---------- Markdown via marked + hljs ----------
if (window.marked) {
  marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
  const renderer = new marked.Renderer();
  renderer.code = (code, lang) => {
    const raw = typeof code === "object" ? code.text : code;
    const language = (typeof code === "object" ? code.lang : lang) || "";
    let html = raw;
    try {
      if (language && window.hljs && hljs.getLanguage(language)) {
        html = hljs.highlight(raw, { language, ignoreIllegals: true }).value;
      } else if (window.hljs) {
        html = hljs.highlightAuto(raw).value;
      } else {
        html = escapeHtml(raw);
      }
    } catch { html = escapeHtml(raw); }
    const langLabel = language ? `<div class="code-lang">${escapeHtml(language)}</div>` : "";
    const rawB64 = btoa(unescape(encodeURIComponent(raw)));
    return `<div class="code-block" data-raw="${rawB64}">${langLabel}<button class="code-copy-btn">Copy</button><pre><code class="hljs language-${escapeHtml(language)}">${html}</code></pre></div>`;
  };
  marked.use({ renderer });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkdown(md) {
  if (!md) return "";
  if (!window.marked) return escapeHtml(md).replace(/\n/g, "<br>");
  try { return marked.parse(md); } catch { return escapeHtml(md).replace(/\n/g, "<br>"); }
}

// ---------- Tool call / result rendering ----------
function formatToolInput(inp) {
  if (!inp) return "";
  try { return JSON.stringify(inp, null, 2); } catch { return ""; }
}
function makeCollapsible(fullText, className, previewChars = TOOL_PREVIEW_CHARS) {
  const wrap = el("div", className);
  const needsToggle = fullText.length > previewChars || fullText.includes("\n");
  if (!needsToggle) { wrap.textContent = fullText; return wrap; }
  const preview = fullText.slice(0, previewChars).replace(/\n/g, " ");
  const contentEl = el("div", "collapsible-content collapsed");
  contentEl.textContent = preview + (fullText.length > previewChars ? "…" : "");
  const fullEl = el("div", "collapsible-content full hidden");
  fullEl.textContent = fullText;
  const btn = el("button", "show-more-btn", "Show more");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = !contentEl.classList.contains("hidden");
    if (isCollapsed) { contentEl.classList.add("hidden"); fullEl.classList.remove("hidden"); btn.textContent = "Show less"; }
    else { contentEl.classList.remove("hidden"); fullEl.classList.add("hidden"); btn.textContent = "Show more"; }
  });
  wrap.append(contentEl, fullEl, btn);
  return wrap;
}

function renderToolCall(name, input) {
  if ((name === "Edit" || name === "Write" || name === "MultiEdit") && input) {
    return renderDiffCall(name, input);
  }
  const block = el("div", "tool-call");
  const header = el("div", "tool-head");
  header.appendChild(el("span", "tool-name", name || "tool"));
  block.appendChild(header);
  const body = makeCollapsible(formatToolInput(input), "tool-body");
  block.appendChild(body);
  return block;
}

function renderDiffCall(name, input) {
  const block = el("div", "diff-block");
  const head = el("div", "diff-head");
  const pathSpan = el("span", "path", input.file_path || "(file)");
  head.appendChild(el("span", "", `${name} · `));
  head.appendChild(pathSpan);
  block.appendChild(head);
  const body = el("div", "diff-body");
  if (name === "Write") renderDiffLines(body, "", input.content || "");
  else if (name === "Edit") renderDiffLines(body, input.old_string || "", input.new_string || "");
  else if (name === "MultiEdit") (input.edits || []).forEach((e, i) => {
    if (i > 0) body.appendChild(el("div", "diff-line ctx", "───"));
    renderDiffLines(body, e.old_string || "", e.new_string || "");
  });
  block.appendChild(body);
  return block;
}
function renderDiffLines(container, oldText, newText) {
  oldText.split("\n").forEach(l => {
    if (l === "" && oldText === "") return;
    const row = el("div", "diff-line del");
    row.appendChild(el("span", "marker", "-"));
    row.appendChild(document.createTextNode(l));
    container.appendChild(row);
  });
  newText.split("\n").forEach(l => {
    const row = el("div", "diff-line ins");
    row.appendChild(el("span", "marker", "+"));
    row.appendChild(document.createTextNode(l));
    container.appendChild(row);
  });
}

// ---------- Scroll / auto-follow ----------
const NEAR_BOTTOM_PX = 40; // tolerance for "pinned to bottom"

function isNearBottom(box) {
  if (!box) return true;
  return (box.scrollHeight - box.scrollTop - box.clientHeight) <= NEAR_BOTTOM_PX;
}

function scrollToBottom(box, smooth) {
  if (!box) return;
  if (smooth) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  else box.scrollTop = box.scrollHeight;
}

// Called after appending content inside a tab's messages DOM.
// Only auto-scrolls if the user is still pinned to the bottom for that tab.
function maybeAutoScroll(t) {
  if (!t || !t.messagesEl) return;
  if (t.autoScroll) {
    t.messagesEl.scrollTop = t.messagesEl.scrollHeight;
  } else if (t.id === state.activeTabId) {
    // User is reading scrollback — surface the jump-down button.
    updateScrollButton();
  }
}

function attachScrollWatcher(t) {
  const box = t.messagesEl;
  if (!box || box.__scrollWatcherAttached) return;
  box.__scrollWatcherAttached = true;
  box.addEventListener("scroll", () => {
    const near = isNearBottom(box);
    t.autoScroll = near;
    if (near) {
      // Back at the bottom — clear the unseen-reply badge.
      t.unseenReply = false;
    }
    if (t.id === state.activeTabId) updateScrollButton();
  });
}

function updateScrollButton() {
  const btn = $("#scroll-to-bottom");
  const badge = btn?.querySelector(".scroll-badge");
  const t = activeTab();
  if (!btn || !t) return;
  // Show the button whenever the active tab isn't pinned to the bottom.
  const show = !t.autoScroll && t.messagesEl && !isNearBottom(t.messagesEl);
  btn.classList.toggle("hidden", !show);
  if (badge) badge.classList.toggle("hidden", !t.unseenReply);
}

// ---------- Turn handling (per-tab) ----------
function ensureWelcomeHiddenInTab(t) {
  const w = t.messagesEl?.querySelector(".welcome");
  if (w) w.remove();
}

function startAssistantBubble(t) {
  ensureWelcomeHiddenInTab(t);
  const wrap = el("div", "msg-wrap");
  const msg = el("div", "msg assistant");
  const avatar = el("div", "avatar");
  const img = document.createElement("img");
  img.src = "claude-logo.png"; img.alt = ""; img.className = "avatar-img";
  avatar.appendChild(img);
  const body = el("div", "body");
  body.innerHTML = '<span class="cursor">▍</span>';
  msg.append(avatar, body);
  wrap.appendChild(msg);
  t.messagesEl.appendChild(wrap);
  maybeAutoScroll(t);
  t.currentAssistantEl = body;
  t.currentAssistantText = "";
}

function clearThinkingIndicator(t) {
  if (t.thinkingWrap) t.thinkingWrap.remove();
  t.thinkingEl = null;
  t.thinkingWrap = null;
}

function showTypingBar() { $("#typing-bar").classList.remove("hidden"); }
function hideTypingBar() { $("#typing-bar").classList.add("hidden"); }
function hideTypingBarIfAllDone() {
  const t = activeTab();
  if (!t || !t.streaming) hideTypingBar();
}
function updateTypingBarForActiveTab() {
  const t = activeTab();
  if (t && t.streaming) showTypingBar();
  else hideTypingBar();
}

function appendAssistantText(t, text) {
  if (!t.currentAssistantEl) startAssistantBubble(t);
  // Close thinking block — we're now speaking to the user.
  t.thinkingBlockEl = null;
  t.currentAssistantText += text;
  scheduleAssistantRender(t);
  if (t.id === state.activeTabId) maybeAutoScroll(t);
  if (t.id !== state.activeTabId) { t.unread = true; renderTabs(); }
}

// Coalesce many deltas-per-second into one rAF paint.
// Without this, every tiny token re-parses the whole message and re-runs
// highlight.js — O(n²) over the length of a long reply.
function scheduleAssistantRender(t) {
  if (t.renderQueued) return;
  t.renderQueued = true;
  requestAnimationFrame(() => {
    t.renderQueued = false;
    if (!t.currentAssistantEl) return;
    // Preserve any thinking block child — it's a separate DOM artifact.
    const existingThinking = t.currentAssistantEl.querySelector(".thinking-block");
    t.currentAssistantEl.innerHTML = renderMarkdown(t.currentAssistantText) + '<span class="cursor">▍</span>';
    if (existingThinking) t.currentAssistantEl.insertBefore(existingThinking, t.currentAssistantEl.firstChild);
  });
}

function appendThinkingText(t, text) {
  if (!t.currentAssistantEl) startAssistantBubble(t);
  if (!t.thinkingBlockEl || !t.currentAssistantEl.contains(t.thinkingBlockEl)) {
    // Create a new thinking block at the top of the current assistant bubble
    // (before any already-streamed user-facing text).
    const block = el("div", "thinking-block");
    const head = el("div", "thinking-head");
    head.innerHTML = '<span class="thinking-icon">✦</span><span class="thinking-label">Thinking…</span><span class="thinking-toggle">hide</span>';
    const body = el("div", "thinking-body");
    body.textContent = "";
    block.append(head, body);
    head.addEventListener("click", () => {
      block.classList.toggle("collapsed");
      head.querySelector(".thinking-toggle").textContent = block.classList.contains("collapsed") ? "show" : "hide";
    });
    // Place it where the cursor is / at the start of the bubble so far
    t.currentAssistantEl.insertBefore(block, t.currentAssistantEl.firstChild);
    t.thinkingBlockEl = body;
    t.thinkingContainer = block;
  }
  t.thinkingBlockEl.textContent += text;
  if (t.id === state.activeTabId) maybeAutoScroll(t);
}

function addToolCall(t, name, input) {
  if (!t.currentAssistantEl) startAssistantBubble(t);
  t.currentAssistantEl.appendChild(renderToolCall(name, input));
  if (t.id === state.activeTabId) maybeAutoScroll(t);
}
function addToolResult(t, text) {
  if (!t.currentAssistantEl) return;
  const block = el("div", "tool-result");
  const header = el("div", "tool-head");
  header.appendChild(el("span", "tool-name", "result"));
  block.appendChild(header);
  block.appendChild(makeCollapsible(text, "tool-body"));
  t.currentAssistantEl.appendChild(block);
  if (t.id === state.activeTabId) maybeAutoScroll(t);
}
function addError(t, msg) {
  ensureWelcomeHiddenInTab(t);
  const wrap = el("div", "msg-wrap");
  const e = el("div", "err-msg", msg);
  wrap.appendChild(e);
  t.messagesEl.appendChild(wrap);
  if (t.id === state.activeTabId) maybeAutoScroll(t);
}

function finishAssistantTurn(t) {
  // Finalize thinking block if present (change label from "Thinking…" to "Thought").
  if (t.thinkingContainer) {
    const label = t.thinkingContainer.querySelector(".thinking-label");
    if (label) label.textContent = "Thought";
  }
  t.thinkingBlockEl = null;
  t.thinkingContainer = null;
  if (t.currentAssistantEl) {
    // Re-render without the cursor but preserve any thinking block at the top.
    const existingThinking = t.currentAssistantEl.querySelector(".thinking-block");
    t.currentAssistantEl.innerHTML = renderMarkdown(t.currentAssistantText);
    if (existingThinking) t.currentAssistantEl.insertBefore(existingThinking, t.currentAssistantEl.firstChild);
  }
  clearThinkingIndicator(t);
  // Hide typing bar only if no other tabs are streaming.
  if (t.id === state.activeTabId) hideTypingBarIfAllDone();
  // If the user was scrolled up while Claude finished, flag the reply as unseen.
  if (!t.autoScroll) t.unseenReply = true;
  t.currentAssistantEl = null;
  t.currentAssistantText = "";
  t.streamedViaDelta = false;
  t.streaming = false;
  if (t.id === state.activeTabId) {
    $("#send-btn").classList.remove("hidden");
    $("#stop-btn").classList.add("hidden");
    $("#compact-btn").disabled = false;
    updateScrollButton();
  }
  renderTabs();
  refreshSessions();
}

function addUserBubble(t, text) {
  ensureWelcomeHiddenInTab(t);
  t.lastUserText = text;
  const wrap = el("div", "msg-wrap");
  const msg = el("div", "msg user");
  const avatar = el("div", "avatar", "U");
  const body = el("div", "body");
  body.innerHTML = renderMarkdown(text);
  if (t.attachments.length) {
    const atts = el("div", "");
    atts.style.display = "flex"; atts.style.gap = "6px"; atts.style.marginTop = "8px";
    t.attachments.forEach(a => {
      const img = document.createElement("img");
      img.src = a.b64; img.style.maxWidth = "120px"; img.style.borderRadius = "6px";
      atts.appendChild(img);
    });
    body.appendChild(atts);
  }
  const editBtn = el("button", "edit-btn", "Edit");
  editBtn.addEventListener("click", () => {
    $("#input").value = text; autosizeInput(); $("#input").focus();
  });
  msg.append(avatar, body, editBtn);
  wrap.appendChild(msg);
  t.messagesEl.appendChild(wrap);
  // Sending a message is an explicit intent to follow the conversation.
  t.autoScroll = true;
  t.unseenReply = false;
  t.messagesEl.scrollTop = t.messagesEl.scrollHeight;
  updateScrollButton();
}

// ---------- Usage meter ----------
// Tolerant number coercion — the CLI sometimes emits objects (e.g.
// `cache_creation: {ephemeral_5m_input_tokens: 123}`) or missing fields.
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    // Sum any numeric leaves (handles the nested cache_creation shape).
    let s = 0;
    for (const k of Object.keys(v)) s += num(v[k]);
    return s;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function applyUsage(u) {
  if (!u) return;
  const total = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  if (!Number.isFinite(total) || total < 0) { resetUsage(); return; }
  const pct = Math.min(100, Math.round((total / CONTEXT_WINDOW) * 100));
  const fill = $("#meter-fill");
  fill.style.width = pct + "%";
  fill.classList.remove("warn", "danger");
  if (pct > 85) fill.classList.add("danger");
  else if (pct > 65) fill.classList.add("warn");
  $("#meter-text").textContent = `${formatTokens(total)} / 200k`;
}
function resetUsage() { $("#meter-fill").style.width = "0%"; $("#meter-text").textContent = "0 / 200k"; $("#meter-fill").classList.remove("warn","danger"); }
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

// ---------- Slash autocomplete ----------
function updateSlashPopup() {
  const input = $("#input");
  const txt = input.value;
  const popup = $("#slash-popup");
  const m = txt.match(/^\/(\S*)$/);
  if (!m) { popup.classList.add("hidden"); return; }
  const q = m[1].toLowerCase();
  state.slashFiltered = state.slashCommands.filter(c => c.name.slice(1).toLowerCase().includes(q));
  if (!state.slashFiltered.length) { popup.classList.add("hidden"); return; }
  state.slashIndex = 0;
  renderSlashPopup();
  popup.classList.remove("hidden");
}
function renderSlashPopup() {
  const popup = $("#slash-popup");
  popup.innerHTML = "";
  state.slashFiltered.slice(0, 30).forEach((c, i) => {
    const item = el("div", "slash-item");
    if (i === state.slashIndex) item.classList.add("active");
    item.appendChild(el("span", "cmd", c.name));
    item.appendChild(el("span", "desc", c.description || ""));
    if (c.source) item.appendChild(el("span", "badge", c.source));
    item.addEventListener("mousedown", (e) => { e.preventDefault(); acceptSlash(i); });
    popup.appendChild(item);
  });
}
function acceptSlash(i) {
  const choice = state.slashFiltered[i]; if (!choice) return;
  $("#input").value = choice.name + " ";
  $("#slash-popup").classList.add("hidden"); autosizeInput(); $("#input").focus();
}

// ---------- Input ----------
function autosizeInput() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(260, ta.scrollHeight) + "px";
}

async function send() {
  const t = activeTab(); if (!t || t.streaming) return;
  const input = $("#input");
  const text = input.value.trim();
  if (!text && !t.attachments.length) return;
  addUserBubble(t, text);
  t.streaming = true;
  // Only derive a title from the first message of a brand-new tab.
  // Don't overwrite an existing session's name (especially from commands like /compact).
  if (!t.sessionId && (!t.title || t.title === "New chat")) {
    t.title = text.slice(0, 40) || t.title;
  }
  renderTabs();
  $("#send-btn").classList.add("hidden");
  $("#stop-btn").classList.remove("hidden");
  $("#compact-btn").disabled = true;
  showTypingBar();
  if (!t.sessionId) {
    await window.pywebview.api.start_conversation(t.id, t.cwd, t.model || null, t.effort || null, t.permissionMode);
  } else {
    await window.pywebview.api.update_runner_settings(t.id, t.model || null, t.effort || null, t.permissionMode);
  }
  const imgs = t.attachments.map(a => a.b64);
  await window.pywebview.api.send_message(t.id, text, imgs);
  input.value = "";
  t.attachments = [];
  renderAttachments();
  autosizeInput();
  renderTabs();
}

function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  const t = activeTab(); if (!t) return;
  t.attachments.forEach((a, i) => {
    const chip = el("div", "attachment-chip");
    const img = document.createElement("img"); img.src = a.b64;
    chip.appendChild(img);
    const rm = el("button", "remove", "×");
    rm.addEventListener("click", () => { t.attachments.splice(i, 1); renderAttachments(); });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

function handleFiles(files) {
  const t = activeTab(); if (!t) return;
  Array.from(files).forEach(f => {
    if (!f.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      t.attachments.push({ b64: reader.result, name: f.name });
      renderAttachments();
    };
    reader.readAsDataURL(f);
  });
}

function wireUI() {
  const input = $("#input");

  input.addEventListener("input", () => { autosizeInput(); updateSlashPopup(); });
  input.addEventListener("keydown", (e) => {
    const popup = $("#slash-popup");
    if (!popup.classList.contains("hidden")) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.slashIndex = Math.min(state.slashFiltered.length - 1, state.slashIndex + 1); renderSlashPopup(); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); state.slashIndex = Math.max(0, state.slashIndex - 1); renderSlashPopup(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(state.slashIndex); return; }
      if (e.key === "Escape") { popup.classList.add("hidden"); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === "ArrowUp" && !input.value.trim()) {
      const t = activeTab();
      if (t && t.lastUserText) {
        e.preventDefault();
        input.value = t.lastUserText; autosizeInput();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  });

  input.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    let handled = false;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) { handleFiles([blob]); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  });

  ["dragover","drop"].forEach(evn => document.addEventListener(evn, (e) => e.preventDefault()));
  document.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

  $("#attach-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#attach-menu");
    menu.classList.toggle("hidden");
  });
  $("#file-input").addEventListener("change", (e) => handleFiles(e.target.files));
  $("#attach-menu").addEventListener("click", async (e) => {
    const item = e.target.closest(".attach-menu-item");
    if (!item) return;
    $("#attach-menu").classList.add("hidden");
    const action = item.dataset.action;
    if (action === "upload") {
      $("#file-input").click();
    } else if (action === "screenshot") {
      await takeScreenshot();
    }
  });
  // Clicks outside the attach menu close it.
  document.addEventListener("click", (e) => {
    const menu = $("#attach-menu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (e.target.closest("#attach-menu") || e.target.closest("#attach-btn")) return;
    menu.classList.add("hidden");
  });

  $("#send-btn").addEventListener("click", send);
  $("#stop-btn").addEventListener("click", async () => {
    const t = activeTab(); if (!t) return;
    await window.pywebview.api.interrupt(t.id);
    finishAssistantTurn(t);
  });

  $("#new-chat").addEventListener("click", openNewTab);
  $("#new-tab-btn").addEventListener("click", openNewTab);
  $("#collapse-sidebar").addEventListener("click", toggleSidebar);
  $("#expand-sidebar").addEventListener("click", toggleSidebar);

  $("#pick-cwd").addEventListener("click", pickCwd);
  $("#cwd-display").addEventListener("click", pickCwd);

  $("#model-select").addEventListener("change", async (e) => {
    const t = activeTab(); if (!t) return;
    t.model = e.target.value;
    patchSettings({ model: t.model });
    await window.pywebview.api.update_runner_settings(t.id, t.model || null, t.effort || null, t.permissionMode);
  });
  $("#effort-select").addEventListener("change", async (e) => {
    const t = activeTab(); if (!t) return;
    t.effort = e.target.value;
    patchSettings({ effort: t.effort });
    await window.pywebview.api.update_runner_settings(t.id, t.model || null, t.effort || null, t.permissionMode);
  });

  const search = $("#session-search");
  search.addEventListener("input", (e) => { state.searchQuery = e.target.value; renderSessionsFiltered(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; state.searchQuery = ""; renderSessionsFiltered(); $("#input").focus(); }
  });

  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#auth-login-btn").addEventListener("click", triggerAuthLogin);
  $("#compact-btn").addEventListener("click", runCompact);

  $("#theme-reset-btn").addEventListener("click", resetTheme);
  $("#theme-font").addEventListener("change", (e) => {
    const t = loadTheme(); t["--font"] = e.target.value; saveTheme(t);
    document.documentElement.style.setProperty("--font", e.target.value);
  });
  $("#theme-code-font").addEventListener("change", (e) => {
    const t = loadTheme(); t["--code-font"] = e.target.value; saveTheme(t);
    document.documentElement.style.setProperty("--code-font", e.target.value);
  });

  $("#scroll-to-bottom").addEventListener("click", () => {
    const t = activeTab(); if (!t || !t.messagesEl) return;
    t.autoScroll = true;
    t.unseenReply = false;
    scrollToBottom(t.messagesEl, true);
    updateScrollButton();
  });
  $("#auth-banner-btn").addEventListener("click", triggerAuthLogin);
  $("#auth-banner-dismiss").addEventListener("click", () => $("#auth-banner").classList.add("hidden"));
  $("#update-banner-btn").addEventListener("click", async () => {
    const banner = $("#update-banner");
    const url = banner.dataset.url || "https://github.com/romanchernyaev/ClaudeCodeUI/releases/latest";
    try { await window.pywebview.api.open_external_url(url); } catch {}
  });
  $("#update-banner-dismiss").addEventListener("click", () => {
    const banner = $("#update-banner");
    const latest = banner.dataset.latest || "";
    if (latest) {
      try { localStorage.setItem(UPDATE_DISMISS_KEY, latest); } catch {}
    }
    banner.classList.add("hidden");
  });
  $("#permission-mode").addEventListener("change", async (e) => {
    const t = activeTab(); if (!t) return;
    t.permissionMode = e.target.value;
    patchSettings({ permissionMode: t.permissionMode });
    await window.pywebview.api.update_runner_settings(t.id, t.model || null, t.effort || null, t.permissionMode);
  });

  // Copy-code (delegated)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".code-copy-btn");
    if (!btn) return;
    const block = btn.closest(".code-block");
    if (!block) return;
    const rawB64 = block.dataset.raw || "";
    let raw = "";
    try { raw = decodeURIComponent(escape(atob(rawB64))); } catch { raw = block.innerText; }
    navigator.clipboard.writeText(raw).then(() => {
      btn.textContent = "Copied!"; btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1200);
    }).catch(() => { btn.textContent = "Failed"; });
  });

  // Global shortcuts
  document.addEventListener("keydown", (e) => {
    const inSettings = !$("#settings-panel").classList.contains("hidden");
    const inConfirm = !!document.querySelector(".confirm-backdrop");
    if (e.key === "Escape") {
      if (inConfirm) return; // let modal handle
      if (inSettings) { closeSettings(); return; }
      const t = activeTab();
      if (t?.streaming) { $("#stop-btn").click(); return; }
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); openNewTab(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "t") { e.preventDefault(); openNewTab(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      const t = activeTab(); if (t) closeTab(t.id);
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); return; }
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      if (!state.tabs.length) return;
      const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
      const next = (idx + (e.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length;
      switchToTab(state.tabs[next].id);
    }
  });
}

async function pickCwd() {
  const chosen = await window.pywebview.api.pick_directory();
  if (!chosen) return;
  state.cwd = chosen;
  patchSettings({ cwd: chosen });
  $("#cwd-display").textContent = shortenPath(chosen);
  state.slashCommands = await window.pywebview.api.get_slash_commands(state.cwd);
  const t = activeTab(); if (t) {
    t.cwd = chosen;
    t.sessionId = null;
    await window.pywebview.api.start_conversation(t.id, t.cwd, t.model || null, t.effort || null, t.permissionMode);
  }
  await refreshSessions();
}

// ---------- Theme customizer ----------
const THEME_STORAGE_KEY = "claudecodeui.theme.v1";
const THEME_DEFAULTS = {
  "--bg":           "#1b1b1b",
  "--bg-2":         "#202020",
  "--bg-3":         "#262626",
  "--bg-hover":     "#2c2c2c",
  "--border":       "#333333",
  "--text":         "#ececec",
  "--text-dim":     "#a0a0a0",
  "--text-faint":   "#707070",
  "--accent":       "#d97757",
  "--accent-2":     "#b85f3d",
  "--user-bubble":  "#2b2b2b",
  "--code-bg":      "#111111",
  "--error":        "#ff6e6e",
  "--tool":         "#8fb8f5",
  "--link":         "#9cc4ff",
  "--thinking":     "#a0a0a0",
};
const THEME_COLOR_LABELS = {
  "--bg":           "Background (main)",
  "--bg-2":         "Panel background",
  "--bg-3":         "Input / chip background",
  "--bg-hover":     "Hover background",
  "--border":       "Borders",
  "--text":         "Text (primary)",
  "--text-dim":     "Text (dimmed)",
  "--text-faint":   "Text (faint)",
  "--accent":       "Accent / primary",
  "--accent-2":     "Accent (hover)",
  "--user-bubble":  "Your message bubble",
  "--code-bg":      "Code block background",
  "--error":        "Error / destructive",
  "--tool":         "Tool call accent",
  "--link":         "Links",
  "--thinking":     "Thinking text",
};
const FONT_OPTIONS = [
  { label: "System UI (default)", value: `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` },
  { label: "Segoe UI",            value: `"Segoe UI", Arial, sans-serif` },
  { label: "Inter",               value: `Inter, "Segoe UI", sans-serif` },
  { label: "Helvetica Neue",      value: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { label: "Georgia (serif)",     value: `Georgia, "Times New Roman", serif` },
  { label: "Cambria (serif)",     value: `Cambria, Georgia, serif` },
  { label: "Verdana",             value: `Verdana, Geneva, sans-serif` },
  { label: "Courier New",         value: `"Courier New", Courier, monospace` },
];
const CODE_FONT_OPTIONS = [
  { label: "Cascadia Code (default)", value: `"Cascadia Code", "Consolas", "SF Mono", monospace` },
  { label: "Consolas",                value: `"Consolas", monospace` },
  { label: "Fira Code",               value: `"Fira Code", "Consolas", monospace` },
  { label: "JetBrains Mono",          value: `"JetBrains Mono", "Consolas", monospace` },
  { label: "Courier New",             value: `"Courier New", Courier, monospace` },
  { label: "Menlo",                   value: `Menlo, "Consolas", monospace` },
];
const FONT_DEFAULT = FONT_OPTIONS[0].value;
const CODE_FONT_DEFAULT = CODE_FONT_OPTIONS[0].value;

function loadTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme)); } catch {}
}
function applyTheme(theme) {
  const root = document.documentElement;
  for (const key of Object.keys(THEME_DEFAULTS)) {
    const val = theme[key] || THEME_DEFAULTS[key];
    root.style.setProperty(key, val);
  }
  root.style.setProperty("--font", theme["--font"] || FONT_DEFAULT);
  root.style.setProperty("--code-font", theme["--code-font"] || CODE_FONT_DEFAULT);
}
function initTheme() {
  applyTheme(loadTheme());
}
function renderThemeEditor() {
  const theme = loadTheme();
  const colorsBox = $("#theme-colors");
  if (!colorsBox) return;
  colorsBox.innerHTML = "";
  for (const key of Object.keys(THEME_DEFAULTS)) {
    const current = theme[key] || THEME_DEFAULTS[key];
    const row = el("div", "theme-color-row");
    const label = el("div", "theme-color-label", THEME_COLOR_LABELS[key] || key);
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = normalizeHex(current);
    const hex = el("div", "theme-hex", picker.value);
    picker.addEventListener("input", () => {
      const v = picker.value;
      hex.textContent = v;
      const t = loadTheme();
      t[key] = v;
      saveTheme(t);
      document.documentElement.style.setProperty(key, v);
    });
    row.append(label, picker, hex);
    colorsBox.appendChild(row);
  }
  // Fonts
  const fontSel = $("#theme-font");
  const codeSel = $("#theme-code-font");
  if (fontSel && !fontSel.options.length) {
    FONT_OPTIONS.forEach(o => fontSel.add(new Option(o.label, o.value)));
  }
  if (codeSel && !codeSel.options.length) {
    CODE_FONT_OPTIONS.forEach(o => codeSel.add(new Option(o.label, o.value)));
  }
  if (fontSel) fontSel.value = theme["--font"] || FONT_DEFAULT;
  if (codeSel) codeSel.value = theme["--code-font"] || CODE_FONT_DEFAULT;
}
function normalizeHex(v) {
  if (!v) return "#000000";
  v = String(v).trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return "#" + v.slice(1).split("").map(c => c + c).join("");
  }
  // Handle named colors / rgb(...) by drawing into a canvas.
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillStyle = v;
    return ctx.fillStyle;
  } catch { return "#000000"; }
}
function resetTheme() {
  localStorage.removeItem(THEME_STORAGE_KEY);
  applyTheme({});
  renderThemeEditor();
}

function openSettings() {
  let bd = document.querySelector(".settings-backdrop");
  if (!bd) {
    bd = el("div", "settings-backdrop");
    bd.addEventListener("click", closeSettings);
    document.body.appendChild(bd);
  }
  const t = activeTab();
  if (t) $("#permission-mode").value = t.permissionMode;
  window.pywebview.api.get_status().then(s => { $("#settings-cli-path").textContent = s.cli || "(not found)"; });
  checkAuthAndShowBanner();
  renderThemeEditor();
  $("#settings-panel").classList.remove("hidden");
}
function closeSettings() {
  $("#settings-panel").classList.add("hidden");
  const bd = document.querySelector(".settings-backdrop"); if (bd) bd.remove();
}

init();
