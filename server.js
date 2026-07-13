require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");
const { Pool } = require("pg");
const https = require("https");
const Stripe = require("stripe");
function getStripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set in environment variables.");
    return new Stripe(key);
}
const WebSocket = require("ws");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Stripe webhook MUST be registered before express.json() ──
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
        event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error("Webhook signature failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const meta = session.metadata || {};
        const itemId = meta.item_id;
        const itemName = meta.item_name;
        const itemPrice = meta.item_price;
        const roleId = meta.role_id;
        const zipUrl = meta.zip_url;
        const discordUserId = meta.discord_user_id;
        const customerEmail = session.customer_details?.email || "";

        try {
            await pool.query(
                "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                [Date.now(), itemId || null, itemName, itemPrice, discordUserId || "", "stripe", `Stripe checkout — ${customerEmail}`]
            );
        } catch (e) {
            console.error("Failed to record purchase:", e.message);
        }

        let roleResult = null;
        if (roleId && discordUserId) {
            const guildId = await getSetting("discordGuildId");
            roleResult = await assignDiscordRole(guildId, discordUserId, roleId);
        }

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `✅ **Stripe Purchase Completed**\n` +
            `📦 Item: **${itemName}**\n` +
            `💷 Price: **${itemPrice}**\n` +
            `📧 Email: ${customerEmail}\n` +
            `👤 Discord: ${discordUserId ? `<@${discordUserId}>` : "Not linked"}\n` +
            `🎭 Role: ${roleResult?.ok ? `✅ Assigned` : roleResult ? `⚠️ ${roleResult.error}` : "ℹ️ No Discord ID"}\n` +
            `📁 File: ${zipUrl ? "✅ Download ready" : "ℹ️ No file attached"}\n` +
            `🕐 Time: ${ts}`
        );
    }

    res.json({ received: true });
});

