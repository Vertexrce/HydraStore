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
let BotDB = null;
const BOT_DB_PATH = process.env.BOT_DB_PATH || "";
if (BOT_DB_PATH) {
    try {
        const BetterSqlite = require("better-sqlite3");
        BotDB = new BetterSqlite(BOT_DB_PATH, { readonly: true, fileMustExist: true });
        console.log("✅ Valora bot SQLite connected:", BOT_DB_PATH);
    } catch (e) {
        console.warn("⚠️  Could not open bot SQLite DB:", e.message);
        BotDB = null;
    }
}

// Helper: safely convert a Discord ID string to BigInt for SQLite INTEGER columns.
// Discord IDs are 64-bit ints; better-sqlite3 must receive them as BigInt to match.
function _discordBigInt(id) {
    try { return BigInt(id); } catch { return id; }
}

function getBotLinkedGamertag(discordUserId) {
    if (!BotDB) return null;
    const uid = _discordBigInt(discordUserId);
    try {
        // linked_accounts table: written by deploy_link_panel / older system
        const row = BotDB.prepare("SELECT account_name FROM linked_accounts WHERE discord_user_id=?").get(uid);
        if (row) return row.account_name;
        // player_links table: written by /link command in link.py (correct table)
        const row2 = BotDB.prepare("SELECT gamer_tag FROM player_links WHERE discord_id=? LIMIT 1").get(uid);
        return row2 ? row2.gamer_tag : null;
    } catch { return null; }
}

function getBotClanForUser(discordUserId) {
    if (!BotDB) return null;
    const uid = _discordBigInt(discordUserId);
    try {
        // clan_members columns: clan_id, user_id, clan_role, joined_at
        const member = BotDB.prepare(
            "SELECT cm.clan_id, cm.clan_role FROM clan_members cm WHERE cm.user_id=? LIMIT 1"
        ).get(uid);
        if (!member) return null;
        // clans PK is 'id', not 'clan_id'
        const clan = BotDB.prepare("SELECT * FROM clans WHERE id=?").get(member.clan_id);
        if (!clan) return null;
        const count = BotDB.prepare("SELECT COUNT(*) as cnt FROM clan_members WHERE clan_id=?").get(member.clan_id);
        return { ...clan, memberRole: member.clan_role, memberCount: Number(count?.cnt || 1) };
    } catch { return null; }
}

function getBotAllClans(limit = 50) {
    if (!BotDB) return null;
    try {
        const clans = BotDB.prepare("SELECT * FROM clans ORDER BY id LIMIT ?").all(limit);
        return clans.map(c => {
            // clan_members FK is clan_id referencing clans.id
            const count = BotDB.prepare("SELECT COUNT(*) as cnt FROM clan_members WHERE clan_id=?").get(c.id);
            // owner is stored with clan_role='owner' and column is user_id
            const owner = BotDB.prepare("SELECT user_id FROM clan_members WHERE clan_id=? AND clan_role='owner' LIMIT 1").get(c.id);
            return { ...c, memberCount: Number(count?.cnt || 1), ownerDiscordId: String(owner?.user_id || c.owner_id || "") };
        });
    } catch { return null; }
}

function getBotClanByCode(code) {
    if (!BotDB) return null;
    try {
        const ic = BotDB.prepare(
            "SELECT * FROM clan_invite_codes WHERE code=? AND expires_at > ? LIMIT 1"
        ).get(code, Math.floor(Date.now() / 1000));
        if (!ic) return null;
        // clans PK is 'id'
        const clan = BotDB.prepare("SELECT * FROM clans WHERE id=?").get(ic.clan_id);
        return clan ? { inviteCode: ic, clan } : null;
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
            `🕐 Time: ${ts}`
        );
    }
    res.json({ received: true });
});

// ── DB setup ──────────────────────────────────────────────────────────────────
async function getSetting(key) {
    try {
        const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
        return rows[0]?.value || null;
    } catch { return null; }
}

async function setSetting(key, value) {
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, value]
    );
}

