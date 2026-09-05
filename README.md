# MailMart

Static MailMart frontend backed by Supabase Authentication, Postgres, Row Level Security, and Realtime.

## Supabase setup

1. Open the project's **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
2. In **Authentication → URL Configuration**, add the deployed site URL and its `dashboard.html` URL to the redirect allow list.
3. Enable **Email** and, if wanted, **Google** under Authentication providers. Add the Google credentials requested by Supabase.
4. Register the administrator through the app, then run the commented `update public.users ...` command at the end of the schema with the administrator's email.
5. If email confirmation is enabled, users must confirm their email before they receive a session and can enter the dashboard.

The browser-safe project URL and publishable key live in `js/supabase.js`. Never put a Supabase secret/service-role key in this repository or browser code.

## Local development

Serve the repository over HTTP (ES modules do not work reliably through `file://`):

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Security note

The existing sales workflow collects third-party email passwords and OTP-like follow-ups. This is extremely sensitive authentication data. Do not deploy that workflow without reviewing its legality, consent model, encryption, retention/deletion rules, audit controls, and Supabase policies. Prefer a provider-authorized OAuth transfer flow that never exposes passwords or one-time codes.
