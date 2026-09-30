/* ═══════════════════════════════════════════════════════════════
   RBAC — Role-Based Access Control
   Defines roles, permissions, and helper functions.
   ═══════════════════════════════════════════════════════════════ */

export type Role = "super_admin" | "admin" | "manager" | "cashier" | "inventory_clerk" | "viewer";

export type Permission =
  | "dashboard:view"
  | "pos:view"
  | "pos:create_order"
  | "pos:apply_discount"
  | "pos:refund"
  | "products:view"
  | "products:create"
  | "products:edit"
  | "products:delete"
  | "categories:view"
  | "categories:create"
  | "categories:edit"
  | "categories:delete"
  | "brands:view"
  | "brands:create"
  | "brands:edit"
  | "brands:delete"
  | "inventory:view"
  | "inventory:adjust"
  | "inventory:transfer"
  | "orders:view"
  | "orders:manage"
  | "orders:refund"
  | "receipts:print"       // print (or retry) the receipt of a sale just made
  | "receipts:reprint_own" // reprint own receipts from the current/last shift
  | "receipts:reprint_any" // reprint any receipt (manager+)
  | "customers:view"
  | "customers:create"
  | "customers:edit"
  | "customers:delete"
  | "suppliers:view"
  | "suppliers:create"
  | "suppliers:edit"
  | "suppliers:delete"
  | "purchase_orders:view"
  | "purchase_orders:create"
  | "purchase_orders:confirm"
  | "purchase_orders:receive"
  | "purchase_orders:cancel"
  | "reports:view"
  | "reports:export"
  | "users:view"
  | "users:create"
  | "users:edit"
  | "users:delete"
  | "settings:view"
  | "settings:edit";

/* ─── Role → Permission Map ─────────────────────────────────── */

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: [
    "dashboard:view",
    "pos:view", "pos:create_order", "pos:apply_discount", "pos:refund",
    "receipts:print", "receipts:reprint_own", "receipts:reprint_any",
    "products:view", "products:create", "products:edit", "products:delete",
    "categories:view", "categories:create", "categories:edit", "categories:delete",
    "brands:view", "brands:create", "brands:edit", "brands:delete",
    "inventory:view", "inventory:adjust", "inventory:transfer",
    "orders:view", "orders:manage", "orders:refund",
    "customers:view", "customers:create", "customers:edit", "customers:delete",
    "suppliers:view", "suppliers:create", "suppliers:edit", "suppliers:delete",
    "purchase_orders:view", "purchase_orders:create", "purchase_orders:confirm", "purchase_orders:receive", "purchase_orders:cancel",
    "reports:view", "reports:export",
    "users:view", "users:create", "users:edit", "users:delete",
    "settings:view", "settings:edit",
  ],
  admin: [
    "dashboard:view",
    "pos:view", "pos:create_order", "pos:apply_discount", "pos:refund",
    "receipts:print", "receipts:reprint_own", "receipts:reprint_any",
    "products:view", "products:create", "products:edit", "products:delete",
    "categories:view", "categories:create", "categories:edit", "categories:delete",
    "brands:view", "brands:create", "brands:edit", "brands:delete",
    "inventory:view", "inventory:adjust", "inventory:transfer",
    "orders:view", "orders:manage", "orders:refund",
    "customers:view", "customers:create", "customers:edit", "customers:delete",
    "suppliers:view", "suppliers:create", "suppliers:edit", "suppliers:delete",
    "purchase_orders:view", "purchase_orders:create", "purchase_orders:confirm", "purchase_orders:receive", "purchase_orders:cancel",
    "reports:view", "reports:export",
    "users:view", "users:create", "users:edit",
    "settings:view", "settings:edit",
  ],
  manager: [
    "dashboard:view",
    "pos:view", "pos:create_order", "pos:apply_discount",
    "receipts:print", "receipts:reprint_own", "receipts:reprint_any",
    "products:view", "products:create", "products:edit",
    "categories:view", "categories:create", "categories:edit",
    "brands:view", "brands:create", "brands:edit",
    "inventory:view", "inventory:adjust", "inventory:transfer",
    "orders:view", "orders:manage", "orders:refund",
    "customers:view", "customers:create", "customers:edit",
    "suppliers:view", "suppliers:create", "suppliers:edit",
    "purchase_orders:view", "purchase_orders:create", "purchase_orders:confirm", "purchase_orders:receive",
    "reports:view", "reports:export",
    "users:view",
    "settings:view",
  ],
  cashier: [
    "dashboard:view",
    "pos:view", "pos:create_order",
    "receipts:print", "receipts:reprint_own",
    "products:view",
    "categories:view",
    "brands:view",
    "inventory:view",
    "orders:view",
    "customers:view", "customers:create", "customers:edit",
  ],
  inventory_clerk: [
    "dashboard:view",
    "products:view", "products:create", "products:edit",
    "categories:view", "categories:create", "categories:edit",
    "brands:view", "brands:create", "brands:edit",
    "inventory:view", "inventory:adjust", "inventory:transfer",
    "orders:view",
    "suppliers:view",
    "purchase_orders:view",
  ],
  viewer: [
    "dashboard:view",
    "products:view",
    "categories:view",
    "brands:view",
    "inventory:view",
    "orders:view",
    "customers:view",
    "reports:view",
  ],
};

/* ─── Helper Functions ──────────────────────────────────────── */

export function getPermissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.viewer;
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return getPermissionsForRole(role).includes(permission);
}

export function hasAnyPermission(role: Role, permissions: Permission[]): boolean {
  const rolePerms = getPermissionsForRole(role);
  return permissions.some((p) => rolePerms.includes(p));
}

export function hasAllPermissions(role: Role, permissions: Permission[]): boolean {
  const rolePerms = getPermissionsForRole(role);
  return permissions.every((p) => rolePerms.includes(p));
}

export function canAccessRoute(role: Role, pathname: string): boolean {
  const routePermissionMap: Array<[RegExp, Permission]> = [
    [/^\/dashboard/, "dashboard:view"],
    [/^\/pos/, "pos:view"],
    [/^\/products/, "products:view"],
    [/^\/inventory/, "inventory:view"],
    [/^\/orders/, "orders:view"],
    [/^\/refunds/, "orders:view"],
    [/^\/customers/, "customers:view"],
    [/^\/suppliers/, "suppliers:view"],
    [/^\/purchase-orders/, "purchase_orders:view"],
    [/^\/reports/, "reports:view"],
    [/^\/users/, "users:view"],
    [/^\/settings/, "settings:view"],
  ];

  for (const [pattern, permission] of routePermissionMap) {
    if (pattern.test(pathname)) {
      return hasPermission(role, permission);
    }
  }

  return true; // Allow unlisted routes
}

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  inventory_clerk: "Inventory Clerk",
  viewer: "Viewer",
};

export const ROLE_COLORS: Record<Role, string> = {
  super_admin: "danger",
  admin: "primary",
  manager: "success",
  cashier: "info",
  inventory_clerk: "warning",
  viewer: "default",
};