async function setupDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS session (
            sid VARCHAR NOT NULL PRIMARY KEY,
            sess JSON NOT NULL,
            expire TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);

        CREATE TABLE IF NOT EXISTS store_items (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price TEXT NOT NULL,
            description TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            buy_link TEXT DEFAULT '',
            stripe_link TEXT DEFAULT '',
            paypal_link TEXT DEFAULT '',
            role_id TEXT DEFAULT '',
            category TEXT DEFAULT 'General',
            sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS purchases (
            id BIGINT PRIMARY KEY,
            item_id INTEGER,
            item_name TEXT,
            item_price TEXT,
            discord_user_id TEXT DEFAULT '',
            type TEXT DEFAULT 'bypass',
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS store_credits (
            discord_id TEXT PRIMARY KEY,
            balance NUMERIC(10,2) DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS credit_transactions (
            id BIGSERIAL PRIMARY KEY,
            discord_id TEXT NOT NULL,
            amount NUMERIC(10,2) NOT NULL,
            reason TEXT DEFAULT '',
            type TEXT DEFAULT 'grant',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS web_game_servers (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            rcon_host TEXT NOT NULL,
            rcon_port INTEGER DEFAULT 28016,
            rcon_password TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS web_kit_configs (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            required_role_id TEXT DEFAULT '',
            cooldown_minutes INTEGER DEFAULT 60,
            server_id INTEGER,
            enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS web_kit_cooldowns (
            discord_id TEXT NOT NULL,
            kit_id INTEGER NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (discord_id, kit_id)
        );

        CREATE TABLE IF NOT EXISTS web_player_links (
            discord_id TEXT PRIMARY KEY,
            gamertag TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS stripe_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS paypal_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS zip_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS discord_user_id TEXT DEFAULT ''`);

    const { rows } = await pool.query("SELECT COUNT(*) FROM store_items");
    if (parseInt(rows[0].count) === 0) {
        await pool.query(`
            INSERT INTO store_items (name, price, description, buy_link, stripe_link, paypal_link, role_id, category, sort_order) VALUES
            ('VIP', '£9.99', 'Priority Queue\nVIP Chat Tag\nStarter Kit\nDiscord Role', '', '', '', '', 'Ranks', 1),
            ('AK Kit', '£4.99', 'AK-47\nAmmo\nMedical Supplies', '', '', '', '', 'Kits', 2),
            ('Builder Kit', '£2.99', 'Wood\nStone\nMetal', '', '', '', '', 'Kits', 3)
        `);
    }
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
    new DiscordStrategy(
        {
            clientID: process.env.CLIENT_ID,
            clientSecret: process.env.CLIENT_SECRET,
            callbackURL: process.env.CALLBACK_URL,
            scope: ["identify"]
        },
        (accessToken, refreshToken, profile, done) => done(null, profile)
    )
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        store: new PgSession({ pool, tableName: "session" }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production"
        }
    })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

function checkAdmin(req, res, next) {
    if (req.session.adminLoggedIn) return next();
    res.redirect("/admin-login.html");
}

function checkAdminJson(req, res, next) {
    if (req.session.adminLoggedIn) return next();
    res.status(401).json({ error: "Unauthorized" });
}

app.get("/auth/discord", passport.authenticate("discord"));

app.get(
    "/auth/discord/callback",
    passport.authenticate("discord", { failureRedirect: "/" }),
    (req, res) => res.redirect("/")
);

app.get("/logout", (req, res) => {
    req.logout(() => res.redirect("/"));
});

app.get("/user", (req, res) => {
    if (!req.user) return res.json({ loggedIn: false });
    res.json({
        loggedIn: true,
        id: req.user.id,
        username: req.user.username,
        avatar: `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
    });
});

app.post("/admin-login", (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        req.session.adminLoggedIn = true;
        res.redirect("/admin");
    } else {
        res.redirect("/admin-login.html?error=1");
    }
});

app.get("/admin-logout", (req, res) => {
    req.session.adminLoggedIn = false;
    res.redirect("/admin-login.html");
});

app.get("/admin", checkAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/checkout/:itemId", async (req, res) => {
    res.sendFile(path.join(__dirname, "checkout.html"));
});

app.get("/checkout-success", (req, res) => {
    res.sendFile(path.join(__dirname, "checkout-success.html"));
});

app.get("/api/checkout/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.status(404).json({ error: "Item not found" });
        const item = rows[0];

        let creditBalance = 0;
        if (req.user) {
            const cr = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
            creditBalance = parseFloat(cr.rows[0]?.balance || 0);
        }

        const globalPaypal = await getSetting("paypalDefaultLink");
        res.json({
            id: item.id,
            name: item.name,
            price: item.price,
            description: item.description,
            imageUrl: item.image_url || "",
            buyLink: item.buy_link,
            stripeLink: item.stripe_link,
            stripeEnabled: !!process.env.STRIPE_SECRET_KEY,
            paypalLink: item.paypal_link || globalPaypal,
            roleId: item.role_id,
            zipUrl: item.zip_url || "",
            category: item.category || "General",
            isAdmin: !!req.session.adminLoggedIn,
            isLoggedIn: !!req.user,
            discordId: req.user?.id || null,
            creditBalance
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Lookup Stripe session for success page ──
app.get("/api/checkout-session/:sessionId", async (req, res) => {
    try {
        const session = await getStripe().checkout.sessions.retrieve(req.params.sessionId);
        res.json({
            itemName: session.metadata?.item_name || "",
            itemPrice: session.metadata?.item_price || "",
            zipUrl: session.metadata?.zip_url || "",
            customerEmail: session.customer_details?.email || "",
            roleAssigned: session.metadata?.discord_user_id ? true : false
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/buy/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.redirect("/store.html");
        const item = rows[0];
        const link = item.stripe_link || item.paypal_link || item.buy_link;
        if (!link) return res.redirect("/store.html");
        await logPurchaseClick(item, "click", "Customer clicked Buy Now");
        res.redirect(link);
    } catch (e) {
        res.redirect("/store.html");
    }
});

// ── Stripe Checkout Session — uses per-item Price ID if set, else auto-prices from item.price ──
app.get("/buy-stripe/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.redirect("/store.html");
        const item = rows[0];

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.redirect(`/checkout/${item.id}?err=no-stripe`);
        }

        const discordUserId = req.user?.id || "";

        let lineItems;
        const priceId = (item.stripe_link || "").trim();

        if (priceId.startsWith("https://")) {
            await logPurchaseClick(item, "click-stripe", "Customer redirected to Stripe payment link");
            return res.redirect(priceId);
        }

        if (priceId.startsWith("price_")) {
            lineItems = [{ price: priceId, quantity: 1 }];
        } else {
            const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, ""));
            if (isNaN(priceNum) || priceNum <= 0) {
                return res.redirect(`/checkout/${item.id}?err=stripe-error`);
            }
            lineItems = [{
                price_data: {
                    currency: "gbp",
                    unit_amount: Math.round(priceNum * 100),
                    product_data: { name: item.name }
                },
                quantity: 1
            }];
        }

        const checkoutSession = await getStripe().checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: lineItems,
            mode: "payment",
            success_url: `${BASE_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${BASE_URL}/checkout/${item.id}`,
            metadata: {
                item_id: String(item.id),
                item_name: item.name,
                item_price: item.price,
                role_id: item.role_id || "",
                zip_url: item.zip_url || "",
                discord_user_id: discordUserId
            }
        });

        await logPurchaseClick(item, "click-stripe", "Customer clicked Pay with Card (Stripe)");
        res.redirect(checkoutSession.url);
    } catch (e) {
        console.error("Stripe checkout error:", e.message);
        res.redirect(`/checkout/${req.params.itemId}?err=stripe-error`);
    }
});

