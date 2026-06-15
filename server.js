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

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
