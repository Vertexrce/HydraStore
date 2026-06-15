require("dotenv").config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

passport.serializeUser((user, done) => {
done(null, user);
});

passport.deserializeUser((obj, done) => {
done(null, obj);
});

passport.use(
new DiscordStrategy(
{
clientID: process.env.CLIENT_ID,
clientSecret: process.env.CLIENT_SECRET,
callbackURL: process.env.CALLBACK_URL,
scope: ["identify"]
},
(accessToken, refreshToken, profile, done) => {
return done(null, profile);
}
)
);

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

function checkAuth(req, res, next) {
if (req.isAuthenticated()) return next();
res.redirect("/auth/discord");
}

function checkAdmin(req, res, next) {
if (
req.isAuthenticated() &&
req.user.id === process.env.ADMIN_ID
) {
return next();
}

```
res.send("Access Denied");
```

}

app.get(
"/auth/discord",
passport.authenticate("discord")
);

app.get(
"/auth/discord/callback",
passport.authenticate("discord", {
failureRedirect: "/"
}),
(req, res) => {
res.redirect("/");
}
);

app.get("/logout", (req, res) => {
req.logout(() => {
res.redirect("/");
});
});

app.get("/profile", checkAuth, (req, res) => {
res.send(`         <h1>Logged in</h1>         <img src="https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png" width="100">         <h2>${req.user.username}</h2>         <p>ID: ${req.user.id}</p>         <a href="/logout">Logout</a>
    `);
});

app.get("/admin", checkAdmin, (req, res) => {
res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/user", (req, res) => {
if (!req.user) {
return res.json({
loggedIn: false
});
}

```
res.json({
    loggedIn: true,
    username: req.user.username,
    avatar: `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
});
```

});

app.listen(PORT, () => {
console.log("Server running on port " + PORT);
});
