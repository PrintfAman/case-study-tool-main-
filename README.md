# Case Study Tool

A public, shared project workspace that collects evidence from a website and/or public GitHub repository, builds editable project information, generates a case study, and exports a PDF.

> Authentication is currently disabled. Anyone who can reach the API can read, create, change, analyze, or delete project data. Do not store confidential information here. CORS and rate limits are not authentication.

## Product workflow

1. Create a project with a name and at least one source URL (website or GitHub).
2. The dashboard saves the project and immediately starts source collection as a separate API request.
3. Review and edit discovered fields, add notes/custom fields, and accept or reject suggestions.
4. Select **View Case Study** to create a saved case-study version from collected evidence and visible, accepted, finalized fields.
5. Review the report, optionally edit individual sections, then download a PDF from the report preview or history.

Creating a project does not automatically create a case study or PDF. Project fields are collected at creation; case-study generation and PDF generation are separate actions.

## Technology stack

| Area | Technology | How it is used |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite 8 | Single-page dashboard, client-side state, typed API calls, static build |
| Styling | Tailwind CSS 4 Vite plugin and project CSS | Utility layout plus shared theme tokens and component styles |
| Backend | Node.js 22.13+, TypeScript 5.9, Express 5 | JSON API, crawling, analysis, persistence coordination, report generation |
| Validation | Zod 4 | Environment, API input, provider response, and dynamic-field validation |
| Local database | Built-in `node:sqlite` | Local SQLite file when `DATABASE_URL` is not set |
| Production database | Supabase Postgres, `pg` 8 | Relational application data over a Node Postgres pool with verified TLS |
| Production file storage | Supabase Storage private bucket via REST | PDFs and field attachments; credentials stay on the backend |
| Website parsing | Cheerio | HTML text, headings, links, and metadata extraction |
| AI | Groq Chat Completions REST API | Synthesis, classification, suggestions, chat, reranking, and report edits |
| Repository analysis | GitHub REST API | Public repository metadata, languages, tree, manifests, docs, bounded source inspection |
| Competitor discovery | Tavily Search API (optional) | Candidate search results, treated as unverified |
| PDF | `pdf-lib` | Report pages, tables, contents, headers/footers, and page numbers |
| Tests/build | TypeScript compiler, Node test runner via `tsx` | Backend tests and frontend/backend typecheck/build scripts |

There is no Supabase client SDK in the dependency list: Postgres uses `pg` and Storage uses Supabase's HTTP API. The knowledge index is implemented in the application and stored in the relational database; it is not Supabase `pgvector` or a separate vector service.

## Architecture

### Runtime components

~~~mermaid
flowchart LR
    Browser[Browser] --> React[React dashboard]
    React --> ApiClient[api-client.ts and project-api.ts]
    ApiClient --> Express[Express API under /api/v1]
    Express --> Routes[Route modules]
    Routes --> Controllers[Controllers]
    Controllers --> Services[Domain services]
    Services --> DBAdapter[Database adapter]
    DBAdapter --> SQLite[Local SQLite]
    DBAdapter --> Postgres[Supabase Postgres in production]
    Services --> FileAdapter[Storage service]
    FileAdapter --> LocalFiles[Local report and upload directories]
    FileAdapter --> SupabaseStorage[Private Supabase Storage bucket]
    Services --> Website[Public website]
    Services --> GitHub[GitHub REST API]
    Services --> Groq[Groq API]
    Services --> Tavily[Tavily API when configured]
~~~

Local development uses SQLite and local report/upload directories by default. When `DATABASE_URL` is set, the database adapter uses Supabase Postgres. When the Supabase URL and server key are set, the storage service uses the configured Supabase bucket. Production configuration validation requires Supabase Postgres, a TLS CA certificate, and Storage configuration.

### Backend startup

