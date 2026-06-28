/**
 * ChatMCP content script.
 *
 * Extraction philosophy (tiered, most-specific to least):
 *   Tier 1 — Known stable selectors (data-testid, aria roles, etc.)
 *   Tier 2 — Heuristic role detection (class names, DOM position)
 *   Tier 3 — Full visible text of the main content area
 *
 * For non-chat pages the caller requests "page" mode, which skips
 * chat parsing and returns the full readable text (Readability-style).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);

  // Remove hidden elements, buttons, tooltips
  for (const hidden of clone.querySelectorAll(
    '[aria-hidden="true"], button, [role="tooltip"], noscript, style, script'
  )) {
    hidden.remove();
  }

  // Preserve code blocks with fenced markdown
  for (const pre of clone.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const lang = code?.className.match(/language-(\w+)/)?.[1] ?? "";
    const content = (code ?? pre).textContent ?? "";
    pre.replaceWith(`\n\`\`\`${lang}\n${content.trim()}\n\`\`\`\n`);
  }
  for (const code of clone.querySelectorAll("code")) {
    code.replaceWith("`" + code.textContent + "`");
  }

  return (clone.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function firstNonEmpty(...selectors) {
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Per-platform chat extractors
// ---------------------------------------------------------------------------

const EXTRACTORS = {
  // ── ChatGPT ───────────────────────────────────────────────────────────────
  // Stable: articles with data-testid="conversation-turn-N" each contain
  // a [data-message-author-role] child.
  chatgpt: {
    detect: () =>
      location.hostname === "chat.openai.com" || location.hostname === "chatgpt.com",

    extract() {
      const messages = [];

      // Tier 1: conversation turn articles (most stable)
      const articles = document.querySelectorAll(
        'article[data-testid^="conversation-turn"]'
      );
      if (articles.length > 0) {
        for (const article of articles) {
          const roleEl = article.querySelector("[data-message-author-role]");
          const role = roleEl?.getAttribute("data-message-author-role");
          if (role !== "user" && role !== "assistant") continue;
          const text = textOf(article);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: data-message-author-role directly on any element
      const roleEls = document.querySelectorAll("[data-message-author-role]");
      if (roleEls.length > 0) {
        for (const el of roleEls) {
          const role = el.getAttribute("data-message-author-role");
          if (role !== "user" && role !== "assistant") continue;
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 3: full text of main content
      return fallbackFullText("user");
    },
  },

  // ── Claude (claude.ai) ────────────────────────────────────────────────────
  // Stable: data-testid="human-turn" / "ai-turn"
  claude: {
    detect: () => location.hostname === "claude.ai",

    extract() {
      const messages = [];

      // Tier 1: testid attributes
      const turns = document.querySelectorAll(
        '[data-testid="human-turn"], [data-testid="ai-turn"]'
      );
      if (turns.length > 0) {
        for (const turn of turns) {
          const isHuman = turn.getAttribute("data-testid") === "human-turn";
          const text = textOf(turn);
          if (text) messages.push({ role: isHuman ? "user" : "assistant", content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: class-based (less stable)
      const humanEls = document.querySelectorAll(".human-turn, [class*='HumanTurn']");
      const aiEls = document.querySelectorAll(".ai-turn, [class*='AiTurn'], [class*='AssistantTurn']");
      if (humanEls.length > 0 || aiEls.length > 0) {
        // Merge and sort by DOM order
        const allTurns = [
          ...Array.from(humanEls).map((el) => ({ el, role: "user" })),
          ...Array.from(aiEls).map((el) => ({ el, role: "assistant" })),
        ].sort((a, b) => {
          const pos = a.el.compareDocumentPosition(b.el);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const { el, role } of allTurns) {
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      return fallbackFullText("user");
    },
  },

  // ── Gemini ────────────────────────────────────────────────────────────────
  // Gemini uses Angular custom elements: <user-query> and <model-response>
  gemini: {
    detect: () => location.hostname === "gemini.google.com",

    extract() {
      const messages = [];

      // Tier 1: Angular custom elements (very stable for Gemini)
      const userEls = document.querySelectorAll("user-query, .user-query");
      const modelEls = document.querySelectorAll(
        "model-response, .model-response, .response-container"
      );

      if (userEls.length > 0 || modelEls.length > 0) {
        const allTurns = [
          ...Array.from(userEls).map((el) => ({ el, role: "user" })),
          ...Array.from(modelEls).map((el) => ({ el, role: "assistant" })),
        ].sort((a, b) => {
          const pos = a.el.compareDocumentPosition(b.el);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const { el, role } of allTurns) {
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      return fallbackFullText("user");
    },
  },

  // ── Grok ──────────────────────────────────────────────────────────────────
  grok: {
    detect: () => location.hostname === "grok.com",

    extract() {
      const messages = [];

      // Tier 1: aria roles — Grok marks user messages with role="region" or similar
      // Try data-testid patterns first
      const testidMessages = document.querySelectorAll(
        "[data-testid*='message'], [data-testid*='turn'], [data-testid*='response']"
      );
      if (testidMessages.length > 0) {
        for (const el of testidMessages) {
          const id = el.getAttribute("data-testid") ?? "";
          const isUser = id.includes("user") || id.includes("human");
          const text = textOf(el);
          if (text) messages.push({ role: isUser ? "user" : "assistant", content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: look for visually distinct bubbles and guess from layout
      // (left-aligned = assistant, right-aligned = user is a common pattern)
      const allDivs = document.querySelectorAll("main div[class]");
      const candidates = Array.from(allDivs).filter((el) => {
        const cls = el.className;
        return (
          (cls.includes("message") || cls.includes("Message") ||
           cls.includes("bubble") || cls.includes("Bubble")) &&
          el.children.length < 10 &&
          el.textContent.trim().length > 10
        );
      });
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const text = textOf(el);
        if (!text) continue;
        // Right-side or self-aligned elements are usually user
        const isUser =
          style.alignSelf === "flex-end" ||
          style.marginLeft === "auto" ||
          el.className.toLowerCase().includes("user") ||
          el.className.toLowerCase().includes("human");
        messages.push({ role: isUser ? "user" : "assistant", content: text });
      }
      if (messages.length > 0) return messages;

      return fallbackFullText("user");
    },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  deepseek: {
    detect: () => location.hostname === "chat.deepseek.com",

    extract() {
      const messages = [];

      // Tier 1: DeepSeek renders user messages and assistant responses in
      // separate containers. User messages often have a specific wrapper.
      const userEls = document.querySelectorAll(
        "[class*='user-message'], [class*='UserMessage'], [class*='humanMessage']"
      );
      const assistantEls = document.querySelectorAll(
        ".ds-markdown, [class*='assistant-message'], [class*='AssistantMessage'], [class*='botMessage']"
      );

      if (userEls.length > 0 || assistantEls.length > 0) {
        const allTurns = [
          ...Array.from(userEls).map((el) => ({ el, role: "user" })),
          ...Array.from(assistantEls).map((el) => ({ el, role: "assistant" })),
        ].sort((a, b) => {
          const pos = a.el.compareDocumentPosition(b.el);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const { el, role } of allTurns) {
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: alternating pattern in the chat container
      const chatContainer = document.querySelector(
        "[class*='chat-container'], [class*='ChatContainer'], main"
      );
      if (chatContainer) {
        const children = Array.from(chatContainer.children);
        for (let i = 0; i < children.length; i++) {
          const text = textOf(children[i]);
          if (text.length > 5) {
            messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: text });
          }
        }
        if (messages.length > 0) return messages;
      }

      return fallbackFullText("user");
    },
  },

  // ── Mistral (Le Chat) ─────────────────────────────────────────────────────
  mistral: {
    detect: () => location.hostname === "chat.mistral.ai",

    extract() {
      const messages = [];

      // Tier 1: role attributes and testids
      const roleEls = document.querySelectorAll("[data-role], [data-message-role]");
      if (roleEls.length > 0) {
        for (const el of roleEls) {
          const role =
            el.getAttribute("data-role") || el.getAttribute("data-message-role");
          const normalized = role === "user" || role === "human" ? "user" : "assistant";
          const text = textOf(el);
          if (text) messages.push({ role: normalized, content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: class-based
      const userEls = document.querySelectorAll(
        "[class*='UserMessage'], [class*='user-message'], [class*='HumanMessage']"
      );
      const assistantEls = document.querySelectorAll(
        "[class*='AssistantMessage'], [class*='assistant-message'], [class*='BotMessage']"
      );
      if (userEls.length > 0 || assistantEls.length > 0) {
        const allTurns = [
          ...Array.from(userEls).map((el) => ({ el, role: "user" })),
          ...Array.from(assistantEls).map((el) => ({ el, role: "assistant" })),
        ].sort((a, b) => {
          const pos = a.el.compareDocumentPosition(b.el);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const { el, role } of allTurns) {
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      return fallbackFullText("user");
    },
  },

  // ── Perplexity ────────────────────────────────────────────────────────────
  // Perplexity is more of a search engine than a chat, but the conversation
  // thread follows a query → answer → follow-up pattern.
  perplexity: {
    detect: () =>
      location.hostname === "perplexity.ai" || location.hostname === "www.perplexity.ai",

    extract() {
      const messages = [];

      // Tier 1: Perplexity marks queries with a specific heading/div
      // and answers with a prose container
      const queryEls = document.querySelectorAll(
        "[data-testid='query'], [class*='query-text'], h2.break-words, [class*='QuerySection']"
      );
      const answerEls = document.querySelectorAll(
        "[class*='prose'], [class*='AnswerSection'], [class*='answer-section'], " +
        "[data-testid='answer'], [class*='markdown-content']"
      );

      if (queryEls.length > 0 || answerEls.length > 0) {
        const allTurns = [
          ...Array.from(queryEls).map((el) => ({ el, role: "user" })),
          ...Array.from(answerEls).map((el) => ({ el, role: "assistant" })),
        ].sort((a, b) => {
          const pos = a.el.compareDocumentPosition(b.el);
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const { el, role } of allTurns) {
          const text = textOf(el);
          if (text) messages.push({ role, content: text });
        }
        if (messages.length > 0) return messages;
      }

      // Tier 2: section-based — Perplexity groups each Q&A in a section
      const sections = document.querySelectorAll("section, [class*='Section']");
      for (const section of sections) {
        const text = textOf(section);
        if (text.length > 20) {
          // First section child is usually the query
          const firstHeading = section.querySelector("h1, h2, h3, strong");
          const queryText = firstHeading ? textOf(firstHeading) : "";
          if (queryText) messages.push({ role: "user", content: queryText });
          // Rest is the answer
          const answerText = text.replace(queryText, "").trim();
          if (answerText) messages.push({ role: "assistant", content: answerText });
        }
      }
      if (messages.length > 0) return messages;

      return fallbackFullText("user");
    },
  },
};

// ---------------------------------------------------------------------------
// Generic page extractor (non-chat tabs)
// ---------------------------------------------------------------------------

function extractPage() {
  // Use a Readability-inspired approach:
  // Find the main content area, strip nav/footer/sidebar noise.
  const mainEl =
    document.querySelector("main, [role='main'], article, .content, #content, #main") ??
    document.body;

  // Clone and clean
  const clone = mainEl.cloneNode(true);
  for (const el of clone.querySelectorAll(
    "nav, footer, header, aside, [role='navigation'], [role='banner'], " +
    "[role='complementary'], script, style, noscript, iframe, [aria-hidden='true']"
  )) {
    el.remove();
  }

  // Preserve code blocks
  for (const pre of clone.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const lang = code?.className.match(/language-(\w+)/)?.[1] ?? "";
    const content = (code ?? pre).textContent ?? "";
    pre.replaceWith(`\n\`\`\`${lang}\n${content.trim()}\n\`\`\`\n`);
  }
  for (const code of clone.querySelectorAll("code")) {
    code.replaceWith("`" + code.textContent + "`");
  }

  const text = (clone.textContent ?? "").replace(/\n{4,}/g, "\n\n\n").trim();

  return {
    type: "page",
    url: location.href,
    title: document.title,
    text,
    extractedAt: new Date().toISOString(),
  };
}

function isGeneratingNow() {
  var selectors = ['button[data-testid*="stop" i]','button[aria-label*="stop" i]','button[aria-label*="停止" i]'];
  for (var i = 0; i < selectors.length; i++) {
    var els = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      if (el && el.offsetParent) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fallback: full visible text from the main content area
// ---------------------------------------------------------------------------

function fallbackFullText(defaultRole) {
  // Just return the whole main content as one big block — better than nothing
  const mainEl =
    document.querySelector("main, [role='main'], #main") ?? document.body;
  const text = textOf(mainEl);
  // Return as a single assistant message so it still flows into context
  return text ? [{ role: "assistant", content: `[Full page text]\n\n${text}` }] : [];
}

// ---------------------------------------------------------------------------
// Entry point — called by background.js via executeScript
// ---------------------------------------------------------------------------

function extractChat() {
  for (const [name, ext] of Object.entries(EXTRACTORS)) {
    if (ext.detect()) {
      try {
        const messages = ext.extract();
        return {
          type: "chat",
          platform: name,
          url: location.href,
          title: document.title,
          messages,
          extractedAt: new Date().toISOString(),
          isGenerating: isGeneratingNow(),
        };
      } catch (err) {
        return { error: `Extraction failed on ${name}: ${err.message}` };
      }
    }
  }
  // Not a known AI chat site — extract as generic page
  return extractPage();
}

// ---------------------------------------------------------------------------
// Claude artifact extractor
// ---------------------------------------------------------------------------

async function extractArtifacts(includeLinks = false, maxLinks = 10) {
  if (location.hostname !== "claude.ai") {
    return { error: "Not on claude.ai — artifacts are only available on claude.ai." };
  }

  const artifacts = [];

  // ── Strategy 0: Known stable element IDs ──────────────────────────────────
  // Claude stores artifact source in known element IDs:
  //   #wiggle-file-content  — JSX / code artifacts
  //   #markdown-artifact    — Document / markdown artifacts
  // ── Strategy 0: Known stable element IDs and landmarks ───────────────────
  // Claude stores artifact source in known element IDs / aria-labels:
  //   #wiggle-file-content         — JSX / code artifacts
  //   #markdown-artifact           — Document / markdown artifacts
  //   aria-label="Research panel"  — Research process (ordered list of steps)

  // Research panel
  const researchPanel = document.querySelector('[aria-label="Research panel"]');
  if (researchPanel) {
    const items = researchPanel.querySelectorAll("ol li");
    if (items.length > 0) {
      const lines = [];

      // First pass: collect step summaries
      for (let i = 0; i < items.length; i++) {
        const stepText = items[i].textContent?.trim() ?? "";
        lines.push(`${i + 1}. ${stepText}`);
      }

      // If links requested: click the first source button to enter the Sources view,
      // then scrape all links from the [aria-label="Sources"] ul in one pass.
      if (includeLinks) {
        // Target the sources summary button specifically — it's a full-width flex-col
        // button (the domain breakdown card), not the small icon buttons in the li.
        const firstSourceBtn =
          researchPanel.querySelector('ol li button[class*="flex-col"]') ??
          researchPanel.querySelector('ol li button[class*="w-full"]') ??
          researchPanel.querySelector("ol li button");
        if (firstSourceBtn) {
          firstSourceBtn.click();

          // Wait for the Sources view to render — poll up to 2s
          let sourcesPanel = null;
          for (let t = 0; t < 8; t++) {
            await new Promise((r) => setTimeout(r, 250));
            sourcesPanel =
              document.querySelector('[aria-label="Sources"]') ??
              // Sources panel may be a sibling/parent of the research panel
              researchPanel.closest('[aria-label="Sources"]') ??
              researchPanel.parentElement?.querySelector('[aria-label="Sources"]') ??
              null;
            if (sourcesPanel) break;
          }

          if (sourcesPanel) {
            // Collect all URLs — return only the href, no labels or categories
            const allLinks = Array.from(sourcesPanel.querySelectorAll("ul > li a[href]"))
              .map((a) => a.getAttribute("href"))
              .filter(Boolean);

            const capped = maxLinks > 0 ? allLinks.slice(0, maxLinks) : allLinks;
            lines.push(`\nSOURCE_URLS_TOTAL:${allLinks.length}\n${capped.join("\n")}`);

            // Return to the research panel view
            const backBtn = sourcesPanel.querySelector('[aria-label="Back"]');
            if (backBtn) {
              backBtn.click();
              await new Promise((r) => setTimeout(r, 300));
            }
          } else {
            lines.push(`\n[Sources panel not found after click]`);
          }
        } else {
          lines.push(`\n[No source button found in research panel]`);
        }
      }

      const content = lines.filter((l) => l.length > 4).join("\n\n");
      if (content.length > 5) {
        return buildArtifactsResult([{ type: "research", title: "Research Process", content }]);
      }
    }
    // Fallback: full text of the panel
    const content = textOf(researchPanel);
    if (content.length > 5) {
      return buildArtifactsResult([{ type: "research", title: "Research Process", content }]);
    }
  }

  const ARTIFACT_IDS = [
    { id: "wiggle-file-content", type: null },   // type inferred from content
    { id: "markdown-artifact",   type: "md"  },
  ];
  for (const { id, type } of ARTIFACT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const content = el.textContent?.trim() ?? "";
    if (content.length < 5) continue;
    const panel = el.closest('[data-testid*="artifact"], [class*="artifact" i]') ?? el.parentElement;
    const titleEl = panel?.querySelector("h1,h2,h3,[class*='title' i]");
    const title = titleEl?.textContent?.trim() || document.title.split(" - ")[0] || "Artifact";
    const artifactType = type ?? inferTypeFromContent(content);
    return buildArtifactsResult([{ type: artifactType, title, content }]);
  }

  // ── Strategy 1: Open artifact side panel ──────────────────────────────────
  // When a user clicks "Open artifact", Claude renders a side panel.
  // That panel contains either:
  //   (a) a CodeMirror 6 editor (.cm-editor) in "Code" view, or
  //   (b) a rendered preview (iframe or prose) in "Preview" view.
  //
  // We look for the side panel first because it has the actual content.
  // The inline artifact cards in the chat only show a title + type badge.

  const openPanel = findArtifactPanel();
  if (openPanel) {
    const artifact = extractFromPanel(openPanel);
    if (artifact) {
      return buildArtifactsResult([artifact]);
    }
  }

  // ── Strategy 2: Any CodeMirror editor on the page ─────────────────────────
  // If the panel was found but extraction missed, try all cm-editor roots.
  const cmEditors = document.querySelectorAll(".cm-editor");
  for (const editor of cmEditors) {
    const lines = editor.querySelectorAll(".cm-line");
    if (lines.length === 0) continue;
    const content = Array.from(lines).map((l) => l.textContent ?? "").join("\n").trim();
    if (content.length > 20) {
      // Walk up to find a container that might have a title
      const container = editor.closest('[data-testid*="artifact"], [class*="artifact" i]') ?? editor.parentElement;
      const title = container?.querySelector("h1,h2,h3,[class*='title' i]")?.textContent?.trim() || "Artifact";
      artifacts.push({ type: inferTypeFromContent(content), title, content });
    }
  }
  if (artifacts.length > 0) return buildArtifactsResult(artifacts);

  // ── Strategy 3: Inline artifact cards (titles only, no source) ────────────
  // Fall back to the cards in the conversation. These only have the label text,
  // so we report them with a note telling the user to open the artifact panel.
  const cards = document.querySelectorAll(
    '[data-testid="artifact"], [data-testid*="artifact-"]'
  );
  if (cards.length > 0) {
    for (const card of cards) {
      const titleEl = card.querySelector("button, [class*='title' i], span");
      const rawText = card.textContent?.trim() ?? "";
      // Strip the badge suffixes like "Code · JSX" or "Document"
      const title = rawText
        .replace(/\s*(Code\s*·\s*\w+|Document|Preview)\s*/gi, "")
        .replace(/Open artifact/gi, "")
        .trim() || "Untitled artifact";
      const typeMatch = rawText.match(/Code\s*·\s*(\w+)/i);
      const isDoc = /\bDocument\b/i.test(rawText);
      const artifactType = typeMatch ? typeMatch[1].toLowerCase() : (isDoc ? "md" : "text");
      artifacts.push({ type: artifactType, title, content: "" });
    }
    return {
      type: "artifacts",
      platform: "claude",
      url: location.href,
      title: document.title,
      artifacts,
      count: artifacts.length,
      extractedAt: new Date().toISOString(),
      note: `Found ${artifacts.length} artifact(s) but source code is not visible. Click "Open artifact" in the Claude UI, then switch to the "Code" tab, and run this tool again.`,
    };
  }

  return {
    type: "artifacts",
    platform: "claude",
    url: location.href,
    title: document.title,
    artifacts: [],
    count: 0,
    extractedAt: new Date().toISOString(),
    note: "No artifacts found. Make sure the artifact panel is open and visible.",
  };
}