async function sendDiscordLog(message) {
    try {
        const webhookUrl = await getSetting("discordWebhookUrl");
        if (!webhookUrl) return;
        const body = JSON.stringify({ content: message });
        const url = new URL(webhookUrl);
        const opts = { hostname: url.hostname, path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
        const req = https.request(opts);
        req.write(body);
        req.end();
    } catch {}
}

async function assignDiscordRole(guildId, userId, roleId) {
    try {
        const token = await getSetting("discordBotToken");
        if (!token || !guildId || !userId || !roleId) return { ok: false, error: "Missing params" };
        return await new Promise((resolve) => {
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
    } catch (e) { return { ok: false, error: e.message }; }
}

async function setupDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

        CREATE TABLE IF NOT EXISTS store_items (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price TEXT DEFAULT '',
            description TEXT DEFAULT '',
            buy_link TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS purchases (
            id BIGINT PRIMARY KEY,
            item_id BIGINT,
            item_name TEXT,
            item_price TEXT,
            discord_user_id TEXT DEFAULT '',
            type TEXT DEFAULT 'stripe',
            note TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW()
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

        CREATE TABLE IF NOT EXISTS web_clans (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            tag TEXT DEFAULT '',
            description TEXT DEFAULT '',
            icon_url TEXT DEFAULT '',
            owner_discord_id TEXT NOT NULL,
            color TEXT DEFAULT '#a855f7',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS web_clan_members (
            discord_id TEXT NOT NULL,
            clan_id INTEGER NOT NULL REFERENCES web_clans(id) ON DELETE CASCADE,
            role TEXT DEFAULT 'member',
            joined_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (discord_id)
        );

        CREATE TABLE IF NOT EXISTS web_clan_invite_codes (
            code TEXT PRIMARY KEY,
            clan_id INTEGER NOT NULL REFERENCES web_clans(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            max_uses INTEGER,
            current_uses INTEGER DEFAULT 0
        );
    `);

    // Alter existing tables to add new columns if they don't exist
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS stripe_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS paypal_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS zip_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS discord_user_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS rate TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE web_game_servers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'online'`);

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

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Auth ──────────────────────────────────────────────────────────────────────
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
        return res.json({ ok: true });
    }
    res.status(401).json({ error: "Invalid credentials" });
});

app.get("/admin-logout", (req, res) => {
    req.session.adminLoggedIn = false;
    res.redirect("/");
});

app.get("/api/admin-status", (req, res) => {
    res.json({ isAdmin: !!req.session.adminLoggedIn });
});

// ── Public: Servers with live RCON status ────────────────────────────────────
async function queryRconStatus(host, port, password) {
    return new Promise((resolve) => {
        if (!host || !password) return resolve({ online: false, players: 0, maxPlayers: 100, queued: 0 });
        const ws = new WebSocket(`ws://${host}:${port}/${password}`);
        let done = false;
        const timeout = setTimeout(() => {
            if (!done) { done = true; try { ws.terminate(); } catch {} resolve({ online: false, players: 0, maxPlayers: 100, queued: 0 }); }
        }, 6000);
        ws.on("open", () => {
            ws.send(JSON.stringify({ Identifier: 1, Message: "serverinfo", Name: "SolarixWeb" }));
        });
        ws.on("message", (data) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            try {
                const msg = JSON.parse(data.toString());
                const payload = typeof msg.Message === "string" ? JSON.parse(msg.Message) : msg.Message;
                resolve({
                    online: true,
                    players: parseInt(payload.Players || payload.players || 0),
                    maxPlayers: parseInt(payload.MaxPlayers || payload.maxPlayers || 100),
                    queued: parseInt(payload.Queued || payload.queued || 0)
                });
            } catch {
                resolve({ online: true, players: 0, maxPlayers: 100, queued: 0 });
            } finally {
                try { ws.close(); } catch {}
            }
        });
        ws.on("error", () => {
            if (!done) { done = true; clearTimeout(timeout); resolve({ online: false, players: 0, maxPlayers: 100, queued: 0 }); }
        });
    });
}

app.get("/api/public/servers", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM web_game_servers ORDER BY sort_order, id");
        // Query RCON in parallel for all servers
        const results = await Promise.all(rows.map(async (s) => {
            let rconData = { online: false, players: 0, maxPlayers: 100, queued: 0 };
            if (s.status !== 'coming_soon' && s.rcon_host && s.rcon_password) {
                rconData = await queryRconStatus(s.rcon_host, s.rcon_port || 28016, s.rcon_password);
            }
            return {
                id: s.id,
                name: s.name,
                location: s.location || "",
                rate: s.rate || "",
                status: s.status || "online",
                online: s.status === "coming_soon" ? false : rconData.online,
                players: rconData.players,
                maxPlayers: rconData.maxPlayers,
                queued: rconData.queued
            };
        }));
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Store ─────────────────────────────────────────────────────────────────────
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

// ── Gems (store credits) ──────────────────────────────────────────────────────
app.get("/api/credits/me", async (req, res) => {
    if (!req.user) return res.json({ balance: 0, loggedIn: false });
    try {
        const { rows } = await pool.query("SELECT balance FROM store_credits WHERE discord_id = $1", [req.user.id]);
        res.json({ balance: parseFloat(rows[0]?.balance || 0), loggedIn: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/credits", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT discord_id, balance FROM store_credits ORDER BY balance DESC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/give-credit", checkAdminJson, async (req, res) => {
    const { discordId, amount, reason } = req.body;
    if (!discordId || !amount) return res.status(400).json({ error: "Missing params" });
    const amt = parseFloat(amount);
    if (isNaN(amt)) return res.status(400).json({ error: "Invalid amount" });
    try {
        await pool.query(
            `INSERT INTO store_credits (discord_id, balance) VALUES ($1, $2)
             ON CONFLICT (discord_id) DO UPDATE SET balance = store_credits.balance + $2, updated_at = NOW()`,
            [discordId, amt]
        );
        await pool.query(
            "INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1, $2, $3, $4)",
            [discordId, amt, reason || "", amt > 0 ? "grant" : "deduct"]
        );
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(`💎 **Credits Given**\n👤 Discord: <@${discordId}>\n💎 Amount: **${amt}**\n📝 Reason: ${reason || "N/A"}\n🕐 Time: ${ts}`);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        if (balance < price) return res.status(400).json({ error: `Insufficient balance. You have ${balance.toFixed(2)} gems, need ${price.toFixed(2)}.` });
        await pool.query(
            "UPDATE store_credits SET balance = balance - $1, updated_at = NOW() WHERE discord_id = $2",
            [price, req.user.id]
        );
        await pool.query(
            "INSERT INTO credit_transactions (discord_id, amount, reason, type) VALUES ($1,$2,$3,$4)",
            [req.user.id, -price, `Purchase: ${item.name}`, "spend"]
        );
        await pool.query(
            "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [Date.now(), item.id, item.name, item.price, req.user.id, "credits", "Paid with store credits"]
        );
        let roleAssigned = false;
        if (item.role_id) {
            const guildId = await getSetting("discordGuildId");
            const result = await assignDiscordRole(guildId, req.user.id, item.role_id);
            roleAssigned = result?.ok || false;
        }
        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(`💎 **Credit Purchase**\n📦 Item: **${item.name}**\n💷 Price: **${item.price}**\n👤 Discord: <@${req.user.id}>\n🕐 Time: ${ts}`);
        res.json({ ok: true, roleAssigned });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        await sendDiscordLog(`⚡ **Bypass Payment**\n📦 Item: **${itemName}**\n💷 Price: **${itemPrice || "N/A"}**\n👤 ${discordUserId ? `<@${discordUserId}>` : "Not specified"}\n🕐 Time: ${ts}`);
        res.json({ ok: true, roleAssigned: roleResult?.ok || false, entry: { id, itemName, itemPrice, discordUserId } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/purchases", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM purchases ORDER BY created_at DESC LIMIT 100");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/settings", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT key, value FROM settings");
        const out = {};
        rows.forEach(r => { out[r.key] = r.value; });
        res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings", checkAdminJson, async (req, res) => {
    const data = req.body;
    try {
        for (const [key, value] of Object.entries(data)) {
            await setSetting(key, value);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/create-checkout-session", async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "Missing itemId" });
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [itemId]);
        const item = rows[0];
        if (!item) return res.status(404).json({ error: "Item not found" });
        if (!item.stripe_link) return res.status(400).json({ error: "No Stripe payment link for this item" });
        const priceStr = item.price.replace(/[^0-9.]/g, "");
        const priceCents = Math.round(parseFloat(priceStr) * 100);
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [{ price_data: { currency: "gbp", product_data: { name: item.name, description: item.description }, unit_amount: priceCents }, quantity: 1 }],
            mode: "payment",
            success_url: `${BASE_URL}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${BASE_URL}/store.html`,
            metadata: { item_id: String(item.id), item_name: item.name, item_price: item.price, role_id: item.role_id || "", discord_user_id: req.user?.id || "" }
        });
        res.json({ url: session.url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/checkout/:id", (req, res) => res.sendFile(path.join(__dirname, "checkout.html")));

app.get("/api/checkout-info", async (req, res) => {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "Missing session_id" });
    try {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(session_id);
        res.json({ status: session.payment_status, customer_email: session.customer_details?.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Player links ───────────────────────────────────────────────────────
app.get("/api/admin/player-links", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM web_player_links ORDER BY updated_at DESC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/give-kit", checkAdminJson, async (req, res) => {
    const { gamertag, kitName, serverId } = req.body;
    if (!gamertag || !kitName) return res.status(400).json({ error: "Missing gamertag or kitName" });
    try {
        const { rows: serverRows } = await pool.query("SELECT * FROM web_game_servers WHERE id = $1", [serverId]);
        const server = serverRows[0];
        if (!server) return res.status(404).json({ error: "Server not found" });
        await sendRconCommand(server.rcon_host, server.rcon_port, server.rcon_password, `kit ${kitName} ${gamertag}`);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kits: routes ─────────────────────────────────────────────────────────────
app.get("/kits", (req, res) => res.sendFile(path.join(__dirname, "kits.html")));

// Link status: check if user is linked on web AND in bot
app.get("/api/link-status", async (req, res) => {
    if (!req.user) return res.json({ loggedIn: false });
    try {
        const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const webGamertag = rows[0]?.gamertag || null;
        const botGamertag = getBotLinkedGamertag(req.user.id);
        res.json({
            loggedIn: true,
            webLinked: !!webGamertag,
            botLinked: !!botGamertag,
            webGamertag,
            botGamertag,
            fullyLinked: !!webGamertag && !!botGamertag
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/kits/gamertag", async (req, res) => {
    if (!req.user) return res.json({ gamertag: null });
    try {
        const { rows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        if (rows[0]) return res.json({ gamertag: rows[0].gamertag });
        const botGamertag = getBotLinkedGamertag(req.user.id);
        if (botGamertag) {
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
            return res.json({
                loggedIn: false, gamertag: null,
                kits: allKits.map(k => ({
                    id: k.id, name: k.name, description: k.description,
                    cooldownMinutes: k.cooldown_minutes,
                    serverName: k.server_name || "Server",
                    onCooldown: false, expiresAt: null
                }))
            });
        }

        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        const gamertag = linkRows[0]?.gamertag || null;

        const { rows: cooldownRows } = await pool.query(
            "SELECT kit_id, expires_at FROM web_kit_cooldowns WHERE discord_id = $1 AND expires_at > NOW()",
            [req.user.id]
        );
        const cooldownMap = {};
        cooldownRows.forEach(r => { cooldownMap[r.kit_id] = r.expires_at; });

        // Also check bot link
        const botGamertag = getBotLinkedGamertag(req.user.id);

        res.json({
            loggedIn: true,
            gamertag,
            botLinked: !!botGamertag,
            kits: allKits.map(k => ({
                id: k.id, name: k.name, description: k.description,
                cooldownMinutes: k.cooldown_minutes,
                serverName: k.server_name || "Server",
                onCooldown: !!cooldownMap[k.id],
                expiresAt: cooldownMap[k.id] || null
            }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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

        // Get gamertag — check web link first, then bot link
        let gamertag = null;
        const { rows: linkRows } = await pool.query("SELECT gamertag FROM web_player_links WHERE discord_id = $1", [req.user.id]);
        gamertag = linkRows[0]?.gamertag || getBotLinkedGamertag(req.user.id);

        if (!gamertag) {
            return res.status(400).json({ error: "Link your in-game name first. Use /link in Discord or the Link Account page." });
        }

        // Must also be linked in Discord bot (if bot DB available)
        const botGamertag = getBotLinkedGamertag(req.user.id);
        if (BotDB && !botGamertag) {
            return res.status(400).json({ error: "You must also link your account in Discord using /link before claiming kits." });
        }

        if (!kit.rcon_host) return res.status(500).json({ error: "No game server configured for this kit." });

        // Send RCON command — use exact kit name (case-insensitive match attempted)
        try {
            await sendRconCommand(kit.rcon_host, kit.rcon_port, kit.rcon_password, `kit ${kit.name} ${gamertag}`);
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

// ── RCON helpers ──────────────────────────────────────────────────────────────
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

// ── Admin: Game servers ───────────────────────────────────────────────────────
app.get("/api/admin/game-servers", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM web_game_servers ORDER BY sort_order, id");
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
            if (!s.name) continue;
            if (s.id) {
                await pool.query(
                    "INSERT INTO web_game_servers (id, name, rcon_host, rcon_port, rcon_password, location, rate, status, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                    [s.id, s.name, s.rcon_host || "", parseInt(s.rcon_port) || 28016, s.rcon_password || "", s.location || "", s.rate || "", s.status || "online", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO web_game_servers (name, rcon_host, rcon_port, rcon_password, location, rate, status, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                    [s.name, s.rcon_host || "", parseInt(s.rcon_port) || 28016, s.rcon_password || "", s.location || "", s.rate || "", s.status || "online", i]
                );
            }
        }
        try { await pool.query("SELECT setval('web_game_servers_id_seq', COALESCE((SELECT MAX(id) FROM web_game_servers), 1))"); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Kit configs ────────────────────────────────────────────────────────
app.get("/api/admin/web-kits", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM web_kit_configs ORDER BY sort_order, id");
        res.json(rows.map(k => ({
            id: k.id, name: k.name, description: k.description,
            cooldownMinutes: k.cooldown_minutes,
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
                    "INSERT INTO web_kit_configs (id, name, description, cooldown_minutes, server_id, enabled, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    [k.id, k.name, k.description || "", parseInt(k.cooldownMinutes) || 60, k.serverId || null, k.enabled !== false ? 1 : 0, i]
                );
            } else {
                await pool.query(
                    "INSERT INTO web_kit_configs (name, description, cooldown_minutes, server_id, enabled, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
                    [k.name, k.description || "", parseInt(k.cooldownMinutes) || 60, k.serverId || null, k.enabled !== false ? 1 : 0, i]
                );
            }
        }
        try { await pool.query("SELECT setval('web_kit_configs_id_seq', COALESCE((SELECT MAX(id) FROM web_kit_configs), 1))"); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clans: Public ─────────────────────────────────────────────────────────────
app.get("/clans", (req, res) => res.sendFile(path.join(__dirname, "clans.html")));
app.get("/link", (req, res) => res.sendFile(path.join(__dirname, "link.html")));

app.get("/api/clans/public", async (req, res) => {
    try {
        // Try bot DB first
        const botClans = getBotAllClans(100);
        if (botClans && botClans.length) {
            return res.json(botClans.map(c => ({
                id: c.clan_id,
                name: c.name,
                tag: c.tag || "",
                description: c.description || "",
                iconUrl: c.icon_url || "",
                color: c.color || "#a855f7",
                memberCount: c.memberCount || 1,
                ownerDiscordId: String(c.ownerDiscordId || c.owner_id || ""),
                source: "bot"
            })));
        }
        // Fallback: web_clans table
        const { rows } = await pool.query(`
            SELECT wc.*, COUNT(wcm.discord_id) as member_count
            FROM web_clans wc
            LEFT JOIN web_clan_members wcm ON wcm.clan_id = wc.id
            GROUP BY wc.id
            ORDER BY wc.created_at DESC
        `);
        res.json(rows.map(c => ({
            id: String(c.id),
            name: c.name,
            tag: c.tag || "",
            description: c.description || "",
            iconUrl: c.icon_url || "",
            color: c.color || "#a855f7",
            memberCount: parseInt(c.member_count) || 1,
            ownerDiscordId: c.owner_discord_id,
            source: "web"
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/clans/mine", async (req, res) => {
    if (!req.user) return res.json({ loggedIn: false });
    try {
        // Try bot DB first
        const botClan = getBotClanForUser(req.user.id);
        if (botClan) {
            return res.json({
                loggedIn: true,
                inClan: true,
                clan: {
                    id: String(botClan.id),           // clans PK is 'id'
                    name: botClan.name,
                    tag: botClan.clantag || "",        // column is 'clantag', not 'tag'
                    description: botClan.description || "",
                    iconUrl: botClan.icon_url || "",
                    color: botClan.color || "#a855f7",
                    memberCount: botClan.memberCount || 1,
                    memberRole: botClan.memberRole || "member",
                    ownerDiscordId: String(botClan.owner_id || ""),
                    source: "bot"
                }
            });
        }
        // Fallback: web_clans
        const { rows } = await pool.query(`
            SELECT wc.*, wcm.role as member_role, COUNT(all_m.discord_id) as member_count
            FROM web_clan_members wcm
            JOIN web_clans wc ON wc.id = wcm.clan_id
            LEFT JOIN web_clan_members all_m ON all_m.clan_id = wc.id
            WHERE wcm.discord_id = $1
            GROUP BY wc.id, wcm.role
        `, [req.user.id]);
        if (!rows[0]) return res.json({ loggedIn: true, inClan: false });
        const c = rows[0];
        res.json({
            loggedIn: true,
            inClan: true,
            clan: {
                id: String(c.id),
                name: c.name,
                tag: c.tag || "",
                description: c.description || "",
                iconUrl: c.icon_url || "",
                color: c.color || "#a855f7",
                memberCount: parseInt(c.member_count) || 1,
                memberRole: c.member_role || "member",
                ownerDiscordId: c.owner_discord_id,
                source: "web"
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/clans/join", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: "Clan code required" });
    const cleanCode = code.trim().toUpperCase();
    try {
        // Try bot DB first (read-only — just validate)
        if (BotDB) {
            const found = getBotClanByCode(cleanCode);
            if (!found) return res.status(404).json({ error: "Invalid or expired clan code. Use /clan join in Discord." });
            return res.json({ ok: true, message: `Code valid! Use /clan join ${found.clan.name || ""} ${cleanCode} in Discord to join.`, clanName: found.clan.name });
        }
        // Web-only path
        const { rows: codeRows } = await pool.query(
            `SELECT wcc.*, wc.name as clan_name
             FROM web_clan_invite_codes wcc
             JOIN web_clans wc ON wc.id = wcc.clan_id
             WHERE wcc.code = $1 AND (wcc.expires_at IS NULL OR wcc.expires_at > NOW())
               AND (wcc.max_uses IS NULL OR wcc.current_uses < wcc.max_uses)`,
            [cleanCode]
        );
        if (!codeRows[0]) return res.status(404).json({ error: "Invalid or expired clan code." });
        const ic = codeRows[0];
        // Check if already in a clan
        const { rows: existing } = await pool.query("SELECT 1 FROM web_clan_members WHERE discord_id=$1", [req.user.id]);
        if (existing[0]) return res.status(400).json({ error: "You are already in a clan. Leave your current clan first." });
        await pool.query("INSERT INTO web_clan_members (discord_id, clan_id, role) VALUES ($1,$2,'member')", [req.user.id, ic.clan_id]);
        await pool.query("UPDATE web_clan_invite_codes SET current_uses = current_uses + 1 WHERE code=$1", [cleanCode]);
        res.json({ ok: true, clanName: ic.clan_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Setup and start ───────────────────────────────────────────────────────────
setupDB()
    .then(() => {
        app.listen(PORT, () => console.log(`Solarix server running on port ${PORT}`));
    })
    .catch(err => {
        console.error("DB setup failed:", err.message);
        process.exit(1);
    });
