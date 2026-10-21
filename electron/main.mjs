// Vectra CAD desktop shell (Electron main process).
// The app is the same build as the web version (dist/), served from a private app:// scheme so
// module workers and WebAssembly behave as in a browser. Nothing is loaded from the network.
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell } from 'electron';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const DEV_URL = process.env.VECTRA_DEV_URL; // e.g. http://localhost:5173 for live development
const ORIGIN = 'app://vectra';
const DRAWING = /\.(dxf|dwg)$/i;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.dxf': 'application/octet-stream', '.dwg': 'application/octet-stream',
};
// Strict policy: only our own files; WebAssembly compilation allowed for the DWG reader.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
].join('; ');

// The DWG reader worker only: Emscripten's embind builds its call wrappers with new Function,
// so that one script may evaluate code. It runs isolated in a worker and only ever sees file bytes.
const WORKER_CSP = CSP.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");

/** Serve dist/ on app://vectra/ (path traversal refused). */
async function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': /^dwg\.worker-[\w-]+\.js$/.test(path.basename(file)) ? WORKER_CSP : CSP,
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---- files -------------------------------------------------------------------------------------
async function readDrawing(p) {
  const st = await stat(p);
  if (!st.isFile()) throw new Error(`${p} is not a file`);
  return { path: p, name: path.basename(p), data: new Uint8Array(await readFile(p)) };
}

/** A drawing path from command-line arguments (double-click in Explorer, "Open with"). */
function drawingFromArgs(argv) {
  return argv.slice(1).find((a) => DRAWING.test(a) && !a.startsWith('-') && existsSync(a)) ?? null;
}

let win = null;
let pendingPath = drawingFromArgs(process.argv);
let docState = { dirty: false, title: 'Vectra CAD' };
let closeConfirmed = false;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

async function openPath(p) {
  try {
    send('file:opened', await readDrawing(p));
  } catch (e) {
    dialog.showErrorBox('Could not open file', `${p}\n\n${e.message}`);
  }
}

ipcMain.handle('file:initial', async () => {
  const p = pendingPath;
  pendingPath = null;
  return p ? readDrawing(p).catch(() => null) : null;
});

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open drawing',
    properties: ['openFile'],
    filters: [{ name: 'Drawings (*.dxf, *.dwg)', extensions: ['dxf', 'dwg'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readDrawing(r.filePaths[0]);
});

ipcMain.handle('file:save', async (_e, filePath, data) => {
  if (typeof filePath !== 'string' || !/\.dxf$/i.test(filePath)) throw new Error('Only .dxf files can be written.');
  await writeFile(filePath, Buffer.from(data));
  app.addRecentDocument(filePath);
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('file:save-as', async (_e, suggestedPath, data) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save drawing as DXF',
    defaultPath: suggestedPath,
    filters: [{ name: 'DXF drawing (*.dxf)', extensions: ['dxf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const target = /\.dxf$/i.test(r.filePath) ? r.filePath : r.filePath + '.dxf';
  await writeFile(target, Buffer.from(data));
  app.addRecentDocument(target);
  return { path: target, name: path.basename(target) };
});

ipcMain.on('doc:state', (_e, dirty, title) => {
  docState = { dirty: !!dirty, title: String(title || 'Vectra CAD') };
  if (win && !win.isDestroyed()) {
    win.setTitle(docState.title);
    win.setDocumentEdited?.(docState.dirty);
  }
});

ipcMain.on('app:close-ok', () => {
  closeConfirmed = true;
  win?.close();
});

// ---- window & menu --------------------------------------------------------------------------------
function buildMenu() {
  const cmd = (name) => () => send('menu', name);
  // Accelerators are shown but handled by the page itself (registerAccelerator: false), so a
  // shortcut never fires twice.
  const item = (label, name, accelerator) => ({ label, accelerator, registerAccelerator: false, click: cmd(name) });
  const template = [
    {
      label: '&File',
      submenu: [
        item('&Open…', 'open', 'CmdOrCtrl+O'),
        item('&Save', 'save', 'CmdOrCtrl+S'),
        item('Save &As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        { role: 'recentDocuments', visible: process.platform !== 'win32' },
        { label: 'E&xit', role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('&Undo', 'undo', 'CmdOrCtrl+Z'),
        item('&Redo', 'redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' },
        item('Select &All', 'selectAll', 'CmdOrCtrl+A'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Zoom &Extents', 'zoomExtents'),
        item('Dark / &Light background', 'toggleTheme'),
        { type: 'separator' },
        item('&Properties panel', 'toggleProperties', 'CmdOrCtrl+1'),
        item('La&yers panel', 'toggleLayers', 'CmdOrCtrl+2'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(DEV_URL || !app.isPackaged ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        item('&Commands', 'help'),
        {
          label: '&About Vectra CAD',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'About Vectra CAD',
            message: `Vectra CAD ${app.getVersion()}`,
            detail: 'DXF/DWG viewer and editor. Works fully offline.\n\nLicensed under the GNU GPL v3.0. DWG reading uses LibreDWG (GPL-3.0); the Roman Simplex font is based on the Hershey fonts. See the licence files in the installation folder.',
          }),
        },
        { label: 'Licence files', click: () => shell.showItemInFolder(path.join(here, '..', 'LICENSE')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b2027',
    title: 'Vectra CAD',
    icon: path.join(here, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // no popups, no navigation away from the app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  win.on('close', async (e) => {
    if (closeConfirmed || !docState.dirty) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Vectra CAD',
      message: 'Save changes to the drawing?',
      detail: docState.title.replace(/ — Vectra CAD$/, ''),
    });
    if (response === 0) send('menu', 'saveThenClose');
    else if (response === 1) {
      closeConfirmed = true;
      win.close();
    }
  });
  win.loadURL(DEV_URL ?? `${ORIGIN}/index.html`);
}

// ---- lifecycle --------------------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // a drawing double-clicked while the app is running opens in the existing window
    const p = drawingFromArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (p) openPath(p);
  });

  app.whenReady().then(() => {
    protocol.handle('app', serve);
    // Offline by design: refuse every network request (the dev server is the only exception).
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
      const allowed = DEV_URL && details.url.startsWith(DEV_URL.replace(/^http/, details.url.startsWith('ws') ? 'ws' : 'http'));
      if (!allowed) console.warn('[offline] blocked', details.url);
      cb({ cancel: !allowed });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    buildMenu();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