// Find the artifact side panel (the expanded view, not inline cards).
function findArtifactPanel() {
  // Claude's artifact panel is a large aside/div that sits to the right of the chat.
  // It typically contains a code editor or rendered content and a title bar at the top.

  // Approach A: look for a container that has a CodeMirror editor inside
  const cmEditor = document.querySelector(".cm-editor");
  if (cmEditor) {
    // Walk up to the nearest sizeable panel ancestor
    let el = cmEditor.parentElement;
    while (el && el !== document.body) {
      const rect = el.getBoundingClientRect();
      // The panel is typically at least 300px wide and 200px tall
      if (rect.width > 300 && rect.height > 200) return el;
      el = el.parentElement;
    }
    return cmEditor.parentElement;
  }

  // Approach B: look for the panel by common testid/class patterns
  return (
    document.querySelector('[data-testid="artifact-panel"]') ??
    document.querySelector('[data-testid="artifact-viewer"]') ??
    document.querySelector('[class*="artifactPanel" i]') ??
    document.querySelector('[class*="artifact-panel" i]') ??
    document.querySelector('[class*="ArtifactViewer"]') ??
    null
  );
}

// Extract a single artifact from an open panel element.
function extractFromPanel(panel) {
  // ── Title ──────────────────────────────────────────────────────────────────
  let title = "";
  // Title is usually in a heading or a prominent non-button text node near the top
  for (const sel of ["h1","h2","h3","[class*='title' i]","[data-testid*='title']"]) {
    const el = panel.querySelector(sel);
    const t = el?.textContent?.trim();
    if (t && t.length > 1 && t.length < 120) { title = t; break; }
  }

  // ── Type hint from the panel header ───────────────────────────────────────
  let artifactType = "text";
  const headerText = panel.querySelector("header, [class*='header' i], [class*='toolbar' i]")?.textContent ?? panel.textContent ?? "";
  const typeMatch = headerText.match(/Code\s*[·•]\s*(\w+)/i);
  if (typeMatch) artifactType = typeMatch[1].toLowerCase();
  else if (/\bDocument\b/i.test(headerText)) artifactType = "md";

  // ── Content: CodeMirror editor ────────────────────────────────────────────
  let content = "";
  const cmLines = panel.querySelectorAll(".cm-line");
  if (cmLines.length > 0) {
    content = Array.from(cmLines).map((l) => l.textContent ?? "").join("\n").trim();
  }

  // ── Content: <pre><code> ──────────────────────────────────────────────────
  if (!content) {
    const pre = panel.querySelector("pre");
    if (pre) {
      const code = pre.querySelector("code");
      const lang = code?.className.match(/language-(\w+)/)?.[1];
      if (lang) artifactType = lang;
      content = (code ?? pre).textContent?.trim() ?? "";
    }
  }

  // ── Content: textarea ─────────────────────────────────────────────────────
  if (!content) {
    const ta = panel.querySelector("textarea");
    if (ta) content = ta.value.trim();
  }

  // ── Content: rendered document prose ─────────────────────────────────────
  if (!content && artifactType === "md") {
    const prose = panel.querySelector("[class*='prose'], [class*='markdown'], article");
    if (prose) content = textOf(prose);
  }

  if (!content || content.length < 5) return null;
  if (!title) title = `Artifact (${artifactType})`;
  if (artifactType === "text") artifactType = inferTypeFromContent(content);

  return { type: artifactType, title, content };
}

