const json = (data, status = 200, extra = {}) => new Response(
  JSON.stringify(data),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  }
);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text) {
  return b64url(new TextEncoder().encode(text));
}

function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(text)
    )
  );
}

async function makeSession(secret) {
  const payload = b64urlText(
    JSON.stringify({ exp: Date.now() + 86400000 })
  );
  return payload + "." + b64url(await hmac(secret, payload));
}

async function validSession(req, secret) {
  const m = (req.headers.get("Cookie") || "")
    .match(/(?:^|;\s*)ngg_session=([^;]+)/);

  if (!m || !secret) return false;

  const parts = m[1].split(".");
  if (parts.length !== 2) return false;

  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  const expected = b64url(await hmac(secret, payload));

  if (sig.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return false;

  try {
    const data = JSON.parse(
      new TextDecoder().decode(fromB64url(payload))
    );
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function cookie(value, maxAge = 86400) {
  return `ngg_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function discount(p) {
  const old = Number(p.old) || 0;
  const price = Number(p.price) || 0;
  return old > 0
    ? Math.max(0, Math.round((1 - price / old) * 100))
    : 0;
}

function mapProduct(p) {
  const q = {
    id: String(p.id),
    name: p.name || "",
    cat: p.category || "",
    price: Number(p.offer_price) || 0,
    old: Number(p.regular_price) || 0,
    stock: p.stock || "In Stock",
    caption: p.caption || "",
    emoji: p.emoji || "📦",
    image: p.image_url || "",
    video: p.video_url || ""
  };
  q.discount = discount(q);
  return q;
}

function mapOrder(o) {
  return {
    id: String(o.id),
    code: o.code,
    productId: String(o.product_id),
    product: o.product_name,
    name: o.customer_name,
    phone: o.phone,
    address: o.address,
    qty: Number(o.quantity) || 1,
    total: Number(o.total) || 0,
    status: o.status || "Pending",
    date: o.created_at,
    step: Number(o.step) || 0
  };
}

function mapReview(r) {
  return {
    id: String(r.id),
    name: r.name || "Customer",
    rating: Number(r.rating) || 5,
    text: r.text || ""
  };
}

async function sb(env, path, opts = {}) {
  const base = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !key) {
    throw new Error("Supabase secrets are not configured");
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...(opts.headers || {})
  };

  const r = await fetch(`${base}/rest/v1/${path}`, {
    ...opts,
    headers
  });

  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!r.ok) {
    throw new Error(
      typeof data === "object"
        ? data.message || data.hint || data.error || "Supabase request failed"
        : "Supabase request failed"
    );
  }

  return data;
}

function dataUrlParts(value) {
  if (typeof value !== "string") return null;

  const m = value.match(
    /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s
  );

  return m ? { mime: m[1], base64: m[2] } : null;
}

function decodeBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  return out;
}

function extForMime(mime) {
  const m = String(mime).toLowerCase();

  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov"
  };

  return map[m] || "bin";
}

async function uploadMedia(env, dataUrl, prefix) {
  const parts = dataUrlParts(dataUrl);
  if (!parts) return dataUrl || "";

  const bytes = decodeBase64(parts.base64);

  if (bytes.byteLength > 12 * 1024 * 1024) {
    throw new Error(
      "Media file is too large. Please use a file under 12 MB."
    );
  }

  const name =
    `${prefix}-${crypto.randomUUID()}.${extForMime(parts.mime)}`;

  const base = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !key) {
    throw new Error("Supabase secrets are not configured");
  }

  const r = await fetch(
    `${base}/storage/v1/object/product-media/${name}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": parts.mime,
        "x-upsert": "true"
      },
      body: bytes
    }
  );

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Media upload failed: ${t.slice(0, 300)}`);
  }

  return `${base}/storage/v1/object/public/product-media/${name}`;
}

async function readAll(env) {
  const [products, orders, reviews] = await Promise.all([
    sb(env, "products?select=*&order=created_at.desc"),
    sb(env, "orders?select=*&order=created_at.desc"),
    sb(env, "reviews?select=*&order=created_at.desc")
  ]);

  return {
    products: products.map(mapProduct),
    orders: orders.map(mapOrder),
    reviews: reviews.map(mapReview)
  };
}

async function body(req) {
  const text = await req.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function categories(products) {
  return [...new Set(
    products
      .map(p => p.category)
      .filter(Boolean)
  )];
}

function requireAdmin(request, env) {
  return validSession(
    request,
    String(env.ADMIN_PASSWORD || "")
  );
}
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const p = u.pathname;

    try {
      if (p.startsWith("/api/")) {
        if (
          !env.SUPABASE_URL ||
          !env.SUPABASE_SERVICE_ROLE_KEY
        ) {
          return json(
            {
              error:
                "Supabase is not configured on this Worker"
            },
            500
          );
        }

        if (p === "/api/health" && request.method === "GET") {
          return json({ ok: true });
        }

        if (
          p === "/api/admin/login" &&
          request.method === "POST"
        ) {
          const b = await body(request);
          const pass = String(env.ADMIN_PASSWORD || "");

          if (!pass) {
            return json(
              { error: "ADMIN_PASSWORD is not configured" },
              500
            );
          }

          if (String(b.password || "") !== pass) {
            return json(
              { error: "Wrong password" },
              401
            );
          }

          const sid = await makeSession(pass);

          return json(
            { ok: true },
            200,
            { "Set-Cookie": cookie(sid) }
          );
        }

        if (
          p === "/api/admin/logout" &&
          request.method === "POST"
        ) {
          return json(
            { ok: true },
            200,
            { "Set-Cookie": cookie("", 0) }
          );
        }

        if (
          p === "/api/admin/me" &&
          request.method === "GET"
        ) {
          return json({
            authenticated: await requireAdmin(request, env)
          });
        }

        // Admin dashboard data — requires a valid session
        if (
          p === "/api/admin/data" &&
          request.method === "GET"
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          return json(await readAll(env));
        }

        if (
          p === "/api/data" &&
          request.method === "GET"
        ) {
          return json(await readAll(env));
        }

        if (
          p === "/api/categories" &&
          request.method === "GET"
        ) {
          const products = await sb(
            env,
            "products?select=category&order=category.asc"
          );

          return json({
            categories: categories(
              products.map(p => ({
                category: p.category
              }))
            )
          });
        }

        if (
          p === "/api/products" &&
          request.method === "GET"
        ) {
          const products = await sb(
            env,
            "products?select=*&order=created_at.desc"
          );

          return json(products.map(mapProduct));
        }

        if (
          p === "/api/orders" &&
          request.method === "POST"
        ) {
          const b = await body(request);

          const productId = String(b.productId || "");
          const quantity = Math.max(
            1,
            Number(b.quantity) || 1
          );

          if (!productId) {
            return json(
              { error: "Product is required" },
              400
            );
          }

          const products = await sb(
            env,
            `products?id=eq.${encodeURIComponent(productId)}&select=*`
          );

          if (!products.length) {
            return json(
              { error: "Product not found" },
              404
            );
          }

          const product = products[0];
          const price = Number(product.offer_price) || 0;
          const total = price * quantity;

          const code =
            "NGG-" +
            Date.now().toString(36).toUpperCase() +
            "-" +
            Math.random()
              .toString(36)
              .slice(2, 7)
              .toUpperCase();

          const customerName = String(b.name || "").trim();
          const phone = String(b.phone || "").trim();
          const address = String(b.address || "").trim();

          if (!customerName || !phone || !address) {
            return json(
              {
                error:
                  "Name, phone and address are required"
              },
              400
            );
          }

          const rows = await sb(
            env,
            "orders",
            {
              method: "POST",
              body: JSON.stringify({
                code,
                product_id: product.id,
                product_name: product.name,
                customer_name: customerName,
                phone,
                address,
                quantity,
                total,
                status: "Pending",
                step: 0
              })
            }
          );

          return json({
            ok: true,
            order: mapOrder(rows[0])
          });
        }

        if (
          p === "/api/reviews" &&
          request.method === "GET"
        ) {
          const reviews = await sb(
            env,
            "reviews?select=*&order=created_at.desc"
          );

          return json(reviews.map(mapReview));
        }

        if (
          p === "/api/admin/products" &&
          request.method === "GET"
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const products = await sb(
            env,
            "products?select=*&order=created_at.desc"
          );

          return json(products.map(mapProduct));
        }

        if (
          p === "/api/admin/orders" &&
          request.method === "GET"
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const orders = await sb(
            env,
            "orders?select=*&order=created_at.desc"
          );

          return json(orders.map(mapOrder));
        }

        if (
          p === "/api/admin/reviews" &&
          request.method === "GET"
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const reviews = await sb(
            env,
            "reviews?select=*&order=created_at.desc"
          );

          return json(reviews.map(mapReview));
      }
                 if (
          p === "/api/admin/products" &&
          request.method === "POST"
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const b = await body(request);

          const name = String(b.name || "").trim();
          if (!name) {
            return json(
              { error: "Product name is required" },
              400
            );
          }

          const imageUrl = await uploadMedia(
            env,
            b.image || b.imageUrl || "",
            "product-image"
          );

          const videoUrl = await uploadMedia(
            env,
            b.video || b.videoUrl || "",
            "product-video"
          );

          const rows = await sb(
            env,
            "products",
            {
              method: "POST",
              body: JSON.stringify({
                name,
                category: String(b.cat || b.category || "").trim(),
                caption: String(b.caption || "").trim(),
                regular_price: Number(b.old || b.regular_price) || 0,
                offer_price: Number(b.price || b.offer_price) || 0,
                stock: String(b.stock || "In Stock"),
                image_url: imageUrl,
                video_url: videoUrl,
                emoji: String(b.emoji || "📦")
              })
            }
          );

          return json({
            ok: true,
            product: mapProduct(rows[0])
          });
        }

        const productMatch =
          p.match(/^\/api\/admin\/products\/([^/]+)$/);

        if (
          productMatch &&
          (request.method === "PUT" ||
            request.method === "PATCH" ||
            request.method === "DELETE")
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const id = decodeURIComponent(productMatch[1]);

          if (request.method === "DELETE") {
            await sb(
              env,
              `products?id=eq.${encodeURIComponent(id)}`,
              { method: "DELETE" }
            );

            return json({ ok: true });
          }

          const b = await body(request);
          const patch = {};

          if (b.name !== undefined) {
            patch.name = String(b.name).trim();
          }

          if (b.cat !== undefined || b.category !== undefined) {
            patch.category = String(
              b.cat ?? b.category ?? ""
            ).trim();
          }

          if (b.caption !== undefined) {
            patch.caption = String(b.caption || "").trim();
          }

          if (b.old !== undefined || b.regular_price !== undefined) {
            patch.regular_price =
              Number(b.old ?? b.regular_price) || 0;
          }

          if (b.price !== undefined || b.offer_price !== undefined) {
            patch.offer_price =
              Number(b.price ?? b.offer_price) || 0;
          }

          if (b.stock !== undefined) {
            patch.stock = String(b.stock || "In Stock");
          }

          if (b.emoji !== undefined) {
            patch.emoji = String(b.emoji || "📦");
          }

          if (b.image || b.imageUrl) {
            patch.image_url = await uploadMedia(
              env,
              b.image || b.imageUrl,
              "product-image"
            );
          }

          if (b.video || b.videoUrl) {
            patch.video_url = await uploadMedia(
              env,
              b.video || b.videoUrl,
              "product-video"
            );
          }

          const rows = await sb(
            env,
            `products?id=eq.${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              body: JSON.stringify(patch)
            }
          );

          return json({
            ok: true,
            product: rows[0] ? mapProduct(rows[0]) : null
          });
        }

        const orderMatch =
          p.match(/^\/api\/admin\/orders\/([^/]+)$/);

        if (
          orderMatch &&
          (request.method === "PUT" ||
            request.method === "PATCH" ||
            request.method === "DELETE")
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const id = decodeURIComponent(orderMatch[1]);

          if (request.method === "DELETE") {
            await sb(
              env,
              `orders?id=eq.${encodeURIComponent(id)}`,
              { method: "DELETE" }
            );

            return json({ ok: true });
          }

          const b = await body(request);
          const patch = {};

          if (b.status !== undefined) {
            patch.status = String(b.status || "Pending");
          }

          if (b.step !== undefined) {
            patch.step = Number(b.step) || 0;
          }

          if (b.name !== undefined) {
            patch.customer_name = String(b.name || "").trim();
          }

          if (b.phone !== undefined) {
            patch.phone = String(b.phone || "").trim();
          }

          if (b.address !== undefined) {
            patch.address = String(b.address || "").trim();
          }

          if (b.quantity !== undefined || b.qty !== undefined) {
            patch.quantity =
              Math.max(1, Number(b.quantity ?? b.qty) || 1);
          }

          if (Object.keys(patch).length === 0) {
            return json({ ok: true });
          }

          const rows = await sb(
            env,
            `orders?id=eq.${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              body: JSON.stringify(patch)
            }
          );

          return json({
            ok: true,
            order: rows[0] ? mapOrder(rows[0]) : null
          });
        }

        const reviewMatch =
          p.match(/^\/api\/admin\/reviews\/([^/]+)$/);

        if (
          reviewMatch &&
          (request.method === "PUT" ||
            request.method === "PATCH" ||
            request.method === "DELETE")
        ) {
          if (!await requireAdmin(request, env)) {
            return json(
              { error: "Unauthorized" },
              401
            );
          }

          const id = decodeURIComponent(reviewMatch[1]);

          if (request.method === "DELETE") {
            await sb(
              env,
              `reviews?id=eq.${encodeURIComponent(id)}`,
              { method: "DELETE" }
            );

            return json({ ok: true });
          }

          const b = await body(request);
          const patch = {};

          if (b.name !== undefined) {
            patch.name = String(b.name || "").trim();
          }

          if (b.rating !== undefined) {
            patch.rating = Number(b.rating) || 5;
          }

          if (b.text !== undefined) {
            patch.text = String(b.text || "").trim();
          }

          const rows = await sb(
            env,
            `reviews?id=eq.${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              body: JSON.stringify(patch)
            }
          );

          return json({
            ok: true,
            review: rows[0] ? mapReview(rows[0]) : null
          });
        }

        return json(
          { error: "API route not found" },
          404
        );
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json(
        { error: e?.message || "Server error" },
        500
      );
    }
  }
};
