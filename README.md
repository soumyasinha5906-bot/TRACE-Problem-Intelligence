# TRACE — Problem Intelligence MVP

TRACE collects reports, groups potentially related reports, ranks incidents, and tracks resolutions.

## Requirements
- Windows 10/11
- Node.js 18 or newer (LTS recommended)
- VS Code
- Optional: Python 3.10+ for the AI service
- Optional: MinGW-w64 / g++ for the C++ priority engine

## 1. Open the project
1. Extract the ZIP file.
2. Open VS Code.
3. Select **File → Open Folder**.
4. Select the extracted `TRACE` folder.

## 2. Install and run the website
Open **Terminal → New Terminal** in VS Code. Make sure the terminal is inside the TRACE folder.

Run:

```bash
npm install
```

Copy `.env.example` to `.env` and change `JWT_SECRET` to a long random value. On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Start the server:

```bash
npm start
```

Open this address in Chrome:

http://localhost:5000

The server creates `data/trace.sqlite` automatically. Your users, reports and incidents persist in this file when you stop and restart the server.

Demo login:
- Email: `admin@trace.local`
- Password: `TraceDemo123!`

Change the demo password and JWT secret before using this with real users. The demo account is created automatically on first start.

## 3. Optional Python AI service
The website works without this service using its built-in fallback analysis. To enable the separate Python service, open a second VS Code terminal:

```bash
cd ai-service
py -m venv .venv
```

PowerShell activation:

```powershell
.\.venv\Scripts\Activate.ps1
```

If activation is blocked, run the service using the venv's Python executable directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

If activation works:

```bash
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

Keep this terminal running. The Node backend will use the Python service automatically when it is reachable. The included model is a lightweight TF-IDF similarity/classification baseline, not a production-trained AI model.

## 4. Optional C++ priority engine
Install a C++ compiler such as MinGW-w64 and ensure `g++` is available in the terminal.

From the TRACE folder:

```bash
cd cpp-engine
g++ -std=c++17 priority.cpp -o priority_engine.exe
```

The backend checks for `cpp-engine/priority_engine.exe` and uses it when present. If it is absent, the same scoring formula runs in JavaScript.

## 5. How to use
1. Sign in with the demo login.
2. Open Reports and submit a report.
3. Open Dashboard to see live totals.
4. Open Incidents to see related reports grouped together.
5. Open an incident to review the investigation and suggested actions.
6. Resolve an incident to record the resolution.

Open another browser window and sign in as another user to see Socket.IO updates.

## 6. Important limitations
- This is a local development MVP, not a hardened production deployment.
- The included AI is a baseline for demonstrating the workflow. Validate clustering with real labelled data before relying on it.
- AI suggestions are hypotheses. Administrators must verify causes and approve incident merges/resolutions.
- Do not enter sensitive personal, medical, financial or confidential information into a demo.
- Before public deployment, add HTTPS, secure cookie/token handling, rate limiting, backups, database migrations, stronger audit controls, and organization-level authorization tests.
