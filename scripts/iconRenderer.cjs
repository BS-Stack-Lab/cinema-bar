void (async () => {
  const { app, BrowserWindow, session } = await import('electron');
  const { readFile, writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  let profile;
  await (async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), 'cinema-icons-'));
    app.setPath('userData', profile);
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith('data:') }),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL('data:text/html,<html></html>');
    const svg = await readFile(process.argv[2], 'utf8');
    const images = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}; await image.decode();
    const character = document.createElement('canvas'); character.width = character.height = 80; character.getContext('2d').drawImage(image, 0, 0, 80, 80);
    const master = document.createElement('canvas'); master.width = master.height = 1024;
    const ctx = master.getContext('2d'); ctx.fillStyle = '#262628'; ctx.beginPath(); ctx.roundRect(32, 32, 960, 960, 208); ctx.fill(); ctx.imageSmoothingEnabled = false; ctx.drawImage(character, 112, 112, 800, 800);
    const output = {}; for (const size of [16,24,32,48,64,128,256,512,1024]) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false; context.drawImage(master, 0, 0, size, size); output[size] = canvas.toDataURL('image/png').split(',')[1]; }
    return output;
  })()`);
    await writeFile(
      process.argv[3],
      JSON.stringify({ electron: process.versions.electron, images }),
    );
    window.destroy();
    await rm(profile, { recursive: true, force: true });
    app.exit(0);
  })().catch(async () => {
    if (profile) await rm(profile, { recursive: true, force: true });
    app.exit(1);
  });
})();
