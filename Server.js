const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const fsp = require('fs').promises;
const axios     = require('axios');
const Greenlock = require('greenlock-express');
const crypto    = require('crypto');

/* ---------------------------------------------------------------------------*/
/*   Hard-coded 256-bit key (32 bytes) – keep this secret in production!  */
/* ---------------------------------------------------------------------------*/
let HARDCORE_KEY = Buffer.from(
  '{redacted}',
  'hex'
);
const BACKUP_KEY = Buffer.from(
  '{redacted}',
  'hex'
);

/* ---------------------------------------------------------------------------*/
/*   AES-256-GCM helpers                                                     */
/* ---------------------------------------------------------------------------*/
function encryptGCM(plaintext, key = BACKUP_KEY) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), content: encrypted.toString('hex') };
}
function decryptGCM(encrypted, key = BACKUP_KEY) {
  const { iv, tag, content } = encrypted;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(content, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

/* ---------------------------------------------------------------------------*/
/*   Public directory                                                        */
/* ---------------------------------------------------------------------------*/
const publicDir = path.join(__dirname, 'public');

/* ---------------------------------------------------------------------------*/
/*   Queue & processing                                                    */
/* ---------------------------------------------------------------------------*/
let requestQueue = [];
let processing   = false;

let offlineMode     = false;
let maintenanceMode = false;                // true  ? redirect to /maintenance
const STATUS_URL = 'https://{redacted}/status';
const POLL_INTERVAL_MS = 60_000;             // 60 s

/* ---------------------------------------------------------------------------*/
/*   Flat conversation history (by chatId only)                              */
/* ---------------------------------------------------------------------------*/
let conversations = {};           // { chatId: [ { role, content } ] }

const bigModels = [
  'gemma3_27b',
];

let bigModelUsage = {};           // { sessionId: { count, lastReset, lastUsed } }

function isBigModel(model) {
  return bigModels.includes(model);
}

function canUseBigModel(sessionId, model) {
  // Only apply limits to the four big models
  if (!isBigModel(model)) return { allowed: true };

  const now         = Date.now();
  const dailyLimit  = 20;
  const cooldownMs  = 2 * 60 * 1000;   // 2 minutes

  if (!bigModelUsage[sessionId]) {
    bigModelUsage[sessionId] = { count: 0, lastReset: now, lastUsed: 0 };
  }

  // Reset count after 24h
  if (now - bigModelUsage[sessionId].lastReset > 24 * 60 * 60 * 1000) {
    bigModelUsage[sessionId].count    = 0;
    bigModelUsage[sessionId].lastReset = now;
  }

  // Enforce daily limit
  if (bigModelUsage[sessionId].count >= dailyLimit) {
    return { allowed: false, reason: `Daily limit of ${dailyLimit} reached` };
  }

  // Enforce cooldown
  if (now - bigModelUsage[sessionId].lastUsed < cooldownMs) {
    const waitSec = Math.ceil((cooldownMs - (now - bigModelUsage[sessionId].lastUsed)) / 1000);
    return { allowed: false, reason: `Please wait ${waitSec} seconds before using a large model again` };
  }

  return { allowed: true };
}

function recordBigModelUsage(sessionId) {
  if (!bigModelUsage[sessionId]) {
    bigModelUsage[sessionId] = { count: 0, lastReset: Date.now(), lastUsed: 0 };
  }
  bigModelUsage[sessionId].count++;
  bigModelUsage[sessionId].lastUsed = Date.now();
}

/* ---------------------------------------------------------------------------*/
/*   Session ID from headers (used only for rate limiting)                  */
/* ---------------------------------------------------------------------------*/
function getSessionId(req) {
  return req.headers['x-session-id'] || req.body.sessionID || req.ip;
}


/* ---------------------------------------------------------------------------*/
/*   Static file serving                                                   */
/* ---------------------------------------------------------------------------*/
function serveStatic(req, res) {
  const cleanUrl = (req.path || '/').split('?')[0];
  let requestedPath;
  switch (cleanUrl) {
    case '/': case '/main':          requestedPath = 'main.html';  break;
    case '/try':                     requestedPath = 'index.html'; break;
    case '/privacy':                 requestedPath = 'privacy_policy.html'; break;
    case '/tos':                     requestedPath = 'tos.html'; break;
    case '/q_a':                     requestedPath = 'Q_&_A.html'; break;
    case '/chan-ai':                 requestedPath = 'chan-ai.html'; break;
    case '/api/docs':                 requestedPath = 'api.html'; break;
    case '/maintenance':             requestedPath = 'maintenance.html'; break;
    case '/offline':                 requestedPath = 'offline.html'; break;
    case '/create-account':           requestedPath = 'create_account.html'; break;
    case '/sign-in':                  requestedPath = 'signin.html'; break;
    default:                         requestedPath = cleanUrl; break;
  }
  let filePath = path.join(publicDir, path.normalize(requestedPath));
  if (!filePath.startsWith(publicDir)) return res.status(403).send('Forbidden');

  fs.readFile(filePath, (err, content) => {
    if (err) return res.status(404).send('404 - Not Found');
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'text/html';
    switch (ext) {
      case '.css':  contentType = 'text/css'; break;
      case '.js':   contentType = 'application/javascript'; break;
      case '.json': contentType = 'application/json'; break;
      case '.png':  contentType = 'image/png'; break;
      case '.jpg':
      case '.jpeg': contentType = 'image/jpeg'; break;
      case '.svg':  contentType = 'image/svg+xml'; break;
      case '.webp': contentType = 'image/webp'; break;
      case '.ico':  contentType = 'image/x-icon'; break;
    }
    res.setHeader('Content-Type', contentType);
    res.send(content);
  });
}

/* ---------------------------------------------------------------------------*/
/*   Queue Processing                                                      */
/* ---------------------------------------------------------------------------*/
async function processQueue() {
  if (processing || requestQueue.length === 0) return;

  processing = true;

  const { chatId, message, messages, model, res, sessionId } = requestQueue.shift();

  try {

    /* ------------------------------------------------------------- */
    /* Build conversation history                                    */
    /* ------------------------------------------------------------- */

    if (messages && Array.isArray(messages)) {

      // API request already contains full conversation
      conversations[chatId] = messages;

    } else {

      // Legacy /ask behaviour
      if (!conversations[chatId]) {
        conversations[chatId] = [
          {
            role: 'system',
            content: 'You are a helpful assistant that provides helpfull and detailed responses'
          }
        ];
      }

      conversations[chatId].push({
        role: 'user',
        content: message
      });
    }

    /* ------------------------------------------------------------- */
    /* Build request payload                                         */
    /* ------------------------------------------------------------- */

    const apiUrl = 'https://{redacted}/';
    const endpoint = model.startsWith('z') ? 'generate-image' : 'generate-text';
    const baseUrl = `${apiUrl}${endpoint}`;

    let payload;

    if (model.startsWith('z')) {

      payload = {
        model,
        prompt: encryptGCM(message)
      };

    } else {

      const messagesJson = JSON.stringify(conversations[chatId]);
      const encryptedMessages = encryptGCM(messagesJson);

      payload = {
        model,
        messages: encryptedMessages
      };

    }

    /* ------------------------------------------------------------- */
    /* Send request to external API                                  */
    /* ------------------------------------------------------------- */

    const apiResponse = await axios.post(baseUrl, payload);
    let data = apiResponse.data;

    /* ------------------------------------------------------------- */
    /* Decrypt response if necessary                                 */
    /* ------------------------------------------------------------- */

    if (data.encryptedMessage) {

      try {

        const plaintext = decryptGCM(data.encryptedMessage);

        data.message = plaintext;
        delete data.encryptedMessage;

      } catch (err) {

        console.error('Decryption error:', err.message);

        return res.status(502).json({
          message: 'Failed to decrypt response from external API'
        });

      }

    }

    /* ------------------------------------------------------------- */
    /* Send response to client                                       */
    /* ------------------------------------------------------------- */

    if (model.startsWith('z')) {

      res.json({
        imageUrl: data.imageUrl
      });

    } else {

      // Store assistant response
      conversations[chatId].push({
        role: 'assistant',
        content: data.message
      });

      res.json({
        message: data.message
      });

    }

    /* ------------------------------------------------------------- */
    /* Record large-model usage                                      */
    /* ------------------------------------------------------------- */

    recordBigModelUsage(sessionId);

  } catch (err) {

    console.error('Error in processQueue:', err.message);

    res.status(500).json({
      message: 'Internal Server Error / Feature Disabled'
    });

  } finally {

    processing = false;

    // Continue processing queue
    processQueue();

  }
}
/* ---------------------------------------------------------------------------*/
/*   Valid models                                                          */
/* ---------------------------------------------------------------------------*/
const validModels = {
  gpt_oss_20b: true,
  gemma3_27b: true,
  gemma3_1b: true,
  qwen3_coder_30b: true,
  qwen3_4b: true,
  llama3_1_8b: true,
  Chan_AI_Censored: true,
  Chan_AI_Uncensored: true,
  chat_small: true,
  z_image: true,
  LinguaTale_EN_ES: true,
};

/* ---------------------------------------------------------------------------*/
/*   Express app                                                          */
/* ---------------------------------------------------------------------------*/
const app = express();
app.use(express.json());

const ACCOUNT_FILE = path.resolve('{redacted}', 'account_numbers.txt');
const FILE_FLAGS = 'a';
const FILE_MODE = 0o600;
const ACCOUNT_REGEX = /^\d{10,100}$/;

// ---- helper: validation ----
function isValidAccountNumber(acct) {
  return ACCOUNT_REGEX.test(acct);
}
async function isAccountNumberInFile(acct) {
  const cleanAcct = acct.trim();

  try {
    await fsp.access(ACCOUNT_FILE);
  } catch {
    return false;
  }

  const data = await fsp.readFile(ACCOUNT_FILE, 'utf8');

  const lines = data
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return lines.includes(cleanAcct);
}
app.get('/lookup/:account_number', async (req, res) => {
  try {
    const acct = req.params.account_number;
    if (!isValidAccountNumber(acct)) {
      return res.status(400).json({
        error:
          "Invalid format – account_number must be exactly 64 digits (0-9)",
      });
    }

    const exists = await isAccountNumberInFile(acct);

    return res.status(200).json({ exists });
  } catch (err) {
    console.error('Error handling /lookup:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/add_account_number', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Missing JSON body' });
    }

    const { account_number: acct } = req.body;

    if (typeof acct !== 'string' || !isValidAccountNumber(acct)) {
      return res.status(400).json({
        error: 'Invalid format – account_number must be exactly 64 digits (0-9)',
      });
    }

    fs.appendFile(
      ACCOUNT_FILE,
      acct + '\n',
      { encoding: 'utf8', flag: FILE_FLAGS, mode: FILE_MODE },
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        return res.status(200).json({ status: 'success' });
      }
    );

  } catch (err) {
    console.error('Error handling /add_account_number:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
/* ---------------------------------------------------------------------------*/
/*   POST /ask                                                             */
/* ---------------------------------------------------------------------------*/
app.post('/ask', (req, res) => {
  const { message, model = 'chat_small', chatId } = req.body;
  const sessionId = getSessionId(req);

  if (!message || message.length > 5_000) {
    return res.status(400).json({ message: 'Invalid message' });
  }

  if (!validModels[model]) {
    return res.status(400).json({ message: 'Invalid model' });
  }

  if (!chatId) {
    return res.status(400).json({ message: 'Missing chatId' });
  }

  /* --------------------------------------------------------------------- */
  /*   Big-model rate-limit                                               */
  /* --------------------------------------------------------------------- */
  const bigCheck = canUseBigModel(sessionId, model);
  if (!bigCheck.allowed) {
    return res.status(429).json({ message: bigCheck.reason });
  }

  /* Queue the request */
  requestQueue.push({ chatId, message, model, res, sessionId });
  processQueue();
});

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setInterval(async () => {
  /* ----------------------------------------------------------
   * Existing cleanup logic
   * ---------------------------------------------------------- */
  console.log('?? Hourly cleanup triggered — wiping all stored data.');
  conversations = {};
  allowedChanSessions.clear();
  bigModelUsage = {};

  /* ----------------------------------------------------------
   * Key rotation (authorized via BACKUP key)
   * ---------------------------------------------------------- */
  try {
    // 2.1 Generate NEW 256-bit AES key
    const newKeyBytes = crypto.randomBytes(32); // 32 bytes
    const newKeyHex = newKeyBytes.toString('hex'); // 64-char hex

    // 2.2 Encrypt the NEW key using BACKUP KEY ONLY
    const encryptedPayload = encryptGCM(newKeyHex, BACKUP_KEY);

    // 2.3 Send rotation request to API
    const resp = await fetch('https://{redacted}/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encryptedPayload)
    });

    // 2.4 Abort if rotation failed
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Rotate failed (${resp.status}): ${errBody}`);
    }

    // 2.5 Rotation succeeded ? adopt new primary key locally
    HARDCORE_KEY = newKeyBytes;
    console.log('?? [Rotate] Primary AES key rotated successfully (via BACKUP key).');
  } catch (err) {
    // Fail-safe: old key remains active
    console.error(
      '? [Rotate] Rotation error — primary key unchanged:',
      err.message
    );
  }
}, CLEANUP_INTERVAL_MS);

async function checkStatus() {
  try {
    const resp   = await axios.get(STATUS_URL, { timeout: 5_000 });
    const raw    = typeof resp.data === 'object'
      ? JSON.stringify(resp.data).toLowerCase()
      : resp.data.toString().toLowerCase();

    // Offline first – if the API says “offline” or we couldn’t reach it
    offlineMode = raw.includes('offline');

    // Maintenance only matters when we’re NOT offline
    maintenanceMode = !offlineMode && raw.includes('maintenance');
  } catch (err) {
    // Any network error = “offline”
    offlineMode     = true;
    maintenanceMode = false;
  }

  console.log(
    `[Status] offline=${offlineMode}  maintenance=${maintenanceMode}`
  );
}
// Kick-off immediately, then every 60 s
checkStatus();
setInterval(checkStatus, POLL_INTERVAL_MS);

/* ----------------------------------------------------------
 * /queue-status – status of the current user in the queue
 * ---------------------------------------------------------- */
app.get('/queue-status', (req, res) => {
  const sessionId = getSessionId(req);
  const position = requestQueue.findIndex(q => q.sessionId === sessionId);
  res.json({ queuePosition: position >= 0 ? position + 1 : 0 });
});

function enqueue(task) {
  let normalised = {
    chatId: task.chatId,
    model: task.model,
    res: task.res,
    sessionId: task.sessionId
  };

  // New API routes (chat / generate / embeddings)
  if (task.type && task.payload) {

    // FULL message history
    if (Array.isArray(task.payload.messages)) {
      normalised.messages = task.payload.messages;

      // Last user message (used for logging / fallback)
      const lastMsg = task.payload.messages
        .slice()
        .reverse()
        .find(m => m.role === "user");

      normalised.message = lastMsg ? lastMsg.content : "";
    }

    // Prompt-style requests
    else if (typeof task.payload.prompt === "string") {
      normalised.message = task.payload.prompt;
    }

    // Embedding-style input
    else if (typeof task.payload.input === "string") {
      normalised.message = task.payload.input;
    }

    else {
      normalised.message = "";
    }

  }

  // Legacy `/ask` route
  else {
    normalised.message = task.message;
  }

  requestQueue.push(normalised);

  // Start queue processing
  processQueue();
}

/* ------------------------------------------------------------------------ */
/*  Legacy /ask route (used by the internal /ask endpoint)                */
/* ------------------------------------------------------------------------ */
app.post('/ask', (req, res) => {
  const { model, messages, prompt, stream } = req.body
  if (!model) return res.status(400).json({ error: 'Missing model' })

  const sessionId = getSessionId(req)
  const chatId    = req.body.chat_id || Math.random().toString(36).substring(2, 10)

  enqueue({
    type:     'legacy',
    isOllama: false,
    chatId,
    model,
    message:  prompt || messages?.[0]?.content,
    res,
    sessionId
  })
})

app.post('/api/chat', async (req, res) => {
  const {
    model,
    system_prompt,
    messages,
    temperature,
    sessionId,
  } = req.body;

  /* ---------- Basic validation ---------- */
  if (!model) {
    return res.status(400).json({ error: "Missing model" });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages must be an array" });
  }

  if (!sessionId) {
    return res.status(401).json({ error: "Missing account number" });
  }

  /* ---------- Validate account format ---------- */
  if (!isValidAccountNumber(sessionId)) {
    return res.status(400).json({
      error: "Invalid account number format",
    });
  }

  /* ---------- Check if account exists ---------- */
  try {
    const exists = await isAccountNumberInFile(sessionId);

    if (!exists) {
      return res.statu25s(403).json({
        error: "Invalid account number (not found)",
      });
    }
  } catch (err) {
    console.error("Account check failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }

  /* ---------- Use ONLY verified account ---------- */
  const userId = sessionId;

  /* ---------- Generate chat ID ---------- */
  const chatId = Math.random().toString(36).substring(2, 10);

  /* ---------- Prepare messages ---------- */
  const fullMessages = system_prompt
    ? [{ role: "system", content: system_prompt }, ...messages]
    : messages;

  /* ---------- Queue job ---------- */
  enqueue({
    type: "chat",
    chatId,
    model,
    payload: {
      messages: fullMessages,
      temperature: temperature ?? 0.7,
    },
    res,
    userId,
  });
});
app.get('/list', async (req, res) => {
  try {
    // Forward the request to the external service
    const { data } = await axios.get('https://{redacted}/list', {
    });

    // Return the JSON exactly as received
    res.json(data);
  } catch (err) {
    console.error('Error fetching /list from {redacted}:', err.message);

    // Basic error handling – you can adjust status codes as needed
    const status = err.response?.status || 502;   // Bad Gateway if remote failed
    const message = err.response?.data?.message || err.message;

    res.status(status).json({
      error: true,
      message: `Failed to retrieve model list: ${message}`
    });
  }
});

/* ----------------------------------------------------------
 * Static serving
 * ---------------------------------------------------------- */
app.use((req, res, next) => {
  // 1?? If we’re offline ? /offline (takes priority)
  if (offlineMode && !req.path.startsWith('/offline')) {
    console.log(`[Redirect] ${req.originalUrl} ? /offline`);
    return res.redirect(302, '/offline');
  }

  // 2?? Otherwise, if maintenance ? /maintenance
  if (maintenanceMode && !req.path.startsWith('/maintenance')) {
    console.log(`[Redirect] ${req.originalUrl} ? /maintenance`);
    return res.redirect(302, '/maintenance');
  }

  // 3?? Normal request
  next();
});
// 2??  All other routes – static, API, etc.
app.use((req, res) => serveStatic(req, res));
/* ----------------------------------------------------------
 * Greenlock HTTPS setup
 * ---------------------------------------------------------- */
const greenlock = Greenlock.init({
  packageRoot: __dirname,
  configDir: './greenlock.d',
  maintainerEmail: '{redacted}',
  cluster: false,
  server:
    'https://acme-staging-v02.api.letsencrypt.org/directory',
  approveDomains: async opts => {
    console.log('Greenlock requested hostname:', opts.hostname);
    return {
      domains: ['local-axiom.com', 'www.local-axiom.com'],
      email: '{redacted}',
      agreeTos: true
    };
  }
});

/* ----------------------------------------------------------
 * Start HTTPS server with Greenlock
 * ---------------------------------------------------------- */
greenlock.serve(app);