function inferTypeFromContent(content) {
  const t = content.trimStart();
  if (t.startsWith("import ") || t.includes("export default") || /\bReact\b/.test(t)) return "jsx";
  if (t.startsWith("<") && t.includes("</")) return "html";
  if (t.startsWith("#") || t.includes("\n## ")) return "md";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  return "text";
}

function extractArtifactFromContainer(container) {
  // ── Title ──────────────────────────────────────────────────────────────────
  // Claude puts the artifact title in a button or heading in the header bar.
  // The header is usually the first child; the content panel comes after.
  let title = "";
  let artifactType = "text";

  // Look for the artifact title element — Claude uses a specific testid or
  // a prominent text element near the top of the artifact panel.
  const titleCandidates = container.querySelectorAll(
    '[data-testid*="title"], [data-testid*="name"], h1, h2, h3, h4'
  );
  for (const el of titleCandidates) {
    const t = el.textContent?.trim();
    if (t && t.length > 1 && !t.includes("·") && !t.toLowerCase().includes("open artifact")) {
      title = t;
      break;
    }
  }

  // ── Type detection ─────────────────────────────────────────────────────────
  // Claude shows a language badge like "Code · JSX" or "Document" in the header.
  // Find the label that contains the type hint.
  const allText = container.textContent ?? "";
  const typeMatch = allText.match(/Code\s*·\s*(\w+)/i);
  if (typeMatch) {
    artifactType = typeMatch[1].toLowerCase(); // "jsx", "tsx", "html", etc.
  } else if (/\bDocument\b/i.test(allText)) {
    artifactType = "md";
  }

  // Infer type from title file extension
  if (artifactType === "text" && title) {
    const ext = title.split(".").pop()?.toLowerCase();
    if (ext && ["jsx", "tsx", "js", "ts", "html", "css", "md", "py", "json", "svg"].includes(ext)) {
      artifactType = ext;
    }
  }

  // ── Content extraction ─────────────────────────────────────────────────────

  let content = "";

  // Strategy A: CodeMirror editor (used for JSX/code artifacts).
  // CodeMirror 6 stores each line in .cm-line elements.
  const cmLines = container.querySelectorAll(".cm-line");
  if (cmLines.length > 0) {
    content = Array.from(cmLines).map((l) => l.textContent ?? "").join("\n");
  }

  // Strategy B: Standard <pre><code> block (markdown code view or plain code)
  if (!content) {
    const pre = container.querySelector("pre");
    if (pre) {
      const codeEl = pre.querySelector("code");
      const detected = codeEl?.className.match(/language-(\w+)/)?.[1];
      if (detected) artifactType = detected;
      content = (codeEl ?? pre).textContent?.trim() ?? "";
    }
  }

  // Strategy C: Textarea (some editors expose a hidden textarea for a11y)
  if (!content) {
    const textarea = container.querySelector("textarea");
    if (textarea) content = textarea.value.trim();
  }

  // Strategy D: For Document artifacts, extract the rendered prose.
  // Claude renders markdown documents as styled HTML — grab the prose container.
  if (!content && artifactType === "md") {
    const proseEl = container.querySelector(
      "[class*='prose'], [class*='markdown'], [class*='document'], article"
    );
    if (proseEl) content = textOf(proseEl);
  }

  // Strategy E: Last resort — full visible text of the container,
  // but strip out the header bar to avoid title/badge noise.
  if (!content) {
    // Try to skip the first child (header) and read the rest
    const children = Array.from(container.children);
    const bodyChildren = children.slice(1); // skip header bar
    if (bodyChildren.length > 0) {
      const bodyText = bodyChildren.map((c) => textOf(c)).join("\n").trim();
      if (bodyText.length > 10) content = bodyText;
    }
    if (!content) content = textOf(container);
  }

  if (!content || content.length < 5) return null;

  // Content-based type inference if still unknown
  if (artifactType === "text") {
    if (content.trimStart().startsWith("import ") || content.includes("export default") || /React/.test(content)) {
      artifactType = "jsx";
    } else if (content.trimStart().startsWith("<") && content.includes("</")) {
      artifactType = "html";
    } else if (content.trimStart().startsWith("#") || content.includes("\n## ")) {
      artifactType = "md";
    }
  }

  if (!title) title = `Artifact (${artifactType})`;

  return { type: artifactType, title, content };
}