1. `config/env.ts` loads `backend/.env` and validates configuration with Zod.
2. `server.ts` initializes the selected database and its schema.
3. If `SQLITE_MIGRATION_PATH` is configured, SQLite records are imported once into Postgres in a transaction.
4. The server verifies the Storage bucket exists and is private, then copies legacy disk PDFs and attachments if the one-time file migration has not run.
5. `app.ts` builds the Express middleware and mounts routes; `server.ts` starts listening. Shutdown closes the HTTP server and database connections gracefully.

### Project, fields, case-study, and PDF sequence

~~~mermaid
sequenceDiagram
    actor User
    participant UI as React dashboard
    participant API as Express API
    participant Info as Project information service
    participant Sources as Website, GitHub, Tavily
    participant Groq
    participant DB as SQLite or Supabase Postgres
    participant Files as Local files or Supabase Storage

    User->>UI: Create project
    UI->>API: POST /projects
    API->>DB: Insert project and seed name/source fields
    API-->>UI: Project created
    UI->>API: POST /projects/:id/discover-fields
    API->>Info: Collect sources and build information
    Info->>Sources: Crawl website, inspect repository, optional search
    Info->>Groq: Synthesize evidence and suggest fields when configured
    Info->>DB: Save evidence, fields, warnings, and knowledge chunks
    API-->>UI: Fields ready or ready with warnings
    User->>UI: Finalize fields and select View Case Study
    UI->>API: POST /analysis/projects/:id/analyze
    API->>Groq: Generate report from evidence and finalized fields
    API->>DB: Insert a new case-study version
    API-->>UI: Return saved case study
    User->>UI: Download PDF
    UI->>API: POST /reports/projects/:id/report
    API->>Files: Save generated PDF
    API-->>UI: Return download URL
    UI->>API: GET report download URL
    API->>Files: Read PDF bytes
    API-->>UI: Stream PDF
~~~

`POST /projects` does not crawl sources itself. The active frontend calls `POST /projects/:id/discover-fields` after project creation so the dashboard can show the new project and its collection state immediately.

## How project information is extracted

### Website crawler

`website-crawler.service.ts` accepts HTTP/HTTPS URLs on standard ports and uses `network-safety.service.ts` for URL and DNS checks. It rejects URL credentials and private/local IP ranges, resolves DNS, and pins requests to a validated public address to reduce SSRF and DNS-rebinding risk.

The crawler:

- Requests `robots.txt` first and stops if it cannot verify permission or the root path is disallowed.
- Follows at most four redirects, only when the redirect stays on the same hostname.
- Crawls same-origin HTML pages only. The project pipeline requests six pages; the crawler hard-caps requests at ten.
- Limits a page response to 2 MB and `robots.txt` to 512 KB; extracted text per page is capped at 20,000 characters.
- Removes scripts, styles, navigation, footer, SVG, and other non-content elements before extracting.
- Captures title, description, canonical URL, language, site name, image URL, keywords, publication date, headings, body text, and same-origin links.
- Returns warnings for blocked, inaccessible, oversized, or unsupported pages.

### GitHub repository analyzer

`github-analyzer.service.ts` accepts public `https://github.com/owner/repository` URLs and calls GitHub's REST API. It does not clone or download the whole repository.

It collects repository metadata (description, default branch, topics, license, stars, forks, open issues, size, timestamps), language byte counts, and a recursive file tree. It reads selected dependency manifests, the README, up to four documentation files, and a prioritized sample of up to eight source files. Inspection uses at most 600 KB of source text, with individual files capped at 100 KB and up to four concurrent file requests.

The analyzer derives technology/dependency indicators, likely API routes, database/ORM references, test and CI indicators, and limited potentially risky code patterns. These are heuristics from a bounded sample, not a full build, runtime trace, code-quality review, or security audit. `GITHUB_TOKEN` is optional and raises API rate limits; only public repositories are supported.

### Competitor discovery

`competitor-research.service.ts` calls Tavily only when `TAVILY_API_KEY` is configured. It requests at most five results, excludes submitted website/repository hosts, and marks results as candidates/unverified. It does not prove a result is a direct competitor or establish market share.

