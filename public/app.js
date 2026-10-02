// ==========================================
// TeleVault — Client Application
// ==========================================

const API = "";

// ===== State =====
let allFiles = [];
let allFolders = [];
let currentView = "all";       // all | folder | category | starred
let currentFolder = "root";
let currentCategory = "";
let viewMode = "grid";         // grid | list
let searchTimeout = null;

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
  const sharePath = window.location.pathname.match(/^\/share\/([a-f0-9]+)$/);
  if (sharePath) {
    showSharePage(sharePath[1]);
    return;
  }

  initUpload();
  initNav();
  initSearch();
  initDropZone();
  initViewToggle();
  initMobileMenu();
  initLock();
  loadAll();
});

function initLock() {
  const lockBtn = document.getElementById("btn-lock");
  if (lockBtn) {
    lockBtn.addEventListener("click", async () => {
      try {
        await fetch(`${API}/api/auth/logout`, { method: "POST" });
      } catch (e) {}
      window.location.href = "/login.html";
    });
  }
}

// ===== Data Loading =====
async function loadAll() {
  await Promise.all([loadFiles(), loadFolders(), loadStats()]);
}

async function loadFiles() {
  try {
    const params = new URLSearchParams();
    const search = document.getElementById("search-input")?.value || "";
    if (search) params.set("search", search);
    if (currentView === "folder") params.set("folder", currentFolder);
    if (currentView === "category") params.set("category", currentCategory);
    if (currentView === "starred") params.set("starred", "true");

    const res = await fetch(`${API}/api/files?${params}`);
    const data = await res.json();
    allFiles = data.files;
    renderFiles(allFiles);
  } catch (err) {
    console.error("Load files failed:", err);
  }
}

async function loadFolders() {
  try {
    const res = await fetch(`${API}/api/folders`);
    const data = await res.json();
    allFolders = data.folders;
    renderFolders();
  } catch (err) {
    console.error("Load folders failed:", err);
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const data = await res.json();
    setText("footer-files", data.totalFiles);
    setText("footer-size", formatSize(data.totalSize));
    setText("footer-downloads", data.totalDownloads);
    setText("count-all", data.totalFiles);

    const cats = data.categories || {};
    setText("count-images", cats.images || 0);
    setText("count-videos", cats.videos || 0);
    setText("count-audio", cats.audio || 0);
    setText("count-documents", cats.documents || 0);
    setText("count-archives", cats.archives || 0);
  } catch (e) {}
}

// ===== Navigation =====
function initNav() {
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const view = btn.dataset.view;
      currentView = view;

      if (view === "folder") {
        currentFolder = btn.dataset.folder || "root";
      } else if (view === "category") {
        currentCategory = btn.dataset.category;
      }

      updateBreadcrumb();
      loadFiles();
      loadFolders();
      closeMobileMenu();
    });
  });

  // New Folder
  document.getElementById("btn-new-folder").addEventListener("click", showNewFolderModal);
  document.getElementById("folder-modal-close").addEventListener("click", () => {
    document.getElementById("folder-modal-overlay").style.display = "none";
  });
  document.getElementById("folder-create-btn").addEventListener("click", createFolder);
  document.getElementById("folder-name-input").addEventListener("keydown", e => {
    if (e.key === "Enter") createFolder();
  });
}

function updateBreadcrumb() {
  const el = document.getElementById("breadcrumb");
  let html = "";

  if (currentView === "all") {
    html = `<span class="crumb active">◆ ALL ASSETS</span>`;
  } else if (currentView === "starred") {
    html = `<span class="crumb" onclick="navTo('all')">ALL</span><span class="crumb-sep">›</span><span class="crumb active">★ STARRED</span>`;
  } else if (currentView === "category") {
    const labels = { images: "▨ IMAGES", videos: "▶ VIDEOS", audio: "♫ AUDIO", documents: "▤ DOCUMENTS", archives: "▧ ARCHIVES" };
    html = `<span class="crumb" onclick="navTo('all')">ALL</span><span class="crumb-sep">›</span><span class="crumb active">${labels[currentCategory] || currentCategory.toUpperCase()}</span>`;
  } else if (currentView === "folder") {
    html = buildFolderBreadcrumb();
  }

  el.innerHTML = html;
}

