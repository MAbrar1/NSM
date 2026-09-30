import { z } from "zod";

/* ═══════════════════════════════════════════════════════════════
   VALIDATION SCHEMAS
   Centralized Zod schemas for form validation and API input.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Shared Fragments ─── */
export const idSchema = z.string().min(1, "ID is required");
export const emailSchema = z.string().email("Invalid email address");
export const phoneSchema = z
  .string()
  .regex(/^\+?[\d\s-()]{7,20}$/, "Invalid phone number")
  .optional()
  .or(z.literal(""));
export const priceSchema = z
  .number()
  .min(0, "Price must be non-negative")
  .multipleOf(0.01, "Price must have at most 2 decimal places");
export const positiveIntSchema = z.number().int().min(0, "Must be zero or positive");
export const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format");

/* ─── Auth Schemas ─── */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const registerSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(100),
    email: emailSchema,
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain at least one uppercase letter")
      .regex(/[a-z]/, "Must contain at least one lowercase letter")
      .regex(/[0-9]/, "Must contain at least one number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

/* ─── Product Schemas ─── */
export const productSchema = z.object({
  name: z.string().min(1, "Product name is required").max(200),
  sku: z.string().min(1, "SKU is required").max(50),
  barcode: z.string().max(50).optional().or(z.literal("")),
  description: z.string().max(2000).optional().or(z.literal("")),
  categoryId: idSchema,
  brandId: idSchema.optional().or(z.literal("")),
  unitPrice: priceSchema,
  costPrice: priceSchema,
  compareAtPrice: priceSchema.optional(),
  taxRate: z.number().min(0).max(100).default(0),
  status: z.enum(["active", "inactive", "discontinued"]).default("active"),
  tags: z.array(z.string()).optional(),
  trackInventory: z.boolean().default(true),
  allowDiscount: z.boolean().default(true),
  minStockLevel: z.number().int().min(0).default(5),
  maxStockLevel: z.number().int().min(0).optional(),
  unit: z.string().min(1).max(20).default("pcs"),
  allowFractional: z.boolean().default(false),
  sellByValue: z.boolean().default(false),
  unitConversions: z.array(z.object({
    unit: z.string().min(1).max(20),
    factor: z.number().min(0),
  })).optional(),
});

export const productSearchSchema = z.object({
  search: z.string().optional(),
  categoryId: idSchema.optional(),
  brandId: idSchema.optional(),
  status: z.enum(["active", "inactive", "discontinued"]).optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  inStock: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/* Bulk operations over a selection of products. Each action is applied
   identically to every id in `ids`; values are optional so the API can
   distinguish "not provided" from "clear it". */
export const bulkUpdateSchema = z.object({
  ids: z.array(idSchema).min(1, "Select at least one product").max(200),
  status: z.enum(["active", "inactive", "discontinued"]).optional(),
  categoryId: idSchema.optional(),
});

export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;

export type ProductInput = z.infer<typeof productSchema>;
export type ProductSearchParams = z.infer<typeof productSearchSchema>;

/* ─── Category Schemas ─── */
export const categorySchema = z.object({
  name: z.string().min(1, "Category name is required").max(100),
  description: z.string().max(500).optional().or(z.literal("")),
  parentId: idSchema.optional().or(z.literal("")),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export type CategoryInput = z.infer<typeof categorySchema>;

/* ─── Order Schemas ─── */
export const orderItemSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  // Fractional allowed for weight/volume products (e.g. 0.385 kg)
  quantity: z.number().positive("Quantity must be greater than 0"),
  unitPrice: priceSchema,
  discountType: z.enum(["percentage", "fixed"]).optional(),
  discountValue: z.number().min(0).optional(),
});

export const orderSchema = z.object({
  customerId: idSchema.optional(),
  warehouseId: idSchema,
  items: z.array(orderItemSchema).min(1, "At least one item is required"),
  notes: z.string().max(500).optional(),
});

export type OrderInput = z.infer<typeof orderSchema>;

/* ─── Cart Schemas ─── */
export const addToCartSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  quantity: z.number().positive().default(1),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0, "Quantity cannot be negative"),
  discountType: z.enum(["percentage", "fixed"]).optional(),
  discountValue: z.number().min(0).optional(),
});

/* ─── Customer Schemas ─── */
export const customerSchema = z.object({
  name: z.string().min(1, "Customer name is required").max(200),
  email: emailSchema.optional().or(z.literal("")),
  phone: phoneSchema,
  address: z.string().max(500).optional().or(z.literal("")),
  taxId: z.string().max(50).optional().or(z.literal("")),
  notes: z.string().max(500).optional().or(z.literal("")),
});