function buildArtifactsResult(artifacts) {
  return {
    type: "artifacts",
    platform: "claude",
    url: location.href,
    title: document.title,
    artifacts,
    count: artifacts.length,
    extractedAt: new Date().toISOString(),
  };
}




// ── Platform-aware input/send button finders ────────────────────────────
const PLATFORM_SELECTORS = {
  chatgpt: { input: ['#prompt-textarea','textarea[data-id]','div[contenteditable="true"][data-lexical-editor]'], send: ['button[data-testid="send-button"]','button[aria-label="Send"]'] },
  gemini:  { input: ['rich-textarea div[contenteditable="true"]','div[contenteditable="true"][role="textbox"]'], send: ['button[aria-label*="send message" i]','.send-button-container button'] },
  claude:  { input: ['div.ProseMirror[contenteditable="true"]','div[contenteditable="true"][data-placeholder]'], send: ['button[aria-label*="Send Message" i]'] },
  deepseek:{ input: ['textarea#chat-input','textarea[placeholder*="发给"]'], send: ['div[role="button"][aria-label*="发送" i]','button[type="submit"]'] },
  grok:    { input: ['textarea[placeholder*="Ask"]','div[contenteditable="true"][role="textbox"]'], send: ['button[aria-label*="send" i]'] },
};

