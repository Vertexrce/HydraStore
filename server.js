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
    `);

    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS stripe_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS paypal_link TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'`);
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

        res.json({
            id: item.id,
            name: item.name,
            price: item.price,
            description: item.description,
            imageUrl: item.image_url || "",
            buyLink: item.buy_link,
            stripeLink: item.stripe_link,
            paypalLink: item.paypal_link,
            roleId: item.role_id,
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

app.get("/buy-stripe/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.redirect("/store.html");
        const item = rows[0];
        if (!item.stripe_link) {
            return res.redirect(`/checkout/${item.id}?err=no-stripe`);
        }
        await logPurchaseClick(item, "click-stripe", "Customer clicked Pay with Card (Stripe)");
        res.redirect(item.stripe_link);
    } catch (e) {
        res.redirect("/store.html");
    }
});

app.get("/buy-paypal/:itemId", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM store_items WHERE id = $1", [req.params.itemId]);
        if (!rows[0]) return res.redirect("/store.html");
        const item = rows[0];
        if (!item.paypal_link) {
            return res.redirect(`/checkout/${item.id}?err=no-paypal`);
        }
        await logPurchaseClick(item, "click-paypal", "Customer clicked Pay with PayPal");
        res.redirect(item.paypal_link);
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
                    "INSERT INTO store_items (id, name, price, description, image_url, buy_link, stripe_link, paypal_link, role_id, category, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                    [numericId, item.name, item.price, item.description || "", item.imageUrl || "", item.buyLink || "", item.stripeLink || "", item.paypalLink || "", item.roleId || "", item.category || "General", i]
                );
            } else {
                await pool.query(
                    "INSERT INTO store_items (name, price, description, image_url, buy_link, stripe_link, paypal_link, role_id, category, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                    [item.name, item.price, item.description || "", item.imageUrl || "", item.buyLink || "", item.stripeLink || "", item.paypalLink || "", item.roleId || "", item.category || "General", i]
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

        res.json({ ok: true, newBalance, roleAssigned: roleResult?.ok || false, roleError: roleResult?.error || null });
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
        res.json({ discordChannelId: channelId, discordBotToken: token ? "••••••••••••••••" : "", discordGuildId: guildId });
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
