# Supabase setup for the Case Study Tool

The backend uses Supabase Postgres for projects, analyses, fields, chat history, and reports. PDFs and custom-field attachments use a private Supabase Storage bucket. Local development continues to use SQLite and local files unless Supabase environment variables are set.

## 1. Create the Supabase project

1. Create a Supabase project and save its database password.
2. In **Connect**, copy the **Session pooler** URI for an IPv4 hosted backend such as Render. Put that full URI in Render as `DATABASE_URL`; replace the password placeholder with the database password. Keep the username and host exactly as Supabase provides them.
3. Copy the Project URL shown on the dashboard. In **Project Settings → API Keys**, copy the server-side **Secret key** (`sb_secret_...`). The backend also accepts the legacy `service_role` key if that is all the project shows.
4. In **Storage**, create a bucket named `case-study-files` and make it **private**.

The backend creates its Postgres tables and indexes at startup. The frontend needs no Supabase keys and should not receive any `SUPABASE_*` or `DATABASE_URL` variables.

## 2. Set Render environment variables

Add these to the **backend Web Service** in Render:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase Session pooler connection URI |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SECRET_KEY` | Server-side Secret key (`sb_secret_...`); legacy `SUPABASE_SERVICE_ROLE_KEY` is also accepted |
| `SUPABASE_STORAGE_BUCKET` | `case-study-files` |
| `CORS_ORIGIN` | Deployed Vercel frontend origin |
| `GROQ_API_KEY` | Existing Groq key, if AI analysis should run |

Do not add these secrets to Vercel or any `VITE_*` variable. On startup the backend checks the database and confirms the Storage bucket exists and is private. It exits with an error if the production configuration is missing or the bucket cannot be accessed.

## 3. Preserve existing Render data during the switch

The first deployment keeps the current Render disk attached. `render.yaml` sets `SQLITE_MIGRATION_PATH=/var/data/case-study-tool.sqlite`; if that file exists, the backend imports projects, analyses, fields, case studies, knowledge chunks, and chat messages into Supabase in one transaction. It clears obsolete user references because authentication is disabled. The backend also copies PDFs from `REPORT_STORAGE_DIR` and attachments referenced by project fields from `UPLOAD_STORAGE_DIR` into the private bucket. Render logs the database row counts and file counts. Each import runs only once, recorded in Postgres.

After Render logs `[database] SQLite data imported into Supabase Postgres` and `[storage] Legacy files copied into Supabase Storage`, then `/health` reports the database as `up`:

1. Remove `SQLITE_MIGRATION_PATH` from the Render service environment.
2. Remove the temporary `disk` block from `render.yaml` and apply the updated Blueprint.
3. Confirm project listing, analysis, case-study generation, PDF download, and attachment download still work.

If there is no existing SQLite database to preserve, remove `SQLITE_MIGRATION_PATH` before the first deploy; then the disk can be removed from the Blueprint immediately. If the import path is configured but the database file is missing, the backend deliberately fails startup instead of silently skipping a requested migration.

## Notes

- PDF and attachment objects are stored under project-scoped paths in the private bucket. Existing API download URLs remain unchanged.
- Authentication is currently disabled. The bucket is private and the service key stays on Render, but the public backend API can still read or change project data when a caller knows its project ID. Treat project content as public until authentication is restored.
- The old disk should not be deleted until the import log is confirmed. The importer does not copy user or session records.