## How fields are generated and saved

### Collection and AI enrichment

`project-information.service.ts` coordinates collection. Website and GitHub failures become independent warnings, so one unavailable source does not discard the other. The service calls case-study synthesis to create field-analysis content, upserts dynamic fields, saves source evidence and warnings, then rebuilds the project's knowledge index.

Field extraction combines source-specific rules and AI analysis:

- Website fields can include site/company name, page/product title, description/tagline, observed headings, and metadata keywords.
- GitHub fields can include languages, detected frameworks, dependencies, database/ORM indicators, repository size and stars, API route indicators, build manifests, CI/hosting configuration indicators, and bounded quality/security signals.
- AI analysis can add business model, target audience, revenue/market analysis, SWOT, recommendations, project type, and up to twelve validated suggestions when returned by the model.
- Project type is one of `Frontend`, `Full Stack`, `Backend`, `Automation`, or `Not enough evidence`. Groq classification is used when available; an evidence-based deterministic classifier is the fallback.
- Source-aware fallback suggestions (for example, customer persona, funding stage, traffic, deployment frequency, or missing technical details) have no invented value and await user input.

Groq calls use the Chat Completions REST endpoint. Model output is parsed and validated; accepted sections are merged into a deterministic evidence-based fallback. If Groq is missing or fails, fallback analysis keeps collected facts and labels unknown/unverified claims. Chat answers and AI-assisted section edits require `GROQ_API_KEY`.

### Dynamic field record

Fields are rows in `project_fields`, not fixed project columns. Categories are `general`, `technical`, `business`, `product`, `market`, `financial`, `ai_insights`, and `custom_fields`.

Supported types are `text`, `long_text`, `number`, `currency`, `percentage`, `url`, `email`, `phone`, `date`, `date_time`, `boolean`, `dropdown`, `multi_select`, `tags`, `rich_text`, `json`, and `file_attachment`.

Each record stores its category, name, type, JSON value, source, confidence, AI value/source/confidence, generator, editability, required/read-only flags, default, description, dropdown options, order, visibility, pin state, suggestion state, notes, and timestamps.

On re-analysis, AI/source values refresh. If the user edited a field, the current value is preserved and the new AI value is saved separately for optional restoration. Accepted, rejected, and deleted suggestions are not silently reopened. Custom fields use stable `custom:<id>` keys and remain separate from source-derived fields.

`ProjectInformationPanel.tsx` supports search/category filters, collapsible categories, inline edits, notes, pinning, drag-and-drop ordering within a category, bulk value edits, hidden fields, custom settings, suggestions, AI restore, and attachments.

## Case-study generation and editing

`analysis.controller.ts` runs when the user selects **View Case Study**. It reuses saved source analysis, reads visible fields and accepted suggestions, excludes pending suggestions, and passes finalized values with website/GitHub/competitor evidence to `synthesizeCaseStudy()`.

The case study is stored as JSON in a new `case_studies` row, along with status, warnings, collected evidence, and finalized project information. Each generation creates a version rather than overwriting the previous version.

Standard report sections are defined in `CASE_STUDY_SECTIONS` in `case-study.service.ts`:

Executive Summary; Project Overview; Business Background; Problem Statement; Objectives; Website Analysis; Technical Architecture; Technology Stack; Repository Analysis; Business Model; Target Audience; Market Analysis; Competitor Analysis; Competitor Comparison; Business Scope; Market Opportunities; Revenue Model; Profitability Analysis; Risks and Limitations; SWOT Analysis; Recommendations; Growth Strategy; Implementation Roadmap; Conclusion.

Section editing is versioned too. `project-ai.controller.ts` can expand, rewrite, replace, add, or remove one selected section. AI expand/rewrite/add operations retrieve project context and call Groq; replace/remove are direct edits. Each edit inserts a new case-study version.

## Project chat and retrieval

