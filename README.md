# Case Study Tool

A project workspace that opens directly into a private guest dashboard, collects public website and GitHub evidence, creates an evidence-labeled case study, and generates a PDF report.

## Requirements

- Node.js 22.13 or newer. The backend uses Node's built-in `node:sqlite` module.
- npm

## Run locally

In a terminal:

```powershell
cd backend
npm ci
Copy-Item .env.example .env
npm run dev
```

In a second terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`. The dashboard opens directly; no sign-up or login is needed. The backend creates a private guest workspace for that browser and stores its projects in `backend/storage/` with the SQLite database and generated reports. Guest workspace access uses the configured session lifetime (`SESSION_DAYS`, 7 days by default); clearing browser cookies or allowing the session to expire creates a new workspace, and the old guest data cannot be recovered through an account.

The browser calls `http://localhost:5000/api/v1` by default. For a different backend URL, set `VITE_API_BASE_URL` in the frontend environment. Set `CORS_ORIGIN` in the backend to the exact frontend origin.

## Optional integrations

- `GROQ_API_KEY` enables model-assisted report synthesis. Without it, the backend creates a deterministic report from collected evidence and labels unknowns.
- `TAVILY_API_KEY` enables competitor search. Search results are shown as unverified sources and are not presented as confirmed competitors.
- `GITHUB_TOKEN` raises GitHub API limits. Public repository analysis can run without it, subject to unauthenticated API limits.

Copy `backend/.env.example` to `backend/.env` and provide credentials only when needed. Never commit `.env` or provider keys. Before production, set `NODE_ENV=production`, use a randomly generated `SESSION_SECRET` of at least 32 characters, set the production CORS origin, and serve over HTTPS.

## Checks

Run these from `backend/`:

```powershell
npm run typecheck
npm test
npm run build
```

Run these from `frontend/`:

```powershell
npm run typecheck
npm run build
```

## Current scope

The database is a local SQLite file. Website crawling is bounded, checks `robots.txt`, follows validated redirects, pins DNS-resolved public addresses, and limits response sizes. GitHub analysis uses the public REST API and inspects a bounded set of source files. External crawling and GitHub API access require network access. AI and competitor provider calls require their respective API keys.

Each project also has a **Project Information** workspace. After analysis it stores evidence-derived website, GitHub, and case-study fields with their source and confidence metadata. Re-analysis refreshes the AI snapshot while retaining user-edited values. Use the Information button on a project to search and filter fields, edit values and notes, restore AI values, accept or reject suggested fields, add custom fields, pin or hide fields, bulk edit, reorder, and attach files. Custom field values support text, long text, numbers, currency, percentages, URLs, email, phone, dates, date-time, booleans, dropdowns, multi-select, tags, rich text, JSON, and file attachments. Attachments are limited to 10 MB and stored under `UPLOAD_STORAGE_DIR` (defaults to `backend/storage/uploads/`).

With `GROQ_API_KEY` configured, report synthesis can also suggest up to 12 additional fields; the backend validates each suggestion before saving it. Without a provider key, the tool still offers source-aware suggestions, but model-generated suggestion behavior has not been runtime-verified.

Fields that cannot be established from the submitted public sources are left unset or shown as suggestions. Company size, verified customer or traffic metrics, funding, and revenue estimates require trusted external data or user input; the tool does not treat guesses as facts.

See [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) for the audited checklist, implementation status, and verification log.