function getCfg() {
  var h=location.hostname;
  if(h.includes('chatgpt')||h.includes('openai')) return PLATFORM_SELECTORS.chatgpt;
  if(h.includes('gemini')) return PLATFORM_SELECTORS.gemini;
  if(h.includes('claude.ai')) return PLATFORM_SELECTORS.claude;
  if(h.includes('deepseek')) return PLATFORM_SELECTORS.deepseek;
  if(h.includes('grok')) return PLATFORM_SELECTORS.grok;
  return null;
}

function vis(el) { if(!el) return false; try { return el.checkVisibility?el.checkVisibility():!!el.offsetParent; } catch(e) { return false; } }

function findInput() {
  var cfg=getCfg();
  if(!cfg) return null;
  for(var i=0;i<cfg.input.length;i++){ var els=document.querySelectorAll(cfg.input[i]); for(var j=0;j<els.length;j++){ if(vis(els[j])) return els[j]; } }
  return null;
}

function findSend(input) {
  var cfg=getCfg();
  if(!cfg) return null;
  var roots=[input?input.closest('form'):null,input?input.closest('fieldset'):null,null,document]; if(input&&input.parentElement&&input.parentElement.parentElement) roots.splice(2,0,input.parentElement.parentElement);
  for(var i=0;i<roots.length;i++){
    for(var j=0;j<cfg.send.length;j++){
      try { var els=roots[i].querySelectorAll(cfg.send[j]); for(var k=0;k<els.length;k++){ if(vis(els[k])&&!els[k].disabled) return els[k]; } } catch(e) {}
    }
  }
  return null;
}