`project-knowledge.service.ts` builds a project-isolated index from project metadata, website pages, GitHub metadata/README/docs/source summary, competitor search, field analysis, the latest saved case study, warnings, and visible accepted/finalized fields.

Documents are split into chunks up to 1,600 characters with 180 characters of overlap. The service creates deterministic 256-dimensional hashed-token and adjacent-token vectors (`local-hash-v1`) and stores their JSON beside each chunk in `project_knowledge_chunks`. Content hashes let it reuse unchanged vectors and remove obsolete chunks.

For questions, retrieval is constrained by `project_id`, ranks chunks using local cosine similarity (up to twelve candidates), then asks Groq to rerank at most six. The answer call receives selected project excerpts plus recent conversation turns for follow-up context; it does not send the full website or repository. Answers store citations, and chat history is saved in `project_chat_messages`. If Groq reranking fails, local ranking is used; generating an answer still requires Groq.

This is a lightweight local-vector RAG implementation, not a neural embedding model or hosted vector database.

## PDF generation and download

1. `reports.controller.ts` loads the selected case-study version, or the latest version if no ID is specified.
2. `pdf-report.service.ts` maps standard and custom sections into a PDF using `pdf-lib` and built-in Helvetica/Helvetica Bold fonts.
3. Text wraps to page width and flows across pages. Arrays of objects become tables, primitive arrays become lists, and nested objects become labeled fields.
4. The service creates a cover page, inserts a table of contents after pagination is known, adds report-page headers, and adds `Page N of M` footers.
5. The PDF is written via `supabase-storage.service.ts` to `project-id/reports/<file>.pdf` in the private bucket in production, or to the local report directory in local mode.
6. The download route reads the object and streams it as `application/pdf`. The API URL stays the same with either storage adapter.

Field attachments are limited to 10 MB by the API. They use project-scoped paths in Supabase Storage in production or `UPLOAD_STORAGE_DIR` locally.

## Persistence model

The schema is created idempotently at startup by `storage/database.ts` for Postgres, or `storage/sqlite-database.ts` for local SQLite.

| Table | Stored data |
| --- | --- |
| `projects` | Project name/URLs/status/input and timestamps; `user_id` is nullable because authentication is disabled |
| `project_source_analyses` | Latest collection status, source evidence JSON, field-analysis JSON, warnings, update time |
| `project_fields` | Dynamic source-derived and custom fields, values, edit metadata, suggestions, ordering |
| `case_studies` | Versioned case-study JSON and generation status |
| `project_knowledge_chunks` | Project-scoped chunks, metadata, content hashes, local vectors, embedding-version label |
| `project_chat_messages` | User/assistant messages and cited source metadata |
| `app_migrations` | One-time SQLite/file migration markers |

Legacy `users` and `sessions` tables remain for migration/backward compatibility; the current API has no active login, signup, session middleware, or ownership filtering. Foreign keys cascade project-owned relational records when a project is deleted.

Postgres uses text identifiers and serialized JSON text columns to keep the SQLite-oriented SQL model compatible. The adapter translates `?` parameters to Postgres placeholders, uses `AsyncLocalStorage` for transaction context, and retains SQLite as the local fallback.

## API map

Business routes use `API_PREFIX`, default `/api/v1`. Responses use the shared `{ success, message, data, error }` envelope.

