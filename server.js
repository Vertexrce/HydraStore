require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");
const { Pool } = require("pg");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
            buy_link TEXT DEFAULT '',
            role_id TEXT DEFAULT '',
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
    `);

    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS discord_user_id TEXT DEFAULT ''`);

    const { rows } = await pool.query("SELECT COUNT(*) FROM store_items");
    if (parseInt(rows[0].count) === 0) {
        await pool.query(`
            INSERT INTO store_items (name, price, description, buy_link, role_id, sort_order) VALUES
            ('VIP', '£9.99', 'Priority Queue\nVIP Chat Tag\nStarter Kit\nDiscord Role', '', '', 1),
            ('AK Kit', '£4.99', 'AK-47\nAmmo\nMedical Supplies', '', '', 2),
            ('Builder Kit', '£2.99', 'Wood\nStone\nMetal', '', '', 3)
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
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
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

app.get("/api/checkout/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.status(404).json({ error: "Item not found" });
        const item = rows[0];
        res.json({
            id: item.id,
            name: item.name,
            price: item.price,
            description: item.description,
            buyLink: item.buy_link,
            roleId: item.role_id,
            isAdmin: !!req.session.adminLoggedIn
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/buy/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0] || !rows[0].buy_link) return res.redirect("/store.html");
        const item = rows[0];

        await pool.query(
            "INSERT INTO purchases (id, item_id, item_name, item_price, type, note) VALUES ($1, $2, $3, $4, $5, $6)",
            [Date.now(), item.id, item.name, item.price, "click", "Customer clicked Buy Now"]
        );

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        await sendDiscordLog(
            `🛒 **Purchase Initiated**\n` +
            `📦 Item: **${item.name}**\n` +
            `💷 Price: **${item.price}**\n` +
            `🕐 Time: ${ts}\n` +
            `📝 Note: Customer clicked Buy Now — redirecting to payment`
        );

        res.redirect(item.buy_link);
    } catch (e) {
        res.redirect("/store.html");
    }
});

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
            buyLink: r.buy_link,
            roleId: r.role_id || ""
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
                    "INSERT INTO store_items (id, name, price, description, buy_link, role_id, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                    [numericId, item.name, item.price, item.description || "", item.buyLink || "", item.roleId || "", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO store_items (name, price, description, buy_link, role_id, sort_order) VALUES ($1, $2, $3, $4, $5, $6)",
                    [item.name, item.price, item.description || "", item.buyLink || "", item.roleId || "", i]
                );
            }
        }
        await pool.query("SELECT setval('store_items_id_seq', COALESCE((SELECT MAX(id) FROM store_items), 1))");
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
            headers: {
                "Authorization": `Bot ${token}`,
                "Content-Length": 0
            }
        };
        const req = https.request(options, r => {
            let data = "";
            r.on("data", chunk => data += chunk);
            r.on("end", () => {
                if (r.statusCode === 204) {
                    resolve({ ok: true });
                } else {
                    resolve({ ok: false, error: `Discord API returned ${r.statusCode}: ${data}` });
                }
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
            "INSERT INTO purchases (id, item_id, item_name, item_price, discord_user_id, type, note) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [id, itemId || null, itemName, itemPrice || "", discordUserId || "", "bypass", "Admin bypass — no payment taken"]
        );

        const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
        const roleNote = roleResult?.ok
            ? `✅ Role assigned to <@${discordUserId}>`
            : roleResult
            ? `⚠️ Role assignment failed: ${roleResult.error}`
            : `ℹ️ No role ID or Discord user provided`;

        await sendDiscordLog(
            `⚡ **Bypass Payment Used**\n` +
            `📦 Item: **${itemName}**\n` +
            `💷 Price: **${itemPrice || "N/A"}**\n` +
            `👤 Discord User: ${discordUserId ? `<@${discordUserId}>` : "Not specified"}\n` +
            `🕐 Time: ${ts}\n` +
            `🎭 Role: ${roleNote}`
        );

        res.json({
            ok: true,
            roleAssigned: roleResult?.ok || false,
            roleError: roleResult?.error || null,
            entry: { id, itemName, itemPrice, discordUserId, timestamp: new Date().toISOString() }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/purchases", checkAdminJson, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM purchases ORDER BY created_at DESC");
        res.json(rows.map(r => ({
            id: r.id,
            itemId: r.item_id,
            itemName: r.item_name,
            itemPrice: r.item_price,
            discordUserId: r.discord_user_id || "",
            type: r.type,
            note: r.note,
            timestamp: r.created_at
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
        res.json({
            discordChannelId: channelId,
            discordBotToken: token ? "••••••••••••••••" : "",
            discordGuildId: guildId
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/settings", checkAdminJson, async (req, res) => {
    try {
        const { discordChannelId, discordBotToken, discordGuildId } = req.body;
        if (discordChannelId !== undefined) await setSetting("discordChannelId", discordChannelId);
        if (discordBotToken && !discordBotToken.startsWith("•")) await setSetting("discordBotToken", discordBotToken);
        if (discordGuildId !== undefined) await setSetting("discordGuildId", discordGuildId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

setupDB()
    .then(() => {
        app.listen(PORT, () => console.log("Server running on port " + PORT));
    })
    .catch(err => {
        console.error("DB setup failed:", err.message);
        process.exit(1);
    });
