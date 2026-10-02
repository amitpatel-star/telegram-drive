require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const FormData = require("form-data");
const session = require("express-session");
const { generateSecret, generateURI, verifySync } = require("otplib");
const QRCode = require("qrcode");

const app = express();
const upload = multer({ dest: path.join(__dirname, "temp_uploads"), limits: { fileSize: 50 * 1024 * 1024 } });

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ===== TOTP Auth Config =====
const AUTH_PATH = path.join(__dirname, "auth.json");
let authConfig = { secret: null, isSetup: false };

function loadAuth() {
  const envSecret = process.env.TOTP_SECRET;
  try {
    if (fs.existsSync(AUTH_PATH)) {
      authConfig = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    }
  } catch (e) {
    authConfig = { secret: null, isSetup: false };
  }
  if (envSecret) {
    authConfig.secret = envSecret;
    authConfig.isSetup = true;
  }
}

function saveAuth() {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(authConfig, null, 2));
}

loadAuth();

// ===== Database =====
const DB_PATH = path.join(__dirname, "file_index.json");
let db = { files: [], folders: [] };

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
      db = { files: data.files || data || [], folders: data.folders || [] };
      if (!db.folders.find(f => f.id === "root")) {
        db.folders.unshift({ id: "root", name: "My Drive", parent: null, createdAt: new Date().toISOString() });
      }
    } else {
      db = { files: [], folders: [{ id: "root", name: "My Drive", parent: null, createdAt: new Date().toISOString() }] };
    }
  } catch (e) {
    db = { files: [], folders: [{ id: "root", name: "My Drive", parent: null, createdAt: new Date().toISOString() }] };
  }
}

function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
loadDB();

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Any request resets the 10-minute countdown while active
  cookie: { maxAge: 10 * 60 * 1000 } // 10 minutes of inactivity
}));

const tempDir = path.join(__dirname, "temp_uploads");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ===== Auth Routes (public) =====

// Check auth status
app.get("/api/auth/status", (req, res) => {
  res.json({
    isSetup: authConfig.isSetup,
    isLoggedIn: req.session.authenticated === true
  });
});

// Setup TOTP disabled - secret is already provisioned
app.post("/api/auth/setup", (req, res) => {
  return res.status(403).json({ error: "Vault already paired and locked." });
});

// Verify TOTP and login
app.post("/api/auth/verify", (req, res) => {
  const { code, secret } = req.body;

  if (!code) return res.status(400).json({ error: "Code required" });

  // If setting up for first time, use the provided secret
  if (!authConfig.isSetup && secret) {
    const result = verifySync({ secret, token: code });
    if (result && result.valid) {
      authConfig.secret = secret;
      authConfig.isSetup = true;
      saveAuth();
      req.session.authenticated = true;
      return res.json({ success: true, message: "Setup complete!" });
    } else {
      return res.status(401).json({ error: "Invalid code. Try again." });
    }
  }

  // Normal login
  if (!authConfig.isSetup || !authConfig.secret) {
    return res.status(400).json({ error: "TOTP not set up yet" });
  }

  const result = verifySync({ secret: authConfig.secret, token: code, epochTolerance: 120 });
  if (result && result.valid) {
    req.session.authenticated = true;
    return res.json({ success: true });
  } else {
    return res.status(401).json({ error: "Invalid code" });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  // Allow share download pages without auth
  if (req.path.startsWith("/share/") || req.path.startsWith("/api/auth/")) {
    return next();
  }
  // Allow file download via share link
  if (req.path.match(/^\/api\/download\//) && req.query.shared === "true") {
    return next();
  }
  // Allow static files (login page assets)
  if (req.path.endsWith(".css") || req.path.endsWith(".js") || req.path.endsWith(".ico") || req.path.endsWith(".woff2")) {
    return next();
  }

  if (req.session.authenticated) return next();

  // For API calls return 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // For page requests, serve login page
  return res.sendFile(path.join(__dirname, "public", "login.html"));
}

// Serve login page explicitly
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Apply auth to everything below
app.use(requireAuth);

// Serve static files (after auth)
app.use(express.static(path.join(__dirname, "public")));

// ===== FOLDERS =====

app.post("/api/folders", (req, res) => {
  const { name, parent } = req.body;
  if (!name) return res.status(400).json({ error: "Folder name required" });
  const folder = {
    id: crypto.randomBytes(6).toString("hex"),
    name,
    parent: parent || "root",
    createdAt: new Date().toISOString()
  };
  db.folders.push(folder);
  saveDB();
  res.json({ success: true, folder });
});

app.get("/api/folders", (req, res) => {
  res.json({ folders: db.folders });
});

app.delete("/api/folders/:id", (req, res) => {
  const id = req.params.id;
  if (id === "root") return res.status(400).json({ error: "Cannot delete root" });
  function getChildIds(parentId) {
    let ids = [parentId];
    db.folders.filter(f => f.parent === parentId).forEach(f => { ids = ids.concat(getChildIds(f.id)); });
    return ids;
  }
  const allIds = getChildIds(id);
  db.files.forEach(f => { if (allIds.includes(f.folderId)) f.folderId = "root"; });
  db.folders = db.folders.filter(f => !allIds.includes(f.id) || f.id === "root");
  saveDB();
  res.json({ success: true });
});

app.patch("/api/folders/:id", (req, res) => {
  const folder = db.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "Folder not found" });
  if (req.body.name) folder.name = req.body.name;
  if (req.body.parent) folder.parent = req.body.parent;
  saveDB();
  res.json({ success: true, folder });
});

// ===== FILES =====

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const originalName = req.file.originalname;
    const filePath = req.file.path;
    const fileSize = req.file.size;
    const mimeType = req.file.mimetype || "application/octet-stream";
    const folderId = req.body.folderId || "root";

    const form = new FormData();
    form.append("chat_id", CHANNEL_ID);
    form.append("document", fs.createReadStream(filePath), { filename: originalName, contentType: mimeType });
    form.append("caption", `📁 ${originalName}\n📦 ${formatSize(fileSize)}\n🕐 ${new Date().toISOString()}`);

    const tgRes = await fetch(`${TELEGRAM_API}/sendDocument`, { method: "POST", body: form });
    const tgData = await tgRes.json();
    fs.unlinkSync(filePath);

    if (!tgData.ok) return res.status(500).json({ error: "Telegram upload failed", details: tgData.description });

    const msg = tgData.result;
    const tgFile = msg.document || msg.photo?.[msg.photo.length - 1] || msg.video || msg.audio;
    const shareId = crypto.randomBytes(6).toString("hex");

    const entry = {
      id: shareId, name: originalName, size: fileSize, mimeType,
      fileId: tgFile?.file_id, messageId: msg.message_id,
      folderId, starred: false, uploadedAt: new Date().toISOString(), downloads: 0,
    };
    db.files.push(entry);
    saveDB();
    res.json({ success: true, file: entry });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

app.get("/api/files", (req, res) => {
  const { search, folder, category, starred } = req.query;
  let files = [...db.files];
  if (search) { const q = search.toLowerCase(); files = files.filter(f => f.name.toLowerCase().includes(q)); }
  if (folder) files = files.filter(f => f.folderId === folder);
  if (category && category !== "all") files = files.filter(f => getCategory(f.mimeType, f.name) === category);
  if (starred === "true") files = files.filter(f => f.starred);
  files.reverse();
  res.json({ files, total: files.length });
});

app.get("/api/file/:shareId", (req, res) => {
  const file = db.files.find(f => f.id === req.params.shareId);
  if (!file) return res.status(404).json({ error: "File not found" });
  res.json({ file });
});

app.get("/api/download/:shareId", async (req, res) => {
  const file = db.files.find(f => f.id === req.params.shareId);
  if (!file) return res.status(404).json({ error: "File not found" });
  try {
    const fileInfoRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${file.fileId}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok) return res.status(500).json({ error: "Could not retrieve file" });
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const fileRes = await fetch(downloadUrl);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    if (file.size) res.setHeader("Content-Length", file.size);
    fileRes.body.pipe(res);
    file.downloads = (file.downloads || 0) + 1;
    saveDB();
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ error: "Download failed" });
  }
});

