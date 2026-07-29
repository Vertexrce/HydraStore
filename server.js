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

// ── Optional Valora bot SQLite integration ───────────────────────────────────
// If BOT_DB_PATH points to the Valora bot's SQLite file, the website will
// look up linked accounts there so players don't need to re-link on the site.
// Uses Node.js 24's built-in node:sqlite — no native compilation needed.
let _botDbPath = null;
const BOT_DB_PATH = process.env.BOT_DB_PATH || "";
if (BOT_DB_PATH) {
    try {
        const { DatabaseSync } = require("node:sqlite");
        // Test-open to verify the file is accessible, then keep the path for lazy queries
        const testDb = new DatabaseSync(BOT_DB_PATH, { readOnly: true });
        testDb.close();
        _botDbPath = BOT_DB_PATH;
        console.log("✅ Valora bot SQLite linked:", BOT_DB_PATH);
    } catch (e) {
        console.warn("⚠️  Could not open bot SQLite DB:", e.message);
    }
}

async function getBotLinkedGamertag(discordUserId) {
    // 1. Check Postgres mirror first (works on Railway where SQLite isn't shared)
    try {
        const { rows } = await pool.query(
            "SELECT account_name FROM linked_accounts_mirror WHERE discord_user_id=$1",
            [String(discordUserId)]
        );
        if (rows[0]) return rows[0].account_name;
    } catch { /* fall through */ }

    // 2. Fall back to bot SQLite (only works if same machine / BOT_DB_PATH set)
    if (!_botDbPath) return null;
    try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(_botDbPath, { readOnly: true });
        const row = db.prepare("SELECT account_name FROM linked_accounts WHERE discord_user_id=?").get(String(discordUserId));
        db.close();
        return row ? row.account_name : null;
    } catch { return null; }
}

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
            sort_order INTEGER DEFAULT 0,
            max_players INTEGER DEFAULT 100,
            location TEXT DEFAULT '',
            status_label TEXT DEFAULT 'online'
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

        CREATE TABLE IF NOT EXISTS clans_mirror (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            clantag TEXT,
            color TEXT,
            description TEXT,
            owner_id TEXT,
            created_at INTEGER,
            guild_id TEXT,
            server_id TEXT,
            image_url TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS clan_members_mirror (
            clan_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY (clan_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS clan_stats_mirror (
            user_id TEXT PRIMARY KEY,
            gamertag TEXT,
            kills INTEGER DEFAULT 0,
            deaths INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS clan_invite_codes_mirror (
            code TEXT PRIMARY KEY,
            clan_id INTEGER NOT NULL,
            expires_at INTEGER,
            max_uses INTEGER,
            uses INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS web_join_requests (
            discord_id TEXT PRIMARY KEY,
            clan_id INTEGER NOT NULL,
            code TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS linked_accounts_mirror (
            discord_user_id TEXT PRIMARY KEY,
            account_name TEXT NOT NULL
        );
    `);

    await pool.query(`ALTER TABLE clans_mirror ADD COLUMN IF NOT EXISTS owner_discord_name TEXT`);
    await pool.query(`ALTER TABLE clans_mirror ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS max_players INTEGER DEFAULT 100`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS status_label TEXT DEFAULT 'online'`);

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

function makeDiscordStrategy(callbackURL) {
    return new DiscordStrategy(
        {
            clientID: process.env.CLIENT_ID,
            clientSecret: process.env.CLIENT_SECRET,
            callbackURL,
            scope: ["identify"]
        },
        (accessToken, refreshToken, profile, done) => done(null, profile)
    );
}

function getCallbackURL(req) {
    const host = req.hostname;
    const proto = req.protocol;
    return `${proto}://${host}/auth/discord/callback`;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        store: new PgSession({ pool, tableName: "session" }),
        secret: process.env.SESSION_SECRET || "solarix-change-me",
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

app.get("/auth/discord", (req, res, next) => {
    const callbackURL = getCallbackURL(req);
    passport.use(makeDiscordStrategy(callbackURL));
    passport.authenticate("discord")(req, res, next);
});

app.get(
    "/auth/discord/callback",
    (req, res, next) => {
        const callbackURL = getCallbackURL(req);
        passport.use(makeDiscordStrategy(callbackURL));
        passport.authenticate("discord", { failureRedirect: "/" })(req, res, next);
    },
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
        avatar: req.user.avatar
            ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/0.png`
    });
});

// ── Admin login ───────────────────────────────────────────────────────────────
app.post("/admin-login", (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || "admin";
    const adminPass = process.env.ADMIN_PASSWORD || "solarix";
    if (username === adminUser && password === adminPass) {
        req.session.adminLoggedIn = true;
        res.redirect("/admin.html");
    } else {
        res.redirect("/admin-login.html?error=1");
    }
});

app.get("/admin-logout", (req, res) => {
    req.session.adminLoggedIn = false;
    res.redirect("/");
});

app.get("/api/admin-status", (req, res) => {
    res.json({ isAdmin: !!req.session.adminLoggedIn });
});

// ── Public: game servers list (name, location, status — no RCON details) ─────
app.get("/api/public/servers", async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, name, location, status_label, max_players FROM web_game_servers ORDER BY sort_order, id"
        );
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            location: r.location || "",
            statusLabel: r.status_label || "online",
            maxPlayers: r.max_players || 100
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Public: live player counts (queries RCON, cached 60s) ────────────────────
const _playerCountCache = new Map(); // id → { count, ts }
app.get("/api/public/server-status", async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, name, rcon_host, rcon_port, rcon_password, max_players, status_label FROM web_game_servers ORDER BY sort_order, id"
        );
        const now = Date.now();
        const results = await Promise.all(rows.map(async s => {
            // Only query RCON for servers that are "online"
            if ((s.status_label || "online") !== "online") {
                return { id: s.id, online: false, players: null, maxPlayers: s.max_players || 100 };
            }
            const cached = _playerCountCache.get(s.id);
            if (cached && now - cached.ts < 60000) {
                return { id: s.id, online: true, players: cached.count, maxPlayers: s.max_players || 100 };
            }
            try {
                const response = await sendRconCommand(s.rcon_host, s.rcon_port, s.rcon_password, "status");
                // Parse "players: X (Y max)" from Rust RCON status output
                const match = (response || "").match(/players\s*:\s*(\d+)/i);
                const count = match ? parseInt(match[1], 10) : 0;
                _playerCountCache.set(s.id, { count, ts: now });
                return { id: s.id, online: true, players: count, maxPlayers: s.max_players || 100 };
            } catch {
                // RCON unreachable — treat as offline
                return { id: s.id, online: false, players: null, maxPlayers: s.max_players || 100 };
            }
        }));
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

/* ── Gems (store credits) ── */

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
            `💎 **Gems ${amt >= 0 ? "Added" : "Deducted"}** (Solarix)\n` +
            `👤 Discord: <@${discordId}>\n` +
            `💎 Amount: **${amt >= 0 ? "+" : ""}${amt.toFixed(0)} gems**\n` +
            `💼 New Balance: **${newBalance.toFixed(0)} gems**\n` +
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

        if (balance < price) return res.status(400).json({ error: `Not enough gems. You have ${balance.toFixed(0)} gems, need ${price.toFixed(0)}.` });

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
            [Date.now(), item.id, item.name, item.price, req.user.id, "credit", "Paid with gems"]
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
            `✅ **Gem Purchase** (Solarix)\n` +
            `📦 Item: **${item.name}**\n` +
            `💎 Cost: **${price.toFixed(0)} gems**\n` +
            `👤 Discord: <@${req.user.id}>\n` +
            `💼 Remaining Gems: **${newBalance.toFixed(0)}**\n` +
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
                "User-Agent": "Solarix/1.0",
                "Content-Length": Buffer.byteLength(body)
            }
        };
        const req = https.request(options);
        req.on("error", () => {});
        req.write(body);
        req.end();
    } catch {}
}

async function assignDiscordRole(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) return null;
    const token = await getSetting("discordBotToken");
    if (!token) return { ok: false, error: "No bot token configured" };

    return new Promise((resolve) => {
        const options = {
            hostname: "discord.com",
            path: `/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
            method: "PUT",
            headers: { "Authorization": `Bot ${token}`, "Content-Length": 0, "User-Agent": "Solarix/1.0" }
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
            `⚡ **Bypass Payment** (Solarix)\n` +
            `📦 Item: **${itemName}**\n` +
            `💷 Price: **${itemPrice || "N/A"}**\n` +
            `👤 Discord: ${discordUserId ? `<@${discordUserId}>` : "Not specified"}\n` +
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

// ── Stripe Checkout ───────────────────────────────────────────────────────────
app.post("/api/create-checkout-session", async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "Missing itemId" });
    try {
        const stripe = getStripe();
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [itemId]);
        if (!rows[0]) return res.status(404).json({ error: "Item not found" });
        const item = rows[0];
        if (!item.stripe_link) return res.status(400).json({ error: "No Stripe price configured for this item" });

        const priceStr = item.price.replace(/[^0-9.]/g, "");
        const price = parseFloat(priceStr);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [{ price: item.stripe_link, quantity: 1 }],
            mode: "payment",
            success_url: `${BASE_URL}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${BASE_URL}/store.html`,
            metadata: {
                item_id: String(item.id),
                item_name: item.name,
                item_price: item.price,
                role_id: item.role_id || "",
                zip_url: item.zip_url || "",
                discord_user_id: req.user?.id || ""
            }
        });
        res.json({ url: session.url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Checkout route ────────────────────────────────────────────────────────────
app.get("/checkout/:id", (req, res) => res.sendFile(path.join(__dirname, "checkout.html")));

app.get("/api/checkout-info", async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.json({ zipUrl: "" });
    try {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const zipUrl = session.metadata?.zip_url || "";
        res.json({ zipUrl });
    } catch { res.json({ zipUrl: "" }); }
});

// ── Admin: player links ───────────────────────────────────────────────────────
app.get("/api/admin/player-links", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT discord_id, gamertag, updated_at FROM web_player_links ORDER BY updated_at DESC LIMIT 200");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: give kit manually ──────────────────────────────────────────────────
app.post("/api/admin/give-kit", checkAdminJson, async (req, res) => {
    const { player, kitName, serverId } = req.body;
    if (!player || !kitName || !serverId) return res.status(400).json({ error: "Missing player, kitName, or serverId" });

    try {
        // Resolve gamertag — player can be a gamertag or Discord ID
        let gamertag = player.trim();

        // If it looks like a Discord ID (all digits), try to find their linked gamertag
        if (/^\d{15,20}$/.test(gamertag)) {
            const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [gamertag]);
            if (rows[0]) {
                gamertag = rows[0].gamertag;
            } else {
                // Try Valora bot SQLite / Postgres mirror
                const botGamertag = await getBotLinkedGamertag(gamertag);
                if (botGamertag) gamertag = botGamertag;
                else return res.status(404).json({ error: `No linked gamertag found for Discord ID ${player}. Ask them to link on the Kits page first.` });
            }
        }

        // Get server RCON details
        const { rows: serverRows } = await pool.query("SELECT * FROM web_game_servers WHERE id = $1", [serverId]);
        const server = serverRows[0];
        if (!server) return res.status(404).json({ error: "Server not found" });
        if (!server.rcon_host) return res.status(400).json({ error: "Server has no RCON host configured" });

        // Send RCON command
        await sendRconCommand(server.rcon_host, server.rcon_port, server.rcon_password, `kit givetoplayer "${kitName}" "${gamertag}"`);

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `⚡ **Admin Kit Give** (Solarix)\n` +
            `📦 Kit: **${kitName}**\n` +
            `🎮 Gamertag: **${gamertag}**\n` +
            `🖥️ Server: ${server.name}\n` +
            `🕐 Time: ${ts}`
        );

        res.json({ ok: true, gamertag });
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
        // Check website-side link first
        const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        if (rows[0]) return res.json({ gamertag: rows[0].gamertag });

        // Fall back to Valora bot SQLite / Postgres mirror
        const botGamertag = await getBotLinkedGamertag(req.user.id);
        if (botGamertag) {
            // Auto-import into web DB
            await pool.query(
                `INSERT INTO web_player_links (discord_id, gamertag, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (discord_id) DO UPDATE SET gamertag = $2, updated_at = NOW()`,
                [req.user.id, botGamertag]
            );
            return res.json({ gamertag: botGamertag });
        }

        res.json({ gamertag: null });
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

// ── Kits: list available kits ─────────────────────────────────────────────────
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

        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = linkRows[0]?.gamertag || null;

        // Check cooldowns
        const { rows: cooldownRows } = await pool.query(
            "SELECT kit_id, expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND expires_at > NOW()",
            [req.user.id]
        );
        const cooldownMap = {};
        cooldownRows.forEach(r => { cooldownMap[r.kit_id] = r.expires_at; });

        // Check user roles via Discord API (if bot token available)
        let userRoles = [];
        try {
            const token = await getSetting("discordBotToken");
            const guildId = await getSetting("discordGuildId");
            if (token && guildId && req.user.id) {
                const data = await new Promise((resolve) => {
                    const opts = {
                        hostname: "discord.com",
                        path: `/api/v10/guilds/${guildId}/members/${req.user.id}`,
                        method: "GET",
                        headers: { "Authorization": `Bot ${token}`, "User-Agent": "Solarix/1.0" }
                    };
                    const r = https.request(opts, res => {
                        let body = "";
                        res.on("data", c => body += c);
                        res.on("end", () => resolve(JSON.parse(body)));
                    });
                    r.on("error", () => resolve({}));
                    r.end();
                });
                userRoles = data.roles || [];
            }
        } catch {}

        res.json({
            loggedIn: true,
            gamertag,
            kits: allKits.map(k => ({
                id: k.id, name: k.name, description: k.description,
                cooldownMinutes: k.cooldown_minutes,
                requiredRoleId: k.required_role_id,
                serverName: k.server_name || "Server",
                hasRole: !k.required_role_id || userRoles.includes(k.required_role_id),
                onCooldown: !!cooldownMap[k.id],
                expiresAt: cooldownMap[k.id] || null
            }))
        });
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
             WHERE k.id = $1 AND k.enabled = 1`,
            [kitId]
        );
        const kit = rows[0];
        if (!kit) return res.status(404).json({ error: "Kit not found or disabled." });

        // Check cooldown
        const { rows: cdRows } = await pool.query(
            "SELECT expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND kit_id = $2 AND expires_at > NOW()",
            [req.user.id, kitId]
        );
        if (cdRows.length > 0) {
            return res.status(429).json({ error: "Kit on cooldown.", expiresAt: cdRows[0].expires_at });
        }

        // Check role
        if (kit.required_role_id) {
            const token = await getSetting("discordBotToken");
            const guildId = await getSetting("discordGuildId");
            if (token && guildId) {
                const data = await new Promise((resolve) => {
                    const opts = {
                        hostname: "discord.com",
                        path: `/api/v10/guilds/${guildId}/members/${req.user.id}`,
                        method: "GET",
                        headers: { "Authorization": `Bot ${token}`, "User-Agent": "Solarix/1.0" }
                    };
                    const r = https.request(opts, response => {
                        let body = "";
                        response.on("data", c => body += c);
                        response.on("end", () => resolve(JSON.parse(body)));
                    });
                    r.on("error", () => resolve({}));
                    r.end();
                });
                if (!(data.roles || []).includes(kit.required_role_id)) {
                    return res.status(403).json({ error: "You don't have the required role for this kit." });
                }
            }
        }

        // Get gamertag
        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = linkRows[0]?.gamertag;
        if (!gamertag) return res.status(400).json({ error: "Link your in-game name first." });

        if (!kit.rcon_host) return res.status(500).json({ error: "No game server configured for this kit." });

        // Send RCON command
        try {
            await sendRconCommand(kit.rcon_host, kit.rcon_port, kit.rcon_password, `kit givetoplayer "${kit.name}" "${gamertag}"`);
        } catch (e) {
            return res.status(500).json({ error: "RCON connection failed — server may be offline." });
        }

        // Set cooldown
        const expiresAt = new Date(Date.now() + kit.cooldown_minutes * 60 * 1000);
        await pool.query(
            `INSERT INTO web_kit_cooldowns (discord_id, kit_id, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (discord_id, kit_id) DO UPDATE SET expires_at = $3`,
            [req.user.id, kitId, expiresAt]
        );

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `🎒 **Kit Claimed** (Solarix)\n` +
            `📦 Kit: **${kit.name}**\n` +
            `👤 Discord: <@${req.user.id}>\n` +
            `🎮 Gamertag: **${gamertag}**\n` +
            `🖥️ Server: ${kit.server_name || "N/A"}\n` +
            `🕐 Time: ${ts}`
        );

        res.json({ ok: true, expiresAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RCON helper ───────────────────────────────────────────────────────────────
function sendRconCommand(host, port, password, command) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${host}:${port}/${password}`);
        let done = false;
        const timeout = setTimeout(() => {
            if (!done) { done = true; ws.terminate(); reject(new Error("RCON timeout")); }
        }, 8000);
        ws.on("open", () => {
            ws.send(JSON.stringify({ Identifier: 1, Message: command, Name: "Solarix" }));
        });
        ws.on("message", () => {
            if (!done) { done = true; clearTimeout(timeout); ws.close(); resolve(); }
        });
        ws.on("error", e => {
            if (!done) { done = true; clearTimeout(timeout); reject(e); }
        });
    });
}

// ── Admin: Game Servers ───────────────────────────────────────────────────────
app.get("/api/admin/game-servers", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT id, name, rcon_host, rcon_port, rcon_password, sort_order FROM web_game_servers ORDER BY sort_order, id");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/game-servers", checkAdminJson, async (req, res) => {
    const servers = req.body;
    if (!Array.isArray(servers)) return res.status(400).json({ error: "Expected array" });
    try {
        await pool.query("DELETE FROM web_game_servers");
        for (let i = 0; i < servers.length; i++) {
            const s = servers[i];
            if (!s.name || !s.rcon_host) continue;
            if (s.id) {
                await pool.query(
                    "INSERT INTO web_game_servers (id, name, rcon_host, rcon_port, rcon_password, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
                    [s.id, s.name, s.rcon_host, parseInt(s.rcon_port) || 28016, s.rcon_password || "", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO web_game_servers (name, rcon_host, rcon_port, rcon_password, sort_order) VALUES ($1,$2,$3,$4,$5)",
                    [s.name, s.rcon_host, parseInt(s.rcon_port) || 28016, s.rcon_password || "", i]
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

// ── Debug: show what's on the volume (admin only) ────────────────────────────
app.get("/api/debug/volume", checkAdminJson, (req, res) => {
    const fs = require("fs");
    const botPath = process.env.BOT_DB_PATH || "(not set)";
    const dir = require("path").dirname(botPath);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { files = [`ERROR reading ${dir}: ${e.message}`]; }
    const exists = botPath !== "(not set)" && fs.existsSync(botPath);
    res.json({ BOT_DB_PATH: botPath, dir, dir_contents: files, file_exists: exists });
});

// ── /link → redirect to kits (where gamertag linking lives) ──────────────────
app.get("/link", (req, res) => res.redirect("/kits"));

// ── /clans → dedicated clans page ────────────────────────────────────────────
app.get("/clans", (req, res) => res.sendFile(path.join(__dirname, "clans.html")));

// ── Bot sync: receive clan + linked account data ──────────────────────────────
app.post("/api/sync/clans", express.json(), async (req, res) => {
    const token = process.env.SYNC_TOKEN || "";
    if (!token || req.headers["x-sync-token"] !== token) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const { clans = [], members = [], stats = [], invite_codes = [], linked_accounts = [] } = req.body;
    try {
        await pool.query("DELETE FROM clan_members_mirror");
        await pool.query("DELETE FROM clans_mirror");
        await pool.query("DELETE FROM clan_stats_mirror");
        await pool.query("DELETE FROM clan_invite_codes_mirror");

        for (const c of clans) {
            await pool.query(
                `INSERT INTO clans_mirror (id, name, clantag, color, description, owner_id, created_at, guild_id, server_id, owner_discord_name, image_url)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT (id) DO UPDATE SET name=$2, clantag=$3, color=$4, description=$5, owner_id=$6, created_at=$7, guild_id=$8, server_id=$9, owner_discord_name=$10, image_url=$11`,
                [c.id, c.name, c.clantag || null, c.color || null, c.description || null,
                 String(c.owner_id || ""), c.created_at || null, String(c.guild_id || ""),
                 String(c.server_id || ""), c.owner_discord_name || null, c.image_url || null]
            );
        }
        for (const m of members) {
            await pool.query(
                "INSERT INTO clan_members_mirror (clan_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
                [m.clan_id, String(m.user_id)]
            );
        }
        for (const s of stats) {
            await pool.query(
                `INSERT INTO clan_stats_mirror (user_id, gamertag, kills, deaths)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (user_id) DO UPDATE SET gamertag=$2, kills=$3, deaths=$4`,
                [String(s.user_id), s.gamertag || null, s.kills || 0, s.deaths || 0]
            );
        }
        for (const ic of invite_codes) {
            await pool.query(
                `INSERT INTO clan_invite_codes_mirror (code, clan_id, expires_at, max_uses, uses)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (code) DO UPDATE SET clan_id=$2, expires_at=$3, max_uses=$4`,
                [ic.code, ic.clan_id, ic.expires_at || null, ic.max_uses || null, ic.uses || 0]
            );
        }
        // Sync linked accounts (bot → Postgres mirror)
        for (const la of linked_accounts) {
            await pool.query(
                `INSERT INTO linked_accounts_mirror (discord_user_id, account_name)
                 VALUES ($1,$2)
                 ON CONFLICT (discord_user_id) DO UPDATE SET account_name=$2`,
                [String(la.discord_user_id), la.account_name]
            );
            // Also keep web_player_links up to date
            await pool.query(
                `INSERT INTO web_player_links (discord_id, gamertag, updated_at)
                 VALUES ($1,$2,NOW())
                 ON CONFLICT (discord_id) DO UPDATE SET gamertag=$2, updated_at=NOW()`,
                [String(la.discord_user_id), la.account_name]
            );
        }
        res.json({ ok: true, clans: clans.length, members: members.length, stats: stats.length, linked: linked_accounts.length });
    } catch (e) {
        console.error("sync/clans error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── My clan (logged-in user) ──────────────────────────────────────────────────
app.get("/api/public/clans/me", async (req, res) => {

    try {

        const { rows } = await pool.query(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.owner_discord_name,
       ic.code AS clan_code,
                COUNT(cm2.user_id)::int AS member_count
            FROM clan_members_mirror cm
            JOIN clans_mirror c 
                ON c.id = cm.clan_id
            LEFT JOIN clan_members_mirror cm2 
                ON cm2.clan_id = c.id
            WHERE cm.user_id=$1
            GROUP BY c.id
        `,[String(req.user.id)]);


        if(!rows[0]){
            return res.json({
                loggedIn:true,
                clan:null
            });
        }


        const clan = rows[0];

        clan.is_owner =
            String(clan.owner_id) === String(req.user.id);


        res.json({
            loggedIn:true,
            clan:clan
        });


    } catch(e){
        res.status(500).json({
            error:e.message
        });
    }
});
    if (!req.user) return res.json({ loggedIn: false, clan: null });
    try {
        const { rows } = await pool.query(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.owner_discord_name,
                   COUNT(DISTINCT cm2.user_id)::int AS member_count
            FROM clan_members_mirror cm
            JOIN clans_mirror c ON c.id = cm.clan_id
            LEFT JOIN clan_members_mirror cm2 ON cm2.clan_id = c.id
            WHERE cm.user_id = $1
            GROUP BY c.id
            LIMIT 1
        `, [String(req.user.id)]);
        if (!rows[0]) return res.json({ loggedIn: true, clan: null });
        const clan = rows[0];
        const isOwner = String(clan.owner_id) === String(req.user.id);
        return res.json({ loggedIn: true, clan: { ...clan, is_owner: isOwner } });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── Join clan with invite code ────────────────────────────────────────────────
app.post("/api/clans/join", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: "Invite code required" });
    try {
        // Already in a clan?
        const { rows: existing } = await pool.query(
            "SELECT clan_id FROM clan_members_mirror WHERE user_id=$1 LIMIT 1",
            [String(req.user.id)]
        );
        if (existing[0]) return res.status(400).json({ error: "You are already in a clan. Leave your current clan first via Discord." });

        // Validate code
        const now = Math.floor(Date.now() / 1000);
        const { rows: codes } = await pool.query(
            `SELECT * FROM clan_invite_codes_mirror WHERE code=$1
             AND (expires_at IS NULL OR expires_at > $2)
             AND (max_uses IS NULL OR uses < max_uses)`,
            [code.trim().toUpperCase(), now]
        );
        if (!codes[0]) return res.status(404).json({ error: "Invalid or expired invite code. Ask the clan owner for a new one." });

        const invite = codes[0];

        // Add to clan_members_mirror
        await pool.query(
            "INSERT INTO clan_members_mirror (clan_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            [invite.clan_id, String(req.user.id)]
        );
        // Increment uses
        await pool.query("UPDATE clan_invite_codes_mirror SET uses=uses+1 WHERE code=$1", [code.trim().toUpperCase()]);
        // Store web join request for bot to assign Discord role
        await pool.query(
            `INSERT INTO web_join_requests (discord_id, clan_id, code, created_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT (discord_id) DO UPDATE SET clan_id=$2, code=$3, created_at=NOW()`,
            [String(req.user.id), invite.clan_id, code.trim().toUpperCase()]
        );

        const { rows: clanRows } = await pool.query("SELECT name FROM clans_mirror WHERE id=$1", [invite.clan_id]);
        return res.json({ ok: true, clanName: clanRows[0]?.name || "Unknown" });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});
app.post("/api/clans/disband", async(req,res)=>{

if(!req.user)
return res.status(401).json({error:"Not logged in"});


try{

const {rows}=await pool.query(
"SELECT clan_id FROM clan_members_mirror WHERE user_id=$1",
[String(req.user.id)]
);


if(!rows[0])
return res.status(404).json({error:"No clan"});


const {rows:clan}=await pool.query(
"SELECT owner_id FROM clans_mirror WHERE id=$1",
[rows[0].clan_id]
);


if(String(clan[0].owner_id)!==String(req.user.id))
return res.status(403).json({error:"Not owner"});


await pool.query(
"DELETE FROM clan_members_mirror WHERE clan_id=$1",
[rows[0].clan_id]
);


await pool.query(
"DELETE FROM clans_mirror WHERE id=$1",
[rows[0].clan_id]
);


res.json({ok:true});


}catch(e){
res.status(500).json({error:e.message});
}

});

// ── Bot SQLite helper — opens fresh each request so startup-time file absence is fine ──
function openBotDb() {
    const p = process.env.BOT_DB_PATH || "";
    if (!p) return null;
    try {
        const { DatabaseSync } = require("node:sqlite");
        return new DatabaseSync(p, { readOnly: true });
    } catch (e) {
        console.warn("⚠️  openBotDb failed:", e.message);
        return null;
    }
}

// ── Public: Clans ─────────────────────────────────────────────────────────────
// Reads from Postgres mirror (populated by bot via /api/sync/clans).
// Falls back to bot SQLite if mirror is empty and BOT_DB_PATH is set.
app.get("/api/public/clans/me", async (req, res) => {
    if (!req.user) {
        return res.json({
            loggedIn:false,
            clan:null
        });
    }

    try {

        const { rows } = await pool.query(`
            SELECT 
                c.id,
                c.name,
                c.clantag,
                c.color,
                c.description,
                c.owner_id,
                c.owner_discord_name,
                COUNT(cm2.user_id)::int AS member_count
           FROM clan_members_mirror cm
JOIN clans_mirror c ON c.id = cm.clan_id
LEFT JOIN clan_invite_codes_mirror ic ON ic.clan_id = c.id
            LEFT JOIN clan_members_mirror cm2 
                ON cm2.clan_id = c.id
            WHERE cm.user_id=$1
            GROUP BY c.id
        `,[String(req.user.id)]);


        if(!rows[0]){
            return res.json({
                loggedIn:true,
                clan:null
            });
        }


        const clan = rows[0];

        clan.is_owner =
            String(clan.owner_id) === String(req.user.id);


        res.json({
            loggedIn:true,
            clan:clan
        });


    } catch(e){
        res.status(500).json({
            error:e.message
        });
    }
});
    try {
        const { rows: clans } = await pool.query(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.created_at,
                   c.owner_discord_name, c.image_url,
                   COUNT(DISTINCT cm.user_id)::int AS member_count
            FROM clans_mirror c
            LEFT JOIN clan_members_mirror cm ON cm.clan_id = c.id
            GROUP BY c.id
            ORDER BY member_count DESC, c.created_at DESC NULLS LAST
            LIMIT 100
        `);

        if (clans.length > 0) {
            const enriched = await Promise.all(clans.map(async c => {
                // Owner gamertag from web_player_links
                let owner_gamertag = null;
                try {
                    const { rows } = await pool.query(
                        "SELECT gamertag FROM web_player_links WHERE discord_id=$1 LIMIT 1",
                        [String(c.owner_id)]
                    );
                    owner_gamertag = rows[0]?.gamertag || null;
                } catch {}

                // Total kills for clan
                let total_kills = 0;
                try {
                    const { rows } = await pool.query(`
                        SELECT COALESCE(SUM(s.kills),0)::int AS k
                        FROM clan_stats_mirror s
                        JOIN clan_members_mirror cm ON cm.user_id=s.user_id
                        WHERE cm.clan_id=$1
                    `, [c.id]);
                    total_kills = rows[0]?.k || 0;
                } catch {}

                return { ...c, owner_gamertag, total_kills };
            }));
            return res.json(enriched);
        }
    } catch (e) {
        console.warn("clans Postgres query failed:", e.message);
    }

    // Fallback: bot SQLite (local dev / same-machine setups)
    const db = openBotDb();
    if (!db) return res.json([]);
    try {
        const clans = db.prepare(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.created_at,
                   COUNT(DISTINCT cm.user_id) as member_count
            FROM clans c
            LEFT JOIN clan_members cm ON cm.clan_id = c.id
            GROUP BY c.id
            ORDER BY member_count DESC, c.created_at DESC
            LIMIT 50
        `).all();
        const enriched = clans.map(c => {
            let owner_gamertag = null;
            try {
                const row = db.prepare(
                    "SELECT account_name FROM linked_accounts WHERE CAST(discord_user_id AS TEXT)=? LIMIT 1"
                ).get(String(c.owner_id));
                owner_gamertag = row ? row.account_name : null;
            } catch {}
            let total_kills = 0;
            try {
                const ks = db.prepare(
                    "SELECT COALESCE(SUM(cps.kills),0) as k FROM clan_player_stats cps JOIN clan_members cm ON CAST(cm.user_id AS TEXT)=CAST(cps.user_id AS TEXT) WHERE cm.clan_id=?"
                ).get(c.id);
                total_kills = ks ? ks.k : 0;
            } catch {}
            return { ...c, owner_gamertag, total_kills };
        });
        db.close();
        res.json(enriched);
    } catch (e) {
        try { db.close(); } catch {}
        console.error("clans SQLite fallback error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Public: Leaderboard ───────────────────────────────────────────────────────
// Reads from Postgres mirror first, falls back to bot SQLite.
app.get("/api/public/leaderboard", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.user_id, s.gamertag, s.kills, s.deaths,
                   CASE WHEN s.deaths = 0 THEN s.kills::float
                        ELSE ROUND(s.kills::numeric / s.deaths, 2) END AS kd,
                   c.name AS clan_name, c.clantag AS clan_tag, c.color AS clan_color
            FROM clan_stats_mirror s
            LEFT JOIN clan_members_mirror cm ON cm.user_id = s.user_id
            LEFT JOIN clans_mirror c ON c.id = cm.clan_id
            WHERE s.kills > 0 OR s.deaths > 0
            ORDER BY s.kills DESC
            LIMIT 50
        `);
        if (rows.length > 0) return res.json(rows);
    } catch (e) {
        console.warn("leaderboard Postgres query failed:", e.message);
    }

    // Fallback: bot SQLite
    const db = openBotDb();
    if (!db) return res.json([]);
    try {
        const rows = db.prepare(`
            SELECT cps.user_id, cps.gamertag, cps.kills, cps.deaths,
                   CASE WHEN cps.deaths = 0 THEN CAST(cps.kills AS FLOAT)
                        ELSE ROUND(CAST(cps.kills AS FLOAT) / cps.deaths, 2) END as kd
            FROM clan_player_stats cps
            WHERE cps.kills > 0 OR cps.deaths > 0
            GROUP BY cps.user_id
            ORDER BY cps.kills DESC
            LIMIT 50
        `).all();
        const enriched = rows.map(p => {
            let clan_name = null, clan_tag = null, clan_color = null;
            try {
                const cm = db.prepare(
                    "SELECT c.name, c.clantag, c.color FROM clan_members cm JOIN clans c ON c.id=cm.clan_id WHERE CAST(cm.user_id AS TEXT)=? LIMIT 1"
                ).get(String(p.user_id));
                if (cm) { clan_name = cm.name; clan_tag = cm.clantag; clan_color = cm.color; }
            } catch {}
            return { ...p, clan_name, clan_tag, clan_color };
        });
        db.close();
        res.json(enriched);
    } catch (e) {
        try { db.close(); } catch {}
        console.error("leaderboard SQLite fallback error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

setupDB()
    .then(() => {
        app.listen(PORT, () => console.log(`Solarix server running on port ${PORT}`));
    })
    .catch(err => {
        console.error("DB setup failed:", err.message);
        process.exit(1);
    });
