/* ═══════════════════════════════════════════════════════════════
   CORE DOMAIN TYPES
   Single source of truth for all TypeScript interfaces.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Base Types ─── */
export type ID = string;
export type Timestamp = string; // ISO 8601
export type Currency = number; // Amount in smallest unit (cents)

/* ─── Base Entity (all models extend this) ─── */
export interface BaseEntity {
  id: ID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/* ═══════════════════════════════════════════════════════════════
   USER & AUTH TYPES
   ═══════════════════════════════════════════════════════════════ */

export type Role =
  | "super_admin"
  | "admin"
  | "manager"
  | "cashier"
  | "inventory_clerk"
  | "viewer";

export interface User extends BaseEntity {
  email: string;
  name: string;
  role: Role;
  avatarUrl?: string;
  isActive: boolean;
  lastLoginAt?: Timestamp;
}

/* ═══════════════════════════════════════════════════════════════
   PRODUCT TYPES
   ═══════════════════════════════════════════════════════════════ */

export type ProductStatus = "active" | "inactive" | "discontinued";

export interface Category extends BaseEntity {
  name: string;
  slug: string;
  description?: string;
  parentId?: ID;
  imageUrl?: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Brand extends BaseEntity {
  name: string;
  slug: string;
  logoUrl?: string;
  isActive: boolean;
}

export interface Product extends BaseEntity {
  name: string;
  slug: string;
  sku: string;
  barcode?: string;
  description?: string;
  categoryId: ID;
  brandId?: ID;
  unitPrice: Currency;
  costPrice: Currency;
  compareAtPrice?: Currency;
  taxRate: number;
  imageUrl?: string;
  images?: string[];
  status: ProductStatus;
  tags?: string[];
  weight?: number;
  dimensions?: ProductDimensions;
  trackInventory: boolean;
  allowDiscount: boolean;
  minStockLevel: number;
  maxStockLevel?: number;
  // Multi-unit support
  unit?: string;
  allowFractional?: boolean;
  sellByValue?: boolean;
}

export interface ProductDimensions {
  length?: number;
  width?: number;
  height?: number;
  unit: "mm" | "cm" | "in";
}

export interface ProductVariant extends BaseEntity {
  productId: ID;
  name: string;
  sku: string;
  barcode?: string;
  unitPrice: Currency;
  costPrice: Currency;
  imageUrl?: string;
  options: Record<string, string>; // e.g., { color: "Red", size: "XL" }
  isActive: boolean;
}

/* ═══════════════════════════════════════════════════════════════
   INVENTORY TYPES
   ═══════════════════════════════════════════════════════════════ */

export interface StockLevel extends BaseEntity {
  productId: ID;
  variantId?: ID;
  warehouseId: ID;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number; // Computed: quantity - reservedQuantity
}

export interface Warehouse extends BaseEntity {
  name: string;
  code: string;
  address?: string;
  isActive: boolean;
  isDefault: boolean;
}

export interface StockTransferItem {
  id: ID;
  productId: ID;
  variantId?: ID;
  quantity: number;
  receivedQuantity?: number;
}

/* ═══════════════════════════════════════════════════════════════
   ORDER & POS TYPES
   ═══════════════════════════════════════════════════════════════ */

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "processing"
  | "completed"
  | "cancelled"
  | "refunded"
  | "partially_refunded";

export type PaymentMethod =
  | "cash"
  | "credit_card"
  | "debit_card"
  | "digital_wallet"
  | "bank_transfer"
  | "store_credit";

export type TransactionType = "sale" | "return" | "refund" | "exchange" | "adjustment";

export interface Order extends BaseEntity {
  orderNumber: string;
  customerId?: ID;
  userId: ID; // Cashier/employee who created it
  warehouseId: ID;
  status: OrderStatus;
  type: TransactionType;
  subtotal: Currency;
  taxAmount: Currency;
  discountAmount: Currency;
  total: Currency;
  paidAmount: Currency;
  changeAmount: Currency;
  notes?: string;
  receiptPrinted: boolean;
}

export interface OrderItem {
  id: ID;
  orderId: ID;
  productId: ID;
  variantId?: ID;
  productName: string;
  sku: string;
  quantity: number;
  unit?: string; // Sale unit (kg, g, L, pcs...)
  unitPrice: Currency;
  costPrice: Currency;
  discountAmount: Currency;
  taxRate: number;
  taxAmount: Currency;
  total: Currency;
}

export interface Payment extends BaseEntity {
  orderId: ID;
  method: PaymentMethod;
  amount: Currency;
  reference?: string; // Transaction reference for card payments
  status: "pending" | "completed" | "failed" | "refunded";
}

/* ─── POS-Specific Types ─── */
export interface CartItem {
  id: ID;
  productId: ID;
  variantId?: ID;
  productName: string;
  sku: string;
  imageUrl?: string;
  quantity: number;
  unit?: string; // Quantity is expressed in this base unit (kg, g, L, pcs...)
  allowFractional?: boolean;
  sellByValue?: boolean;
  unitConversions?: string; // Raw JSON from the product row
  stockAvailable?: number; // Snapshot used to clamp edits
  unitPrice: Currency;
  costPrice: Currency;
  discountType: "percentage" | "fixed";
  discountValue: number;
  discountAmount: Currency;
  taxRate: number;
  taxAmount: Currency;
  total: Currency;
}

export interface Cart {
  id: ID;
  items: CartItem[];
  customerId?: ID;
  customerName?: string;
  subtotal: Currency;
  taxAmount: Currency;
  discountAmount: Currency;
  total: Currency;
  itemQuantity: number;
}

export interface Transaction {
  cart: Cart;
  paymentMethod: PaymentMethod;
  amountPaid: Currency;
  changeDue: Currency;
  userId: ID;
  warehouseId: ID;
  timestamp: Timestamp;
}

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER TYPES
   ═══════════════════════════════════════════════════════════════ */

export interface Customer extends BaseEntity {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  taxId?: string;
  notes?: string;
  loyaltyPoints: number;
  totalSpent: Currency;
  orderCount: number;
  isActive: boolean;
}

/* ═══════════════════════════════════════════════════════════════
   API & QUERY TYPES
   ═══════════════════════════════════════════════════════════════ */

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS TYPES
   ═══════════════════════════════════════════════════════════════ */

export interface StoreSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeEmail?: string;
  taxRate: number;
  taxInclusive: boolean;
  currency: string;
  receiptHeader?: string;
  receiptFooter?: string;
  lowStockThreshold: number;
}