// ── Performance-optimized send message ──────────────────────────────────
const SEND_CONFIRMATION_MODES = new Set(["dispatch","confirmed"]);
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 1800;
const MAX_BUTTON_READY_FRAMES = 8;
const DEFAULT_USER_MSG_SEL = ['[data-message-author-role="user"]','[data-testid="user-message"]','user-query','.user-query'];
const DEFAULT_STOP_SEL = ['button[data-testid*="stop" i]','button[aria-label*="stop" i]','button[aria-label*="停止" i]'];

function norm(v){var s=String(v||"");s=s.replace(/[\r\n]+/g,"\n");s=s.replace(/\s+/g," ");return s.trim();}
function readComp(input){return(input instanceof HTMLTextAreaElement||input instanceof HTMLInputElement)?input.value:(input.innerText||input.textContent||"");}

function waitTick(){return new Promise(function(r){var done=false;var t=setTimeout(function f(){if(done)return;done=true;clearTimeout(t);r();},50);requestAnimationFrame(f);});}

async function waitBtnReady(input,btn,max){max=max||MAX_BUTTON_READY_FRAMES;var b=btn||null;if(!b||b.disabled===false)return b;for(var i=0;i<max;i++){await waitTick();b=findSend(input)||b;if(b&&!b.disabled)return b;}return b;}

