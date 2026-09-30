-- ═══════════════════════════════════════════════════════════════
-- COMMAND-PALETTE RECENTS (ROAMING)
-- Server-side persistence for the ⌘K palette's "Recent" row so it
-- follows a user across browsers and devices. Additive table only —
-- no existing columns or tables change. The (userId, href) unique
-- pair is the dedupe key (upsert semantics); (userId, visitedAt)
-- serves the newest-first read.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "PaletteRecent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "visitedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaletteRecent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PaletteRecent_userId_href_key" ON "PaletteRecent"("userId", "href");
CREATE INDEX "PaletteRecent_userId_visitedAt_idx" ON "PaletteRecent"("userId", "visitedAt");
