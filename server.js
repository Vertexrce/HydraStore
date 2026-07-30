require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");
const { Pool } = require("pg");
const https = require("https");
// ── Helcim helpers ────────────────────────────────────────────────────────────
async function helcimRequest(path, body) {
    const apiToken = process.env.HELCIM_API_TOKEN;
    if (!apiToken) throw new Error("HELCIM_API_TOKEN is not set in environment variables.");
    const resp = await fetch(`https://api.helcim.com/v2${path}`, {
        method: "POST",
        headers: { "api-token": apiToken, "Content-Type": "application/json", "accept": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : `Helcim error ${resp.status}`);
    return data;
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

// ── Helcim webhook ────────────────────────────────────────────────────────────
app.post("/helcim-webhook", express.json(), async (req, res) => {
    try {
        const tx = req.body;
        // Helcim sends transaction objects; only handle approved purchases
        if (!tx || tx.status !== "APPROVED") return res.json({ received: true });

        const meta = tx.customerCode ? {} : (tx.comments ? (() => { try { return JSON.parse(tx.comments); } catch { return {}; } })() : {});
        const itemId   = meta.item_id   || null;
        const itemName = meta.item_name || tx.invoiceNumber || "Store item";
        const itemPrice = tx.amount ? `$${parseFloat(tx.amount).toFixed(2)}` : (meta.item_price || "");
        const roleId   = meta.role_id   || "";
        const zipUrl   = meta.zip_url   || "";
        const discordUserId = meta.discord_user_id || "";
        const customerEmail = tx.billingAddress?.email || "";

        try {
            await pool.query(
                "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                [Date.now(), itemId, itemName, itemPrice, discordUserId, "helcim", `Helcim — txn ${tx.transactionId || ""} — ${customerEmail}`]
            );
        } catch (e) {
            console.error("Failed to record Helcim purchase:", e.message);
        }

        let roleResult = null;
        if (roleId && discordUserId) {
            const guildId = await getSetting("discordGuildId");
            roleResult = await assignDiscordRole(guildId, discordUserId, roleId);
        }

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `✅ **Helcim Purchase Completed**\n` +
            `📦 Item: **${itemName}**\n` +
            `💷 Price: **${itemPrice}**\n` +
            `📧 Email: ${customerEmail}\n` +
            `👤 Discord: ${discordUserId ? `<@${discordUserId}>` : "Not linked"}\n` +
            `🎭 Role: ${roleResult?.ok ? `✅ Assigned` : roleResult ? `⚠️ ${roleResult.error}` : "ℹ️ No Discord ID"}\n` +
            `📁 File: ${zipUrl ? "✅ Download ready" : "ℹ️ No file attached"}\n` +
            `🕐 Time: ${ts}`
        );
    } catch (e) {
        console.error("Helcim webhook error:", e.message);
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

    // ── New tables for per-user kits, gem shop, and gem multipliers ──
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_kits (
            discord_id TEXT NOT NULL,
            kit_id INTEGER NOT NULL,
            given_by TEXT DEFAULT 'admin',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (discord_id, kit_id)
        );

        CREATE TABLE IF NOT EXISTS gem_shop_items (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            shortname TEXT NOT NULL,
            category TEXT DEFAULT 'Weapons',
            gem_cost INTEGER DEFAULT 10,
            server_id INTEGER,
            sort_order INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS gem_multipliers (
            discord_id TEXT PRIMARY KEY,
            multiplier NUMERIC(5,2) DEFAULT 1.0,
            reason TEXT DEFAULT '',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS gem_accrual_log (
            discord_id TEXT PRIMARY KEY,
            last_accrued_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    await pool.query(`ALTER TABLE web_kit_configs ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE gem_shop_items ADD COLUMN IF NOT EXISTS quantity_per_purchase INTEGER DEFAULT 1`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS casino_log (
            id BIGSERIAL PRIMARY KEY,
            discord_id TEXT NOT NULL,
            game TEXT NOT NULL,
            wager INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            payout INTEGER NOT NULL,
            net INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

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
                // RCON unreachable — server status_label says online so keep it online,
                // just show unknown player count rather than marking the whole server offline
                return { id: s.id, online: true, players: null, maxPlayers: s.max_players || 100 };
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

// ── Helcim Checkout Token ─────────────────────────────────────────────────────
app.post("/api/create-helcim-token", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "Missing itemId" });
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [itemId]);
        if (!rows[0]) return res.status(404).json({ error: "Item not found" });
        const item = rows[0];

        const priceStr = String(item.price).replace(/[^0-9.]/g, "");
        const amount = parseFloat(priceStr);
        if (!amount || amount <= 0) return res.status(400).json({ error: "Item has no valid price" });

        // Embed metadata in the invoice comments so webhook can match the purchase
        const meta = JSON.stringify({
            item_id:          String(item.id),
            item_name:        item.name,
            item_price:       item.price,
            role_id:          item.role_id  || "",
            zip_url:          item.zip_url  || "",
            discord_user_id:  req.user.id   || ""
        });

        const data = await helcimRequest("/helcim-pay/initialize", {
            paymentType: "purchase",
            amount,
            currency: "CAD",
            comments: meta
        });

        res.json({ checkoutToken: data.checkoutToken, itemName: item.name, amount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Checkout route ────────────────────────────────────────────────────────────
app.get("/checkout/:id", (req, res) => res.sendFile(path.join(__dirname, "checkout.html")));

// Lightweight endpoint so checkout-success.html can show the zip download link
app.get("/api/checkout-info", async (req, res) => {
    // For Helcim the zip URL is passed as a query param from the success redirect
    const zipUrl = req.query.zip_url || "";
    res.json({ zipUrl });
});

// ── Admin: player links ───────────────────────────────────────────────────────
app.get("/api/admin/player-links", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT discord_id, gamertag, updated_at FROM web_player_links ORDER BY updated_at DESC LIMIT 200");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/player-links/:discordId", checkAdminJson, async (req, res) => {
    const { discordId } = req.params;
    if (!discordId) return res.status(400).json({ error: "Missing discordId" });
    try {
        await pool.query("DELETE FROM web_player_links WHERE discord_id = $1", [discordId]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: give kit to user's kits tab (not directly in-game) ────────────────
app.post("/api/admin/give-kit", checkAdminJson, async (req, res) => {
    const { player, kitId, kitName } = req.body;
    if (!player || (!kitId && !kitName)) return res.status(400).json({ error: "Missing player or kit" });

    try {
        // Resolve discord_id — player can be gamertag or Discord ID
        let discordId = null;
        let gamertag = null;
        const playerTrimmed = player.trim();

        if (/^\d{15,20}$/.test(playerTrimmed)) {
            // Looks like a Discord ID
            discordId = playerTrimmed;
            const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [discordId]);
            gamertag = rows[0]?.gamertag || null;
            if (!gamertag) {
                const botGt = await getBotLinkedGamertag(discordId);
                gamertag = botGt || null;
            }
        } else {
            // Treat as gamertag — look up discord ID from linked accounts
            const { rows } = await pool.query("SELECT discord_id FROM web_player_links WHERE LOWER(gamertag) = LOWER($1)", [playerTrimmed]);
            if (rows[0]) {
                discordId = rows[0].discord_id;
                gamertag = playerTrimmed;
            } else {
                return res.status(404).json({ error: `No linked Discord account found for gamertag "${playerTrimmed}". Ask them to link on the Kits page first.` });
            }
        }

        if (!discordId) return res.status(404).json({ error: "Could not resolve Discord ID for this player." });

        // Resolve kit ID by name if needed
        let resolvedKitId = kitId;
        let resolvedKitName = kitName;
        if (!resolvedKitId && kitName) {
            const { rows } = await pool.query("SELECT id, name FROM web_kit_configs WHERE name = $1 LIMIT 1", [kitName]);
            if (!rows[0]) return res.status(404).json({ error: `Kit "${kitName}" not found in kit configs.` });
            resolvedKitId = rows[0].id;
            resolvedKitName = rows[0].name;
        } else if (resolvedKitId) {
            const { rows } = await pool.query("SELECT name FROM web_kit_configs WHERE id = $1", [resolvedKitId]);
            resolvedKitName = rows[0]?.name || resolvedKitName;
        }

        // Add to user_kits (their kits tab)
        await pool.query(
            `INSERT INTO user_kits (discord_id, kit_id, given_by) VALUES ($1, $2, 'admin')
             ON CONFLICT (discord_id, kit_id) DO NOTHING`,
            [discordId, resolvedKitId]
        );

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `🎒 **Admin Kit Give** (Solarix)\n` +
            `📦 Kit: **${resolvedKitName}**\n` +
            `🎮 Player: **${gamertag || discordId}**\n` +
            `💬 Added to kits tab (player claims in-game themselves)\n` +
            `🕐 Time: ${ts}`
        );

        res.json({ ok: true, discordId, gamertag, kitName: resolvedKitName, addedToKitsTab: true });
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
        // Check if this gamertag is already linked to a DIFFERENT discord account
        const { rows: existing } = await pool.query(
            "SELECT discord_id FROM web_player_links WHERE LOWER(gamertag) = LOWER($1) AND discord_id != $2",
            [gamertag.trim(), req.user.id]
        );
        if (existing[0]) {
            return res.status(409).json({ error: "This username is already being used — try another one." });
        }
        await pool.query(
            `INSERT INTO web_player_links (discord_id, gamertag, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (discord_id) DO UPDATE SET gamertag = $2, updated_at = NOW()`,
            [req.user.id, gamertag.trim()]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kits: list kits for this user (only kits they own via user_kits) ──────────
app.get("/api/kits", async (req, res) => {
    try {
        if (!req.user) {
            return res.json({ loggedIn: false, gamertag: null, kits: [] });
        }

        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = linkRows[0]?.gamertag || null;

        // Get only kits this user owns (from user_kits) + their kit configs
        const { rows: userKitRows } = await pool.query(
            `SELECT k.*, s.name as server_name, s.rcon_host, s.rcon_port, s.rcon_password, uk.given_by
             FROM user_kits uk
             JOIN web_kit_configs k ON k.id = uk.kit_id
             LEFT JOIN web_game_servers s ON s.id = k.server_id
             WHERE uk.discord_id = $1
             ORDER BY k.sort_order, k.id`,
            [req.user.id]
        );

        // Check cooldowns
        const { rows: cooldownRows } = await pool.query(
            "SELECT kit_id, expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND expires_at > NOW()",
            [req.user.id]
        );
        const cooldownMap = {};
        cooldownRows.forEach(r => { cooldownMap[r.kit_id] = r.expires_at; });

        res.json({
            loggedIn: true,
            gamertag,
            kits: userKitRows.map(k => ({
                id: k.id, name: k.name, description: k.description,
                cooldownMinutes: k.cooldown_minutes,
                serverName: k.server_name || "Server",
                enabled: k.enabled === 1 || k.enabled === true,
                onCooldown: !!cooldownMap[k.id],
                expiresAt: cooldownMap[k.id] || null,
                givenBy: k.given_by || "admin"
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
        // Verify user owns this kit
        const { rows: ownerRows } = await pool.query(
            "SELECT 1 FROM user_kits WHERE discord_id = $1 AND kit_id = $2",
            [req.user.id, kitId]
        );
        if (!ownerRows[0]) return res.status(403).json({ error: "You don't own this kit." });

        const { rows } = await pool.query(
            `SELECT k.*, s.name as server_name, s.rcon_host, s.rcon_port, s.rcon_password
             FROM web_kit_configs k
             LEFT JOIN web_game_servers s ON s.id = k.server_id
             WHERE k.id = $1`,
            [kitId]
        );
        const kit = rows[0];
        if (!kit) return res.status(404).json({ error: "Kit not found." });
        if (!kit.enabled) return res.status(400).json({ error: "This kit is currently disabled." });

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
        ws.on("message", (data) => {
            if (!done) { done = true; clearTimeout(timeout); ws.close(); try { const parsed = JSON.parse(data.toString()); resolve(parsed.Message || data.toString()); } catch { resolve(data.toString()); } }
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

// ── Gems page ─────────────────────────────────────────────────────────────────
app.get("/gems", (req, res) => res.sendFile(path.join(__dirname, "gems.html")));

// ── Gems: user balance + earning rate ────────────────────────────────────────
app.get("/api/gems/me", async (req, res) => {
    if (!req.user) return res.json({ loggedIn: false, balance: 0, gemsPerHour: 10, multiplier: 1 });
    try {
        // Accrue any outstanding gems first
        await accrueGems(req.user.id);
        const { rows: cr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const balance = parseFloat(cr[0]?.balance || 0);
        const { rows: kitRows } = await pool.query(
            `SELECT k.id, k.name FROM user_kits uk
             JOIN web_kit_configs k ON k.id = uk.kit_id
             WHERE uk.discord_id = $1 ORDER BY k.sort_order, k.id`,
            [req.user.id]
        );
        const kitCount = kitRows.length;
        const { rows: mxRows } = await pool.query("SELECT multiplier FROM gem_multipliers WHERE discord_id = $1", [req.user.id]);
        const multiplier = parseFloat(mxRows[0]?.multiplier || 1);
        const baseRate = 10 + kitCount * 10;
        const gemsPerHour = Math.round(baseRate * multiplier);
        res.json({ loggedIn: true, balance, gemsPerHour, multiplier, kitCount, baseRate, kits: kitRows.map(k => ({ id: k.id, name: k.name })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gem Shop: list items ──────────────────────────────────────────────────────
app.get("/api/gem-shop", async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, name, shortname, category, gem_cost, quantity_per_purchase, sort_order FROM gem_shop_items WHERE enabled = 1 ORDER BY sort_order, id"
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gem Shop: buy item (deduct gems, send via RCON immediately) ───────────────
app.post("/api/gem-shop/buy", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { itemId, quantity } = req.body;
    if (!itemId || !quantity || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Invalid itemId or quantity" });

    try {
        const { rows: itemRows } = await pool.query("SELECT * FROM gem_shop_items WHERE id = $1 AND enabled = 1", [itemId]);
        const item = itemRows[0];
        if (!item) return res.status(404).json({ error: "Item not found." });

        const totalCost = item.gem_cost * quantity;

        // Check balance
        const { rows: cr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const balance = parseFloat(cr[0]?.balance || 0);
        if (balance < totalCost) return res.status(400).json({ error: `Not enough gems. Need ${totalCost}, you have ${Math.floor(balance)}.` });

        // Get gamertag
        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = linkRows[0]?.gamertag;
        if (!gamertag) return res.status(400).json({ error: "Link your in-game name first on the Kits page." });

        // Get server
        let rconHost, rconPort, rconPassword;
        if (item.server_id) {
            const { rows: srv } = await pool.query("SELECT * FROM web_game_servers WHERE id = $1", [item.server_id]);
            if (!srv[0]) return res.status(400).json({ error: "Server not configured for this item." });
            rconHost = srv[0].rcon_host; rconPort = srv[0].rcon_port; rconPassword = srv[0].rcon_password;
        } else {
            // Use first server
            const { rows: srv } = await pool.query("SELECT * FROM web_game_servers ORDER BY sort_order, id LIMIT 1");
            if (!srv[0]) return res.status(400).json({ error: "No game server configured." });
            rconHost = srv[0].rcon_host; rconPort = srv[0].rcon_port; rconPassword = srv[0].rcon_password;
        }

        // Send RCON — give item (quantity_per_purchase sets how many per unit)
        const qtyPerPurchase = item.quantity_per_purchase || 1;
        await sendRconCommand(rconHost, rconPort, rconPassword, `inventory.giveto "${gamertag}" "${item.shortname}" ${qtyPerPurchase * quantity}`);

        // Deduct gems
        await pool.query("UPDATE store_credits SET balance = balance - $1, updated_at = NOW() WHERE discord_id = $2", [totalCost, req.user.id]);
        await pool.query("INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1,$2,$3,'spend')", [req.user.id, -totalCost, `Gem shop: ${item.name} x${quantity}`]);

        const { rows: newCr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const newBalance = parseFloat(newCr[0]?.balance || 0);

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(`💎 **Gem Shop Purchase** (Solarix)\n📦 Item: **${item.name}** x${quantity}\n💎 Cost: **${totalCost} gems**\n👤 Discord: <@${req.user.id}>\n🎮 Gamertag: **${gamertag}**\n💰 Remaining: **${Math.floor(newBalance)} gems**\n🕐 Time: ${ts}`);

        res.json({ ok: true, newBalance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Gem Shop management ────────────────────────────────────────────────
app.get("/api/admin/gem-shop", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT gs.id, gs.name, gs.shortname, gs.category, gs.gem_cost, gs.quantity_per_purchase, gs.server_id, gs.sort_order, gs.enabled, s.name as server_name FROM gem_shop_items gs LEFT JOIN web_game_servers s ON s.id = gs.server_id ORDER BY gs.sort_order, gs.id");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/gem-shop", checkAdminJson, async (req, res) => {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Expected array" });
    try {
        await pool.query("DELETE FROM gem_shop_items");
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (!it.name || !it.shortname) continue;
            const qpp = parseInt(it.quantity_per_purchase) || 1;
            if (it.id) {
                await pool.query("INSERT INTO gem_shop_items (id, name, shortname, category, gem_cost, quantity_per_purchase, server_id, sort_order, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                    [it.id, it.name, it.shortname, it.category||"Weapons", parseInt(it.gem_cost)||10, qpp, it.server_id||null, i, it.enabled===false?0:1]);
            } else {
                await pool.query("INSERT INTO gem_shop_items (name, shortname, category, gem_cost, quantity_per_purchase, server_id, sort_order, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                    [it.name, it.shortname, it.category||"Weapons", parseInt(it.gem_cost)||10, qpp, it.server_id||null, i, it.enabled===false?0:1]);
            }
        }
        try { await pool.query("SELECT setval('gem_shop_items_id_seq', COALESCE((SELECT MAX(id) FROM gem_shop_items), 1))"); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Give item via RCON to player by gamertag/discord ID ────────────────
app.post("/api/admin/give-item", checkAdminJson, async (req, res) => {
    const { player, shortname, itemName, quantity, serverId } = req.body;
    if (!player || !shortname || !serverId) return res.status(400).json({ error: "Missing player, shortname, or serverId" });
    const qty = parseInt(quantity) || 1;
    try {
        let gamertag = player.trim();
        if (/^\d{15,20}$/.test(gamertag)) {
            const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [gamertag]);
            if (rows[0]) gamertag = rows[0].gamertag;
            else {
                const bg = await getBotLinkedGamertag(gamertag);
                if (bg) gamertag = bg;
                else return res.status(404).json({ error: `No linked gamertag for Discord ID ${player}` });
            }
        }
        const { rows: srv } = await pool.query("SELECT * FROM web_game_servers WHERE id = $1", [serverId]);
        if (!srv[0]) return res.status(404).json({ error: "Server not found" });
        await sendRconCommand(srv[0].rcon_host, srv[0].rcon_port, srv[0].rcon_password, `inventory.giveto "${gamertag}" "${shortname}" ${qty}`);
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(`⚡ **Admin Give Item** (Solarix)\n📦 Item: **${itemName||shortname}** x${qty}\n🎮 Gamertag: **${gamertag}**\n🖥️ Server: ${srv[0].name}\n🕐 Time: ${ts}`);
        res.json({ ok: true, gamertag });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Give gems to user by gamertag or Discord ID ───────────────────────
app.post("/api/admin/give-gems-by-gamertag", checkAdminJson, async (req, res) => {
    const { player, amount, reason } = req.body;
    if (!player || !amount) return res.status(400).json({ error: "Missing player or amount" });
    const playerTrimmed = player.trim();
    try {
        let discordId = null;
        let gamertag = null;
        if (/^\d{15,20}$/.test(playerTrimmed)) {
            discordId = playerTrimmed;
            const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [discordId]);
            gamertag = rows[0]?.gamertag || discordId;
        } else {
            const { rows } = await pool.query("SELECT discord_id FROM web_player_links WHERE LOWER(gamertag) = LOWER($1)", [playerTrimmed]);
            if (!rows[0]) return res.status(404).json({ error: `No linked account for gamertag "${playerTrimmed}"` });
            discordId = rows[0].discord_id;
            gamertag = playerTrimmed;
        }
        const numAmount = parseFloat(amount);
        await pool.query(
            `INSERT INTO store_credits (discord_id, balance, updated_at) VALUES ($1, GREATEST(0, $2), NOW())
             ON CONFLICT (discord_id) DO UPDATE SET balance = GREATEST(0, store_credits.balance + $2), updated_at = NOW()`,
            [discordId, numAmount]
        );
        await pool.query("INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1,$2,$3,'grant')", [discordId, numAmount, reason || "Admin grant"]);
        const { rows: nr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [discordId]);
        const newBalance = parseFloat(nr[0]?.balance || 0);
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(`💎 **Admin Give Gems** (Solarix)\n💎 Amount: **${numAmount > 0 ? '+' : ''}${numAmount}**\n🎮 Player: **${gamertag}**\n📝 Reason: ${reason || "Admin grant"}\n💰 New Balance: **${Math.floor(newBalance)}**\n🕐 Time: ${ts}`);
        res.json({ ok: true, discordId, gamertag, newBalance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Set gem multiplier for user ────────────────────────────────────────
app.post("/api/admin/gem-multiplier", checkAdminJson, async (req, res) => {
    const { player, multiplier, reason } = req.body;
    if (!player || !multiplier) return res.status(400).json({ error: "Missing player or multiplier" });
    const playerTrimmed = player.trim();
    try {
        let discordId = null;
        let gamertag = null;
        if (/^\d{15,20}$/.test(playerTrimmed)) {
            discordId = playerTrimmed;
            const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [discordId]);
            gamertag = rows[0]?.gamertag || discordId;
        } else {
            const { rows } = await pool.query("SELECT discord_id FROM web_player_links WHERE LOWER(gamertag) = LOWER($1)", [playerTrimmed]);
            if (!rows[0]) return res.status(404).json({ error: `No linked account for "${playerTrimmed}"` });
            discordId = rows[0].discord_id;
            gamertag = playerTrimmed;
        }
        await pool.query(
            `INSERT INTO gem_multipliers (discord_id, multiplier, reason, updated_at) VALUES ($1,$2,$3,NOW())
             ON CONFLICT (discord_id) DO UPDATE SET multiplier=$2, reason=$3, updated_at=NOW()`,
            [discordId, parseFloat(multiplier), reason || ""]
        );
        res.json({ ok: true, gamertag, multiplier: parseFloat(multiplier) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Disable all kits ───────────────────────────────────────────────────
app.post("/api/admin/disable-all-kits", checkAdminJson, async (req, res) => {
    try {
        await pool.query("UPDATE web_kit_configs SET enabled = 0");
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Enable all kits ────────────────────────────────────────────────────
app.post("/api/admin/enable-all-kits", checkAdminJson, async (req, res) => {
    try {
        await pool.query("UPDATE web_kit_configs SET enabled = 1");
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        // Only wipe+replace codes if the bot actually sent them
        if (invite_codes.length > 0) {
            await pool.query("DELETE FROM clan_invite_codes_mirror");
            for (const ic of invite_codes) {
                await pool.query(
                    `INSERT INTO clan_invite_codes_mirror (code, clan_id, expires_at, max_uses, uses)
                     VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (code) DO UPDATE SET clan_id=$2, expires_at=$3, max_uses=$4, uses=$5`,
                    [ic.code, ic.clan_id, ic.expires_at || null, ic.max_uses || null, ic.uses || 0]
                );
            }
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

// ── Bot sync: push just invite codes (lightweight, no full wipe) ─────────────
// Bot calls this whenever a code is created or deleted for a clan.
// Body: { clan_id, codes: [{ code, expires_at, max_uses, uses }] }
//   OR: { clan_id, code, action: "delete" }  ← to remove a single code
app.post("/api/sync/clan-codes", express.json(), async (req, res) => {
    const token = process.env.SYNC_TOKEN || "";
    if (!token || req.headers["x-sync-token"] !== token)
        return res.status(401).json({ error: "Unauthorized" });

    const { clan_id, codes, code: singleCode, action } = req.body;
    if (!clan_id) return res.status(400).json({ error: "clan_id required" });

    try {
        // Delete a single code
        if (action === "delete" && singleCode) {
            await pool.query("DELETE FROM clan_invite_codes_mirror WHERE code=$1", [singleCode]);
            return res.json({ ok: true, deleted: singleCode });
        }

        // Upsert a full list of codes for this clan
        if (Array.isArray(codes)) {
            // Replace only this clan's codes
            await pool.query("DELETE FROM clan_invite_codes_mirror WHERE clan_id=$1", [clan_id]);
            for (const ic of codes) {
                if (!ic.code) continue;
                await pool.query(
                    `INSERT INTO clan_invite_codes_mirror (code, clan_id, expires_at, max_uses, uses)
                     VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (code) DO UPDATE SET clan_id=$2, expires_at=$3, max_uses=$4, uses=$5`,
                    [ic.code, clan_id, ic.expires_at || null, ic.max_uses || null, ic.uses || 0]
                );
            }
            return res.json({ ok: true, upserted: codes.length });
        }

        // Upsert a single new code
        if (singleCode) {
            const { expires_at, max_uses, uses = 0 } = req.body;
            await pool.query(
                `INSERT INTO clan_invite_codes_mirror (code, clan_id, expires_at, max_uses, uses)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (code) DO UPDATE SET clan_id=$2, expires_at=$3, max_uses=$4, uses=$5`,
                [singleCode, clan_id, expires_at || null, max_uses || null, uses]
            );
            return res.json({ ok: true, upserted: singleCode });
        }

        res.status(400).json({ error: "Provide codes array, or code + action" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── My clan (logged-in user) ──────────────────────────────────────────────────
app.get("/api/public/clans/me", async (req, res) => {
    if (!req.user) return res.json({ loggedIn: false, clan: null });
    const uid = String(req.user.id);
    try {
        // First: check if user is a member in clan_members_mirror
        const { rows } = await pool.query(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.owner_discord_name, c.image_url,
                   COUNT(DISTINCT cm2.user_id)::int AS member_count
            FROM clan_members_mirror cm
            JOIN clans_mirror c ON c.id = cm.clan_id
            LEFT JOIN clan_members_mirror cm2 ON cm2.clan_id = c.id
            WHERE cm.user_id = $1
            GROUP BY c.id
            LIMIT 1
        `, [uid]);
        if (rows[0]) {
            const clan = rows[0];
            const username = (req.user.username || "").toLowerCase();
            const isOwner = String(clan.owner_id) === uid ||
                            (username && (clan.owner_discord_name || "").toLowerCase() === username);
            return res.json({ loggedIn: true, clan: { ...clan, is_owner: isOwner } });
        }

        // Second: check if user is the owner by numeric Discord ID
        const { rows: ownedRows } = await pool.query(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.owner_discord_name, c.image_url,
                   COUNT(DISTINCT cm.user_id)::int AS member_count
            FROM clans_mirror c
            LEFT JOIN clan_members_mirror cm ON cm.clan_id = c.id
            WHERE c.owner_id = $1
            GROUP BY c.id
            LIMIT 1
        `, [uid]);
        if (ownedRows[0]) {
            const clan = ownedRows[0];
            return res.json({ loggedIn: true, clan: { ...clan, is_owner: true } });
        }

        // Third: match by Discord username stored in owner_discord_name
        // (some bots store username instead of snowflake ID in owner_id)
        const username = req.user.username || "";
        if (username) {
            const { rows: namedRows } = await pool.query(`
                SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id, c.owner_discord_name, c.image_url,
                       COUNT(DISTINCT cm.user_id)::int AS member_count
                FROM clans_mirror c
                LEFT JOIN clan_members_mirror cm ON cm.clan_id = c.id
                WHERE LOWER(c.owner_discord_name) = LOWER($1)
                GROUP BY c.id
                LIMIT 1
            `, [username]);
            if (namedRows[0]) {
                const clan = namedRows[0];
                return res.json({ loggedIn: true, clan: { ...clan, is_owner: true } });
            }
        }
    } catch (e) {
        console.warn("clans/me Postgres query failed:", e.message);
    }

    // Fallback: bot SQLite (local dev / same-machine setups)
    const db = openBotDb();
    if (!db) return res.json({ loggedIn: true, clan: null });
    try {
        // Check member table first, then owner
        let row = db.prepare(`
            SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id,
                   COUNT(DISTINCT cm2.user_id) as member_count
            FROM clan_members cm
            JOIN clans c ON c.id = cm.clan_id
            LEFT JOIN clan_members cm2 ON cm2.clan_id = c.id
            WHERE CAST(cm.user_id AS TEXT) = ?
            GROUP BY c.id LIMIT 1
        `).get(uid);
        if (!row) {
            row = db.prepare(`
                SELECT c.id, c.name, c.clantag, c.color, c.description, c.owner_id,
                       COUNT(DISTINCT cm.user_id) as member_count
                FROM clans c
                LEFT JOIN clan_members cm ON cm.clan_id = c.id
                WHERE CAST(c.owner_id AS TEXT) = ?
                GROUP BY c.id LIMIT 1
            `).get(uid);
        }
        db.close();
        if (!row) return res.json({ loggedIn: true, clan: null });
        const isOwner = String(row.owner_id) === uid;
        return res.json({ loggedIn: true, clan: { ...row, image_url: null, owner_discord_name: null, is_owner: isOwner } });
    } catch (e) {
        try { db.close(); } catch {}
        return res.json({ loggedIn: true, clan: null });
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
            `SELECT * FROM clan_invite_codes_mirror WHERE UPPER(code) = UPPER($1)
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
app.get("/api/public/clans", async (req, res) => {
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


// ── Clan Details: members, codes, kick, edit, disband ─────────────────────────

// GET /api/clans/:clanId/members — list members with gamertags
app.get("/api/clans/:clanId/members", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const clanId = parseInt(req.params.clanId);
    if (!clanId) return res.status(400).json({ error: "Invalid clan ID" });
    try {
        // Verify caller is in this clan OR is the owner (by ID or username)
        const uid = String(req.user.id);
        const uname = (req.user.username || "").toLowerCase();
        const { rows: membership } = await pool.query(
            "SELECT 1 FROM clan_members_mirror WHERE clan_id=$1 AND user_id=$2 LIMIT 1",
            [clanId, uid]
        );
        const { rows: ownership } = await pool.query(
            "SELECT 1 FROM clans_mirror WHERE id=$1 AND (owner_id=$2 OR LOWER(owner_discord_name)=$3) LIMIT 1",
            [clanId, uid, uname]
        );
        if (!membership[0] && !ownership[0]) return res.status(403).json({ error: "You are not in this clan" });

        // Fetch owner info for name fallback
        const { rows: clanInfo } = await pool.query(
            "SELECT owner_id, owner_discord_name FROM clans_mirror WHERE id=$1 LIMIT 1", [clanId]
        );
        const ownerInfo = clanInfo[0] || {};

        const { rows: members } = await pool.query(`
            SELECT cm.user_id,
                   COALESCE(cs.gamertag, wpl.gamertag) AS gamertag,
                   la.account_name
            FROM clan_members_mirror cm
            LEFT JOIN clan_stats_mirror cs ON cs.user_id = cm.user_id
            LEFT JOIN web_player_links wpl ON wpl.discord_id = cm.user_id
            LEFT JOIN linked_accounts_mirror la ON la.discord_user_id = cm.user_id
            WHERE cm.clan_id = $1
            ORDER BY cm.user_id
        `, [clanId]);

        // Enrich owner row with owner_discord_name when no gamertag available
        const enriched = members.map(m => {
            const isOwnerRow = String(m.user_id) === String(ownerInfo.owner_id);
            return {
                ...m,
                discord_name: isOwnerRow ? (ownerInfo.owner_discord_name || null) : null
            };
        });

        // Synthetic owner row if owner not in clan_members_mirror at all
        const ownerInList = enriched.some(m => String(m.user_id) === String(ownerInfo.owner_id));
        if (!ownerInList && ownerInfo.owner_id) {
            enriched.unshift({
                user_id: ownerInfo.owner_id,
                gamertag: null,
                account_name: null,
                discord_name: ownerInfo.owner_discord_name || null
            });
        }

        res.json({ members: enriched });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clans/:clanId/codes — invite codes (caller must be in clan)
app.get("/api/clans/:clanId/codes", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const clanId = parseInt(req.params.clanId);
    if (!clanId) return res.status(400).json({ error: "Invalid clan ID" });
    try {
        const uid = String(req.user.id);
        const uname = (req.user.username || "").toLowerCase();
        const { rows: membership } = await pool.query(
            "SELECT 1 FROM clan_members_mirror WHERE clan_id=$1 AND user_id=$2 LIMIT 1",
            [clanId, uid]
        );
        const { rows: ownership } = await pool.query(
            "SELECT 1 FROM clans_mirror WHERE id=$1 AND (owner_id=$2 OR LOWER(owner_discord_name)=$3) LIMIT 1",
            [clanId, uid, uname]
        );
        if (!membership[0] && !ownership[0]) return res.status(403).json({ error: "You are not in this clan" });

        const now = Math.floor(Date.now() / 1000);
        const { rows: codes } = await pool.query(
            `SELECT code, expires_at, max_uses, uses
             FROM clan_invite_codes_mirror
             WHERE clan_id=$1
             ORDER BY expires_at DESC NULLS LAST`,
            [clanId]
        );
        res.json({ codes });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clans/:clanId/kick — kick a member (owner only)
app.post("/api/clans/:clanId/kick", express.json(), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const clanId = parseInt(req.params.clanId);
    const { userId } = req.body;
    if (!clanId || !userId) return res.status(400).json({ error: "Missing fields" });
    try {
        const { rows: clan } = await pool.query(
            "SELECT owner_id, owner_discord_name FROM clans_mirror WHERE id=$1 LIMIT 1", [clanId]
        );
        if (!clan[0]) return res.status(404).json({ error: "Clan not found" });
        const isOwner = String(clan[0].owner_id) === String(req.user.id) ||
            (req.user.username && (clan[0].owner_discord_name || "").toLowerCase() === req.user.username.toLowerCase());
        if (!isOwner)
            return res.status(403).json({ error: "Only the clan owner can kick members" });
        if (String(userId) === String(req.user.id))
            return res.status(400).json({ error: "You cannot kick yourself" });

        await pool.query(
            "DELETE FROM clan_members_mirror WHERE clan_id=$1 AND user_id=$2",
            [clanId, String(userId)]
        );
        // Record kick request for bot to process
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS web_kick_requests (
                    id SERIAL PRIMARY KEY, clan_id INT, user_id TEXT,
                    kicked_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
                )`);
            await pool.query(
                "INSERT INTO web_kick_requests (clan_id, user_id, kicked_by) VALUES ($1,$2,$3)",
                [clanId, String(userId), String(req.user.id)]
            );
        } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clans/:clanId/edit — update description (owner only)
app.post("/api/clans/:clanId/edit", express.json(), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const clanId = parseInt(req.params.clanId);
    const { description } = req.body;
    if (!clanId) return res.status(400).json({ error: "Invalid clan ID" });
    try {
        const { rows: clan } = await pool.query(
            "SELECT owner_id, owner_discord_name FROM clans_mirror WHERE id=$1 LIMIT 1", [clanId]
        );
        if (!clan[0]) return res.status(404).json({ error: "Clan not found" });
        const isOwner = String(clan[0].owner_id) === String(req.user.id) ||
            (req.user.username && (clan[0].owner_discord_name || "").toLowerCase() === req.user.username.toLowerCase());
        if (!isOwner)
            return res.status(403).json({ error: "Only the clan owner can edit the clan" });

        await pool.query(
            "UPDATE clans_mirror SET description=$1 WHERE id=$2",
            [(description || "").slice(0, 200), clanId]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clans/:clanId/disband — disband clan (owner only)
app.post("/api/clans/:clanId/disband", express.json(), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const clanId = parseInt(req.params.clanId);
    if (!clanId) return res.status(400).json({ error: "Invalid clan ID" });
    try {
        const { rows: clan } = await pool.query(
            "SELECT owner_id, owner_discord_name FROM clans_mirror WHERE id=$1 LIMIT 1", [clanId]
        );
        if (!clan[0]) return res.status(404).json({ error: "Clan not found" });
        const isOwner = String(clan[0].owner_id) === String(req.user.id) ||
            (req.user.username && (clan[0].owner_discord_name || "").toLowerCase() === req.user.username.toLowerCase());
        if (!isOwner)
            return res.status(403).json({ error: "Only the clan owner can disband the clan" });

        await pool.query("DELETE FROM clan_members_mirror WHERE clan_id=$1", [clanId]);
        await pool.query("DELETE FROM clan_invite_codes_mirror WHERE clan_id=$1", [clanId]);
        await pool.query("DELETE FROM clans_mirror WHERE id=$1", [clanId]);
        // Record disband request for bot to process
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS web_disband_requests (
                    id SERIAL PRIMARY KEY, clan_id INT,
                    disbanded_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
                )`);
            await pool.query(
                "INSERT INTO web_disband_requests (clan_id, disbanded_by) VALUES ($1,$2)",
                [clanId, String(req.user.id)]
            );
        } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── Casino ────────────────────────────────────────────────────────────────────
app.post("/api/casino/play", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { game, wager } = req.body;
    const amt = parseInt(wager);
    if (!game || !amt || amt < 1 || amt > 50000) return res.status(400).json({ error: "Invalid game or wager (1–50000 gems)" });

    try {
        const { rows: cr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const balance = parseFloat(cr[0]?.balance || 0);
        if (balance < amt) return res.status(400).json({ error: `Not enough gems. You have ${Math.floor(balance)}.` });

        let outcome, payout, multiplier;
        const rand = Math.random();

        if (game === "coinflip") {
            // 50/50 — win 2x or lose
            if (rand < 0.5) { outcome = "win"; payout = amt * 2; multiplier = 2; }
            else { outcome = "lose"; payout = 0; multiplier = 0; }
        } else if (game === "dice") {
            // Roll 1-6: 6 = 4x, 5 = 2x, 4 = 1.5x, 1-3 = lose
            const roll = Math.ceil(rand * 6);
            if (roll === 6) { outcome = `dice:${roll}`; payout = amt * 4; multiplier = 4; }
            else if (roll === 5) { outcome = `dice:${roll}`; payout = amt * 2; multiplier = 2; }
            else if (roll === 4) { outcome = `dice:${roll}`; payout = Math.floor(amt * 1.5); multiplier = 1.5; }
            else { outcome = `dice:${roll}`; payout = 0; multiplier = 0; }
        } else if (game === "slots") {
            // 3 symbols from pool; matching pays out
            const symbols = ["💎","⚡","🎯","🔥","⭐","🎰"];
            const r1 = symbols[Math.floor(Math.random()*symbols.length)];
            const r2 = symbols[Math.floor(Math.random()*symbols.length)];
            const r3 = symbols[Math.floor(Math.random()*symbols.length)];
            outcome = `slots:${r1}${r2}${r3}`;
            if (r1 === r2 && r2 === r3) {
                if (r1 === "💎") { payout = amt * 10; multiplier = 10; }
                else { payout = amt * 5; multiplier = 5; }
            } else if (r1 === r2 || r2 === r3 || r1 === r3) {
                payout = Math.floor(amt * 1.5); multiplier = 1.5;
            } else { payout = 0; multiplier = 0; }
        } else {
            return res.status(400).json({ error: "Unknown game" });
        }

        const net = payout - amt;
        // Update balance
        await pool.query(
            `INSERT INTO store_credits (discord_id, balance, updated_at) VALUES ($1, GREATEST(0, $2::numeric + $3), NOW())
             ON CONFLICT (discord_id) DO UPDATE SET balance = GREATEST(0, store_credits.balance - $2 + $3), updated_at = NOW()`,
            [req.user.id, amt, payout]
        );
        await pool.query("INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1,$2,$3,'casino')",
            [req.user.id, net, `Casino ${game}: ${outcome}`]);
        await pool.query("INSERT INTO casino_log (discord_id, game, wager, outcome, payout, net) VALUES ($1,$2,$3,$4,$5,$6)",
            [req.user.id, game, amt, outcome, payout, net]);

        const { rows: nr } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        const newBalance = parseFloat(nr[0]?.balance || 0);
        res.json({ ok: true, outcome, payout, net, multiplier, newBalance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/casino/history", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    try {
        const { rows } = await pool.query(
            "SELECT game, wager, outcome, payout, net, created_at FROM casino_log WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 20",
            [req.user.id]
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gem accrual helper ────────────────────────────────────────────────────────
async function accrueGems(discordId) {
    try {
        // Get last accrual time
        const { rows: la } = await pool.query("SELECT last_accrued_at FROM gem_accrual_log WHERE discord_id = $1", [discordId]);
        const lastAccrued = la[0]?.last_accrued_at ? new Date(la[0].last_accrued_at) : null;
        if (!lastAccrued) {
            // First time — initialize without awarding
            await pool.query("INSERT INTO gem_accrual_log (discord_id, last_accrued_at) VALUES ($1, NOW()) ON CONFLICT (discord_id) DO NOTHING", [discordId]);
            return;
        }
        const hoursSince = (Date.now() - lastAccrued.getTime()) / 3600000;
        if (hoursSince < 0.01) return; // < 36s, skip

        // Calculate rate
        const { rows: kitRows } = await pool.query("SELECT COUNT(*) as cnt FROM user_kits WHERE discord_id = $1", [discordId]);
        const kitCount = parseInt(kitRows[0]?.cnt || 0);
        const { rows: mxRows } = await pool.query("SELECT multiplier FROM gem_multipliers WHERE discord_id = $1", [discordId]);
        const multiplier = parseFloat(mxRows[0]?.multiplier || 1);
        const rate = (10 + kitCount * 10) * multiplier; // gems per hour

        const earned = Math.floor(rate * hoursSince);
        if (earned <= 0) return;

        await pool.query(
            `INSERT INTO store_credits (discord_id, balance, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (discord_id) DO UPDATE SET balance = store_credits.balance + $2, updated_at = NOW()`,
            [discordId, earned]
        );
        await pool.query("INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1,$2,'Gem accrual','earn')", [discordId, earned]);
        await pool.query("UPDATE gem_accrual_log SET last_accrued_at = NOW() WHERE discord_id = $1", [discordId]);
    } catch {}
}

// ── Background: accrue gems for all users every hour ─────────────────────────
setInterval(async () => {
    try {
        const { rows } = await pool.query("SELECT discord_id FROM gem_accrual_log");
        for (const r of rows) { await accrueGems(r.discord_id); }
    } catch {}
}, 60 * 60 * 1000);

setupDB()
    .then(() => {
        app.listen(PORT, () => console.log(`Solarix server running on port ${PORT}`));
    })
    .catch(err => {
        console.error("DB setup failed:", err.message);
        process.exit(1);
    });