function buildFolderBreadcrumb() {
  const chain = [];
  let fId = currentFolder;
  while (fId) {
    const f = allFolders.find(x => x.id === fId);
    if (!f) break;
    chain.unshift(f);
    fId = f.parent;
  }
  return chain.map((f, i) => {
    if (i === chain.length - 1) return `<span class="crumb active">▣ ${esc(f.name).toUpperCase()}</span>`;
    return `<span class="crumb" onclick="navToFolder('${f.id}')">${esc(f.name).toUpperCase()}</span><span class="crumb-sep">›</span>`;
  }).join("");
}

function navTo(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  document.getElementById("nav-" + (view === "all" ? "all" : view)).classList.add("active");
  updateBreadcrumb();
  loadFiles();
  loadFolders();
}

function navToFolder(folderId) {
  currentView = "folder";
  currentFolder = folderId;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  document.getElementById("nav-drive").classList.add("active");
  updateBreadcrumb();
  loadFiles();
  loadFolders();
}
window.navTo = navTo;
window.navToFolder = navToFolder;

// ===== Folders =====
function renderFolders() {
  const container = document.getElementById("folders-row");
  if (currentView !== "folder") {
    container.style.display = "none";
    return;
  }

  const subfolders = allFolders.filter(f => f.parent === currentFolder);
  if (subfolders.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "grid";
  container.innerHTML = subfolders.map(f => `
    <div class="folder-card" ondblclick="navToFolder('${f.id}')">
      <span class="folder-card-icon">📁</span>
      <span class="folder-card-name">${esc(f.name)}</span>
      <button class="folder-card-delete" onclick="event.stopPropagation();deleteFolder('${f.id}')" title="Delete">✕</button>
    </div>
  `).join("");
}

function showNewFolderModal() {
  document.getElementById("folder-modal-overlay").style.display = "flex";
  const input = document.getElementById("folder-name-input");
  input.value = "";
  setTimeout(() => input.focus(), 100);
}

async function createFolder() {
  const name = document.getElementById("folder-name-input").value.trim();
  if (!name) return;

  try {
    const res = await fetch(`${API}/api/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent: currentView === "folder" ? currentFolder : "root" })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById("folder-modal-overlay").style.display = "none";
      showToast(`Folder "${name}" created`, "success");
      loadAll();
    }
  } catch (err) {
    showToast("Failed to create folder", "error");
  }
}

async function deleteFolder(id) {
  const f = allFolders.find(x => x.id === id);
  if (!confirm(`Delete folder "${f?.name}"?`)) return;
  try {
    await fetch(`${API}/api/folders/${id}`, { method: "DELETE" });
    showToast("Folder deleted", "info");
    loadAll();
  } catch (e) {
    showToast("Failed to delete folder", "error");
  }
}
window.deleteFolder = deleteFolder;

// ===== Files Rendering =====
function renderFiles(files) {
  const grid = document.getElementById("files-grid");
  const empty = document.getElementById("empty-state");

  if (files.length === 0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  grid.innerHTML = files.map(f => createFileCard(f)).join("");

  // Attach listeners
  grid.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === "download") downloadFile(id);
      if (action === "share") shareFile(id);
      if (action === "delete") deleteFile(id);
      if (action === "star") toggleStar(id);
      if (action === "move") showMoveModal(id);
    });
  });
}

function createFileCard(file) {
  const ext = getExt(file.name);
  const extClass = getExtClass(ext);
  const date = new Date(file.uploadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const starred = file.starred ? "starred" : "";

  return `
    <div class="file-card">
      <div class="file-card-top">
        <div class="file-ext-badge ${extClass}">${ext || '?'}</div>
        <div class="file-name">${esc(file.name)}</div>
        <button class="file-star-btn ${starred}" data-action="star" data-id="${file.id}" title="Star">${file.starred ? '★' : '☆'}</button>
      </div>
      <div class="file-meta">
        <span>${formatSize(file.size)}</span>
        <span>·</span>
        <span>${date}</span>
        ${file.downloads ? `<span>· ${file.downloads}↓</span>` : ""}
      </div>
      <div class="file-actions">
        <button class="retro-btn retro-btn-sm" data-action="download" data-id="${file.id}">↓ GET</button>
        <button class="retro-btn retro-btn-sm retro-btn-blue" data-action="share" data-id="${file.id}">⫘ SHARE</button>
        <button class="retro-btn retro-btn-sm retro-btn-ghost" data-action="move" data-id="${file.id}">→ MOVE</button>
        <button class="retro-btn retro-btn-sm retro-btn-red" data-action="delete" data-id="${file.id}">✕</button>
      </div>
    </div>
  `;
}

// ===== File Actions =====
function downloadFile(id) {
  window.open(`${API}/api/download/${id}`, "_blank");
}

function shareFile(id) {
  const file = allFiles.find(f => f.id === id);
  if (!file) return;
  const url = `${window.location.origin}/share/${file.id}`;
  document.getElementById("modal-filename").textContent = file.name;
  document.getElementById("share-link-input").value = url;
  document.getElementById("modal-overlay").style.display = "flex";

  document.getElementById("modal-close").onclick = () => {
    document.getElementById("modal-overlay").style.display = "none";
  };
  document.getElementById("modal-overlay").onclick = e => {
    if (e.target === e.currentTarget) document.getElementById("modal-overlay").style.display = "none";
  };
  document.getElementById("copy-link-btn").onclick = () => {
    navigator.clipboard.writeText(url).then(() => {
      document.getElementById("copy-link-btn").textContent = "COPIED!";
      showToast("Link copied!", "success");
      setTimeout(() => { document.getElementById("copy-link-btn").textContent = "COPY"; }, 2000);
    });
  };
}

async function deleteFile(id) {
  const file = allFiles.find(f => f.id === id);
  if (!file || !confirm(`Delete "${file.name}"?`)) return;
  try {
    await fetch(`${API}/api/file/${id}`, { method: "DELETE" });
    showToast(`"${file.name}" deleted`, "info");
    loadAll();
  } catch (e) {
    showToast("Delete failed", "error");
  }
}

async function toggleStar(id) {
  const file = allFiles.find(f => f.id === id);
  if (!file) return;
  try {
    await fetch(`${API}/api/file/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: !file.starred })
    });
    file.starred = !file.starred;
    renderFiles(allFiles);
    showToast(file.starred ? "Starred!" : "Unstarred", "info");
  } catch (e) {}
}

