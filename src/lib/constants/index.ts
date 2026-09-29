/* ═══════════════════════════════════════════════════════════════
   APPLICATION CONSTANTS
   Single source of truth for all static values.
   Never hardcode values in components — reference these instead.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Application ─── */
export const APP_NAME = "ElitePOS";
export const APP_DESCRIPTION = "Professional Inventory & POS Management System";
export const APP_VERSION = "0.1.0";
export const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] || "http://localhost:3000";

/* ─── Layout ─── */
export const LAYOUT = {
  SIDEBAR_WIDTH: 260,
  SIDEBAR_COLLAPSED_WIDTH: 72,
  HEADER_HEIGHT: 64,
  CONTENT_MAX_WIDTH: 1440,
  MOBILE_BREAKPOINT: 768,
  TABLET_BREAKPOINT: 1024,
  DESKTOP_BREAKPOINT: 1280,
} as const;

/* ─── Pagination ─── */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  PAGE_SIZE_OPTIONS: [10, 20, 50, 100],
  MAX_PAGE_SIZE: 100,
} as const;

/* ─── Currency ─── */
export const CURRENCY = {
  CODE: "USD",
  SYMBOL: "$",
  LOCALE: "en-US",
  DECIMAL_PLACES: 2,
} as const;

/* ─── Date/Time Formats ─── */
export const DATE_FORMATS = {
  SHORT: "MM/dd/yy",
  MEDIUM: "MMM dd, yyyy",
  LONG: "MMMM dd, yyyy",
  FULL: "EEEE, MMMM dd, yyyy",
  ISO: "yyyy-MM-dd",
  DATETIME: "MMM dd, yyyy HH:mm",
  TIME_12: "hh:mm a",
  TIME_24: "HH:mm",
} as const;

/* ─── Roles & Permissions ─── */
export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  MANAGER: "manager",
  CASHIER: "cashier",
  INVENTORY_CLERK: "inventory_clerk",
  VIEWER: "viewer",
} as const;

// NOTE: These strings must stay in sync with the canonical Permission type
// in src/lib/rbac.ts — that module is the single source of truth for what
// each role can do. These constants exist for convenience/reference.
export const PERMISSIONS = {
  // Dashboard
  DASHBOARD_VIEW: "dashboard:view",

  // POS
  POS_VIEW: "pos:view",
  POS_CREATE_ORDER: "pos:create_order",
  POS_APPLY_DISCOUNT: "pos:apply_discount",
  POS_REFUND: "pos:refund",

  // Products
  PRODUCTS_VIEW: "products:view",
  PRODUCTS_CREATE: "products:create",
  PRODUCTS_EDIT: "products:edit",
  PRODUCTS_DELETE: "products:delete",

  // Categories
  CATEGORIES_VIEW: "categories:view",
  CATEGORIES_CREATE: "categories:create",
  CATEGORIES_EDIT: "categories:edit",
  CATEGORIES_DELETE: "categories:delete",

  // Brands
  BRANDS_VIEW: "brands:view",
  BRANDS_CREATE: "brands:create",
  BRANDS_EDIT: "brands:edit",
  BRANDS_DELETE: "brands:delete",

  // Inventory
  INVENTORY_VIEW: "inventory:view",
  INVENTORY_ADJUST: "inventory:adjust",
  INVENTORY_TRANSFER: "inventory:transfer",

  // Orders
  ORDERS_VIEW: "orders:view",
  ORDERS_MANAGE: "orders:manage",
  ORDERS_REFUND: "orders:refund",

  // Customers
  CUSTOMERS_VIEW: "customers:view",
  CUSTOMERS_CREATE: "customers:create",
  CUSTOMERS_EDIT: "customers:edit",
  CUSTOMERS_DELETE: "customers:delete",

  // Suppliers
  SUPPLIERS_VIEW: "suppliers:view",
  SUPPLIERS_CREATE: "suppliers:create",
  SUPPLIERS_EDIT: "suppliers:edit",
  SUPPLIERS_DELETE: "suppliers:delete",

  // Purchase orders
  PURCHASE_ORDERS_VIEW: "purchase_orders:view",
  PURCHASE_ORDERS_CREATE: "purchase_orders:create",
  PURCHASE_ORDERS_CONFIRM: "purchase_orders:confirm",
  PURCHASE_ORDERS_RECEIVE: "purchase_orders:receive",
  PURCHASE_ORDERS_CANCEL: "purchase_orders:cancel",

  // Reports
  REPORTS_VIEW: "reports:view",
  REPORTS_EXPORT: "reports:export",

  // Users
  USERS_VIEW: "users:view",
  USERS_CREATE: "users:create",
  USERS_EDIT: "users:edit",
  USERS_DELETE: "users:delete",

  // Settings
  SETTINGS_VIEW: "settings:view",
  SETTINGS_EDIT: "settings:edit",
} as const;

