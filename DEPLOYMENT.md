# Secure production deployment

## Recommended hosting

This repository is prepared for a Render Blueprint deployment. It creates a free static React site and a single Singapore Node API service on the `1c-2g` plan (1 CPU, 2 GB RAM), with a 10 GB persistent disk for SQLite, reports, and attachments. Current listed compute and disk rates put this at about **US$27.50/month** before tax or provider API usage; the static site is free. A solo Hobby workspace is sufficient. Choose a different region if most users are elsewhere.

This is the least disruptive fit for the current application: it uses Node's built-in SQLite database and local file storage. Keep the API at one instance. The disk is tied to one service instance, so this deployment does not provide horizontal scaling or zero-downtime API deploys. For high availability or multiple API instances, first move the database to managed PostgreSQL and reports/uploads to shared object storage, then move rate limits to a shared store.

## Before creating the Blueprint

1. Push the repository to a Git provider account that you control. Keep it private if the source should not be public, protect the production branch, and review changes before they deploy.
2. Choose two subdomains under the same registered domain, for example `app.example.com` and `api.example.com`. The current session cookie uses `SameSite=Lax`; keeping both subdomains under the same site supports the cookie while retaining separate frontend and API origins.
3. In Render, create a Blueprint from this repository and select `render.yaml`. During setup, enter:
   - `CORS_ORIGIN`: `https://app.example.com` (the exact frontend origin, without a trailing slash).
   - `VITE_API_BASE_URL`: `https://api.example.com/api/v1`.
   - `GROQ_API_KEY`: the key entered directly into Render's secret environment variable prompt. Never put it in this file, Git, Vite variables, or the browser bundle.
4. After Render creates the services, add `app.example.com` to the static site and `api.example.com` to the API service. Add the DNS records Render shows, wait for verification and managed TLS, then confirm the two environment values above match the final domains. Vite variables are baked into the frontend build, so changing `VITE_API_BASE_URL` requires a new static-site build.
5. Once both custom domains work, disable each service's default `onrender.com` subdomain in its Render settings. Keep the custom domains under the same registered domain.
6. In the Render secret settings, add optional `GITHUB_TOKEN` for higher GitHub API limits or `TAVILY_API_KEY` for external competitor research. Never expose these values in frontend configuration.
7. Set provider usage alerts or caps for the AI/search accounts. The API key is server-side, but this application intentionally opens a guest workspace without login; anyone who can reach the site can create a workspace and request analyses. Do not use this public deployment for confidential projects or uncontrolled public traffic until stronger abuse controls are in place.

Render automatically provides HTTPS and renews TLS certificates. The Blueprint sets browser security headers and an HTTPS-only cookie policy in production. The API trusts one reverse-proxy hop so its existing IP-based limits can identify client IPs behind Render.

After choosing the domain, add a frontend Content-Security-Policy that restricts `connect-src` to the exact API origin. It is intentionally left out of the generic Blueprint so it does not allow arbitrary HTTPS origins or block the eventual custom API domain.

## Data and operational limits

- The disk preserves the SQLite database, reports, and uploads across restarts and deploys. Monitor disk usage; the app allows users to add multiple file attachments.
- Render's daily disk snapshots are retained for seven days. They are a short recovery window, not an independent backup plan. Add and periodically test an off-site SQLite-consistent backup before storing important production data.
- Guest workspaces are tied to a browser cookie and have no login-based recovery. Clearing/expiring the cookie loses access to that workspace.
- Rate-limit counters currently live in process memory. The single-instance setup preserves their intended behavior while the process runs; limits reset on restart and are not a durable, global quota for anonymous AI usage.
- The frontend and backend have independent deploys. A successful static build does not prove the API key, DNS, cookies, or external AI provider work; complete the smoke checks below after configuring the live services.

## Go-live checks

1. Confirm the API's `https://api.example.com/health` responds successfully.
2. Open `https://app.example.com`, create a guest workspace, add a project, analyze a public website/repository, and confirm the report appears.
3. Download the PDF and upload/download a project-field attachment; restart or redeploy the API and verify the records and files remain.
4. In browser developer tools, confirm API requests use HTTPS, the `cst_session` cookie is `Secure` and `HttpOnly`, and the browser sends it between the two custom subdomains.
5. Confirm a request from an unapproved browser origin is rejected, and check Render logs and disk usage.
6. Configure and test the independent backup and recovery process before treating the service as production-ready.

The blueprint and code are prepared locally; live deployment still requires the Render workspace, Git repository connection, the custom domain/DNS, and the AI provider key to be configured by an authorized account holder.
