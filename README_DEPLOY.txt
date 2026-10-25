NEXTGEN GADGET — CLOUDFLARE VERSION

This package replaces the old Node.js server with a Cloudflare Worker API and keeps the existing website frontend.

IMPORTANT:
1. The old server.js/db.json are intentionally not used by this version.
2. Supabase is used for products, orders and reviews.
3. Before the site can save/admin-edit data, the Cloudflare Worker needs these environment secrets/variables:
   SUPABASE_URL = https://pjpksujnbarrfzoxkyeh.supabase.co
   SUPABASE_SERVICE_ROLE_KEY = your Supabase service_role secret (NEVER put this in index.html or send it to anyone)
   ADMIN_PASSWORD = choose a strong admin password

The public frontend never receives the service_role key.

Deploy with Wrangler using wrangler.jsonc. Static files are in /public and API Worker code is _worker.js.