export type CustomerInput = z.infer<typeof customerSchema>;

/* ─── Warehouse Schemas ─── */
export const warehouseSchema = z.object({
  name: z.string().min(1, "Warehouse name is required").max(100),
  code: z
    .string()
    .min(1, "Warehouse code is required")
    .max(20)
    .regex(/^[A-Z0-9-]+$/, "Code must be uppercase alphanumeric"),
  address: z.string().max(500).optional().or(z.literal("")),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export type WarehouseInput = z.infer<typeof warehouseSchema>;

/* ─── Settings Schemas ─── */
export const storeSettingsSchema = z.object({
  storeName: z.string().min(1, "Store name is required").max(200),
  storeAddress: z.string().max(500).optional().or(z.literal("")),
  storePhone: phoneSchema,
  storeEmail: emailSchema.optional().or(z.literal("")),
  taxRate: z.number().min(0).max(100).default(0),
  taxInclusive: z.boolean().default(false),
  currency: z.string().min(3).max(3).default("USD"),
  receiptHeader: z.string().max(500).optional().or(z.literal("")),
  receiptFooter: z.string().max(500).optional().or(z.literal("")),
  // QR payment payload printed at the foot of POS receipts (e.g. a payment
  // link or wallet deep-link). Empty string => QR line is disabled.
  receiptQrPayment: z.string().max(500).optional().or(z.literal("")),
  // Receipt digit style: false (default) = Western numerals 0-9 (standard
  // Pakistani retail convention); true = Urdu-Indic ۰-۹ on receipts.
  receiptUrduDigits: z.boolean().default(false),
  lowStockThreshold: z.number().int().min(0).default(5),
  allowPublicRegistration: z.boolean().default(false),
  // JSON array of custom refund-reason strings; null/"" means "use the
  // built-in localized presets" in the refund dialog.
  refundReasonPresets: z.string().max(4000).optional().or(z.literal("")),
  // Webhook notification config
  webhookUrl: z.string().url("Invalid webhook URL").optional().or(z.literal("")),
  webhookSecret: z.string().max(200).optional().or(z.literal("")),
  // SMTP email config
  smtpHost: z.string().max(200).optional().or(z.literal("")),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpUser: z.string().max(200).optional().or(z.literal("")),
  smtpPassword: z.string().max(200).optional().or(z.literal("")),
  smtpFromEmail: emailSchema.optional().or(z.literal("")),
  smtpFromName: z.string().max(100).optional().or(z.literal("")),
  smtpUseTls: z.boolean().default(true),
  // Notification preferences
  lowStockNotifyWebhook: z.boolean().default(false),
  lowStockNotifyEmail: z.boolean().default(false),
  lowStockNotifyAdmins: z.boolean().default(true),
  // Scheduled low-stock scanning
  lowStockSchedulerEnabled: z.boolean().default(true),
  lowStockCooldownHours: z.number().min(0.5).max(24 * 30).default(6),
  lowStockMinQuantity: z.number().min(0).optional().nullable(),
  // Opt-in early restock warnings — additive alerts that never enter the
  // low-stock counts (see lib/low-stock scanRestockSoon).
  lowStockRunningLowAlerts: z.boolean().default(false),
});

export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;

/* ─── User Schemas ─── */
export const userSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: emailSchema,
  role: z.enum([
    "super_admin",
    "admin",
    "manager",
    "cashier",
    "inventory_clerk",
    "viewer",
  ]),
  isActive: z.boolean().default(true),
});

export type UserInput = z.infer<typeof userSchema>;

/* ─── Brand Schemas ─── */
export const brandSchema = z.object({
  name: z.string().min(1, "Brand name is required").max(100),
  logoUrl: z.string().max(500).optional().or(z.literal("")),
  isActive: z.boolean().default(true),
});

export type BrandInput = z.infer<typeof brandSchema>;

/* ─── Supplier Schemas ─── */
export const supplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required").max(200),
  email: emailSchema.optional().or(z.literal("")),
  phone: phoneSchema,
  address: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  country: z.string().max(100).optional().or(z.literal("")),
  taxId: z.string().max(50).optional().or(z.literal("")),
  paymentTerms: z.number().int().min(0).max(365).default(30),
  rating: z.number().min(0).max(5).default(0),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

export type SupplierInput = z.infer<typeof supplierSchema>;