| Route group | Endpoints | Purpose |
| --- | --- | --- |
| Health | `GET /health`, `GET /api/v1/health` | Liveness/dependency health |
| Projects | `GET/POST /api/v1/projects`, `GET/DELETE /api/v1/projects/:id` | Create, list, inspect, delete |
| Information | `POST /api/v1/projects/:id/discover-fields` | Collect/refresh source evidence and fields |
| Fields | `/api/v1/projects/:projectId/fields...` | List/create/update/delete, bulk edit, reorder, suggestions, restore AI value, attachments |
| Analysis | `POST /api/v1/analysis/projects/:id/analyze` | Generate a case-study version |
| History | `GET /api/v1/analysis/projects/:id/case-study`, `/case-studies`, `/case-studies/:caseStudyId` | Read latest case study and version history |
| Chat | `GET/POST /api/v1/analysis/projects/:id/chat` | Read/send project chat |
| Section edits | `POST /api/v1/analysis/projects/:id/case-studies/:caseStudyId/sections` | Expand/rewrite/replace/add/remove one section |
| Reports | `POST /api/v1/reports/projects/:id/report`, `GET /api/v1/reports/projects/:id/report/download/:fileName` | Generate and download PDF |

Create-project, discovery, analysis, chat, section-edit, and PDF-generation routes have in-memory per-IP limits. They reset when the process restarts and are not a durable global quota.

## File and folder map

### Backend

| File or folder | Responsibility |
| --- | --- |
| `backend/src/server.ts` | Process entry point, startup order, port binding, graceful shutdown, uncaught-error logging |
| `backend/src/app.ts` | Express app factory; security headers, CORS, JSON body limit, request logging, DB initialization, route mounting |
| `backend/src/config/env.ts` | Loads environment and validates configuration with Zod |
| `backend/src/routes/index.ts` | Mounts versioned routers |
| `backend/src/routes/projects.routes.ts` | Project CRUD, source discovery, dynamic fields, attachment routes, rate limits |
| `backend/src/routes/analysis.routes.ts` | Case-study generation/history, chat, section editing, rate limits |
| `backend/src/routes/reports.routes.ts` | PDF generation/download routes and rate limit |
| `backend/src/routes/health.routes.ts` | Versioned health route |
| `backend/src/controllers/projects.controller.ts` | Project validation, create/list/get/delete, seed fields |
| `backend/src/controllers/project-information.controller.ts` | Source collection trigger and status/count response |
| `backend/src/controllers/project-fields.controller.ts` | Field validation/CRUD, bulk edit, suggestions, order, attachment upload/download |
| `backend/src/controllers/analysis.controller.ts` | Generates case-study versions from evidence/finalized fields; reads history |
| `backend/src/controllers/project-ai.controller.ts` | RAG chat and single-section report edits |
| `backend/src/controllers/reports.controller.ts` | Selects version, generates PDF, validates and streams download |
| `backend/src/controllers/health.controller.ts` | Converts health report to HTTP response |
| `backend/src/middleware/request-rate-limit.middleware.ts` | In-memory fixed-window IP limits for public/expensive routes |
| `backend/src/middleware/request-logger.middleware.ts` | Request timing/status logging |
| `backend/src/middleware/error.middleware.ts` | Central 404, validation, payload-size, and unexpected-error handling |
| `backend/src/services/project-information.service.ts` | Coordinates collection, field enrichment, saved evidence/warnings, knowledge refresh |
| `backend/src/services/website-crawler.service.ts` | Robots-aware bounded same-origin crawler and metadata/text extraction |
| `backend/src/services/network-safety.service.ts` | URL checks, DNS resolution, public-address checks |
| `backend/src/services/github-analyzer.service.ts` | Public GitHub REST analysis, tree/manifests/source inspection |
| `backend/src/services/competitor-research.service.ts` | Optional bounded Tavily search |
| `backend/src/services/project-fields.service.ts` | Field definitions, source-to-field inference, AI value preservation/upsert, serialization |
| `backend/src/services/case-study.service.ts` | Groq calls, fallback synthesis, report sections, classification, chat, reranking, edits |
| `backend/src/services/project-knowledge.service.ts` | Project chunking, local vectors, cosine retrieval, chat history |
| `backend/src/services/pdf-report.service.ts` | PDF layout, pagination, contents, tables, headers/footers |
| `backend/src/services/supabase-storage.service.ts` | Supabase Storage REST, local file fallback, bucket verification, legacy file copy |
| `backend/src/services/health.service.ts` | Database/provider configuration and process health report |
| `backend/src/storage/database.ts` | Postgres/SQLite selection, Postgres schema, SQL compatibility, transactions, SQLite import |
| `backend/src/storage/sqlite-database.ts` | Local SQLite schema, migrations, indexes, health |
| `backend/src/types/pg.d.ts` | Minimal TypeScript declarations for `pg` |
| `backend/src/utils/api-response.ts` | Shared typed success/error response envelope |
| `backend/src/utils/app-error.ts` | Typed HTTP/application errors |
| `backend/src/utils/logger.ts` | Structured application logger |
| `backend/src/utils/require-project.ts` | Shared project-existence check |
| `backend/tests/api.test.ts` | Backend API tests |
| `backend/live-analysis-smoke.mjs`, `backend/smoke-test.mjs` | Live/provider and app smoke-test helpers |

