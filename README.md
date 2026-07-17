## Prerequisites

Before running the project, ensure you have the following installed:

- **Node.js** (v18 or later recommended)
- **npm** (included with Node.js)
- **Git**
- **MongoDB** *(Optional)*

> **Note:** MongoDB is optional. If `MONGO_URI` is left blank in `backend/.env`, the application will run entirely in memory. All features will work normally, but data will be lost whenever the server is restarted.

---

## Installation (or directly go to running the project, which also installs everything automatically)

Install all required dependencies by running:

```bash
npm install --prefix backend
npm install --prefix frontend
npm install
```

Next, create or update the following file:

**backend/.env**

```env
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
JWT_SECRET=change-me-to-a-long-random-string
MONGO_URI=
```

- Leave `MONGO_URI` blank to use the in-memory datastore.
- Provide a MongoDB connection string if you want workspaces and snapshots to persist after server restarts.

---

## Running the Project

After installing all dependencies and configuring the environment, start the application using the provided development script.

### Option 1 (Recommended)

Simply **double-click**:

```text
dev.bat
```

### Option 2 (PowerShell / Windows Terminal)

Run:

```powershell
.\dev.bat
```

The script automatically starts both the backend and frontend development servers.

Once both servers have started successfully, open:

**http://localhost:5173**

in your browser.