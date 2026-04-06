/* ==================================================== */
/*  CHAT STATE & INPUT HANDLING – unchanged          */
/* ==================================================== */
let chats = [];               // array of {chatId, messages[]}
let currentChatIndex = null;   // index of the chat currently displayed
/* ---------------------------------------------------- */
/*  Input helpers                                       */
/* ---------------------------------------------------- */
function handleKeyPress(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}
function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}
/* ---------------------------------------------------- */
/*  Safe message formatting                            */
/* ---------------------------------------------------- */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function formatMessage(text) {
  if (!text) return "";
  let escaped = escapeHtml(text);
  // Code blocks ```...```
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `
    <div class="code-block">
      <button class="copy-btn">Copy</button>
      <div class="code-scroll">
        <pre><code>${code.trim()}</code></pre>
      </div>
    </div>
  `);
  // Inline code `...`
  escaped = escaped.replace(/`([^`]+)`/g, `<span class="inline-code">$1</span>`);
  // Bold **...**
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, `<strong>$1</strong>`);
  // Newlines
  escaped = escaped.replace(/\n/g, "<br>");
  return escaped;
}
/* ---------------------------------------------------- */
/*  Message rendering                                  */
/* ---------------------------------------------------- */
function appendMessage(role, content, isTyping = false) {
  const chatbox = document.getElementById("chatbox");
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;
  if (content.startsWith("data:image/")) {
    const img = document.createElement("img");
    img.src = content;
    img.className = "generated-image";
    msgDiv.appendChild(img);
  } else {
    msgDiv.innerHTML = `
      <div class="message-content ${isTyping ? "typing" : ""}">
        ${formatMessage(content)}
      </div>
    `;
  }
  chatbox.appendChild(msgDiv);
  chatbox.scrollTop = chatbox.scrollHeight; // keep scrolled to bottom
  return msgDiv;
}
/* ==================================================== */
/*  NEW: Helper that returns the current identifier   */
/* ==================================================== */
/**
* Returns the identifier that should be sent to the server.
*
* If a user is logged in, it returns the 64-digit account number
* stored in `sessionStorage` under the key `User`.
* Otherwise it falls back to the old session ID logic.
*/
function getIdentity() {
  // 1??  Signed-in user ?
  const signedInAcc = sessionStorage.getItem("User");
  if (signedInAcc) return signedInAcc;   // 64-digit account number
  // 2??  No user – use the original session ID
  return getSessionId();
}
function isLoggedIn() {
  return !!sessionStorage.getItem("User");
}
function applyModelPermissions() {
  const select = document.getElementById("modelSelect");
  const btn = document.getElementById("changeModelBtn");
  if (!isLoggedIn()) {
    // Force Qwen 3 4B for guests
    select.value = "qwen3_4b";
    const qwen = modelList.find(m => m.value === "qwen3_4b");
    if (btn && qwen) btn.textContent = qwen.name;
    // Optional: prevent opening full model modal
    if (btn) {
      btn.onclick = () => {
        openModelModal(); // or replace with "login required" if you want stricter
      };
    }
  } else {
    // Signed-in users keep normal behavior
    const current = modelList.find(m => m.value === select.value);
    if (btn && current) btn.textContent = current.name;
  }
}
/* ==================================================== */
/*  SEND MESSAGE – updated to use getIdentity()        */
/* ==================================================== */
function sendMessage() {
  const userInput = document.getElementById("userInput");
  const message = userInput.value.trim();
  const model = document.getElementById("modelSelect").value;

  if (!message) return;

  // Create a new chat on first message
  if (currentChatIndex === null) {
    chats.push({ chatId: crypto.randomUUID(), messages: [] });
    currentChatIndex = chats.length - 1;
  }

  const chat = chats[currentChatIndex];
  chat.messages.push({ role: "user", content: message });
  appendMessage("user", message);

  const typingDiv = appendMessage("assistant", "...", true);

  userInput.value = "";
  autoResize(userInput);

  fetch("/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      model,
      sessionId: getIdentity(),
      chatId: chat.chatId
    })
  })
    .then(async (res) => {
      const contentType = res.headers.get("content-type") || "";

      /* ====================================================
         CASE 1: NON-STREAMING (normal JSON response)
      ==================================================== */
      if (contentType.includes("application/json")) {
        const data = await res.json();

        if (res.status === 429) {
          typingDiv.innerHTML = `<p class="error">${data.message}</p>`;
          return;
        }

        let output = "";

        // image response
        if (data.imageUrl) {
          const imgSrc = data.imageUrl.startsWith("data:image/")
            ? data.imageUrl
            : `data:image/png;base64,${data.imageUrl}`;

          typingDiv.innerHTML = `
            <div class="message-content">
              <img src="${imgSrc}" class="generated-image">
            </div>
          `;

          chat.messages.push({ role: "assistant", content: imgSrc });
          updateChatHistory();
          return;
        }

        // text response
        output = data.message || data.content || "";

        typingDiv.innerHTML = `
          <div class="message-content">
            ${formatMessage(output)}
          </div>
        `;

        chat.messages.push({ role: "assistant", content: output });
        updateChatHistory();
        return;
      }

      /* ====================================================
         CASE 2: STREAMING RESPONSE (token-based models)
      ==================================================== */
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let fullText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
          line = line.trim();
          if (!line.startsWith("data:")) continue;

          const jsonStr = line.replace("data:", "").trim();
          if (!jsonStr) continue;

          try {
            const obj = JSON.parse(jsonStr);

            // token streaming
            if (obj.type === "token") {
              fullText += obj.token;
            }

            // full message fallback
            else if (obj.type === "full") {
              fullText = obj.data;
            }

            // other model formats
            else if (obj.message) {
              fullText = obj.message;
            }

            else if (obj.content) {
              fullText = obj.content;
            }

            // live render
            typingDiv.innerHTML = `
              <div class="message-content">
                ${formatMessage(fullText)}
              </div>
            `;
          } catch (e) {
            console.warn("Failed to parse chunk:", jsonStr);
          }
        }
      }

      // final save
      chat.messages.push({
        role: "assistant",
        content: fullText
      });

      updateChatHistory();
    })
    .catch((err) => {
      console.error(err);
      typingDiv.innerHTML = `<p class="error">Error getting response</p>`;
    });
}
/* ==================================================== */
/*  CHAT HISTORY (updated with delete functionality)   */
/* ==================================================== */
function startNewChat() {
  chats.push({ chatId: crypto.randomUUID(), messages: [] });
  currentChatIndex = chats.length - 1;
  document.getElementById("chatbox").innerHTML = "";
  updateChatHistory();
}

function updateChatHistory() {
  const historyDiv = document.getElementById("chatHistory");
  historyDiv.innerHTML = "";
  chats.forEach((chat, index) => {
    if (!chat.messages.length) return;
    const preview =
      chat.messages.find(m => m.role === "user")?.content || "Untitled Chat";
    const item = document.createElement("div");
    item.className = "chat-item";
    item.textContent =
      preview.slice(0, 30) + (preview.length > 30 ? "..." : "");
    item.onclick = () => loadChat(index);
    
    // Add delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.innerHTML = "X";
    deleteBtn.onclick = (e) => {
      e.stopPropagation(); // Prevent triggering chat load
      deleteChat(index);
    };
    
    item.appendChild(deleteBtn);
    historyDiv.appendChild(item);
  });
  if (!historyDiv.innerHTML.trim()) {
    historyDiv.innerHTML = "<p>No previous chats</p>";
  }
}

function loadChat(index) {
  currentChatIndex = index;
  const chatbox = document.getElementById("chatbox");
  chatbox.innerHTML = "";
  chats[index].messages.forEach(msg =>
    appendMessage(msg.role, msg.content)
  );
}

function deleteChat(index) {
  // Remove chat from memory
  chats.splice(index, 1);
  
  // If we're deleting the current chat, reset to null
  if (index === currentChatIndex) {
    currentChatIndex = null;
    document.getElementById("chatbox").innerHTML = "";
  }
  
  // Update UI
  updateChatHistory();
}
/* ==================================================== */
/*  SESSION ID (unchanged) – kept for legacy fallback  */
/* ==================================================== */
function getSessionId() {
  if (!sessionStorage.getItem("sessionId")) {
    sessionStorage.setItem("sessionId", crypto.randomUUID());
  }
  return sessionStorage.getItem("sessionId");
}
/* ==================================================== */
/*  COPY BUTTON HANDLER (unchanged)                    */
/* ==================================================== */
document.addEventListener("click", e => {
  if (e.target.classList.contains("copy-btn")) {
    const block = e.target.closest(".code-block");
    const code = block.querySelector("code").innerText;
    navigator.clipboard.writeText(code);
    e.target.textContent = "Copied!";
    setTimeout(() => (e.target.textContent = "Copy"), 1200);
  }
});
/* ==================================================== */
/*  MODEL SELECTION (unchanged)                        */
/* ==================================================== */
const modelList = [
  /* Text models */
  { value: "gpt_oss_20b", name: "GPT-OSS 20B", desc: "Open-source general LLM.", img: "https://local-axiom.com/Gpt_oss_logo.jpg" },
  { value: "gemma3_27b", name: "Gemma3 27B", desc: "High-quality reasoning model.", img: "https://local-axiom.com/Gemma_logo.jpg" },
  { value: "gemma3_1b", name: "Gemma3 1B", desc: "Fast lightweight model.", img: "https://local-axiom.com/Gemma_logo.jpg" },
  { value: "qwen3_4b", name: "Qwen-3 4B", desc: "Efficient general model.", img: "https://local-axiom.com/Qwen_logo.png" },
  { value: "qwen3_coder_30b", name: "Qwen-3-Coder 30B", desc: "Code-focused model.", img: "https://local-axiom.com/Qwen_logo.png" },
  { value: "llama3_1_8b", name: "LLaMA-3.1 8B", desc: "Balanced performance.", img: "https://local-axiom.com/llama_3_logo.jpg" },
  { value: "Chan_AI_Uncensored", name: "Chan AI 4B", desc: "Unfiltered style model.", img: "https://local-axiom.com/Chan_logo.png" },
  { value: "LinguaTale_EN_ES", name: "LinguaTale-EN-ES", desc: "English to Spanish translation model.", img: "https://local-axiom.com/Chan_logo.png" },
  { value: "z_image", name: "Qwen Z Image", desc: "Fast image generation model by Qwen.", img: "https://local-axiom.com/Qwen_logo.png"}
];
const modal = document.getElementById("modelModal");
const grid = document.getElementById("modelGrid");
const search = document.getElementById("modelSearch");
function openModelModal() {
  modal.style.display = "block";
  search.value = "";
  renderModelCards(); // default: show all models
}
function closeModelModal() {
  modal.style.display = "none";
  grid.innerHTML = ""; // optional cleanup
}
function renderModelCards(filter = "") {
  grid.innerHTML = "";
  let filtered = modelList.filter(m =>
    m.name.toLowerCase().includes(filter.toLowerCase())
  );
  // ?? restrict for guests
  filtered.forEach(m => {
    const card = document.createElement("div");
    card.className = "model-card";
    card.onclick = () => selectModel(m.value);
    card.innerHTML = `
      <img src="${m.img}" alt="${m.name}">
      <h4>${m.name}</h4>
      <p>${m.desc}</p>
    `;
    grid.appendChild(card);
  });
}
function filterModels() {
  renderModelCards(search.value.trim());
}
function selectModel(value) {
  const select = document.getElementById("modelSelect");
  select.value = value;
  const btn = document.getElementById("changeModelBtn");
  const chosen = modelList.find(m => m.value === value);
  btn.textContent = chosen ? chosen.name : "Change Model";
  closeModelModal();
}
/* ==================================================== */
/*  EVENT LISTENERS (unchanged)                         */
/* ==================================================== */
document.addEventListener("DOMContentLoaded", () => {
  const changeBtn = document.getElementById("changeModelBtn");
  if (changeBtn) {
    changeBtn.addEventListener("click", openModelModal);
  }
  const closeBtn =
    document.getElementById("closeBtn") ||
    document.querySelector("#modelModal .content > button:first-of-type");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeModelModal);
  }
  // NEW ?? apply login-based model rules
  applyModelPermissions();
});
