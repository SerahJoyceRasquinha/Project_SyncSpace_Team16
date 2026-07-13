# SyncSpace — Prerequisites Setup Guide (Windows) 

Before you can run SyncSpace you need two tools: **Node.js** (runs the backend and builds the
frontend) and **Git** (version control).

Do them in order. After each one, run the verify command — if it doesn't print a version number,
stop and fix it before moving on.

> **Golden rule:** after installing anything, **close every open terminal and VS Code window**,
> then open a fresh one. Installers update your `PATH`, but already-open terminals keep using the
> old one. Roughly 90% of "it's installed but the command isn't recognised" is this.

---

## 1. Node.js + npm

Node.js is the JavaScript runtime. `npm` (the package manager) is bundled with it — you do **not**
install npm separately.

### Download

1. Go to **<https://nodejs.org>**
2. Click the **LTS** button (the recommended one, not "Current").
3. You'll get a file like `node-v22.x.x-x64.msi`. Run it.

> Already have Node? Run `node -v` first.
> - `v18`, `v20`, `v22`, `v24` → you're fine, skip this section.
> - `v16` or lower → upgrade.
>
> If you run the installer and it says **"Change, repair, or remove installation"**, that means
> Node of that exact version is *already installed*. Click **Cancel** → **Yes**. Nothing is broken.

### Installer options

