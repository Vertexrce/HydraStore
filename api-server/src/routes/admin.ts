import { Router, type IRouter } from "express";

const router: IRouter = Router();

function configuredAdminIds() {
  return new Set(
    (process.env.ADMIN_DISCORD_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Server-owned admin check.
 *
 * The Discord ID must come from a trusted authenticated session or upstream
 * adapter. The browser must never be trusted to decide who is an admin.
 * Configure comma-separated IDs in Railway as ADMIN_DISCORD_IDS.
 */
router.get("/admin/check", (req, res) => {
  const discordId = req.header("x-discord-id")?.trim();
  const isAdmin = Boolean(discordId && configuredAdminIds().has(discordId));

  res.json({
    isAdmin,
    role: isAdmin ? "admin" : "member",
  });
});

export default router;