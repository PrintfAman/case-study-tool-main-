# Secure production deployment

## Recommended hosting

This repository is prepared for a Render Blueprint deployment. It creates a free static React site and a single Singapore Node API service on the `1c-2g` plan (1 CPU, 2 GB RAM), with a 10 GB persistent disk for SQLite, reports, and attachments. Current listed compute and disk rates put this at about **US$27.50/month** before tax or provider API usage; the static site is free. A solo Hobby workspace is sufficient. Choose a different region if most users are elsewhere.

This is the least disruptive fit for the current application: it uses Node's built-in SQLite database and local file storage. Keep the API at one instance. The disk is tied to one service instance, so this deployment does not provide horizontal scaling or zero-downtime API deploys. For high availability or multiple API instances, first move the database to managed PostgreSQL and reports/uploads to shared object storage, then move rate limits to a shared store.

## Before creating the Blueprint

1. Push the repository to a Git provider account that you control. Keep it private if the source should not be public, protect the production branch, and review changes before they deploy.
2. Choose the frontend and API URLs. Custom domains are recommended, but they do not need to share a parent domain because the app does not use authentication cookies. Configure the exact frontend origin in backend CORS.
3. In Render, create a Blueprint from this repository and select `render.yaml`. During setup, enter:
   - `CORS_ORIGIN`: `https://app.example.com` (the exact frontend origin, without a trailing slash).
   - `VITE_API_BASE_URL`: `https://api.example.com/api/v1`.
   - `GROQ_API_KEY`: the key entered directly into Render's secret environment variable prompt. Never put it in this file, Git, Vite variables, or the browser bundle.
4. After Render creates the services, add `app.example.com` to the static site and `api.example.com` to the API service. Add the DNS records Render shows, wait for verification and managed TLS, then confirm the two environment values above match the final domains. Vite variables are baked into the frontend build, so changing `VITE_API_BASE_URL` requires a new static-site build.
5. Once both custom domains work, disable each service's default `onrender.com` subdomain in its Render settings. Keep the custom domains under the same registered domain.
6. In the Render secret settings, add optional `GITHUB_TOKEN` for higher GitHub API limits or `TAVILY_API_KEY` for external competitor research. Never expose these values in frontend configuration.
7. Set provider usage alerts or caps for the AI/search accounts. Authentication is disabled: anyone who can reach the site can list, read, edit, analyze, and delete every project. Do not put confidential project data in this shared workspace. Per-IP route limits reduce accidental and basic abusive usage, but they are in-memory limits and do not guarantee an AI spending cap.

Render automatically provides HTTPS and renews TLS certificates. The Blueprint sets browser security headers in production. The API trusts one reverse-proxy hop so per-IP limits can identify client IPs behind Render. The frontend sends no cookies or other authentication credentials.

After choosing the domain, add a frontend Content-Security-Policy that restricts `connect-src` to the exact API origin. It is intentionally left out of the generic Blueprint so it does not allow arbitrary HTTPS origins or block the eventual custom API domain.

## Data and operational limits

- The disk preserves the SQLite database, reports, and uploads across restarts and deploys. Monitor disk usage; the app allows users to add multiple file attachments.
- Render's daily disk snapshots are retained for seven days. They are a short recovery window, not an independent backup plan. Add and periodically test an off-site SQLite-consistent backup before storing important production data.
- All projects share one public workspace. There is no per-user isolation, account recovery, or privacy boundary.
- Rate-limit counters live in process memory. They reset on restart and are not a durable, global quota for anonymous AI usage.
- The frontend and backend have independent deploys. A successful static build does not prove the API key, DNS, CORS, or external AI provider work; complete the smoke checks below after configuring the live services.

## Go-live checks

1. Confirm the API's `https://api.example.com/health` responds successfully.
2. Open the frontend URL without signing in, add a project, analyze a public website/repository, and confirm the report appears.
3. Download the PDF and upload/download a project-field attachment; restart or redeploy the API and verify the records and files remain.
4. In browser developer tools, confirm API requests use HTTPS and no session cookie is created or sent.
5. Check Render logs and disk usage. CORS limits which frontend origins can read API responses; it is not authentication or project privacy.
6. Configure and test the independent backup and recovery process before treating the service as production-ready.

The blueprint and code are prepared locally; live deployment still requires the Render workspace, Git repository connection, the custom domain/DNS, and the AI provider key to be configured by an authorized account holder.