| Screen | What to do |
|---|---|
| Welcome | **Next** |
| End-User License Agreement | Tick *"I accept the terms"* → **Next** |
| Destination Folder | **Leave default** (`C:\Program Files\nodejs\`) → **Next** |
| Custom Setup | **Leave everything as-is.** All four features (Node.js runtime, npm package manager, Online documentation shortcuts, Add to PATH) should already be selected. **Do not deselect "Add to PATH"** — that's the one that makes `node` and `npm` work in your terminal. → **Next** |
| Tools for Native Modules | **Leave the checkbox UNCHECKED.** This installs Chocolatey, Python and Visual Studio Build Tools (~3 GB) for compiling C++ addons. SyncSpace does not need any of it. → **Next** |
| Ready to install | **Install** (approve the UAC prompt) |
| Finish | **Finish** |

### Verify

Open a **new** Command Prompt or PowerShell:

```powershell
node -v
npm -v
```

Expected:

```
v22.x.x     (or v20 / v24 — any of these is fine)
10.x.x      (or 11.x — comes bundled, don't install it separately)
```

### If PowerShell blocks npm

You may hit this the first time you run `npm install`:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts
is disabled on this system.
```

Nothing is broken — this is PowerShell's default security policy blocking the npm script wrapper.
Fix it once, permanently, for your user account only (**no admin rights needed**):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Type `Y` and press Enter. `RemoteSigned` = locally-created scripts run freely, downloaded scripts
must be signed. This is the standard setting for Windows developers and it unblocks `npm`, `npx`,
`vite`, `nodemon` and every other Node CLI tool for good.

*(Alternative: just use Command Prompt (`cmd`) instead of PowerShell — it has no such restriction.
But you'll keep hitting this wall in PowerShell, so the one-line fix above is worth it.)*

### Ignore these warnings

- `npm notice New major version of npm available!` — cosmetic. Upgrading is optional.
- `npm audit: N vulnerabilities` — these live in dev-only build tooling, not in shipped code.
  **Do not run `npm audit fix --force`.** It will upgrade React/Vite past the pinned versions and
  break `react-konva`.

---

## 2. Git

Git is version control. You need it to clone repos, track your work, and push to GitHub.

### Download

1. Go to **<https://git-scm.com/download/win>**
2. Download **64-bit Git for Windows Setup**. Run it (e.g. `Git-2.55.0.2-64-bit.exe`).

### Installer options

The Git installer has *a lot* of screens. Most are safe to click straight through. Only three
actually matter — they're marked ⚠️ below.

| Screen | What to do |
|---|---|
| Information / License | **Next** |
| Select Destination Location | **Leave default** → **Next** |
| Select Components | **Leave defaults.** (Windows Explorer integration, Git LFS, file associations — all pre-ticked, all fine.) → **Next** |
| Select Start Menu Folder | **Next** |
| ⚠️ **Choosing the default editor** | Change the dropdown from *Vim* to **"Use Visual Studio Code as Git's default editor"**. If you don't, Git will one day drop you into Vim and you won't know how to get out. → **Next** |
| ⚠️ **Adjusting the name of the initial branch** | Select **"Override the default branch name for new repositories"** and leave `main` in the box. GitHub uses `main`, so this saves you a rename later. → **Next** |
| ⚠️ **Adjusting your PATH environment** | Select the **MIDDLE** option: **"Git from the command line and also from 3rd-party software"**. This is the one that makes `git` work in Command Prompt, PowerShell and VS Code. If you pick "Git Bash only", `git` will be *installed but invisible* to your terminal. → **Next** |
| Choosing the SSH executable | **Use bundled OpenSSH** (default) → **Next** |
| Choosing HTTPS transport backend | **Use the OpenSSL library** (default) → **Next** |
| Configuring line ending conversions | **Checkout Windows-style, commit Unix-style** (default) → **Next** |
| Configuring the terminal emulator | **Use MinTTY** (default) → **Next** |
| Choose default behavior of `git pull` | **Fast-forward or merge** (default) → **Next** |
| Choose a credential helper | **Git Credential Manager** (default) — this is what remembers your GitHub login → **Next** |
| Configuring extra options | Leave both defaults ticked → **Next** |
| Experimental options | **Leave everything UNCHECKED** → **Install** |

### Verify

**Close every terminal**, open a new one:

```powershell
git --version
```

Expected: `git version 2.55.0.windows.1` (or similar).

### If it says `'git' is not recognized`

1. **Did you open a fresh terminal?** The old one still has the old `PATH`. Close it, open a new
   one, try again. This fixes it most of the time.

2. Still failing? Check whether Git actually landed on disk:

   ```powershell
   dir "C:\Program Files\Git\cmd\git.exe"
   ```

   - **File is listed** → Git installed fine, but the PATH option was set wrong. Re-run the
     installer and this time pick the **middle** option on the *"Adjusting your PATH environment"*
     screen. It reconfigures over the existing install; nothing is lost.
   - **File Not Found** → the install didn't complete. Run the installer again.

### One-time Git config

Set your identity so your commits are attributed correctly:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

Use the same email as your GitHub account.

---

## 3. VS Code (recommended)

Not strictly required — any editor works — but this is what the project assumes.

1. **<https://code.visualstudio.com>** → Download for Windows → run the installer.
2. On the **"Select Additional Tasks"** screen, tick:
   - ✅ **Add "Open with Code" action to the Windows Explorer file context menu**
   - ✅ **Add to PATH** ← this lets you type `code .` in a terminal to open the current folder

Useful extensions: **ESLint**, **Prettier**, **MongoDB for VS Code**.

---

## 4. MongoDB (optional for the demo, required later tho, but can leave it for now)

You can skip this and still run the whole Milestone-0 demo — leave `MONGO_URI` blank in
`backend/.env` and the server runs in memory-only mode. Everything syncs; it just forgets a room
when you restart the server.

You'll need it once you add auth, room permissions, and the replay timeline.

### Install

1. **<https://www.mongodb.com/try/download/community>**
2. Set: **Version** = latest (8.x), **Platform** = Windows x64, **Package** = **msi**. Download.
3. Run the `.msi`.

| Screen | What to do |
|---|---|
| Setup Type | **Complete** (not Custom) |
| ⚠️ **Service Configuration** | ✅ **Install MongoD as a Service** (default — leave it). ✅ **Run service as Network Service user**. Leave the Service Name (`MongoDB`), data directory and log directory at defaults. This makes MongoDB start automatically on every boot, so you never launch it by hand. |
| Install MongoDB Compass | ✅ **Leave it ticked.** Compass is the GUI you'll use to actually *look at* your collections. It's a chunky download, so this step takes a few minutes. |

### Verify

```powershell
sc query MongoDB
```

Look for `STATE : 4 RUNNING`.

If it says `STOPPED`, open Command Prompt **as administrator** and run:

```powershell
net start MongoDB
```

Then open **MongoDB Compass** from the Start menu. The connection string is pre-filled:

```
mongodb://localhost:27017
```

Click **Connect**. You should see `admin`, `config` and `local`. That's a healthy empty install —
your `syncspace` database doesn't exist yet, and that's correct. Mongoose creates it automatically
the first time the backend writes a snapshot.

### Wire it into SyncSpace

In `backend/.env`:

```env
MONGO_URI=mongodb://127.0.0.1:27017/syncspace
```

Use **`127.0.0.1`, not `localhost`.** On some Windows setups `localhost` resolves to the IPv6
address `::1` first, MongoDB isn't listening there, and you get a baffling `ECONNREFUSED`. The
numeric IP sidesteps the problem entirely.

Restart the backend. You should see:

```
[db] MongoDB connected: syncspace
Persistence -> MongoDB
```

---

## Final check

Open a **fresh** terminal and run all three:

```powershell
node -v
npm -v
git --version
```

Three version numbers, no errors → you're ready to install the project:

```powershell
cd syncspace
npm install --prefix backend
npm install --prefix frontend
npm install
npm run dev
```
