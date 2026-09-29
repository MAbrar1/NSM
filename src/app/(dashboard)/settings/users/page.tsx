import { redirect } from "next/navigation";

/* ═══════════════════════════════════════════════════════════════
   SETTINGS → USERS (redirect)
   User management lives at /users; keep /settings/users as a
   shortcut so both sidebar entries work.
   ═══════════════════════════════════════════════════════════════ */

export default function UsersSettingsPage() {
  redirect("/users");
}