app.get("/buy-paypal/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.redirect("/store.html");
        const item = rows[0];
        const paypalLink = item.paypal_link || await getSetting("paypalDefaultLink");
        if (!paypalLink) {
            return res.redirect(`/checkout/${item.id}?err=no-paypal`);
        }
        await logPurchaseClick(item, "click-paypal", "Customer clicked Pay with PayPal");
        res.redirect(paypalLink);
    } catch (e) {
        res.redirect("/store.html");
    }
});

async function logPurchaseClick(item, type, note) {
    try {
        await pool.query(
            "INSERT INTO purchases (id, item_id, item_name, item_price, type, note) VALUES ($1, $2, $3, $4, $5, $6)",
            [Date.now(), item.id, item.name, item.price, type, note]
        );
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `🛒 **Purchase Initiated**\n` +
            `📦 Item: **${item.name}**\n` +
            `💷 Price: **${item.price}**\n` +
            `🕐 Time: ${ts}\n` +
            `📝 ${note}`
        );
    } catch (e) {}
}

app.get("/api/admin-status", (req, res) => {
    res.json({ isAdmin: !!req.session.adminLoggedIn });
});

app.get("/api/store-items", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items ORDER BY sort_order, id");
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            price: r.price,
            description: r.description,
            imageUrl: r.image_url || "",
            buyLink: r.buy_link,
            stripeLink: r.stripe_link || "",
            paypalLink: r.paypal_link || "",
            roleId: r.role_id || "",
            zipUrl: r.zip_url || "",
            category: r.category || "General"
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/store-items", checkAdminJson, async (req, res) => {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Expected array" });
    try {
        await pool.query("DELETE FROM store_items");
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const numericId = item.id && Number(item.id) < 2000000000 ? Number(item.id) : null;
            if (numericId) {
                await pool.query(
                    "INSERT INTO store_items (id, name, price, description, image_url, buy_link, stripe_link, paypal_link, role_id, zip_url, category, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
                    [numericId, item.name, item.price, item.description || "", item.imageUrl || "", item.buyLink || "", item.stripeLink || "", item.paypalLink || "", item.roleId || "", item.zipUrl || "", item.category || "General", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO store_items (name, price, description, image_url, buy_link, stripe_link, paypal_link, role_id, zip_url, category, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                    [item.name, item.price, item.description || "", item.imageUrl || "", item.buyLink || "", item.stripeLink || "", item.paypalLink || "", item.roleId || "", item.zipUrl || "", item.category || "General", i]
                );
            }
        }
        await pool.query("SELECT setval('store_items_id_seq', COALESCE((SELECT MAX(id) FROM store_items), 1))");
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── Store Credits ── */

app.get("/api/credits/me", async (req, res) => {
    if (!req.user) return res.json({ balance: 0, loggedIn: false });
    try {
        const { rows } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        res.json({ balance: parseFloat(rows[0]?.balance || 0), loggedIn: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/admin/credits", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_credits ORDER BY updated_at DESC");
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/admin/give-credit", checkAdminJson, async (req, res) => {
    const { discordId, amount, reason } = req.body;
    if (!discordId || !amount) return res.status(400).json({ error: "Missing discordId or amount" });
    const amt = parseFloat(amount);
    if (isNaN(amt)) return res.status(400).json({ error: "Invalid amount" });
    try {
        await pool.query(
            `INSERT INTO store_credits (discord_id, balance, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (discord_id) DO UPDATE SET balance = GREATEST(0, store_credits.balance + $2), updated_at = NOW()`,
            [discordId, amt]
        );
        await pool.query(
            "INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1, $2, $3, $4)",
            [discordId, amt, reason || "Admin grant", amt >= 0 ? "grant" : "deduct"]
        );
        const { rows } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [discordId]);
        const newBalance = parseFloat(rows[0]?.balance || 0);
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `💰 **Store Credit ${amt >= 0 ? "Added" : "Deducted"}**\n` +
            `👤 Discord: <@${discordId}>\n` +
            `💷 Amount: **${amt >= 0 ? "+" : ""}£${amt.toFixed(2)}**\n` +
            `💼 New Balance: **£${newBalance.toFixed(2)}**\n` +
            `📝 Reason: ${reason || "Admin grant"}\n` +
            `🕐 Time: ${ts}`
        );
        res.json({ ok: true, newBalance });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/pay-with-credits", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "Missing itemId" });
    try {
        const { rows: itemRows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [itemId]);
        if (!itemRows[0]) return res.status(404).json({ error: "Item not found" });
        const item = itemRows[0];

        const priceStr = item.price.replace(/[^0-9.]/g, "");
        const price = parseFloat(priceStr);
        if (isNaN(price)) return res.status(400).json({ error: "Could not parse item price" });

        const { rows: creditRows } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const balance = parseFloat(creditRows[0]?.balance || 0);

        if (balance < price) return res.status(400).json({ error: `Insufficient credits. You have £${balance.toFixed(2)}, need £${price.toFixed(2)}.` });

        await pool.query(
            "UPDATE store_credits SET balance = balance - $1, updated_at = NOW() WHERE discord_id = $2",
            [price, req.user.id]
        );
        await pool.query(
            "INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1, $2, $3, $4)",
            [req.user.id, -price, `Spent on ${item.name}`, "spend"]
        );
        await pool.query(
            "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [Date.now(), item.id, item.name, item.price, req.user.id, "credit", "Paid with store credits"]
        );

        let roleResult = null;
        if (item.role_id) {
            const guildId = await getSetting("discordGuildId");
            roleResult = await assignDiscordRole(guildId, req.user.id, item.role_id);
        }

        const { rows: newCreditRows } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const newBalance = parseFloat(newCreditRows[0]?.balance || 0);

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `✅ **Credit Purchase**\n` +
            `📦 Item: **${item.name}**\n` +
            `💷 Price: **${item.price}**\n` +
            `👤 Discord: <@${req.user.id}>\n` +
            `💼 Remaining Credits: **£${newBalance.toFixed(2)}**\n` +
            `🎭 Role: ${roleResult?.ok ? `✅ Assigned` : roleResult ? `⚠️ ${roleResult.error}` : "ℹ️ No role set"}\n` +
            `🕐 Time: ${ts}`
        );

        res.json({ ok: true, newBalance, roleAssigned: roleResult?.ok || false, roleError: roleResult?.error || null, zipUrl: item.zip_url || "" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── Settings ── */

async function getSetting(key) {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    return rows[0]?.value || "";
}

async function setSetting(key, value) {
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, value]
    );
}

async function sendDiscordLog(message) {
    const token = await getSetting("discordBotToken");
    const channelId = await getSetting("discordChannelId");
    if (!token || !channelId) return;
    try {
        const body = JSON.stringify({ content: message });
        const options = {
            hostname: "discord.com",
            path: `/api/v10/channels/${channelId}/messages`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bot ${token}`,
                "Content-Length": Buffer.byteLength(body)
            }
        };
        await new Promise((resolve, reject) => {
            const req = https.request(options, r => { r.on("data", () => {}); r.on("end", resolve); });
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    } catch (e) {
        console.error("Discord log failed:", e.message);
    }
}

// ── WebSocket RCON (Rust) ──────────────────────────────────────────────────────
async function sendRcon(host, port, password, command) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${host}:${port}/${password}`);
        const timer = setTimeout(() => { ws.terminate(); reject(new Error("RCON timeout")); }, 8000);
        ws.once("open", () => {
            ws.send(JSON.stringify({ Identifier: 1, Message: command, Name: "WebRcon" }));
        });
        ws.once("message", (data) => {
            clearTimeout(timer);
            ws.close();
            try { resolve(JSON.parse(data.toString()).Message || ""); } catch { resolve(data.toString()); }
        });
        ws.once("error", (err) => { clearTimeout(timer); ws.terminate(); reject(err); });
    });
}

// ── Discord member roles ───────────────────────────────────────────────────────
async function getDiscordMemberRoles(guildId, userId, botToken) {
    return new Promise((resolve) => {
        const opts = {
            hostname: "discord.com",
            path: `/api/v10/guilds/${guildId}/members/${userId}`,
            headers: { "Authorization": `Bot ${botToken}`, "User-Agent": "Vestige6X/1.0" }
        };
        const req = https.get(opts, (r) => {
            let data = "";
            r.on("data", (c) => data += c);
            r.on("end", () => {
                try { resolve(JSON.parse(data).roles || []); } catch { resolve([]); }
            });
        });
        req.on("error", () => resolve([]));
    });
}

async function assignDiscordRole(guildId, userId, roleId) {
    const token = await getSetting("discordBotToken");
    if (!token || !guildId || !userId || !roleId) {
        return { ok: false, error: "Missing token, guildId, userId, or roleId" };
    }
    return new Promise((resolve) => {
        const options = {
            hostname: "discord.com",
            path: `/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
            method: "PUT",
            headers: { "Authorization": `Bot ${token}`, "Content-Length": 0 }
        };
        const req = https.request(options, r => {
            let data = "";
            r.on("data", chunk => data += chunk);
            r.on("end", () => {
                resolve(r.statusCode === 204 ? { ok: true } : { ok: false, error: `Discord API ${r.statusCode}: ${data}` });
            });
        });
        req.on("error", e => resolve({ ok: false, error: e.message }));
        req.end();
    });
}

app.post("/api/bypass-payment", checkAdminJson, async (req, res) => {
    const { itemId, itemName, itemPrice, roleId, discordUserId } = req.body;
    if (!itemName) return res.status(400).json({ error: "Missing item info" });
    const id = Date.now();

    let roleResult = null;
    if (roleId && discordUserId) {
        const guildId = await getSetting("discordGuildId");
        roleResult = await assignDiscordRole(guildId, discordUserId.trim(), roleId);
    }

    try {
        await pool.query(
            "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [id, itemId || null, itemName, itemPrice || "", discordUserId || "", "bypass", "Admin bypass — no payment taken"]
        );
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        const roleNote = roleResult?.ok ? `✅ Role assigned to <@${discordUserId}>` : roleResult ? `⚠️ Role failed: ${roleResult.error}` : `ℹ️ No role/user provided`;
        await sendDiscordLog(
            `⚡ **Bypass Payment Used**\n` +
            `📦 Item: **${itemName}**\n` +
            `💷 Price: **${itemPrice || "N/A"}**\n` +
            `👤 Discord User: ${discordUserId ? `<@${discordUserId}>` : "Not specified"}\n` +
            `🕐 Time: ${ts}\n` +
            `🎭 Role: ${roleNote}`
        );
        res.json({ ok: true, roleAssigned: roleResult?.ok || false, roleError: roleResult?.error || null, entry: { id, itemName, itemPrice, discordUserId, timestamp: new Date().toISOString() } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/purchases", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM purchases ORDER BY created_at DESC");
        res.json(rows.map(r => ({
            id: r.id, itemId: r.item_id, itemName: r.item_name, itemPrice: r.item_price,
            discordUserId: r.discord_user_id || "", type: r.type, note: r.note, timestamp: r.created_at
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/settings", checkAdminJson, async (req, res) => {
    try {
        const channelId = await getSetting("discordChannelId");
        const token = await getSetting("discordBotToken");
        const guildId = await getSetting("discordGuildId");
        const paypalDefaultLink = await getSetting("paypalDefaultLink");
        res.json({ discordChannelId: channelId, discordBotToken: token ? "••••••••••••••••" : "", discordGuildId: guildId, paypalDefaultLink });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/settings", checkAdminJson, async (req, res) => {
    try {
        const { discordChannelId, discordBotToken, discordGuildId, paypalDefaultLink } = req.body;
        if (discordChannelId !== undefined) await setSetting("discordChannelId", discordChannelId);
        if (discordBotToken && !discordBotToken.startsWith("•")) await setSetting("discordBotToken", discordBotToken);
        if (discordGuildId !== undefined) await setSetting("discordGuildId", discordGuildId);
        if (paypalDefaultLink !== undefined) await setSetting("paypalDefaultLink", paypalDefaultLink);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Kits page ─────────────────────────────────────────────────────────────────
app.get("/kits", (req, res) => res.sendFile(path.join(__dirname, "kits.html")));

// ── Kits: player gamertag link ────────────────────────────────────────────────
app.get("/api/kits/gamertag", async (req, res) => {
    if (!req.user) return res.json({ gamertag: null });
    try {
        const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        res.json({ gamertag: rows[0]?.gamertag || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/kits/gamertag", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { gamertag } = req.body;
    if (!gamertag?.trim()) return res.status(400).json({ error: "Gamertag required" });
    try {
        await pool.query(
            `INSERT INTO web_player_links (discord_id, gamertag, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (discord_id) DO UPDATE SET gamertag = $2, updated_at = NOW()`,
            [req.user.id, gamertag.trim()]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kits: list available kits for logged-in user ──────────────────────────────
app.get("/api/kits", async (req, res) => {
    try {
        const { rows: allKits } = await pool.query(
            `SELECT k.*, s.name as server_name, s.rcon_host, s.rcon_port, s.rcon_password
             FROM web_kit_configs k
             LEFT JOIN web_game_servers s ON s.id = k.server_id
             WHERE k.enabled = 1
             ORDER BY k.sort_order, k.id`
        );

        if (!req.user) {
            return res.json({ loggedIn: false, gamertag: null, kits: allKits.map(k => ({
                id: k.id, name: k.name, description: k.description,
                cooldownMinutes: k.cooldown_minutes, requiredRoleId: k.required_role_id,
                serverName: k.server_name || "Server", hasRole: false, onCooldown: false, expiresAt: null
            }))});
        }

        const botToken = await getSetting("discordBotToken");
        const guildId  = await getSetting("discordGuildId");
        let memberRoles = [];
        if (botToken && guildId) {
            memberRoles = await getDiscordMemberRoles(guildId, req.user.id, botToken);
        }

        const { rows: cooldowns } = await pool.query(
            "SELECT kit_id, expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND expires_at > NOW()",
            [req.user.id]
        );
        const cdMap = {};
        for (const cd of cooldowns) cdMap[cd.kit_id] = cd.expires_at;

        const { rows: gtRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = gtRows[0]?.gamertag || null;

        const result = allKits
            .map(k => ({
                id: k.id, name: k.name, description: k.description,
                cooldownMinutes: k.cooldown_minutes, requiredRoleId: k.required_role_id,
                serverName: k.server_name || "Server",
                hasRole: !k.required_role_id || memberRoles.includes(k.required_role_id),
                onCooldown: !!cdMap[k.id],
                expiresAt: cdMap[k.id] || null
            }))
            .filter(k => k.hasRole);

        res.json({ loggedIn: true, gamertag, kits: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kits: claim ───────────────────────────────────────────────────────────────
app.post("/api/kits/claim", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { kitId } = req.body;
    if (!kitId) return res.status(400).json({ error: "Missing kitId" });
    try {
        const { rows } = await pool.query(
            `SELECT k.*, s.name as server_name, s.rcon_host, s.rcon_port, s.rcon_password
             FROM web_kit_configs k
             LEFT JOIN web_game_servers s ON s.id = k.server_id
             WHERE k.id = $1 AND k.enabled = 1 LIMIT 1`,
            [kitId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Kit not found" });
        const kit = rows[0];

        if (kit.required_role_id) {
            const botToken = await getSetting("discordBotToken");
            const guildId  = await getSetting("discordGuildId");
            if (botToken && guildId) {
                const roles = await getDiscordMemberRoles(guildId, req.user.id, botToken);
                if (!roles.includes(kit.required_role_id)) {
                    return res.status(403).json({ error: "You do not have the required role for this kit." });
                }
            }
        }

        const { rows: cdRows } = await pool.query(
            "SELECT expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND kit_id = $2 AND expires_at > NOW() LIMIT 1",
            [req.user.id, kitId]
        );
        if (cdRows[0]) {
            return res.status(429).json({ error: "Kit is on cooldown.", expiresAt: cdRows[0].expires_at });
        }

        const { rows: gtRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = gtRows[0]?.gamertag;
        if (!gamertag) return res.status(400).json({ error: "Link your in-game name first." });

        if (!kit.rcon_host) return res.status(500).json({ error: "No game server configured for this kit." });

        const cmd = `kit givetoplayer "${kit.name}" "${gamertag}"`;
        try {
            await sendRcon(kit.rcon_host, kit.rcon_port || 28016, kit.rcon_password || "", cmd);
        } catch (rconErr) {
            console.error("RCON error:", rconErr.message);
            return res.status(500).json({ error: "RCON connection failed — server may be offline." });
        }

        const expiresAt = new Date(Date.now() + kit.cooldown_minutes * 60 * 1000);
        await pool.query(
            `INSERT INTO web_kit_cooldowns (discord_id, kit_id, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (discord_id, kit_id) DO UPDATE SET expires_at = $3`,
            [req.user.id, kitId, expiresAt]
        );

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `🎁 **Kit Claimed (Website)**\n` +
            `📦 Kit: **${kit.name}**\n` +
            `🎮 Gamertag: **${gamertag}**\n` +
            `👤 Discord: <@${req.user.id}>\n` +
            `🖥️ Server: ${kit.server_name || "N/A"}\n` +
            `🕐 Time: ${ts}`
        );

        res.json({ ok: true, expiresAt });
    } catch (e) {
        console.error("Kit claim error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Game Servers ───────────────────────────────────────────────────────
app.get("/api/admin/game-servers", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT id, name, rcon_host, rcon_port, sort_order FROM web_game_servers ORDER BY sort_order, id");
        res.json(rows.map(s => ({ id: s.id, name: s.name, rconHost: s.rcon_host, rconPort: s.rcon_port })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/game-servers", checkAdminJson, async (req, res) => {
    const servers = req.body;
    if (!Array.isArray(servers)) return res.status(400).json({ error: "Expected array" });
    try {
        await pool.query("DELETE FROM web_game_servers");
        for (let i = 0; i < servers.length; i++) {
            const s = servers[i];
            if (!s.name || !s.rconHost) continue;
            if (s.id) {
                await pool.query(
                    "INSERT INTO web_game_servers (id, name, rcon_host, rcon_port, rcon_password, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
                    [s.id, s.name, s.rconHost, parseInt(s.rconPort) || 28016, s.rconPassword || "", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO web_game_servers (name, rcon_host, rcon_port, rcon_password, sort_order) VALUES ($1,$2,$3,$4,$5)",
                    [s.name, s.rconHost, parseInt(s.rconPort) || 28016, s.rconPassword || "", i]
                );
            }
        }
        try { await pool.query("SELECT setval('web_game_servers_id_seq', COALESCE((SELECT MAX(id) FROM web_game_servers), 1))"); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Kit Configs ────────────────────────────────────────────────────────
app.get("/api/admin/web-kits", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM web_kit_configs ORDER BY sort_order, id");
        res.json(rows.map(k => ({
            id: k.id, name: k.name, description: k.description,
            requiredRoleId: k.required_role_id, cooldownMinutes: k.cooldown_minutes,
            serverId: k.server_id, enabled: k.enabled
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/web-kits", checkAdminJson, async (req, res) => {
    const kits = req.body;
    if (!Array.isArray(kits)) return res.status(400).json({ error: "Expected array" });
    try {
        await pool.query("DELETE FROM web_kit_configs");
        for (let i = 0; i < kits.length; i++) {
            const k = kits[i];
            if (!k.name) continue;
            if (k.id) {
                await pool.query(
                    "INSERT INTO web_kit_configs (id, name, description, required_role_id, cooldown_minutes, server_id, enabled, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                    [k.id, k.name, k.description || "", k.requiredRoleId || "", parseInt(k.cooldownMinutes) || 60, k.serverId || null, k.enabled !== false ? 1 : 0, i]
                );
            } else {
                await pool.query(
                    "INSERT INTO web_kit_configs (name, description, required_role_id, cooldown_minutes, server_id, enabled, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    [k.name, k.description || "", k.requiredRoleId || "", parseInt(k.cooldownMinutes) || 60, k.serverId || null, k.enabled !== false ? 1 : 0, i]
                );
            }
        }
        try { await pool.query("SELECT setval('web_kit_configs_id_seq', COALESCE((SELECT MAX(id) FROM web_kit_configs), 1))"); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

setupDB()
    .then(() => {
        app.listen(PORT, () => console.log("Server running on port " + PORT));
    })
    .catch(err => {
        console.error("DB setup failed:", err.message);
        process.exit(1);
    });