app.delete("/api/file/:shareId", async (req, res) => {
  const idx = db.files.findIndex(f => f.id === req.params.shareId);
  if (idx === -1) return res.status(404).json({ error: "File not found" });
  const file = db.files[idx];
  try { await fetch(`${TELEGRAM_API}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHANNEL_ID, message_id: file.messageId }) }); } catch (e) {}
  db.files.splice(idx, 1);
  saveDB();
  res.json({ success: true });
});

app.patch("/api/file/:shareId", (req, res) => {
  const file = db.files.find(f => f.id === req.params.shareId);
  if (!file) return res.status(404).json({ error: "File not found" });
  if (req.body.starred !== undefined) file.starred = req.body.starred;
  if (req.body.folderId) file.folderId = req.body.folderId;
  if (req.body.name) file.name = req.body.name;
  saveDB();
  res.json({ success: true, file });
});

app.get("/api/stats", (req, res) => {
  const totalFiles = db.files.length;
  const totalSize = db.files.reduce((acc, f) => acc + (f.size || 0), 0);
  const totalDownloads = db.files.reduce((acc, f) => acc + (f.downloads || 0), 0);
  const categories = {};
  db.files.forEach(f => { const cat = getCategory(f.mimeType, f.name); categories[cat] = (categories[cat] || 0) + 1; });
  res.json({ totalFiles, totalSize, totalDownloads, totalFolders: db.folders.length - 1, categories });
});

app.get("/share/:shareId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function getCategory(mimeType, name) {
  const ext = name?.split(".").pop()?.toLowerCase() || "";
  if (mimeType?.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","bmp","ico"].includes(ext)) return "images";
  if (mimeType?.startsWith("video/") || ["mp4","mov","avi","mkv","webm","flv","wmv"].includes(ext)) return "videos";
  if (mimeType?.startsWith("audio/") || ["mp3","wav","ogg","flac","aac","m4a"].includes(ext)) return "audio";
  if (["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md","csv"].includes(ext)) return "documents";
  if (["zip","rar","7z","tar","gz"].includes(ext)) return "archives";
  return "other";
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

app.listen(PORT, () => {
  console.log(`\n  💰 TeleVault is running at http://localhost:${PORT}`);
  console.log(`  🔐 TOTP Auth: ${authConfig.isSetup ? "ENABLED" : "NOT SET UP — visit the site to configure"}\n`);
});
