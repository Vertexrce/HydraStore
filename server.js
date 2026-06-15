const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve all website files
app.use(express.static(__dirname));

// Admin page
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