### Frontend

| File or folder | Responsibility |
| --- | --- |
| `frontend/src/main.tsx` | React entry point; mounts `App` and imports CSS |
| `frontend/src/App.tsx` | Active dashboard orchestration: project create/list, automatic field discovery, history/preview, section edits, PDF download, chat |
| `frontend/src/components/ProjectInformationPanel.tsx` | Dynamic fields, suggestions, custom fields, edit/filter/reorder/bulk/attachment controls |
| `frontend/src/components/ProjectChatPanel.tsx` | Project chat, answers, and citations |
| `frontend/src/components/Panel.tsx`, `Badge.tsx` | Shared layout/status components used by active dashboard |
| `frontend/src/services/api-client.ts` | API base URL, credential-free fetch, response envelope, shared errors |
| `frontend/src/services/project-api.ts` | Typed calls for projects, fields, discovery, chat, analysis, edits, reports, attachments |
| `frontend/src/types/api.ts` | API envelope/error types |
| `frontend/src/types/projects.ts` | Project, discovery, and case-study types |
| `frontend/src/types/project-fields.ts` | Field categories/types/metadata and payloads |
| `frontend/src/utils/format.ts` | Shared formatting helpers |
| `frontend/src/index.css`, `frontend/src/styles/theme.css`, `frontend/src/styles/app.css` | Tailwind entry point, design tokens, and dashboard styles |
| `frontend/vite.config.ts` | React/Tailwind plugins and dev/preview ports |
| `frontend/index.html` | Static HTML shell |

`frontend/src/App.new.tsx` and its health/status UI (`BackendStatusPanel`, `DependenciesPanel`, `LiveStatusChip`, `useApiHealth`) are an older dashboard variant and are not imported by the active `main.tsx` → `App.tsx` path. They do not affect the current dashboard.

### Root configuration and documentation

| File | Responsibility |
| --- | --- |
| `render.yaml` | Render Blueprint for a Node backend and static frontend; includes temporary disk paths for legacy data migration |
| `SUPABASE_SETUP.md` | Supabase Postgres, CA, Storage, Render variables, and one-time migration |
| `DEVELOPMENT_ROADMAP.md` | Audit and implementation/verification tracking |
| `DEPLOYMENT.md` | Earlier deployment guide; its SQLite/disk-only assumptions predate Supabase. Use `SUPABASE_SETUP.md` for current database/storage setup |
| `backend/.env.example` | Backend environment variable names and defaults |
| `backend/package.json`, `frontend/package.json` | Dependencies and scripts |

## Configuration

### Frontend

| Variable | Description |
| --- | --- |
| `VITE_API_BASE_URL` | API base URL including prefix, e.g. `https://api.example.com/api/v1`; embedded at frontend build time |

The frontend does not need Supabase credentials and sends requests without cookies.

### Backend

Copy `backend/.env.example` to `backend/.env` locally. In production, set values in the backend host's environment settings.

