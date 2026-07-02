// Runs inside the webview. Talks to the extension host via postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const emptyEl = document.getElementById("empty");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");
  const newChatBtn = document.getElementById("new-chat");
  const reloadBtn = document.getElementById("reload");
  const targetToggle = document.getElementById("target-toggle");
  const modelSelect = document.getElementById("model-select");
  const signinContainer = document.getElementById("signin-container");
  const signinBtn = document.getElementById("signin-btn");
  let currentModel = "";
  const historyBtn = document.getElementById("history");
  const historyPanel = document.getElementById("history-panel");
  const historyList = document.getElementById("history-list");
  const historyClose = document.getElementById("history-close");
  const statusEl = document.getElementById("status");
  const agentModeEl = document.getElementById("agentMode");
  const autoApproveWritesEl = document.getElementById("autoApproveWrites");
  const autopilotModeEl = document.getElementById("autopilotMode");
  const slashMenuEl = document.getElementById("slash-menu");

  // Slash commands provided by the host as a JSON script tag.
  let slashCommands = [];
  try {
    slashCommands = JSON.parse(document.getElementById("slash-data")?.textContent || "[]");
  } catch {
    slashCommands = [];
  }
  let slashActive = -1; // highlighted index in the open menu, -1 = none
  let menuMode = "slash"; // "slash" (commands) or "file" (@-mentions)

  let streaming = false;
  let currentBubble = null; // the assistant bubble being streamed into
  let currentRaw = "";      // accumulated raw markdown for the streaming bubble
  let lastAssistantBubble = null; // last finalized assistant bubble (for regenerate)
  let pendingEditResend = false;  // next send() is an edit-and-resend, not a new turn
  // Terminal-style prompt history: ↑ recalls previous prompts, ↓ goes forward.
  const promptHistory = [];
  let histIndex = -1;   // -1 = not navigating (showing the live draft)
  let histDraft = "";   // the in-progress text saved when you start scrolling back

  function setStreaming(on) {
    streaming = on;
    sendBtn.style.display = on ? "none" : "";
    stopBtn.style.display = on ? "" : "none";
    inputEl.disabled = on;
  }

  function ensureNotEmpty() {
    if (emptyEl) emptyEl.style.display = "none";
    // Switch the message area to bottom-anchored once there's a conversation
    // (short chats sit just above the composer instead of leaving a dead gap).
    messagesEl.classList.add("has-content");
  }

  function addMessage(role, text) {
    ensureNotEmpty();
    const msg = document.createElement("div");
    msg.className = "msg " + role;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "You" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(text);

    msg.appendChild(avatar);
    msg.appendChild(bubble);

    // User messages get an "edit & resend" affordance.
    if (role === "user") {
      const edit = document.createElement("button");
      edit.className = "edit-btn";
      edit.textContent = "✎";
      edit.title = "Edit & resend";
      edit.addEventListener("click", () => {
        if (streaming) return;
        // Put the text back in the composer and let the user edit, then resend.
        inputEl.value = text;
        inputEl.focus();
        autoresize();
        pendingEditResend = true;
      });
      msg.appendChild(edit);
    }

    messagesEl.appendChild(msg);
    scrollToBottom();
    return bubble;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // A muted, centered system note (e.g. "context freed, new chat started").
  function addSystemNote(text) {
    if (!text) return;
    ensureNotEmpty();
    const note = document.createElement("div");
    note.className = "system-note";
    note.textContent = text;
    messagesEl.appendChild(note);
    scrollToBottom();
  }

  function findLastAssistantBubble() {
    const msgs = messagesEl.querySelectorAll(".msg.assistant .bubble");
    return msgs.length ? msgs[msgs.length - 1] : null;
  }

  // Append a small footer (tokens · tok/s · time-to-first-token) + action
  // buttons (Regenerate, Continue) to the just-finished assistant message.
  function attachStats(stats) {
    const bubble = currentBubble || findLastAssistantBubble();
    if (!bubble) return;
    const msg = bubble.closest(".msg");
    if (!msg || msg.querySelector(".reply-footer")) return;

    const footer = document.createElement("div");
    footer.className = "reply-footer";

    const meta = document.createElement("span");
    meta.className = "reply-meta";
    const bits = [];
    if (stats.model) bits.push(shortModel(stats.model)); // which model produced this reply
    if (stats.tokens) bits.push("~" + stats.tokens + " tok");
    if (stats.tps) bits.push(stats.tps + " tok/s");
    if (stats.ttftMs) bits.push((stats.ttftMs / 1000).toFixed(1) + "s to first");
    meta.textContent = bits.join(" · ");

    const actions = document.createElement("span");
    actions.className = "reply-actions";
    const regen = document.createElement("button");
    regen.className = "reply-btn";
    regen.textContent = "↻ Regenerate";
    regen.title = "Regenerate this reply";
    regen.addEventListener("click", () => {
      if (streaming) return;
      vscode.postMessage({ type: "regenerate" });
    });
    actions.appendChild(regen);

    // Offer "Continue" only when the reply may have been cut off by max_tokens.
    const cont = document.createElement("button");
    cont.className = "reply-btn";
    cont.textContent = "→ Continue";
    cont.title = "Continue the previous reply";
    cont.addEventListener("click", () => {
      if (streaming) return;
      vscode.postMessage({ type: "continue" });
    });
    actions.appendChild(cont);

    footer.appendChild(meta);
    footer.appendChild(actions);
    msg.appendChild(footer);
  }

  // Small "context attached" chip shown under the user's message.
  function addContextChip(label) {
    ensureNotEmpty();
    const chip = document.createElement("div");
    chip.className = "context-chip";
    chip.textContent = "📎 " + label;
    messagesEl.appendChild(chip);
    scrollToBottom();
  }

  // --- agent tool activity cards ---
  const toolCards = {}; // name -> latest pending card element

  function addToolCard(name, args) {
    ensureNotEmpty();
    const card = document.createElement("div");
    card.className = "tool-card running";

    const head = document.createElement("div");
    head.className = "tool-head";
    head.textContent = "⚙ " + name + "(" + summarizeArgs(args) + ")";

    const body = document.createElement("pre");
    body.className = "tool-body";
    body.textContent = "running…";

    card.appendChild(head);
    card.appendChild(body);
    messagesEl.appendChild(card);
    toolCards[name] = card;
    scrollToBottom();
  }

  function finishToolCard(name, result) {
    const card = toolCards[name];
    if (!card) return;
    card.classList.remove("running");
    const body = card.querySelector(".tool-body");
    const text = String(result || "");
    body.textContent = text.length > 1200 ? text.slice(0, 1200) + "\n…" : text;
    delete toolCards[name];
    scrollToBottom();
  }

  function summarizeArgs(args) {
    if (!args || typeof args !== "object") return "";
    return Object.keys(args)
      .map((k) => {
        let v = args[k];
        if (typeof v === "string" && v.length > 40) v = v.slice(0, 40) + "…";
        return k + "=" + JSON.stringify(v);
      })
      .join(", ");
  }

  // Minimal, safe markdown: escape first, then apply fenced code, inline code,
  // bold, and paragraph breaks. No raw HTML is ever inserted from model output.
  // Code blocks get a toolbar (lang label + Apply/Copy). The raw code is stored
  // base64 in a data attribute so the host can write it on Apply.
  function renderMarkdown(src) {
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const isTableSep = (line) => {
      const s = String(line || "").trim();
      if (!s.includes("|")) return false;
      const core = s.replace(/^\|/, "").replace(/\|$/, "").trim();
      if (!core) return false;
      return core
        .split("|")
        .every((c) => /^:?-{3,}:?$/.test(c.trim()));
    };

    const splitTableRow = (line) =>
      String(line || "")
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());

    const listItemMatch = (line) => {
      const m = /^(\s*)([-*+] |\d+\. )(.+)$/.exec(String(line || ""));
      return m ? { marker: m[2].trim(), text: m[3] } : null;
    };

    const isCodeLikeLine = (line) => {
      const s = String(line || "");
      if (!s.trim()) return false;
      return (
        /[{};$]/.test(s) ||
        /=>|::|->/.test(s) ||
        /^\s*(class|function|public|private|protected|if|else|for|while|return|import|from|const|let|var|try|catch)\b/.test(s) ||
        /^\s*[$@#]/.test(s)
      );
    };

    const isLikelyCodeBlock = (lines) => {
      if (!lines || lines.length < 3) return false;
      const codey = lines.filter(isCodeLikeLine).length;
      return codey >= Math.max(2, Math.floor(lines.length * 0.5));
    };

    const renderInline = (text) => {
      let t = esc(text || "");
      t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      return t;
    };

    const renderTextWithTables = (text) => {
      const lines = String(text || "").split("\n");
      const chunks = [];
      let i = 0;

      const flushPara = (para) => {
        if (!para.length) return;
        chunks.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
      };

      while (i < lines.length) {
        const header = lines[i];
        const sep = lines[i + 1];
        if (header && sep && header.includes("|") && isTableSep(sep)) {
          const headers = splitTableRow(header);
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
            if (isTableSep(lines[i])) {
              i++;
              continue;
            }
            rows.push(splitTableRow(lines[i]));
            i++;
          }
          const headHtml =
            "<thead><tr>" +
            headers.map((h) => "<th>" + renderInline(h) + "</th>").join("") +
            "</tr></thead>";
          const bodyHtml =
            "<tbody>" +
            rows
              .map((r) => "<tr>" + headers.map((_, idx) => "<td>" + renderInline(r[idx] || "") + "</td>").join("") + "</tr>")
              .join("") +
            "</tbody>";
          chunks.push('<div class="gen-block md-table-wrap"><table class="md-table">' + headHtml + bodyHtml + "</table></div>");
          continue;
        }

        const li = listItemMatch(lines[i]);
        if (li) {
          const items = [];
          let ordered = /^\d+\./.test(li.marker);
          while (i < lines.length) {
            const cur = listItemMatch(lines[i]);
            if (!cur) break;
            ordered = ordered || /^\d+\./.test(cur.marker);
            items.push(cur.text);
            i++;
          }
          const tag = ordered ? "ol" : "ul";
          chunks.push(
            '<div class="gen-block md-list-wrap"><' + tag + ' class="md-list">' +
              items.map((item) => '<li>' + renderInline(item) + "</li>").join("") +
              "</" + tag + "></div>"
          );
          continue;
        }

        const para = [];
        while (i < lines.length) {
          const cur = lines[i];
          const next = lines[i + 1];
          if (!cur.trim()) {
            i++;
            break;
          }
          if (cur.includes("|") && next && isTableSep(next)) break;
          if (listItemMatch(cur)) break;
          para.push(cur);
          i++;
        }
        if (isLikelyCodeBlock(para)) {
          const code = para.join("\n");
          chunks.push('<div class="code-block auto-code-block"><pre><code>' + highlight(code) + "</code></pre></div>");
        } else {
          flushPara(para);
        }
      }
      return chunks.join("");
    };

    const parts = [];
    const fence = /```([^\n]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fence.exec(src)) !== null) {
      parts.push({ type: "text", value: src.slice(last, m.index) });
      parts.push({ type: "code", lang: (m[1] || "").trim(), value: m[2] });
      last = fence.lastIndex;
    }
    parts.push({ type: "text", value: src.slice(last) });

    return parts
      .map((p) => {
        if (p.type === "code") {
          const code = p.value.replace(/\n$/, "");
          const enc = b64encode(code);
          const langLabel = p.lang ? esc(p.lang) : "code";
          const kind = /^(json|json5|jsonc)$/i.test(p.lang) ? " json-block" : "";
          return (
            '<div class="code-block' + kind + '">' +
            '<div class="code-toolbar">' +
            '<span class="code-lang">' + langLabel + "</span>" +
            '<span class="code-actions">' +
            '<button class="code-btn wrap-btn" title="Toggle line wrap">⤶ Wrap</button>' +
            '<button class="code-btn apply-btn" data-code="' + enc + '" data-lang="' +
            esc(p.lang) + '">Apply</button>' +
            '<button class="code-btn copy-btn" data-code="' + enc + '">Copy</button>' +
            "</span></div>" +
            '<pre><code>' + highlight(code) + "</code></pre>" +
            "</div>"
          );
        }
        return renderTextWithTables(p.value);
      })
      .join("");
  }

  // Lightweight, dependency-free syntax highlighting. Works on raw code:
  // tokenizes comments/strings/numbers/keywords FIRST (so we never highlight
  // inside a string/comment), HTML-escapes each piece, then wraps in spans.
  // Theme colors come from VS Code token CSS vars (see chat.css .tok-*).
  function highlight(code) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const KW = new RegExp(
      "\\b(" +
        "function|return|const|let|var|if|else|for|while|do|switch|case|break|continue|" +
        "class|extends|new|this|super|import|export|from|default|async|await|yield|try|catch|" +
        "finally|throw|typeof|instanceof|in|of|void|delete|null|undefined|true|false|" +
        "def|elif|lambda|None|True|False|self|pass|raise|with|as|global|nonlocal|assert|" +
        "public|private|protected|static|interface|type|enum|struct|impl|fn|use|mut|match|" +
        "and|or|not|is" +
        ")\\b",
      "g"
    );
    // Token patterns scanned in priority order.
    const RULES = [
      { cls: "tok-com", re: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//y },
      { cls: "tok-str", re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y },
      { cls: "tok-num", re: /\b\d[\d_]*(?:\.\d+)?\b/y },
    ];
    let out = "";
    let i = 0;
    while (i < code.length) {
      let matched = false;
      for (const r of RULES) {
        r.re.lastIndex = i;
        const m = r.re.exec(code);
        if (m && m.index === i) {
          out += '<span class="' + r.cls + '">' + esc(m[0]) + "</span>";
          i = r.re.lastIndex;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Plain run until the next token-start char; keyword-highlight within it.
      let j = i;
      while (j < code.length && !/["'`#]/.test(code[j]) && !(code[j] === "/" && (code[j + 1] === "/" || code[j + 1] === "*")) && !/\d/.test(code[j])) {
        j++;
      }
      const chunk = code.slice(i, Math.max(j, i + 1));
      out += esc(chunk).replace(KW, '<span class="tok-kw">$1</span>');
      i += chunk.length;
    }
    return out;
  }

  // UTF-8-safe base64 (btoa alone breaks on non-Latin1 chars).
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }
  function b64decode(str) {
    const bin = atob(str);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;
    // Record into prompt history (skip consecutive duplicates) and reset cursor.
    if (promptHistory[promptHistory.length - 1] !== text) promptHistory.push(text);
    histIndex = -1;
    histDraft = "";
    inputEl.value = "";
    autoresize();
    setStreaming(true);

    // Edit & resend: the host rewrites history and re-renders the conversation,
    // so we don't add the user bubble here — just request the resend.
    if (pendingEditResend) {
      pendingEditResend = false;
      statusEl.textContent = "Working…";
      currentBubble = null;
      vscode.postMessage({ type: "editResend", text });
      return;
    }

    addMessage("user", text);
    if (agentModeEl.checked) {
      // Agent mode opens its own bubble on each step (stepStart). Just show status.
      currentBubble = null;
      statusEl.textContent = "Working…";
    } else {
      currentRaw = "";
      currentBubble = addMessage("assistant", "");
      currentBubble.classList.add("typing");
    }

    vscode.postMessage({ type: "send", text });
  }

  function autoresize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }

  // --- events from the extension host ---
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "renderUser") {
      // Host-initiated message (e.g. from editor selection): render the user
      // bubble and open an assistant bubble for streaming.
      addMessage("user", m.text);
      currentRaw = "";
      currentBubble = addMessage("assistant", "");
      currentBubble.classList.add("typing");
      setStreaming(true);
    } else if (m.type === "context") {
      addContextChip(m.label);
    } else if (m.type === "stepStart") {
      // Agent is starting a new reasoning step — open a fresh streaming bubble.
      // First drop any leftover EMPTY bubble from a prior step (e.g. a step that
      // only emitted a suppressed tool-call and produced no visible text) so we
      // don't stack orphaned "•••" bubbles.
      if (currentBubble && !currentRaw.trim()) {
        currentBubble.closest(".msg")?.remove();
      }
      currentRaw = "";
      currentBubble = addMessage("assistant", "");
      currentBubble.classList.add("typing");
      scrollToBottom();
    } else if (m.type === "token") {
      if (!currentBubble) {
        currentRaw = "";
        currentBubble = addMessage("assistant", "");
      }
      currentBubble.classList.remove("typing");
      currentBubble.classList.add("cursor", "streaming-plain");
      currentRaw += m.value;
      currentBubble.textContent = currentRaw;
      scrollToBottom();
    } else if (m.type === "status") {
      statusEl.textContent = m.value || "";
    } else if (m.type === "toolStart") {
      // Finalize any streamed reasoning bubble before the tool card.
      if (currentBubble) {
        currentBubble.classList.remove("cursor", "typing");
        if (!currentRaw.trim()) currentBubble.closest(".msg")?.remove();
        currentBubble = null;
      }
      addToolCard(m.name, m.args);
    } else if (m.type === "toolResult") {
      finishToolCard(m.name, m.result);
    } else if (m.type === "agentAnswer") {
      // Final answer — already streamed via tokens; just finalize.
      if (currentBubble) {
        if (m.value && m.value !== currentRaw) {
          currentRaw = m.value;
        }
        if (currentRaw.trim()) currentBubble.innerHTML = renderMarkdown(currentRaw);
        currentBubble.classList.remove("cursor", "typing", "streaming-plain");
        if (!currentRaw.trim()) currentBubble.closest(".msg")?.remove();
      } else if (m.value) {
        addMessage("assistant", m.value);
      }
      currentBubble = null;
      scrollToBottom();
    } else if (m.type === "done") {
      statusEl.textContent = "";
      if (currentBubble) {
        if (currentRaw.trim()) currentBubble.innerHTML = renderMarkdown(currentRaw);
        currentBubble.classList.remove("cursor", "typing", "streaming-plain");
      }
      // Attach a small stats footer (tokens, tok/s) to the last assistant reply.
      if (m.stats) attachStats(m.stats);
      currentBubble = null;
      lastAssistantBubble = findLastAssistantBubble();
      setStreaming(false);
    } else if (m.type === "error") {
      if (currentBubble) {
        currentBubble.classList.remove("cursor");
        currentBubble.innerHTML =
          '<span class="error">⚠ ' + m.value.replace(/</g, "&lt;") + "</span>";
      }
      currentBubble = null;
      setStreaming(false);
    } else if (m.type === "clear") {
      messagesEl.querySelectorAll(".msg, .tool-card, .context-chip, .system-note").forEach((n) => n.remove());
      if (emptyEl) emptyEl.style.display = "";
      messagesEl.classList.remove("has-content"); // re-center the welcome
    } else if (m.type === "fileMatches") {
      renderFileMenu(m.files || []);
    } else if (m.type === "systemNote") {
      addSystemNote(m.text || "");
    } else if (m.type === "slashCommands") {
      // Live-updated command list (built-in + custom from .cvsuai/).
      if (Array.isArray(m.commands)) slashCommands = m.commands;
    } else if (m.type === "models") {
      populateModels(m.models || [], m.current || currentModel);
    } else if (m.type === "model") {
      currentModel = m.model || "";
      if (modelSelect && currentModel) selectModelValue(currentModel);
    } else if (m.type === "authState") {
      if (signinContainer) {
        signinContainer.style.display = m.authed ? "none" : "block";
      }
    } else if (m.type === "target") {
      renderTarget(m.target, m.localUp);
    } else if (m.type === "autoApproveWrites") {
      if (autoApproveWritesEl) autoApproveWritesEl.checked = !!m.value;
    } else if (m.type === "autopilotMode") {
      if (autopilotModeEl) autopilotModeEl.checked = !!m.value;
    } else if (m.type === "sessionList") {
      renderSessionList(m.sessions || [], m.currentId);
    } else if (m.type === "loadConversation") {
      messagesEl.querySelectorAll(".msg, .tool-card, .context-chip, .system-note").forEach((n) => n.remove());
      if (emptyEl) emptyEl.style.display = "none";
      (m.messages || []).forEach((msg) => addMessage(msg.role, msg.content));
      historyPanel.hidden = true;
    }
  });

  // --- session history panel ---
  function renderSessionList(sessions, currentId) {
    if (sessions.length === 0) {
      historyList.style.display = "flex";
      historyList.innerHTML =
        '<div class="history-empty">No saved chats yet.<br>Your conversations will appear here once you send a message.</div>';
      return;
    }
    historyList.style.display = "block";
    historyList.innerHTML = sessions
      .map(
        (s) =>
          '<div class="history-item' +
          (s.id === currentId ? " current" : "") +
          '" data-id="' +
          s.id +
          '"><span class="history-title">' +
          escapeHtml(s.title) +
          '</span><span class="history-meta">' +
          s.messageCount +
          " msgs</span>" +
          '<span class="history-actions">' +
          '<button class="history-rename" data-id="' + s.id + '" title="Rename">✎</button>' +
          '<button class="history-delete" data-id="' + s.id + '" title="Delete">🗑</button>' +
          "</span></div>"
      )
      .join("");
  }

  // --- server / local target toggle ---
  function renderTarget(target, localUp) {
    if (!targetToggle) return;
    if (target === "local") {
      targetToggle.textContent = localUp ? "💻 Local" : "⚠ Local (down)";
      targetToggle.title = localUp
        ? "Using your LOCAL GPU. Click to switch to the server."
        : "Local instance is not responding. Click to switch back to the server.";
      targetToggle.classList.toggle("target-warn", !localUp);
      targetToggle.disabled = false; // always allow switching AWAY from local
    } else {
      targetToggle.textContent = "☁ Server";
      targetToggle.classList.remove("target-warn");
      if (localUp) {
        targetToggle.title = "Using the server. Click to switch to your LOCAL GPU.";
        targetToggle.disabled = false;
      } else {
        // Local not reachable -> disable switching TO it.
        targetToggle.title = "Using the server. Local instance is offline — start it to enable switching.";
        targetToggle.disabled = true;
      }
    }
  }

  if (targetToggle) {
    targetToggle.addEventListener("click", () => {
      if (targetToggle.disabled) return;
      vscode.postMessage({ type: "toggleTarget" });
    });
  }

  // Model dropdown in the composer row: populate options, keep current selected,
  // and switch the active model on change.
  function populateModels(models, current) {
    if (!modelSelect) return;
    const list = models.length ? models : (current ? [current] : []);
    modelSelect.innerHTML = list
      .map((id) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(shortModel(id)) + "</option>")
      .join("") || '<option value="">model…</option>';
    if (current) selectModelValue(current);
  }
  function selectModelValue(id) {
    currentModel = id;
    if (!modelSelect) return;
    // Add the value if the server list didn't include it (e.g. offline).
    if (![...modelSelect.options].some((o) => o.value === id)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = shortModel(id);
      modelSelect.appendChild(opt);
    }
    modelSelect.value = id;
  }
  if (modelSelect) {
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value) vscode.postMessage({ type: "setModel", model: modelSelect.value });
    });
  }

  // Compact model label: drop the .gguf extension and the instruct/quant noise so
  // "gpt-3.5-turbo" -> "qwen2.5-coder-7b".
  function shortModel(name) {
    if (!name) return "model";
    let s = name.replace(/\.gguf$/i, "");
    s = s.replace(/-instruct.*$/i, "").replace(/[._-]q\d.*$/i, "");
    return s || name;
  }

  historyBtn.addEventListener("click", () => {
    const showing = !historyPanel.hidden;
    historyPanel.hidden = showing;
    if (!showing) vscode.postMessage({ type: "listSessions" });
  });
  historyClose.addEventListener("click", () => (historyPanel.hidden = true));

  historyList.addEventListener("click", (e) => {
    const renameBtn = e.target.closest(".history-rename");
    const deleteBtn = e.target.closest(".history-delete");
    const item = e.target.closest(".history-item");
    if (renameBtn) {
      e.stopPropagation();
      // window.prompt() is blocked in webviews — ask the host to show a native input.
      vscode.postMessage({ type: "renameSessionPrompt", id: renameBtn.dataset.id });
      return;
    }
    if (deleteBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", id: deleteBtn.dataset.id });
      return;
    }
    if (item) {
      vscode.postMessage({ type: "loadSession", id: item.dataset.id });
    }
  });

  // --- UI wiring ---
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  
  if (signinBtn) {
    signinBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "signIn" });
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });
  }

  newChatBtn.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));

  // Delegated handler for the Apply / Copy buttons on code blocks.
  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".code-btn");
    if (!btn) return;
    if (btn.classList.contains("wrap-btn")) {
      const block = btn.closest(".code-block");
      if (block) block.classList.toggle("nowrap");
      return;
    }
    const code = b64decode(btn.dataset.code || "");
    if (btn.classList.contains("apply-btn")) {
      vscode.postMessage({ type: "applyCode", code, lang: btn.dataset.lang || "" });
      flash(btn, "Sent →");
    } else if (btn.classList.contains("copy-btn")) {
      navigator.clipboard?.writeText(code);
      flash(btn, "Copied");
    }
  });

  function flash(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  agentModeEl.addEventListener("change", () => {
    vscode.postMessage({ type: "setAgentMode", value: agentModeEl.checked });
    inputEl.placeholder = agentModeEl.checked
      ? "Ask the agent to read, search, or edit files…"
      : "Message CvSU-AI VSCode Chat…";
  });

  if (autoApproveWritesEl) {
    autoApproveWritesEl.addEventListener("change", () => {
      vscode.postMessage({ type: "setAutoApproveWrites", value: autoApproveWritesEl.checked });
    });
  }

  if (autopilotModeEl) {
    autopilotModeEl.addEventListener("change", () => {
      vscode.postMessage({ type: "setAutopilotMode", value: autopilotModeEl.checked });
    });
  }

  inputEl.addEventListener("input", () => {
    autoresize();
    updateSlashMenu();
  });

  inputEl.addEventListener("keydown", (e) => {
    // When the slash menu is open, arrows/enter/tab/esc drive it.
    if (slashMenuOpen()) {
      const items = slashMenuEl.querySelectorAll(".slash-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashActive = Math.min(slashActive + 1, items.length - 1);
        renderSlashHighlight();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashActive = Math.max(slashActive - 1, 0);
        renderSlashHighlight();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (slashActive >= 0 && items[slashActive]) {
          e.preventDefault();
          const sel = items[slashActive];
          if (menuMode === "file" && sel.dataset.file) chooseFile(sel.dataset.file);
          else chooseSlash(sel.dataset.name);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    // Terminal-style prompt history with ↑/↓ (only when the slash menu is closed).
    // ↑ recalls a previous prompt only when the caret is on the FIRST line, and
    // ↓ goes forward only on the LAST line — so multi-line editing still works.
    if (!slashMenuOpen() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const v = inputEl.value;
      const caret = inputEl.selectionStart ?? 0;
      const onFirstLine = !v.slice(0, caret).includes("\n");
      const onLastLine = !v.slice(caret).includes("\n");
      if (e.key === "ArrowUp" && onFirstLine && promptHistory.length) {
        e.preventDefault();
        if (histIndex === -1) histDraft = v; // save the live draft before scrolling back
        histIndex = Math.min(histIndex + 1, promptHistory.length - 1);
        setInput(promptHistory[promptHistory.length - 1 - histIndex]);
        return;
      }
      if (e.key === "ArrowDown" && onLastLine && histIndex !== -1) {
        e.preventDefault();
        histIndex--;
        setInput(histIndex === -1 ? histDraft : promptHistory[promptHistory.length - 1 - histIndex]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Replace the composer text and put the caret at the end.
  function setInput(text) {
    inputEl.value = text;
    autoresize();
    const end = inputEl.value.length;
    inputEl.setSelectionRange(end, end);
  }

  // --- slash command menu ---
  function slashMenuOpen() {
    return !slashMenuEl.hidden;
  }

  function updateSlashMenu() {
    const val = inputEl.value;
    // Slash command: input is exactly a leading "/word" (no spaces yet).
    const slashM = /^\/(\w*)$/.exec(val);
    if (slashM) {
      menuMode = "slash";
      const q = slashM[1].toLowerCase();
      const matches = slashCommands.filter((c) => c.name.startsWith(q));
      if (matches.length === 0) { closeSlashMenu(); return; }
      slashMenuEl.innerHTML = matches
        .map(
          (c, i) =>
            '<div class="slash-item' + (i === 0 ? " active" : "") +
            '" data-name="' + c.name + '"><span class="slash-name">/' + c.name +
            '</span><span class="slash-desc">' + escapeHtml(c.description) + "</span></div>"
        )
        .join("");
      slashActive = 0;
      slashMenuEl.hidden = false;
      return;
    }
    // File mention: an "@token" at the END of the input (after a space or start).
    const atM = /(^|\s)@([^\s]*)$/.exec(val);
    if (atM) {
      menuMode = "file";
      // Ask the host for matches; renderFileMenu fills the menu when they arrive.
      vscode.postMessage({ type: "fileQuery", query: atM[2] });
      return;
    }
    closeSlashMenu();
  }

  function renderFileMenu(files) {
    if (menuMode !== "file" || files.length === 0) {
      if (menuMode === "file") closeSlashMenu();
      return;
    }
    slashMenuEl.innerHTML = files
      .map(
        (f, i) =>
          '<div class="slash-item' + (i === 0 ? " active" : "") +
          '" data-file="' + escapeHtml(f) + '"><span class="slash-name">@' +
          escapeHtml(f.split("/").pop()) + '</span><span class="slash-desc">' +
          escapeHtml(f) + "</span></div>"
      )
      .join("");
    slashActive = 0;
    slashMenuEl.hidden = false;
  }

  function chooseFile(path) {
    // Replace the trailing "@token" with "@path " and keep the rest of the input.
    inputEl.value = inputEl.value.replace(/(^|\s)@([^\s]*)$/, "$1@" + path + " ");
    closeSlashMenu();
    inputEl.focus();
    autoresize();
  }

  function renderSlashHighlight() {
    const items = slashMenuEl.querySelectorAll(".slash-item");
    items.forEach((el, i) => el.classList.toggle("active", i === slashActive));
    items[slashActive]?.scrollIntoView({ block: "nearest" });
  }

  function chooseSlash(name) {
    inputEl.value = "/" + name + " ";
    closeSlashMenu();
    inputEl.focus();
    autoresize();
  }

  function closeSlashMenu() {
    slashMenuEl.hidden = true;
    slashActive = -1;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  slashMenuEl.addEventListener("click", (e) => {
    const item = e.target.closest(".slash-item");
    if (!item) return;
    if (menuMode === "file" && item.dataset.file) chooseFile(item.dataset.file);
    else if (item.dataset.name) chooseSlash(item.dataset.name);
  });

  setStreaming(false);
  inputEl.focus();

  // Tell the host we're ready to receive messages (restore + session list).
  // Without this, the host's constructor-time postMessage calls fire before
  // this listener exists and are lost — leaving the history panel blank.
  vscode.postMessage({ type: "ready" });
  vscode.postMessage({ type: "requestAutoApproveWrites" });
  vscode.postMessage({ type: "requestAutopilotMode" });
})();