async function fillInput(input,text){
  input.focus();
  if(input.tagName==="TEXTAREA"||input.tagName==="INPUT"){
    var proto=input.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var d=Object.getOwnPropertyDescriptor(proto,"value");
    if(d&&d.set)d.set.call(input,text);else input.value=text;
    input.dispatchEvent(new InputEvent("input",{bubbles:true,composed:true}));
  }else{
    input.textContent=text;
    input.dispatchEvent(new InputEvent("input",{bubbles:true,composed:true,inputType:"insertText",data:text}));
  }
  var expected=norm(text);var actual=norm(readComp(input));
  if(actual!==expected){await waitTick();actual=norm(readComp(input));}
  if(actual!==expected)throw new Error("Input mismatch: expected length "+text.length);
  var btn=findSend(input);return btn?waitBtnReady(input,btn):null;
}

function waitSubmission(opts){
  var input=opts.input,text=opts.text,sendAction=opts.sendAction,timeout=opts.timeout||DEFAULT_CONFIRMATION_TIMEOUT_MS;
  return new Promise(function(resolve,reject){
    var started=performance.now();
    var root=input.closest('[role="main"]')||input.closest("main")||document.body;
    var expected=norm(text);
    var initialUser=root.querySelectorAll(DEFAULT_USER_MSG_SEL.join(",")).length;
    var settled=false,obs=null,timeoutId=null,timers=[];
    function cleanup(){if(obs){obs.disconnect();obs=null;}input.removeEventListener("input",check,true);input.removeEventListener("change",check,true);clearTimeout(timeoutId);timers.forEach(function(t){clearTimeout(t);});}
    function finish(ok,sig){if(settled)return;settled=true;cleanup();resolve({confirmed:ok,signal:sig,durationMs:Math.round(performance.now()-started)});}
    function check(){
      if(settled)return;
      var cur=norm(readComp(input));
      if(cur===""||cur!==expected){finish(true,"composer_changed");return;}
      if(root.querySelectorAll(DEFAULT_USER_MSG_SEL.join(",")).length>initialUser){finish(true,"user_message_added");return;}
      var stopBtn=root.querySelector(DEFAULT_STOP_SEL.join(","));
      if(stopBtn&&stopBtn.offsetParent){finish(true,"generation_started");return;}
    }
    obs=new MutationObserver(check);
    obs.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
    input.addEventListener("input",check,true);input.addEventListener("change",check,true);
    timers.push(setTimeout(check,100),setTimeout(check,350),setTimeout(check,800));
    timeoutId=setTimeout(function(){check();if(!settled)finish(false,"timeout");},timeout);
    Promise.resolve().then(sendAction).catch(function(e){if(!settled){settled=true;cleanup();reject(e);}});
  });
}