| Variable | Use | Description |
| --- | --- | --- |
| `NODE_ENV` | All | `development`, `test`, or `production` |
| `PORT` | All | Express listen port; defaults to `5000` |
| `CORS_ORIGIN` | All | Exact allowed frontend origin |
| `API_PREFIX` | Optional | API prefix; defaults to `/api/v1` |
| `DATABASE_URL` | Production | Supabase Postgres connection URI; omit locally for SQLite |
| `DATABASE_SSL_CA_BASE64` | Production | Base64 of Supabase PEM database CA for verified TLS |
| `DATABASE_PATH` | Local SQLite | File path; defaults to `./storage/case-study-tool.sqlite` |
| `SQLITE_MIGRATION_PATH` | One-time migration | Existing SQLite database to import into Postgres |
| `SUPABASE_URL` | Production Storage | Supabase Project URL, e.g. `https://project-ref.supabase.co` |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Production Storage | Server-side key; never expose to the browser |
| `SUPABASE_STORAGE_BUCKET` | Production Storage | Private bucket; defaults to `case-study-files` |
| `REPORT_STORAGE_DIR` | Local/migration | Local PDF directory; defaults to `./storage/reports` |
| `UPLOAD_STORAGE_DIR` | Local/migration | Local attachment directory; defaults to `./storage/uploads` |
| `GROQ_API_KEY` | Optional AI | Enables Groq synthesis, classification, chat, reranking, and AI edits |
| `GROQ_MODEL` | Optional AI | Model name sent to Groq |
| `GROQ_TEMPERATURE` | Optional AI | Defaults to `0.2` |
| `GROQ_MAX_TOKENS` | Optional AI | Defaults to `8000` |
| `GITHUB_TOKEN` | Optional GitHub | Higher public API rate limits |
| `TAVILY_API_KEY` | Optional search | Enables Tavily competitor research |

Never commit backend secrets or put them in frontend `VITE_*` variables. `SUPABASE_SETUP.md` covers the Postgres CA and private bucket setup. `render.yaml` currently retains a disk and migration path for the one-time legacy import; remove them only after confirming imported records and files.

## Run locally

Requires Node.js 22.13 or newer and npm. In one terminal:

~~~powershell
cd backend
npm ci
Copy-Item .env.example .env
npm run dev
~~~

In a second terminal:

~~~powershell
cd frontend
npm ci
npm run dev
~~~

Open the Vite URL, normally `http://localhost:5173`. The dashboard calls `http://localhost:5000/api/v1` by default. Set `VITE_API_BASE_URL` if the backend has another URL and set backend `CORS_ORIGIN` to the exact frontend origin.

For local development, omit Supabase database and Storage variables to use SQLite and local files. To run against Supabase locally, configure the backend-only variables as for production.

## Checks

Run from `backend/`:

~~~powershell
npm run typecheck
npm test
npm run build
~~~

Run from `frontend/`:

~~~powershell
npm run typecheck
npm run build
~~~

`npm test` runs the backend Node test suite through `tsx`. The frontend package currently has typecheck/build scripts, not a separate test script.

## Operational and evidence limitations

- The API is public and shared. Project IDs are identifiers, not authorization tokens; there is no per-user privacy boundary.
- Rate limits are in-memory, per-process IP counters. They reset on restart and are not a global usage quota.
- CORS controls which browser origins may read responses; it does not prevent direct API calls.
- Crawling and repository analysis are bounded; sources can be incomplete, private, stale, rate-limited, or inaccessible.
- GitHub inspection is a heuristic sample, not a full clone, application execution, or security audit.
- Competitor results are candidates and require manual verification.
- Market size, customers, usage, revenue, funding, and profitability remain unknown unless supported by evidence or user input.
- Provider credentials and network access are required for live external calls. Without Groq, source-based fallback analysis remains; chat and AI section editing are unavailable.
- Groq and Tavily can incur usage charges. Configure provider-side limits and alerts; in-memory request limits are not a spending guarantee.

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for database/Storage setup, [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) for implementation status, and [render.yaml](render.yaml) for the Render Blueprint.
