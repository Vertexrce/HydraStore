require("dotenv").config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const STORE_FILE = path.join(__dirname, "store-items.json");

function loadStoreItems() {
    if (!fs.existsSync(STORE_FILE)) {
        const defaults = [
            {
                id: 1,
                name: "VIP",
                price: "$9.99",
                description: "Priority Queue\nVIP Chat Tag\nStarter Kit\nDiscord Role"
            },
            {
                id: 2,
                name: "AK Kit",
                price: "$4.99",
                description: "AK-47\nAmmo\nMedical Supplies"
            },
            {
                id: 3,
                name: "Builder Kit",
                price: "$2.99",
                description: "Wood\nStone\nMetal"
            }
        ];
        fs.writeFileSync(STORE_FILE, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
}

function saveStoreItems(items) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(items, null, 2));
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
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false
    })
);

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(__dirname));

function checkAdmin(req, res, next) {
    if (req.session.adminLoggedIn) return next();
    res.redirect("/admin-login.html");
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
    if (
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
    ) {
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

app.get("/api/store-items", (req, res) => {
    res.json(loadStoreItems());
});

app.post("/api/store-items", checkAdmin, (req, res) => {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Expected array" });
    saveStoreItems(items);
    res.json({ ok: true });
});

app.get("/api/admin-status", (req, res) => {
    res.json({ isAdmin: !!req.session.adminLoggedIn });
});

const PURCHASES_FILE = path.join(__dirname, "purchases.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

function loadPurchases() {
    if (!fs.existsSync(PURCHASES_FILE)) return [];
    return JSON.parse(fs.readFileSync(PURCHASES_FILE, "utf-8"));
}

function savePurchase(entry) {
    const purchases = loadPurchases();
    purchases.unshift(entry);
    fs.writeFileSync(PURCHASES_FILE, JSON.stringify(purchases, null, 2));
}

function loadSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
}

function saveSettings(data) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

async function sendDiscordLog(message) {
    const settings = loadSettings();
    if (!settings.discordBotToken || !settings.discordChannelId) return;
    try {
        const https = require("https");
        const body = JSON.stringify({ content: message });
        const options = {
            hostname: "discord.com",
            path: `/api/v10/channels/${settings.discordChannelId}/messages`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bot ${settings.discordBotToken}`,
                "Content-Length": Buffer.byteLength(body)
            }
        };
        await new Promise((resolve, reject) => {
            const req = https.request(options, res => {
                res.on("data", () => {});
                res.on("end", resolve);
            });
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    } catch (e) {
        console.error("Discord log failed:", e.message);
    }
}

app.post("/api/bypass-payment", checkAdmin, async (req, res) => {
    const { itemId, itemName, itemPrice } = req.body;
    if (!itemName) return res.status(400).json({ error: "Missing item info" });
    const entry = {
        id: Date.now(),
        itemId,
        itemName,
        itemPrice,
        type: "bypass",
        note: "Admin bypass — no payment taken",
        timestamp: new Date().toISOString()
    };
    savePurchase(entry);

    const ts = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
    await sendDiscordLog(
        `⚡ **Bypass Payment Used**\n` +
        `📦 Item: **${itemName}**\n` +
        `💷 Price: **${itemPrice || "N/A"}**\n` +
        `🕐 Time: ${ts}\n` +
        `📝 Note: Admin bypass — no payment taken`
    );

    res.json({ ok: true, entry });
});

app.get("/api/purchases", checkAdmin, (req, res) => {
    res.json(loadPurchases());
});

app.get("/api/settings", checkAdmin, (req, res) => {
    const s = loadSettings();
    res.json({
        discordChannelId: s.discordChannelId || "",
        discordBotToken: s.discordBotToken ? "••••••••••••••••" : ""
    });
});

app.post("/api/settings", checkAdmin, (req, res) => {
    const current = loadSettings();
    const { discordChannelId, discordBotToken } = req.body;
    if (discordChannelId !== undefined) current.discordChannelId = discordChannelId;
    if (discordBotToken && !discordBotToken.startsWith("•")) current.discordBotToken = discordBotToken;
    saveSettings(current);
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