/* ─── Product Status ─── */
export const PRODUCT_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  DISCONTINUED: "discontinued",
} as const;

/* ─── Order Status ─── */
export const ORDER_STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  PROCESSING: "processing",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
} as const;

/* ─── Payment Methods ─── */
export const PAYMENT_METHODS = {
  CASH: "cash",
  CREDIT_CARD: "credit_card",
  DEBIT_CARD: "debit_card",
  DIGITAL_WALLET: "digital_wallet",
  BANK_TRANSFER: "bank_transfer",
  STORE_CREDIT: "store_credit",
} as const;

/* ─── Transaction Types ─── */
export const TRANSACTION_TYPES = {
  SALE: "sale",
  RETURN: "return",
  REFUND: "refund",
  EXCHANGE: "exchange",
  ADJUSTMENT: "adjustment",
} as const;

/* ─── Inventory Movement Types ─── */
export const INVENTORY_MOVEMENT = {
  PURCHASE: "purchase",
  SALE: "sale",
  RETURN: "return",
  ADJUSTMENT: "adjustment",
  TRANSFER: "transfer",
  DAMAGED: "damaged",
  EXPIRED: "expired",
  COUNT: "count",
} as const;

/* ─── Tax Configuration ─── */
export const TAX = {
  DEFAULT_RATE: 0,
  INCLUSIVE: false,
  LABEL: "Tax",
} as const;

/* ─── Receipt / Print ─── */
export const RECEIPT = {
  WIDTH_MM: 80,
  PAPER_WIDTH: 312, // 80mm thermal printer at 96dpi
  HEADER_LINES: 6,
  FOOTER_LINES: 4,
} as const;

/* ─── Keyboard Shortcuts (POS) ─── */
export const SHORTCUTS = {
  POS_NEW_TRANSACTION: "F2",
  POS_SEARCH_PRODUCT: "F3",
  POS_HOLD_TRANSACTION: "F5",
  POS_RECALL_TRANSACTION: "F6",
  POS_PAYMENT: "F8",
  POS_VOID: "F9",
  POS_DISCOUNT: "F10",
  GLOBAL_SEARCH: "Ctrl+K",
  GLOBAL_SHORTCUTS_HELP: "Ctrl+/",
} as const;

/* ─── Navigation ─── */
export interface NavItem {
  label: string;
  href: string;
  icon: string;
  i18n?: string;
}

export const NAVIGATION: {
  MAIN: NavItem[];
  REPORTS: NavItem[];
  SETTINGS: NavItem[];
} = {
  MAIN: [
    { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard", i18n: "nav.dashboard" },
    { label: "Point of Sale", href: "/pos", icon: "Monitor", i18n: "nav.pos" },
    { label: "Products", href: "/products", icon: "Package", i18n: "nav.products" },
    { label: "Inventory", href: "/inventory", icon: "Warehouse", i18n: "nav.inventory" },
    { label: "Orders", href: "/orders", icon: "ShoppingBag", i18n: "nav.orders" },
    { label: "Refunds", href: "/refunds", icon: "RotateCcw", i18n: "nav.refunds" },
    { label: "Customers", href: "/customers", icon: "Users", i18n: "nav.customers" },
    { label: "Suppliers", href: "/suppliers", icon: "Truck", i18n: "nav.suppliers" },
    { label: "Purchase Orders", href: "/purchase-orders", icon: "ClipboardDocumentList", i18n: "nav.purchaseOrders" },
  ],
  REPORTS: [
    { label: "Sales Report", href: "/reports/sales", icon: "BarChart3", i18n: "reports.salesReport" },
    { label: "Inventory Report", href: "/reports/inventory", icon: "ClipboardList", i18n: "reports.inventoryReport" },
    { label: "Profit & Loss", href: "/reports/profit-loss", icon: "TrendingUp", i18n: "reports.profitLoss" },
  ],
  SETTINGS: [
    { label: "General", href: "/settings", icon: "Settings", i18n: "settings.title" },
    { label: "Users", href: "/users", icon: "Users", i18n: "nav.users" },
    { label: "Receipts", href: "/settings/receipts", icon: "Receipt", i18n: "" },
    { label: "Audit Log", href: "/settings/audit-log", icon: "ClipboardDocumentList", i18n: "" },
  ],
};