function showMoveModal(fileId) {
  const overlay = document.getElementById("move-modal-overlay");
  const list = document.getElementById("move-folder-list");
  overlay.style.display = "flex";

  const movableFolders = allFolders.filter(f => f.id !== "root" || true);
  list.innerHTML = movableFolders.map(f => `
    <div class="folder-list-item" onclick="moveFile('${fileId}','${f.id}')">
      <span>📁</span>
      <span>${esc(f.name)}</span>
    </div>
  `).join("");

  document.getElementById("move-modal-close").onclick = () => { overlay.style.display = "none"; };
  overlay.onclick = e => { if (e.target === e.currentTarget) overlay.style.display = "none"; };
}

async function moveFile(fileId, folderId) {
  try {
    await fetch(`${API}/api/file/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId })
    });
    document.getElementById("move-modal-overlay").style.display = "none";
    const folder = allFolders.find(f => f.id === folderId);
    showToast(`Moved to "${folder?.name || 'folder'}"`, "success");
    loadFiles();
  } catch (e) {
    showToast("Move failed", "error");
  }
}
window.moveFile = moveFile;

// ===== Upload =====
function initUpload() {
  const fileInput = document.getElementById("file-input");
  const folderInput = document.getElementById("folder-input");

  document.getElementById("sidebar-upload-btn").addEventListener("click", () => fileInput.click());
  document.getElementById("empty-upload-btn")?.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) { handleFiles(fileInput.files); fileInput.value = ""; }
  });

  folderInput.addEventListener("change", () => {
    if (folderInput.files.length) { handleFiles(folderInput.files); folderInput.value = ""; }
  });
}

function handleFiles(files) {
  for (const file of files) uploadFile(file);
}

async function uploadFile(file) {
  const list = document.getElementById("upload-progress-list");
  const el = document.createElement("div");
  el.className = "upload-item";
  el.innerHTML = `
    <div class="upload-item-icon uploading">↑</div>
    <div class="upload-item-info">
      <div class="upload-item-name">${esc(file.name)}</div>
      <div class="upload-item-status">UPLOADING... ${formatSize(file.size)}</div>
      <div class="progress-bar-track"><div class="progress-bar-fill indeterminate" style="width:30%"></div></div>
    </div>
  `;
  list.prepend(el);

  try {
    const form = new FormData();
    form.append("file", file);
    if (currentView === "folder") form.append("folderId", currentFolder);

    const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
    const data = await res.json();

    if (data.success) {
      el.querySelector(".upload-item-icon").className = "upload-item-icon done";
      el.querySelector(".upload-item-icon").textContent = "✓";
      el.querySelector(".upload-item-status").textContent = "DEPOSITED";
      const bar = el.querySelector(".progress-bar-fill");
      bar.classList.remove("indeterminate");
      bar.style.width = "100%";

      setTimeout(() => {
        el.style.transition = "opacity 0.4s, transform 0.4s";
        el.style.opacity = "0";
        el.style.transform = "translateX(20px)";
        setTimeout(() => el.remove(), 400);
      }, 2500);

      showToast(`"${file.name}" deposited!`, "success");
      loadAll();
    } else {
      throw new Error(data.error || "Upload failed");
    }
  } catch (err) {
    el.querySelector(".upload-item-icon").className = "upload-item-icon error";
    el.querySelector(".upload-item-icon").textContent = "✕";
    el.querySelector(".upload-item-status").textContent = `FAILED: ${err.message}`;
    const bar = el.querySelector(".progress-bar-fill");
    bar.classList.remove("indeterminate");
    bar.style.width = "0%";
    showToast(`Upload failed: ${err.message}`, "error");
  }
}

// ===== Drop Zone =====
function initDropZone() {
  let dragCounter = 0;
  const overlay = document.getElementById("drop-overlay");

  document.addEventListener("dragenter", e => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.add("visible");
  });

  document.addEventListener("dragleave", e => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove("visible"); }
  });

  document.addEventListener("dragover", e => e.preventDefault());

  document.addEventListener("drop", e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove("visible");
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
}

// ===== Search =====
function initSearch() {
  document.getElementById("search-input").addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadFiles(), 300);
  });
}

// ===== View Toggle =====
function initViewToggle() {
  document.getElementById("btn-view-toggle").addEventListener("click", () => {
    viewMode = viewMode === "grid" ? "list" : "grid";
    const grid = document.getElementById("files-grid");
    grid.classList.toggle("list-view", viewMode === "list");
    document.getElementById("view-toggle-icon").textContent = viewMode === "grid" ? "▦" : "▤";
  });
}

// ===== Mobile Menu =====
function initMobileMenu() {
  document.getElementById("menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
}

function closeMobileMenu() {
  document.getElementById("sidebar").classList.remove("open");
}

// ===== Share Page =====
async function showSharePage(shareId) {
  document.querySelector(".app-layout").style.display = "none";
  document.getElementById("share-page").style.display = "flex";

  try {
    const res = await fetch(`${API}/api/file/${shareId}`);
    if (!res.ok) throw new Error("Not found");
    const data = await res.json();
    const file = data.file;

    document.getElementById("share-filename").textContent = file.name;
    document.getElementById("share-size").textContent = formatSize(file.size);
    document.getElementById("share-date").textContent = new Date(file.uploadedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    const dlBtn = document.getElementById("share-download-btn");
    dlBtn.href = `${API}/api/download/${shareId}`;
    dlBtn.target = "_blank";
  } catch (err) {
    document.getElementById("share-filename").textContent = "FILE NOT FOUND";
    document.getElementById("share-download-btn").style.display = "none";
    document.querySelector(".share-meta").style.display = "none";
  }
}

// ===== Utilities =====
function formatSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function getExt(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function getExtClass(ext) {
  const img = ["jpg","jpeg","png","gif","webp","svg","bmp","ico","tiff"];
  const vid = ["mp4","mov","avi","mkv","webm","flv","wmv","m4v"];
  const aud = ["mp3","wav","ogg","flac","aac","m4a","wma"];
  const doc = ["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md","csv"];
  const zip = ["zip","rar","7z","tar","gz","bz2"];
  if (img.includes(ext)) return "ext-img";
  if (vid.includes(ext)) return "ext-vid";
  if (aud.includes(ext)) return "ext-audio";
  if (doc.includes(ext)) return "ext-doc";
  if (zip.includes(ext)) return "ext-zip";
  return "ext-other";
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icons = { success: "✓", error: "✕", info: "●" };
  toast.innerHTML = `<span class="toast-icon">${icons[type] || "●"}</span> ${esc(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.getElementById("modal-overlay").style.display = "none";
    document.getElementById("folder-modal-overlay").style.display = "none";
    document.getElementById("move-modal-overlay").style.display = "none";
  }
});