async function sendMessage(text,confirmation){
  confirmation=confirmation||"confirmed";
  var started=performance.now();
  if(!text||!text.trim())throw new Error("消息不能为空");
  if(!SEND_CONFIRMATION_MODES.has(confirmation))throw new Error("无效confirmation: "+confirmation);
  var input=findInput();
  if(!input)throw new Error("找不到输入框: "+location.href);
  var btn=await fillInput(input,text);
  var method,sendAction;
  if(btn){method="button";sendAction=function(){btn.click();};}
  else{
    var form=input.closest("form");
    if(form&&form.requestSubmit){method="form";sendAction=function(){form.requestSubmit();};}
    else{method="enter";sendAction=function(){input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}));};}
  }
  var cfg=getCfg?getCfg():{};
  if(confirmation==="dispatch"){await Promise.resolve().then(sendAction);return{ok:true,sent:true,confirmed:false,confirmation:"dispatch",confirmationSignal:"dispatched",site:cfg.name||"unknown",method:method,url:location.href,durationMs:Math.round(performance.now()-started)};}
  var r=await waitSubmission({input:input,text:text,sendAction:sendAction});
  if(!r.confirmed)throw new Error("提交确认超时"+DEFAULT_CONFIRMATION_TIMEOUT_MS+"ms");
  return{ok:true,sent:true,confirmed:true,confirmation:"confirmed",confirmationSignal:r.signal,site:cfg.name||"unknown",method:method,url:location.href,durationMs:Math.round(performance.now()-started)};
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener(function(request,sender,sendResponse){
  if(request.type==="SEND_MESSAGE"){sendMessage(request.text||request.message,request.confirmation||"confirmed").then(sendResponse).catch(function(e){sendResponse({ok:false,sent:false,error:e.message});});return true;}
  if(request.type==="EXTRACT_CHAT")sendResponse(extractChat());
  if(request.type==="EXTRACT_PAGE")sendResponse(extractPage());
  if(request.type==="EXTRACT_ARTIFACTS"){extractArtifacts(request.includeLinks||false,request.maxLinks||10).then(sendResponse);return true;}
  return true;
});
