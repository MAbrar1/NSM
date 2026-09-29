import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { recomputeCustomerRollups } from "@/lib/customer-rollups";

/* ═══════════════════════════════════════════════
   SHARED SEED RUNNER - COMPREHENSIVE MOCK DATA
   Exported so both the CLI entry point
   (prisma/seed.ts) and the /api/seed route can
   invoke the same logic without duplicating it.
   ═══════════════════════════════════════════════ */

const prisma = new PrismaClient();

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function seededRand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

export async function runSeed(): Promise<Record<string, number>> {
  console.log("🌱 Seeding database with COMPREHENSIVE mock data (SEED=1)...\n");

  console.log("  Cleaning existing data...");
  // Delete in reverse-dependency order so foreign-key constraints don't
  // fire. Child tables first, then parents.
  await prisma.purchaseOrderPayment.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.inventoryMovement.deleteMany();
  await prisma.stockTransferItem.deleteMany();
  await prisma.stockTransfer.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.stockAlertLog.deleteMany();
  await prisma.storeSettings.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.user.deleteMany();
  console.log("  ✓ Data cleaned\n");

  // ============================================
  // USERS - All roles represented
  // ============================================
  console.log("  Creating users (all roles)...");
  const hashedPassword = await bcrypt.hash("Admin@123", 12);
  const cashierPassword = await bcrypt.hash("Cashier@123", 12);

  const superAdmin = await prisma.user.create({
    data: {
      name: "Super Admin",
      email: "admin@elitepos.com",
      password: hashedPassword,
      role: "super_admin",
      isActive: true,
    },
  });
  // Admin user is part of the demo story (see the credentials summary at
  // the end) even though the seed body itself never references the row.
  await prisma.user.create({
    data: {
      name: "James Administrator",
      email: "admin2@elitepos.com",
      password: hashedPassword,
      role: "admin",
      isActive: true,
    },
  });
  const manager = await prisma.user.create({
    data: {
      name: "Sarah Manager",
      email: "manager@elitepos.com",
      password: hashedPassword,
      role: "manager",
      isActive: true,
    },
  });
  const cashier1 = await prisma.user.create({
    data: {
      name: "Ahmed Cashier",
      email: "ahmed@elitepos.com",
      password: cashierPassword,
      role: "cashier",
      isActive: true,
    },
  });
  const cashier2 = await prisma.user.create({
    data: {
      name: "Lisa Cashier",
      email: "lisa@elitepos.com",
      password: cashierPassword,
      role: "cashier",
      isActive: true,
    },
  });
  const inventoryClerk = await prisma.user.create({
    data: {
      name: "Mike Inventory",
      email: "mike@elitepos.com",
      password: cashierPassword,
      role: "inventory_clerk",
      isActive: true,
    },
  });
  await prisma.user.create({
    data: {
      name: "Tom Viewer",
      email: "viewer@elitepos.com",
      password: cashierPassword,
      role: "viewer",
      isActive: true,
    },
  });
  console.log("  ✓ 7 users created (super_admin, admin, manager, 2 cashiers, inventory_clerk, viewer)\n");

  // ============================================
  // WAREHOUSES - Multiple locations
  // ============================================
  console.log("  Creating warehouses...");
  const mainWarehouse = await prisma.warehouse.create({
    data: {
      name: "Main Warehouse",
      code: "WH-MAIN",
      address: "123 Industrial Blvd, Suite 100",
      isActive: true,
      isDefault: true,
    },
  });
  const storeRoom = await prisma.warehouse.create({
    data: {
      name: "Store Room",
      code: "WH-STORE",
      address: "Ground Floor, Back Section",
      isActive: true,
      isDefault: false,
    },
  });
  const coldStorage = await prisma.warehouse.create({
    data: {
      name: "Cold Storage Unit",
      code: "WH-COLD",
      address: "Basement Level 1, Temperature Controlled",
      isActive: true,
      isDefault: false,
    },
  });
  console.log("  ✓ 3 warehouses created (main, store room, cold storage)\n");

  // ============================================
  // BRANDS - 15 diverse brands
  // ============================================
  console.log("  Creating brands...");
  const brandData = [
    "Coca-Cola",
    "PepsiCo",
    "Nestlé",
    "Kraft Heinz",
    "General Mills",
    "Kellogg's",
    "Unilever",
    "Procter & Gamble",
    "Danone",
    "Mars",
    "Mondelez",
    "Frito-Lay",
    "Tyson Foods",
    "Dean Foods",
    "Dole",
    // Brands added so every seeded product maps to its real owner
    "Red Bull",
    "Kikkoman",
    "Campbell's",
    "Conagra Brands",
    "Colgate-Palmolive",
    "Clorox",
    "Abbott",
  ];
  const brands: Array<{ id: string }> = [];
  for (const name of brandData) {
    const b = await prisma.brand.create({
      data: { name: name.trim(), slug: slugify(name.trim()), isActive: true },
    });
    brands.push(b);
  }
  console.log(`  ✓ ${brands.length} brands created\n`);

  // ============================================
  // CATEGORIES - Hierarchical structure
  // ============================================
  console.log("  Creating categories...");
  const categoryData = [
    { name: "Beverages", sortOrder: 1 },
    { name: "Snacks & Chips", sortOrder: 2 },
    { name: "Dairy & Eggs", sortOrder: 3 },
    { name: "Bakery", sortOrder: 4 },
    { name: "Produce", sortOrder: 5 },
    { name: "Meat & Seafood", sortOrder: 6 },
    { name: "Frozen Foods", sortOrder: 7 },
    { name: "Canned Goods", sortOrder: 8 },
    { name: "Condiments & Sauces", sortOrder: 9 },
    { name: "Personal Care", sortOrder: 10 },
    { name: "Household", sortOrder: 11 },
    { name: "Baby Products", sortOrder: 12 },
  ];
  const categories: Array<{ id: string }> = [];
  for (const cat of categoryData) {
    const c = await prisma.category.create({
      data: {
        name: cat.name,
        slug: slugify(cat.name),
        sortOrder: cat.sortOrder,
        isActive: true,
      },
    });
    categories.push(c);
  }
  console.log(`  ✓ ${categories.length} categories created\n`);

  // ============================================
  // PRODUCTS - 50+ products with varied stock levels
  // ============================================
  console.log("  Creating products...");

  interface ProductDef {
    name: string;
    sku: string;
    categoryIndex: number;
    brandIndex?: number;
    unitPrice: number;
    costPrice: number;
    taxRate: number;
    minStock: number;
    maxStock?: number;
    unit?: string;
    allowFractional?: boolean;
    sellByValue?: boolean;
    stockLevel: "in_stock" | "low_stock" | "out_of_stock" | "overstocked";
    stockQty?: number;
    tags?: string[];
  }

  const productDefs: ProductDef[] = [
    // BEVERAGES (0) - Mix of stock levels
    {
      name: "Coca-Cola Classic 330ml",
      sku: "BEV-0001",
      categoryIndex: 0,
      brandIndex: 0,
      unitPrice: 149,
      costPrice: 85,
      taxRate: 0,
      minStock: 24,
      maxStock: 100,
      stockLevel: "in_stock",
      stockQty: 50,
      tags: ["cold", "carbonated", "popular"],
    },
    {
      name: "Pepsi Cola 330ml",
      sku: "BEV-0002",
      categoryIndex: 0,
      brandIndex: 1,
      unitPrice: 149,
      costPrice: 82,
      taxRate: 0,
      minStock: 24,
      maxStock: 100,
      stockLevel: "low_stock",
      stockQty: 15,
      tags: ["cold", "carbonated"],
    },
    {
      name: "Sprite Lemon 330ml",
      sku: "BEV-0003",
      categoryIndex: 0,
      brandIndex: 0,
      unitPrice: 149,
      costPrice: 85,
      taxRate: 0,
      minStock: 24,
      maxStock: 100,
      stockLevel: "in_stock",
      stockQty: 45,
    },
    {
      name: "Fanta Orange 330ml",
      sku: "BEV-0004",
      categoryIndex: 0,
      brandIndex: 0,
      unitPrice: 149,
      costPrice: 85,
      taxRate: 0,
      minStock: 18,
      maxStock: 80,
      stockLevel: "in_stock",
      stockQty: 35,
    },
    {
      name: "Nestlé Pure Life Water 1.5L",
      sku: "BEV-0005",
      categoryIndex: 0,
      brandIndex: 2,
      unitPrice: 99,
      costPrice: 45,
      taxRate: 0,
      minStock: 48,
      maxStock: 200,
      stockLevel: "overstocked",
      stockQty: 250,
    },
    {
      name: "Minute Maid Orange Juice 1L",
      sku: "BEV-0006",
      categoryIndex: 0,
      brandIndex: 0,
      unitPrice: 299,
      costPrice: 180,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "low_stock",
      stockQty: 8,
      tags: ["refrigerated"],
    },
    {
      name: "Tropicana Apple Juice 1L",
      sku: "BEV-0007",
      categoryIndex: 0,
      brandIndex: 1,
      unitPrice: 349,
      costPrice: 210,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["refrigerated"],
    },
    {
      name: "Red Bull Energy 250ml",
      sku: "BEV-0008",
      categoryIndex: 0,
      brandIndex: 15, // Red Bull
      unitPrice: 249,
      costPrice: 150,
      taxRate: 0,
      minStock: 24,
      maxStock: 100,
      stockLevel: "in_stock",
      stockQty: 60,
      tags: ["popular"],
    },
    // SNACKS (1)
    {
      name: "Lay's Classic Chips 150g",
      sku: "SNK-0001",
      categoryIndex: 1,
      brandIndex: 11,
      unitPrice: 329,
      costPrice: 190,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "in_stock",
      stockQty: 40,
      tags: ["popular", "shelf_stable"],
    },
    {
      name: "Doritos Nacho Cheese 140g",
      sku: "SNK-0002",
      categoryIndex: 1,
      brandIndex: 11,
      unitPrice: 349,
      costPrice: 200,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "in_stock",
      stockQty: 30,
    },
    {
      name: "Oreo Original Cookies 137g",
      sku: "SNK-0003",
      categoryIndex: 1,
      brandIndex: 10,
      unitPrice: 299,
      costPrice: 160,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "low_stock",
      stockQty: 10,
      tags: ["popular"],
    },
    {
      name: "Pringles Original 165g",
      sku: "SNK-0004",
      categoryIndex: 1,
      brandIndex: 5, // Kellogg's owns Pringles
      unitPrice: 399,
      costPrice: 230,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "in_stock",
      stockQty: 25,
    },
    {
      name: "KitKat Chocolate Bar 4-Finger",
      sku: "SNK-0005",
      categoryIndex: 1,
      brandIndex: 2, // Nestlé owns KitKat
      unitPrice: 199,
      costPrice: 110,
      taxRate: 0,
      minStock: 30,
      maxStock: 120,
      stockLevel: "overstocked",
      stockQty: 150,
    },
    {
      name: "M&M's Peanut Chocolate 150g",
      sku: "SNK-0006",
      categoryIndex: 1,
      brandIndex: 9, // Mars owns M&M's
      unitPrice: 399,
      costPrice: 220,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "in_stock",
      stockQty: 20,
    },
    {
      name: "Snickers Bar 50g",
      sku: "SNK-0007",
      categoryIndex: 1,
      brandIndex: 9, // Mars owns Snickers
      unitPrice: 149,
      costPrice: 80,
      taxRate: 0,
      minStock: 36,
      maxStock: 150,
      stockLevel: "in_stock",
      stockQty: 80,
    },
    // DAIRY (2) - Some refrigerated items low
    {
      name: "Whole Milk 1 Gallon",
      sku: "DRY-0001",
      categoryIndex: 2,
      brandIndex: 8,
      unitPrice: 449,
      costPrice: 310,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "low_stock",
      stockQty: 6,
      tags: ["refrigerated", "popular"],
    },
    {
      name: "2% Reduced Fat Milk 1 Gallon",
      sku: "DRY-0002",
      categoryIndex: 2,
      brandIndex: 8,
      unitPrice: 429,
      costPrice: 290,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 15,
      tags: ["refrigerated"],
    },
    {
      name: "Large Eggs 12 Count",
      sku: "DRY-0003",
      categoryIndex: 2,
      brandIndex: 13,
      unitPrice: 399,
      costPrice: 250,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "in_stock",
      stockQty: 30,
      tags: ["refrigerated", "popular"],
    },
    {
      name: "Cheddar Cheese Block 200g",
      sku: "DRY-0004",
      categoryIndex: 2, // generic dairy — no brand
      unitPrice: 549,
      costPrice: 340,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["refrigerated"],
    },
    {
      name: "Greek Yogurt Plain 500g",
      sku: "DRY-0005",
      categoryIndex: 2,
      brandIndex: 8,
      unitPrice: 499,
      costPrice: 300,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 18,
      tags: ["refrigerated"],
    },
    {
      name: "Butter Unsalted 250g",
      sku: "DRY-0006",
      categoryIndex: 2, // generic dairy — no brand
      unitPrice: 599,
      costPrice: 380,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "low_stock",
      stockQty: 5,
      tags: ["refrigerated"],
    },
    // BAKERY (3)
    {
      name: "White Sandwich Bread 20oz",
      sku: "BKR-0001",
      categoryIndex: 3, // in-store bakery — no brand
      unitPrice: 299,
      costPrice: 140,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 20,
      tags: ["fresh"],
    },
    {
      name: "Whole Wheat Bread 20oz",
      sku: "BKR-0002",
      categoryIndex: 3, // in-store bakery — no brand
      unitPrice: 349,
      costPrice: 170,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "low_stock",
      stockQty: 5,
      tags: ["fresh"],
    },
    {
      name: "Croissants 4 Pack",
      sku: "BKR-0003",
      categoryIndex: 3, // in-store bakery — no brand
      unitPrice: 449,
      costPrice: 250,
      taxRate: 0,
      minStock: 6,
      maxStock: 24,
      stockLevel: "in_stock",
      stockQty: 12,
      tags: ["fresh"],
    },
    {
      name: "Chocolate Muffins 4 Pack",
      sku: "BKR-0004",
      categoryIndex: 3, // in-store bakery — no brand
      unitPrice: 499,
      costPrice: 280,
      taxRate: 0,
      minStock: 6,
      maxStock: 24,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["fresh"],
    },
    // PRODUCE (4)
    {
      name: "Bananas per lb",
      sku: "PRD-0001",
      categoryIndex: 4,
      brandIndex: 14,
      unitPrice: 79,
      costPrice: 30,
      taxRate: 0,
      minStock: 50,
      maxStock: 200,
      stockLevel: "in_stock",
      stockQty: 80,
      tags: ["fresh", "popular"],
    },
    {
      name: "Red Apples 3lb Bag",
      sku: "PRD-0002",
      categoryIndex: 4,
      brandIndex: 14,
      unitPrice: 499,
      costPrice: 280,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "in_stock",
      stockQty: 25,
      tags: ["fresh"],
    },
    {
      name: "Avocados Each",
      sku: "PRD-0003",
      categoryIndex: 4,
      brandIndex: 14,
      unitPrice: 149,
      costPrice: 70,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "low_stock",
      stockQty: 12,
      tags: ["fresh"],
    },
    {
      name: "Baby Spinach 5oz",
      sku: "PRD-0004",
      categoryIndex: 4,
      brandIndex: 14,
      unitPrice: 399,
      costPrice: 220,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 15,
      tags: ["fresh"],
    },
    {
      name: "Roma Tomatoes 1lb",
      sku: "PRD-0005",
      categoryIndex: 4, // generic produce — no brand
      unitPrice: 199,
      costPrice: 90,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["fresh"],
    },
    // MEAT (5) - All refrigerated, mixed stock
    {
      name: "Chicken Breast Boneless 1lb",
      sku: "MPT-0001",
      categoryIndex: 5,
      brandIndex: 12,
      unitPrice: 599,
      costPrice: 350,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 18,
      tags: ["refrigerated", "popular"],
    },
    {
      name: "Ground Beef 80/20 1lb",
      sku: "MPT-0002",
      categoryIndex: 5,
      brandIndex: 12,
      unitPrice: 699,
      costPrice: 420,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "low_stock",
      stockQty: 7,
      tags: ["refrigerated"],
    },
    {
      name: "Salmon Fillet 12oz",
      sku: "MPT-0003",
      categoryIndex: 5, // generic seafood — no brand
      unitPrice: 899,
      costPrice: 550,
      taxRate: 0,
      minStock: 6,
      maxStock: 20,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["refrigerated"],
    },
    {
      name: "Pork Chops Bone-in 1lb",
      sku: "MPT-0004",
      categoryIndex: 5,
      brandIndex: 12,
      unitPrice: 549,
      costPrice: 320,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "in_stock",
      stockQty: 12,
      tags: ["refrigerated"],
    },
    // FROZEN (6)
    {
      name: "Ben & Jerry's Ice Cream Pint",
      sku: "FRZ-0001",
      categoryIndex: 6,
      brandIndex: 10,
      unitPrice: 699,
      costPrice: 400,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "in_stock",
      stockQty: 15,
      tags: ["frozen", "popular"],
    },
    {
      name: "Frozen Pizza Margherita",
      sku: "FRZ-0002",
      categoryIndex: 6,
      brandIndex: 4,
      unitPrice: 599,
      costPrice: 300,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 22,
      tags: ["frozen"],
    },
    {
      name: "Frozen Mixed Vegetables 16oz",
      sku: "FRZ-0003",
      categoryIndex: 6, // generic frozen — no brand
      unitPrice: 249,
      costPrice: 120,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "overstocked",
      stockQty: 80,
      tags: ["frozen"],
    },
    // CANNED GOODS (7)
    {
      name: "Campbell's Chicken Soup 10.5oz",
      sku: "CND-0001",
      categoryIndex: 7,
      brandIndex: 17, // Campbell's
      unitPrice: 179,
      costPrice: 80,
      taxRate: 0,
      minStock: 24,
      maxStock: 100,
      stockLevel: "in_stock",
      stockQty: 45,
      tags: ["shelf_stable"],
    },
    {
      name: "Hunt's Tomato Sauce 15oz",
      sku: "CND-0002",
      categoryIndex: 7,
      brandIndex: 18, // Conagra Brands owns Hunt's
      unitPrice: 149,
      costPrice: 60,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "in_stock",
      stockQty: 35,
      tags: ["shelf_stable"],
    },
    {
      name: "Green Beans Canned 14.5oz",
      sku: "CND-0003",
      categoryIndex: 7, // generic canned — no brand
      unitPrice: 129,
      costPrice: 50,
      taxRate: 0,
      minStock: 20,
      maxStock: 80,
      stockLevel: "low_stock",
      stockQty: 15,
      tags: ["shelf_stable"],
    },
    // CONDIMENTS (8)
    {
      name: "Heinz Ketchup 20oz",
      sku: "CND-0004",
      categoryIndex: 8,
      brandIndex: 3,
      unitPrice: 399,
      costPrice: 200,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "in_stock",
      stockQty: 25,
      tags: ["shelf_stable", "popular"],
    },
    {
      name: "French's Yellow Mustard 14oz",
      sku: "CND-0005",
      categoryIndex: 8,
      brandIndex: 3,
      unitPrice: 299,
      costPrice: 140,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "in_stock",
      stockQty: 20,
      tags: ["shelf_stable"],
    },
    {
      name: "Soy Sauce Kikkoman 15oz",
      sku: "CND-0006",
      categoryIndex: 8,
      brandIndex: 16, // Kikkoman
      unitPrice: 449,
      costPrice: 250,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "low_stock",
      stockQty: 5,
      tags: ["shelf_stable"],
    },
    // PERSONAL CARE (9)
    {
      name: "Colgate Total Toothpaste 6oz",
      sku: "PSC-0001",
      categoryIndex: 9,
      brandIndex: 19, // Colgate-Palmolive
      unitPrice: 499,
      costPrice: 250,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      stockLevel: "in_stock",
      stockQty: 30,
      tags: ["shelf_stable", "popular"],
    },
    {
      name: "Dove Body Wash 18oz",
      sku: "PSC-0002",
      categoryIndex: 9,
      brandIndex: 6,
      unitPrice: 799,
      costPrice: 450,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "in_stock",
      stockQty: 18,
      tags: ["shelf_stable"],
    },
    {
      name: "Head & Shoulders Shampoo 12oz",
      sku: "PSC-0003",
      categoryIndex: 9,
      brandIndex: 7,
      unitPrice: 699,
      costPrice: 380,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["shelf_stable"],
    },
    // HOUSEHOLD (10)
    {
      name: "Tide Laundry Detergent 46oz",
      sku: "HSH-0001",
      categoryIndex: 10,
      brandIndex: 7,
      unitPrice: 1299,
      costPrice: 750,
      taxRate: 0,
      minStock: 6,
      maxStock: 24,
      stockLevel: "in_stock",
      stockQty: 12,
      tags: ["shelf_stable"],
    },
    {
      name: "Bounty Paper Towels 6 Roll",
      sku: "HSH-0002",
      categoryIndex: 10,
      brandIndex: 7,
      unitPrice: 1499,
      costPrice: 850,
      taxRate: 0,
      minStock: 6,
      maxStock: 24,
      stockLevel: "low_stock",
      stockQty: 4,
      tags: ["shelf_stable"],
    },
    {
      name: "Dawn Dish Soap 22oz",
      sku: "HSH-0003",
      categoryIndex: 10,
      brandIndex: 7,
      unitPrice: 399,
      costPrice: 200,
      taxRate: 0,
      minStock: 12,
      maxStock: 50,
      stockLevel: "in_stock",
      stockQty: 25,
      tags: ["shelf_stable"],
    },
    {
      name: "Clorox Bleach 64oz",
      sku: "HSH-0004",
      categoryIndex: 10,
      brandIndex: 20, // Clorox
      unitPrice: 349,
      costPrice: 170,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "in_stock",
      stockQty: 15,
      tags: ["shelf_stable"],
    },
    // BABY (11)
    {
      name: "Pampers Diapers Size 3 36ct",
      sku: "BAB-0001",
      categoryIndex: 11,
      brandIndex: 7,
      unitPrice: 1099,
      costPrice: 650,
      taxRate: 0,
      minStock: 8,
      maxStock: 30,
      stockLevel: "in_stock",
      stockQty: 15,
      tags: ["shelf_stable", "popular"],
    },
    {
      name: "Similac Formula 12.5oz",
      sku: "BAB-0002",
      categoryIndex: 11,
      brandIndex: 21, // Abbott owns Similac
      unitPrice: 1799,
      costPrice: 1100,
      taxRate: 0,
      minStock: 6,
      maxStock: 20,
      stockLevel: "low_stock",
      stockQty: 4,
      tags: ["shelf_stable"],
    },
    // MULTI-UNIT WEIGHT/VOLUME PRODUCTS (12)
    // Prices are USD cents per BASE unit (kg / L) so formatCurrency() renders
    // "$1.30 / kg" etc. — previously these were PKR-scale values that showed
    // as an absurd $130/kg in this USD store.
    {
      name: "Sugar (Loose) — per kg",
      sku: "MUL-0001",
      categoryIndex: 1,
      brandIndex: 2,
      unitPrice: 130,
      costPrice: 110,
      taxRate: 0,
      minStock: 10,
      maxStock: 50,
      unit: "kg",
      allowFractional: true,
      sellByValue: true,
      stockLevel: "in_stock",
      stockQty: 45,
      tags: ["loose", "by_weight"],
    },
    {
      name: "Basmati Rice (Loose) — per kg",
      sku: "MUL-0002",
      categoryIndex: 7,
      brandIndex: 2,
      unitPrice: 220,
      costPrice: 185,
      taxRate: 0,
      minStock: 15,
      maxStock: 80,
      unit: "kg",
      allowFractional: true,
      sellByValue: true,
      stockLevel: "in_stock",
      stockQty: 65,
      tags: ["loose", "by_weight"],
    },
    {
      name: "Wheat Flour (Loose) — per kg",
      sku: "MUL-0003",
      categoryIndex: 7,
      brandIndex: 2,
      unitPrice: 95,
      costPrice: 72,
      taxRate: 0,
      minStock: 20,
      maxStock: 100,
      unit: "kg",
      allowFractional: true,
      sellByValue: true,
      stockLevel: "overstocked",
      stockQty: 120,
      tags: ["loose", "by_weight"],
    },
    {
      name: "Cooking Oil — per litre",
      sku: "MUL-0004",
      categoryIndex: 1,
      brandIndex: 6,
      unitPrice: 450,
      costPrice: 390,
      taxRate: 0,
      minStock: 10,
      maxStock: 40,
      unit: "L",
      allowFractional: true,
      sellByValue: false,
      stockLevel: "in_stock",
      stockQty: 35,
      tags: ["loose", "by_volume"],
    },
    {
      name: "Milk (Fresh) — per litre",
      sku: "MUL-0005",
      categoryIndex: 2,
      brandIndex: 8,
      unitPrice: 160,
      costPrice: 125,
      taxRate: 0,
      minStock: 15,
      maxStock: 60,
      unit: "L",
      allowFractional: true,
      sellByValue: false,
      stockLevel: "low_stock",
      stockQty: 10,
      tags: ["loose", "by_volume", "refrigerated"],
    },
    {
      name: "Green Chili (Loose) — per kg",
      sku: "MUL-0006",
      categoryIndex: 4,
      brandIndex: 14,
      unitPrice: 80,
      costPrice: 50,
      taxRate: 0,
      minStock: 5,
      maxStock: 20,
      unit: "kg",
      allowFractional: true,
      sellByValue: true,
      stockLevel: "out_of_stock",
      stockQty: 0,
      tags: ["loose", "by_weight", "fresh"],
    },
  ];

  const products: Array<{
    id: string;
    name: string;
    sku: string;
    unitPrice: number;
    costPrice: number;
    taxRate: number;
    minStockLevel: number;
    maxStockLevel?: number;
    stockLevel: string;
  }> = [];

  for (let i = 0; i < productDefs.length; i++) {
    const def = productDefs[i]!;
    const p = await prisma.product.create({
      data: {
        name: def.name,
        slug: slugify(def.name),
        sku: def.sku,
        barcode: `${4000000000000 + i}`,
        categoryId: categories[def.categoryIndex]!.id,
        brandId: def.brandIndex !== undefined ? brands[def.brandIndex]!.id : undefined,
        unitPrice: def.unitPrice,
        costPrice: def.costPrice,
        taxRate: def.taxRate,
        status: "active",
        trackInventory: true,
        allowDiscount: true,
        minStockLevel: def.minStock,
        maxStockLevel: def.maxStock,
        unit: def.unit ?? "pcs",
        allowFractional: def.allowFractional ?? false,
        sellByValue: def.sellByValue ?? false,
        unitConversions:
          def.unit === "kg"
            ? JSON.stringify([{ unit: "g", factor: 0.001 }])
            : def.unit === "L"
              ? JSON.stringify([{ unit: "ml", factor: 0.001 }])
              : undefined,
        tags: def.tags ? JSON.stringify(def.tags) : undefined,
      },
    });
    products.push({
      ...p,
      minStockLevel: def.minStock,
      maxStockLevel: def.maxStock,
      stockLevel: def.stockLevel,
    });
  }
  console.log(`  ✓ ${products.length} products created\n`);

  // ============================================
  // STOCK LEVELS - Based on product stockLevel designation
  // ============================================
  console.log("  Creating stock levels with varied statuses...");
  let stockCount = 0;

  for (let i = 0; i < products.length; i++) {
    const product = products[i]!;
    const def = productDefs[i];

    // Main warehouse stock: the DESIGNED stockQty is the actual on-hand
    // quantity. Previously low_stock rows were multiplied by 0.3 and
    // overstocked rows by 2, silently turning "15 left" into "4" — stock
    // counts never matched the design. Reserved stays strictly below
    // on-hand so available quantity can never go negative.
    const mainQty =
      product.stockLevel === "out_of_stock"
        ? 0
        : Math.max(0, Math.floor(def?.stockQty ?? 0));
    let reservedQty = 0;
    if (mainQty >= 5 && i % 5 === 0) {
      reservedQty = Math.max(1, Math.floor(mainQty * 0.1));
    }

    await prisma.stockLevel.create({
      data: {
        productId: product.id,
        warehouseId: mainWarehouse.id,
        quantity: mainQty,
        reservedQuantity: reservedQty,
        reservedAt: reservedQty > 0 ? new Date(Date.now() - Math.floor(seededRand(i + 1) * 7 * 24 * 60 * 60 * 1000)) : null,
      },
    });
    stockCount++;

    // Store room stock (usually a modest fraction of main stock)
    const storeQty = Math.max(
      0,
      Math.floor(mainQty * (0.1 + seededRand(i + 100) * 0.3))
    );
    if (storeQty > 0 && product.stockLevel !== "out_of_stock") {
      await prisma.stockLevel.create({
        data: {
          productId: product.id,
          warehouseId: storeRoom.id,
          quantity: storeQty,
          reservedQuantity: 0,
        },
      });
      stockCount++;
    }

    // Cold storage for refrigerated items
    if (
      def?.tags?.includes("refrigerated") &&
      product.stockLevel !== "out_of_stock"
    ) {
      const coldQty = Math.max(
        0,
        Math.floor(mainQty * (0.2 + seededRand(i + 200) * 0.2))
      );
      if (coldQty > 0) {
        await prisma.stockLevel.create({
          data: {
            productId: product.id,
            warehouseId: coldStorage.id,
            quantity: coldQty,
            reservedQuantity: 0,
          },
        });
        stockCount++;
      }
    }

    // Create variants for some products (every 5th product)
    if (i % 5 === 0 && product.sku != null) {
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          name: `${product.name} (Family Pack)`,
          sku: `${product.sku}-FP`,
          unitPrice: Math.round(product.unitPrice * 1.2),
          costPrice: Math.round(product.costPrice * 1.15),
          options: JSON.stringify({ pack: "Family", size: "Large" }),
          isActive: true,
        },
      });

      const vQty =
        product.stockLevel === "out_of_stock"
          ? 0
          : Math.max(1, Math.floor(mainQty * 0.3));

      await prisma.stockLevel.create({
        data: {
          productId: product.id,
          variantId: variant.id,
          warehouseId: mainWarehouse.id,
          quantity: vQty,
          reservedQuantity: 0,
        },
      });
      stockCount++;

      // Also create store room variant stock
      if (vQty > 0) {
        await prisma.stockLevel.create({
          data: {
            productId: product.id,
            variantId: variant.id,
            warehouseId: storeRoom.id,
            quantity: Math.max(0, Math.floor(vQty * 0.3)),
            reservedQuantity: 0,
          },
        });
        stockCount++;
      }
    }
  }
  console.log(`  ✓ ${stockCount} stock levels created\n`);

  // ============================================
  // INVENTORY MOVEMENTS - Rich history
  // ============================================
  console.log("  Creating inventory movements (diverse types)...");
  let movementCount = 0;
  const movementTypes = [
    "purchase",
    "sale",
    "return",
    "adjustment",
    "transfer",
    "damaged",
    "expired",
    "count",
  ] as const;

  for (let i = 0; i < 80; i++) {
    const product = products[Math.floor(seededRand(i + 1) * products.length)]!;
    const type = movementTypes[i % movementTypes.length]!;
    const absQty = Math.floor(seededRand(i + 200) * 20) + 1;
    const quantity = type === "purchase" || type === "return" ? absQty : -absQty;

    let notes: string | undefined;
    if (type === "adjustment") {
      notes = seededRand(i + 1) > 0.5 ? "Cycle count correction" : "Damaged goods adjustment";
    } else if (type === "damaged") {
      notes = "Product damaged in storage";
    } else if (type === "expired") {
      notes = "Expired product removed";
    }

    await prisma.inventoryMovement.create({
      data: {
        productId: product.id,
        warehouseId:
          type === "transfer"
            ? seededRand(i + 1) > 0.5
              ? storeRoom.id
              : mainWarehouse.id
            : mainWarehouse.id,
        type,
        quantity,
        referenceId:
          type === "sale" || type === "return"
            ? undefined
            : `MOVE-${String(i + 1).padStart(5, "0")}`,
        referenceType:
          type === "sale"
            ? "order"
            : type === "return"
              ? "order"
              : type === "transfer"
                ? "stock_transfer"
                : type === "purchase"
                  ? "purchase_order"
                  : type === "damaged" || type === "expired"
                    ? "adjustment"
                    : "manual",
        notes,
        performedById:
          type === "purchase"
            ? superAdmin.id
            : type === "transfer"
              ? inventoryClerk.id
              : manager.id,
        createdAt: new Date(
          Date.now() - (80 - i) * 12 * 60 * 60 * 1000
        ), // Spread over last 40 days
      },
    });
    movementCount++;
  }
  console.log(`  ✓ ${movementCount} inventory movements created\n`);

  // ============================================
  // STOCK TRANSFERS - Various statuses
  // ============================================
  console.log("  Creating stock transfers (various statuses)...");
  let transferCount = 0;

  // Transfer 1: Completed (received)
  await prisma.stockTransfer.create({
    data: {
      fromWarehouseId: mainWarehouse.id,
      toWarehouseId: storeRoom.id,
      status: "received",
      notes: "Restock for weekend sale",
      createdById: cashier1.id,
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      receivedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      items: {
        create: [
          { productId: products[0]!.id, quantity: 15, receivedQuantity: 15 },
          { productId: products[8]!.id, quantity: 10, receivedQuantity: 10 },
          { productId: products[15]!.id, quantity: 8, receivedQuantity: 8 },
        ],
      },
    },
  });
  transferCount++;

  // Transfer 2: Completed (received)
  await prisma.stockTransfer.create({
    data: {
      fromWarehouseId: storeRoom.id,
      toWarehouseId: mainWarehouse.id,
      status: "received",
      notes: "Return excess inventory to main warehouse",
      createdById: inventoryClerk.id,
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      receivedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      items: {
        create: [
          { productId: products[1]!.id, quantity: 5, receivedQuantity: 5 },
          { productId: products[12]!.id, quantity: 12, receivedQuantity: 12 },
        ],
      },
    },
  });
  transferCount++;

  // Transfer 3: In transit
  await prisma.stockTransfer.create({
    data: {
      fromWarehouseId: mainWarehouse.id,
      toWarehouseId: coldStorage.id,
      status: "in_transit",
      notes: "Moving refrigerated items to cold storage",
      createdById: inventoryClerk.id,
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      receivedAt: null,
      items: {
        create: [
          { productId: products[16]!.id, quantity: 10, receivedQuantity: null },
          { productId: products[18]!.id, quantity: 8, receivedQuantity: null },
          { productId: products[27]!.id, quantity: 6, receivedQuantity: null },
        ],
      },
    },
  });
  transferCount++;

  // Transfer 4: Pending
  await prisma.stockTransfer.create({
    data: {
      fromWarehouseId: mainWarehouse.id,
      toWarehouseId: storeRoom.id,
      status: "pending",
      notes: "Upcoming restock for new week",
      createdById: manager.id,
      createdAt: new Date(),
      receivedAt: null,
      items: {
        create: [
          { productId: products[2]!.id, quantity: 20, receivedQuantity: null },
          { productId: products[9]!.id, quantity: 15, receivedQuantity: null },
          { productId: products[20]!.id, quantity: 10, receivedQuantity: null },
          { productId: products[30]!.id, quantity: 12, receivedQuantity: null },
        ],
      },
    },
  });
  transferCount++;

  // Transfer 5: Cancelled
  await prisma.stockTransfer.create({
    data: {
      fromWarehouseId: storeRoom.id,
      toWarehouseId: mainWarehouse.id,
      status: "cancelled",
      notes: "Cancelled - items no longer needed",
      createdById: cashier1.id,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      receivedAt: null,
      items: {
        create: [
          { productId: products[5]!.id, quantity: 5, receivedQuantity: null },
        ],
      },
    },
  });
  transferCount++;

  console.log(`  ✓ ${transferCount} stock transfers created (received, in_transit, pending, cancelled)\n`);

  // ============================================
  // CUSTOMERS - 20 diverse customers
  // ============================================
  console.log("  Creating customers...");
  const customerData = [
    { name: "John Smith", email: "john.smith@email.com", phone: "+1-555-0101" },
    { name: "Emily Johnson", email: "emily.j@email.com", phone: "+1-555-0102" },
    { name: "Michael Brown", email: "m.brown@email.com", phone: "+1-555-0103" },
    { name: "Jessica Davis", email: "j.davis@email.com", phone: "+1-555-0104" },
    { name: "David Wilson", email: "david.w@email.com", phone: "+1-555-0105" },
    { name: "Sarah Martinez", email: "sarah.m@email.com", phone: "+1-555-0106" },
    { name: "Robert Anderson", email: "r.anderson@email.com", phone: "+1-555-0107" },
    { name: "Jennifer Thomas", email: "j.thomas@email.com", phone: "+1-555-0108" },
    { name: "William Garcia", email: "w.garcia@email.com", phone: "+1-555-0109" },
    { name: "Patricia Robinson", email: "p.robinson@email.com", phone: "+1-555-0110" },
    { name: "James Miller", email: "j.miller@email.com", phone: "+1-555-0111" },
    { name: "Linda Davis", email: "linda.d@email.com", phone: "+1-555-0112" },
    { name: "Richard Taylor", email: "r.taylor@email.com", phone: "+1-555-0113" },
    { name: "Barbara Moore", email: "b.moore@email.com", phone: "+1-555-0114" },
    { name: "Joseph Jackson", email: "j.jackson@email.com", phone: "+1-555-0115" },
    { name: "Susan White", email: "s.white@email.com", phone: "+1-555-0116" },
    { name: "Thomas Harris", email: "t.harris@email.com", phone: "+1-555-0117" },
    { name: "Margaret Martin", email: "m.martin@email.com", phone: "+1-555-0118" },
    { name: "Charles Thompson", email: "c.thompson@email.com", phone: "+1-555-0119" },
    { name: "Dorothy Garcia", email: "d.garcia@email.com", phone: "+1-555-0120" },
  ];
  const customers: Array<{ id: string }> = [];
  for (let i = 0; i < customerData.length; i++) {
    const data = customerData[i]!;
    const c = await prisma.customer.create({
      data: {
        ...data,
        // Stats start at zero and are recomputed from real orders below, so
        // the Customers page always agrees with the Orders page.
        loyaltyPoints: 0,
        totalSpent: 0,
        orderCount: 0,
        isActive: seededRand(i + 300) > 0.1, // 90% active
      },
    });
    customers.push(c);
  }
  console.log(`  ✓ ${customers.length} customers created\n`);

  // ============================================
  // ORDERS - Diverse statuses and types
  // ============================================
  console.log("  Creating orders (diverse statuses)...");

  const paymentMethods = [
    "cash",
    "credit_card",
    "debit_card",
    "digital_wallet",
  ] as const;

  const users = [cashier1, cashier2, manager];
  const orders: Array<{ id: string; status: string; total: number }> = [];

  // Create orders over the last 60 days
  for (let day = 0; day < 60; day++) {
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - day);
    orderDate.setHours(
      Math.floor(seededRand(day + 1) * 14) + 8, // 8 AM to 10 PM
      Math.floor(seededRand(day + 2) * 60),
      0,
      0
    );

    // More orders on weekends
    const dayOfWeek = orderDate.getDay();
    const ordersPerDay = dayOfWeek === 0 || dayOfWeek === 6
      ? Math.floor(seededRand(day + 1) * 8) + 3
      : Math.floor(seededRand(day + 1) * 5) + 1;

    for (let j = 0; j < ordersPerDay; j++) {
      const orderUser = users[Math.floor(seededRand(day + j + 1) * users.length)]!;

      // Weighted status distribution
      const statusRand = seededRand(day + j + 100);
      let status: string;
      if (statusRand < 0.6) {
        status = "completed";
      } else if (statusRand < 0.7) {
        status = "confirmed";
      } else if (statusRand < 0.78) {
        status = "processing";
      } else if (statusRand < 0.85) {
        status = "pending";
      } else if (statusRand < 0.92) {
        status = "cancelled";
      } else if (statusRand < 0.97) {
        status = "refunded";
      } else {
        status = "partially_refunded";
      }

      // 30% have customers, 70% walk-in
      const hasCustomer = seededRand(day + j + 200) > 0.3;
      const customer =
        hasCustomer
          ? customers[Math.floor(seededRand(day + j + 200) * customers.length)]
          : undefined;

      const itemCount = Math.floor(seededRand(day + j + 300) * 6) + 1;
      const orderItems: Array<{
        productId: string;
        productName: string;
        sku: string;
        quantity: number;
        unitPrice: number;
        costPrice: number;
        discountAmount: number;
        taxRate: number;
        taxAmount: number;
        total: number;
      }> = [];
      let orderSubtotal = 0;
      let orderDiscount = 0;

      for (let k = 0; k < itemCount; k++) {
        const product = products[
          Math.floor(seededRand(day + j + k + 400) * products.length)
        ]!;

        // Only use in-stock or low-stock products for orders (avoid out_of_stock)
        if (
          product.stockLevel === "out_of_stock" &&
          seededRand(day + j + k + 500) > 0.3
        ) {
          continue;
        }

        const quantity = Math.floor(seededRand(day + j + k + 500) * 4) + 1;

        // Random per-line discount on some items. Semantics match the live
        // cart (lib/cart-math): discountAmount is the LINE TOTAL discount
        // (cents), and `total` is the after-discount line amount.
        let discount = 0;
        if (seededRand(day + j + k + 600) > 0.8) {
          discount = Math.round(product.unitPrice * quantity * seededRand(day + j + k + 700) * 0.3);
        }

        const itemTotal = Math.max(0, product.unitPrice * quantity - discount);
        orderItems.push({
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          quantity,
          unitPrice: product.unitPrice,
          costPrice: product.costPrice,
          discountAmount: discount,
          taxRate: product.taxRate,
          taxAmount: 0,
          total: itemTotal,
        });
        orderSubtotal += product.unitPrice * quantity;
        orderDiscount += discount;
      }

      // Skip if no valid items
      if (orderItems.length === 0) continue;

      // subtotal − Σ line discounts = Σ line totals (receipts stay consistent)
      if (orderSubtotal < orderDiscount) continue;

      // Apply order-level discount for some orders (never below zero)
      let finalDiscount = orderDiscount;
      if (seededRand(day + j + 800) > 0.9) {
        finalDiscount = Math.min(
          orderSubtotal,
          finalDiscount + Math.round(orderSubtotal * 0.05)
        );
      }

      // CONSISTENCY FIX: an order-level discount (the extra 5% some orders
      // carry) must be redistributed onto the line items exactly the way
      // lib/checkout-service does for live sales, so Σ items.total always
      // equals the header total. Previously the header discount was
      // enlarged without touching the items — order totals, receipts and
      // every item-level report disagreed with each other.
      const extraDiscount = Math.max(0, finalDiscount - orderDiscount);
      if (extraDiscount > 0 && orderSubtotal > 0 && orderItems.length > 0) {
        let allocated = 0;
        for (let idx = 0; idx < orderItems.length; idx++) {
          const it = orderItems[idx]!;
          const lineSubtotal = it.unitPrice * it.quantity;
          const cap = Math.max(0, lineSubtotal - it.discountAmount);
          const share =
            idx === orderItems.length - 1
              ? Math.min(cap, Math.max(0, extraDiscount - allocated)) // last line absorbs the rounding remainder
              : Math.min(cap, Math.round((lineSubtotal / orderSubtotal) * extraDiscount));
          it.discountAmount += share;
          it.total = lineSubtotal - it.discountAmount;
          allocated += share;
        }
        finalDiscount = orderDiscount + allocated;
      }

      const orderTotal = orderSubtotal - finalDiscount;

      const orderNumber = `ORD-${orderDate.getFullYear()}${String(orderDate.getMonth() + 1).padStart(2, "0")}${String(orderDate.getDate()).padStart(2, "0")}-${String(j + 1).padStart(4, "0")}`;

      // ── Payment bookkeeping (mirrors the LIVE flows) ─────────────
      // lib/payment-math rules: Payment.status uses the Payment row's own
      // domain (completed | refunded) while the ORDER's paymentStatus is
      // the settlement state (paid | partial | unpaid). The seed used to
      // write "partial"/"unpaid"/"refunded" onto Payment rows — values the
      // P&L payment breakdown (status="completed") and the Orders UI
      // ("refunded" badge) never expect — and it wrote zero-amount rows
      // for unpaid credit sales. Now only real money collected creates a
      // payment row, exactly like lib/checkout-service.
      let paymentStatus = "paid";
      let paidAmount = orderTotal;
      let dueAmount = 0;
      let changeAmount = 0;

      if (status === "cancelled") {
        paymentStatus = "paid"; // a cancelled sale collected nothing
        paidAmount = 0;
      } else if (status === "pending" || status === "confirmed") {
        // A partial pre-payment on an open order is CREDIT, not cash:
        // the shortfall becomes the customer's due (khata semantics).
        if (customer && seededRand(day + j + 900) > 0.7) {
          paidAmount = Math.round(orderTotal * 0.5);
          dueAmount = orderTotal - paidAmount;
          paymentStatus = "partial";
          changeAmount = 0;
        }
      }

      // ── Credit (khata) sales ─────────────────────────────────────
      // Some COMPLETED orders placed by a customer are settled partially
      // or not at all at the register, exactly like the live partial-
      // payment flow (lib/payment-math): the shortfall becomes the
      // customer's outstandingBalance. Walk-in sales always pay in full.
      if (
        status === "completed" &&
        customer &&
        seededRand(day + j + 950) > 0.82
      ) {
        const partial = seededRand(day + j + 960) > 0.5;
        paidAmount = partial ? Math.round(orderTotal * 0.5) : 0;
        dueAmount = orderTotal - paidAmount;
        paymentStatus = partial ? "partial" : "unpaid";
        changeAmount = 0;
      }

      // Refund bookkeeping — mirrors lib/refund-service: refundedAmount is
      // the money returned, every refunded line's refundedQuantity tracks
      // the returned units, refundReason is set, and a NEGATIVE Payment
      // row (status "refunded") is appended to the ledger.
      const isFullRefund = status === "refunded";
      const isPartialRefund = status === "partially_refunded";
      let refundedAmount = 0;
      let refundedAt: Date | null = null;
      let refundedById: string | undefined;
      let refundReason: string | undefined;
      const refundedQtyByLine = new Map<string, number>();

      if (isFullRefund || isPartialRefund) {
        // Spread refund reasons over the same presets the UI offers so the
        // dashboard's reason breakdown and the refunds ledger both read well.
        const reasons = [
          "Customer returned item",
          "Damaged / defective product",
          "Wrong item delivered",
          "Quality not as expected",
          "Duplicate charge refunded",
        ];
        refundReason = reasons[(day + j) % reasons.length]!;
        refundedById = isFullRefund ? manager.id : cashier1.id;
        refundedAt = new Date(
          orderDate.getTime() + (1 + Math.floor(seededRand(day + j + 970) * 3)) * 24 * 60 * 60 * 1000
        );
        if (refundedAt.getTime() > Date.now()) refundedAt = new Date();

        if (isFullRefund) {
          refundedAmount = orderTotal;
          for (const it of orderItems) {
            refundedQtyByLine.set(it.sku + it.productName, it.quantity);
          }
          // Full refund: collected cash goes back to the customer.
          paidAmount = 0;
          dueAmount = 0;
          changeAmount = 0;
        } else {
          // Partial: refund 40% of the value, spread over the first line(s).
          refundedAmount = Math.round(orderTotal * 0.4);
          let remainingValue = refundedAmount;
          for (const it of orderItems) {
            if (remainingValue <= 0) break;
            const lineValue = it.total > 0 ? it.total : it.unitPrice * it.quantity;
            if (lineValue <= 0) continue;
            const share = Math.min(lineValue, remainingValue);
            const qty = Math.min(it.quantity, (it.quantity * share) / lineValue);
            refundedQtyByLine.set(it.sku + it.productName, qty);
            remainingValue -= share;
          }
          // Partial refunds keep the collected cash on the order.
        }
      }

      const refundItems = orderItems.map((it) => {
        const rq = refundedQtyByLine.get(it.sku + it.productName) ?? 0;
        return { ...it, refundedQuantity: rq };
      });

      const order = await prisma.order.create({
        data: {
          orderNumber,
          customerId: customer?.id,
          userId: orderUser.id,
          warehouseId: mainWarehouse.id,
          status,
          // Live refunds keep type "sale" (see lib/refund-service) — the
          // seed used to invent a "refund" type no other code reads.
          type: "sale",
          subtotal: orderSubtotal,
          taxAmount: 0,
          discountAmount: finalDiscount,
          total: orderTotal,
          paidAmount,
          dueAmount,
          paymentStatus,
          changeAmount,
          refundedAmount,
          refundedAt,
          refundedById,
          refundReason,
          receiptPrinted: status === "completed" || isFullRefund,
          createdAt: orderDate,
          notes:
            status === "cancelled"
              ? "Customer changed mind"
              : undefined,
          items: {
            create: refundItems,
          },
        },
      });

      // ── Payment rows (mirror the live ledger exactly) ────────────
      // 1. Collected cash at the register (only when > 0 — no zero rows).
      if (paidAmount > 0) {
        await prisma.payment.create({
          data: {
            orderId: order.id,
            method: paymentMethods[
              Math.floor(seededRand(day + j + 600) * paymentMethods.length)
            ]!,
            amount: paidAmount,
            status: "completed",
            createdAt: orderDate,
          },
        });
      }
      // 2. Refund as a NEGATIVE payment (status "refunded"), the way
      //    lib/refund-service records it — so the refunds ledger and the
      //    payment-method breakdown both agree with the orders page.
      if (refundedAmount > 0) {
        const original = await prisma.payment.findFirst({
          where: { orderId: order.id, status: "completed", amount: { gt: 0 } },
          orderBy: { createdAt: "asc" },
          select: { method: true },
        });
        await prisma.payment.create({
          data: {
            orderId: order.id,
            method: original?.method ?? "cash",
            amount: -refundedAmount,
            status: "refunded",
            reference: `Refund: ${refundReason ?? "Customer request"}`,
            createdAt: refundedAt ?? orderDate,
          },
        });
      }

      orders.push({ id: order.id, status, total: orderTotal });
    }
  }
  console.log(`  ✓ ${orders.length} orders created (completed, confirmed, processing, pending, cancelled, refunded, partially_refunded)\n`);

  // ============================================
  // CUSTOMER STATS — recomputed from the orders just created
  // ============================================
  console.log("  Recomputing customer stats from orders...");
  // ONE shared rule (lib/customer-rollups) rebuilds totalSpent / orderCount /
  // loyaltyPoints / outstandingBalance from the orders just created. The
  // seeder, the repair script (`npm run repair:rollups`) and the verifier all
  // call into it, so a customer's lifetime spend can never mean three
  // different things depending on which code path last touched the row.
  const rollups = await recomputeCustomerRollups(prisma);
  console.log(
    `  ✓ ${rollups.checked} customers' stats reconciled with orders (${rollups.withDues} with open khata dues)\n`
  );

  // ============================================
  // SUPPLIERS - 8 diverse suppliers
  // ============================================
  console.log("  Creating suppliers...");
  const supplierData = [
    {
      name: "Global Beverages Inc.",
      email: "orders@globalbev.com",
      phone: "+1-555-1001",
      city: "New York",
      country: "USA",
      rating: 4.5,
      paymentTerms: 30,
    },
    {
      name: "Fresh Farms Distributors",
      email: "supply@freshfarms.com",
      phone: "+1-555-1002",
      city: "Los Angeles",
      country: "USA",
      rating: 4.0,
      paymentTerms: 15,
    },
    {
      name: "Packaging Plus Co.",
      email: "sales@packagingplus.com",
      phone: "+1-555-1003",
      city: "Chicago",
      country: "USA",
      rating: 3.5,
      paymentTerms: 45,
    },
    {
      name: "Premium Foods Wholesale",
      email: "info@premiumfoods.com",
      phone: "+1-555-1004",
      city: "Houston",
      country: "USA",
      rating: 4.2,
      paymentTerms: 30,
    },
    {
      name: "Asian Imports Ltd.",
      email: "orders@asianimports.com",
      phone: "+1-555-1005",
      city: "San Francisco",
      country: "USA",
      rating: 3.8,
      paymentTerms: 30,
    },
    {
      name: "Clean Home Supplies",
      email: "wholesale@cleanhome.com",
      phone: "+1-555-1006",
      city: "Miami",
      country: "USA",
      rating: 4.1,
      paymentTerms: 30,
    },
    {
      name: "Organic Valley Co-op",
      email: "orders@organicvalley.com",
      phone: "+1-555-1007",
      city: "Portland",
      country: "USA",
      rating: 4.8,
      paymentTerms: 14,
    },
    {
      name: "Budget Mart Distributors",
      email: "supply@budgetmart.com",
      phone: "+1-555-1008",
      city: "Phoenix",
      country: "USA",
      rating: 3.2,
      paymentTerms: 60,
    },
  ];
  const suppliers: Array<{ id: string }> = [];
  for (const data of supplierData) {
    const s = await prisma.supplier.create({
      data: {
        ...data,
        slug: slugify(data.name),
        address: `${Math.floor(seededRand(data.name.length + 1) * 999) + 1} Commerce Ave`,
        isActive: true,
      },
    });
    suppliers.push(s);
  }
  console.log(`  ✓ ${suppliers.length} suppliers created\n`);

  // ============================================
  // PURCHASE ORDERS - Various statuses
  // ============================================
  console.log("  Creating purchase orders (various statuses)...");

  const poStatuses = ["received", "received", "ordered", "pending", "draft"] as const;
  const purchaseOrders: Array<{ id: string; orderNumber: string; status: string }> = [];

  for (let i = 0; i < 15; i++) {
    const supplier = suppliers[Math.floor(seededRand(i + 1) * suppliers.length)]!;
    const status = poStatuses[i % poStatuses.length]!;
    const poDate = new Date();
    poDate.setDate(poDate.getDate() - Math.floor(seededRand(i + 100) * 60));

    const poItems: Array<{
      productId: string;
      productName: string;
      sku: string;
      quantity: number;
      receivedQty: number;
      unitCost: number;
      taxRate: number;
      total: number;
    }> = [];
    let poSubtotal = 0;
    const itemCount = Math.floor(seededRand(i + 200) * 5) + 2;
    const usedProducts = new Set<string>();

    for (let j = 0; j < itemCount; j++) {
      let product;
      let attempt = 0;
      do {
        // Advance the seed per attempt — a constant seed would return the
        // same product forever once it is already in usedProducts.
        product = products[Math.floor(seededRand(i * 13 + j + attempt * 7 + 300) * products.length)]!;
        attempt++;
      } while (usedProducts.has(product.id) && attempt < products.length * 2);
      usedProducts.add(product.id);

      const quantity = Math.floor(seededRand(i + j + 400) * 50) + 10;
      const itemTotal = product.costPrice * quantity;

      poItems.push({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        quantity,
        receivedQty: status === "received" ? quantity : 0,
        unitCost: product.costPrice,
        taxRate: 0,
        total: itemTotal,
      });
      poSubtotal += itemTotal;
    }

    // Totals follow the live /api/purchase-orders POST rules:
    // total = subtotal + tax + shipping (previously shipping was dropped).
    const poTax = 0;
    const poShipping = Math.floor(seededRand(i + 500) * 5000);
    const poTotal = poSubtotal + poTax + poShipping;

    const po = await prisma.purchaseOrder.create({
      data: {
        orderNumber: `PO-${String(i + 1).padStart(6, "0")}`,
        supplierId: supplier.id,
        warehouseId: mainWarehouse.id,
        status,
        subtotal: poSubtotal,
        taxAmount: poTax,
        shippingCost: poShipping,
        total: poTotal,
        createdById: superAdmin.id,
        expectedDate: new Date(poDate.getTime() + 14 * 24 * 60 * 60 * 1000),
        receivedAt: status === "received" ? new Date(poDate.getTime() + 10 * 24 * 60 * 60 * 1000) : null,
        createdAt: poDate,
        items: {
          create: poItems,
        },
      },
    });
    purchaseOrders.push({ id: po.id, orderNumber: po.orderNumber, status });

    // Add payment for received POs — paid in full (matches the total)
    if (status === "received") {
      await prisma.purchaseOrderPayment.create({
        data: {
          purchaseOrderId: po.id,
          method: "bank_transfer",
          amount: poTotal,
          status: "completed",
          reference: `BT-${String(i + 1).padStart(6, "0")}`,
        },
      });
    }
  }
  console.log(`  ✓ ${purchaseOrders.length} purchase orders created (received, ordered, pending, draft)\n`);

  // ============================================
  // STORE SETTINGS - Realistic configuration
  // ============================================
  console.log("  Creating store settings...");
  await prisma.storeSettings.create({
    data: {
      storeName: "ElitePOS Super Mart",
      storeAddress: "123 Main Street, Shopping District",
      storePhone: "+1-555-0100",
      storeEmail: "info@elitepos.com",
      taxRate: 0,
      taxInclusive: false,
      currency: "USD",
      receiptHeader: "Thank you for shopping at ElitePOS Super Mart!",
      receiptFooter: "Returns accepted within 30 days with receipt.",
      lowStockThreshold: 5,
      lowStockSchedulerEnabled: true,
      lowStockCooldownHours: 6,
      lowStockNotifyAdmins: true,
    },
  });
  console.log("  ✓ Store settings created\n");

  // ============================================
  // STOCK ALERT LOGS - Pre-populate for testing
  // ============================================
  console.log("  Creating stock alert logs (for low stock products)...");

  // Find products that are out of stock or low stock
  const lowStockProducts = products.filter(
    (p) => p.stockLevel === "out_of_stock" || p.stockLevel === "low_stock"
  );

  for (const product of lowStockProducts.slice(0, 10)) {
    await prisma.stockAlertLog.create({
      data: {
        productId: product.id,
        warehouseId: mainWarehouse.id,
        lastAlertedAt: new Date(Date.now() - Math.floor(seededRand(1) * 48) * 60 * 60 * 1000),
        lastQuantity: product.stockLevel === "out_of_stock" ? 0 : Math.floor(seededRand(2) * 10) + 1,
        lastSeverity: product.stockLevel === "out_of_stock" ? "critical" : "warning",
        lastKind: product.stockLevel === "out_of_stock" ? "out_of_stock" : "below_min",
        attempts: Math.floor(seededRand(3) * 5) + 1,
      },
    });
  }
  console.log(`  ✓ ${Math.min(10, lowStockProducts.length)} stock alert logs created\n`);

  // ============================================
  // SUMMARY
  // ============================================
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ✅ Database seeded with COMPREHENSIVE mock data!");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\n  📊 DATA SUMMARY:");
  console.log("  ─────────────────");
  console.log(`  Users:              7 (super_admin, admin, manager, 2 cashiers, inventory_clerk, viewer)`);
  console.log(`  Warehouses:         3 (main, store room, cold storage)`);
  console.log(`  Brands:             ${brands.length}`);
  console.log(`  Categories:         ${categories.length}`);
  console.log(`  Products:           ${products.length}`);
  console.log(`  Stock Levels:       ${stockCount}`);
  console.log(`  Inventory Movements: ${movementCount}`);
  console.log(`  Stock Transfers:    ${transferCount} (received, in_transit, pending, cancelled)`);
  console.log(`  Customers:          ${customers.length}`);
  console.log(`  Orders:             ${orders.length} (mixed statuses)`);
  console.log(`  Suppliers:          ${suppliers.length}`);
  console.log(`  Purchase Orders:    ${purchaseOrders.length} (mixed statuses)`);
  console.log(`  Stock Alerts:       ${Math.min(10, lowStockProducts.length)} pre-logged`);
  console.log("\n  📈 STOCK STATUS BREAKDOWN:");
  console.log("  ─────────────────");
  const inStockCount = products.filter((p) => p.stockLevel === "in_stock").length;
  const lowStockCount = products.filter((p) => p.stockLevel === "low_stock").length;
  const outOfStockCount = products.filter((p) => p.stockLevel === "out_of_stock").length;
  const overstockedCount = products.filter((p) => p.stockLevel === "overstocked").length;
  console.log(`  In Stock:           ${inStockCount} products`);
  console.log(`  Low Stock:          ${lowStockCount} products (triggers warnings)`);
  console.log(`  Out of Stock:       ${outOfStockCount} products (triggers critical alerts)`);
  console.log(`  Overstocked:        ${overstockedCount} products`);
  console.log("\n  🛒 ORDER STATUS BREAKDOWN:");
  console.log("  ─────────────────");
  const completedOrders = orders.filter((o) => o.status === "completed").length;
  const cancelledOrders = orders.filter((o) => o.status === "cancelled").length;
  const refundedOrders = orders.filter((o) => o.status === "refunded" || o.status === "partially_refunded").length;
  console.log(`  Completed:          ${completedOrders} orders`);
  console.log(`  Cancelled:          ${cancelledOrders} orders`);
  console.log(`  Refunded/Partial:   ${refundedOrders} orders`);
  console.log("\n  🔐 LOGIN CREDENTIALS:");
  console.log("  ─────────────────");
  console.log("  Super Admin:  admin@elitepos.com     / Admin@123");
  console.log("  Admin:        admin2@elitepos.com    / Admin@123");
  console.log("  Manager:      manager@elitepos.com   / Admin@123");
  console.log("  Cashier 1:    ahmed@elitepos.com     / Cashier@123");
  console.log("  Cashier 2:    lisa@elitepos.com      / Cashier@123");
  console.log("  Inventory:    mike@elitepos.com      / Cashier@123");
  console.log("  Viewer:       viewer@elitepos.com    / Cashier@123");
  console.log("\n");

  return {
    users: 7,
    warehouses: 3,
    brands: brands.length,
    categories: categories.length,
    products: products.length,
    stockLevels: stockCount,
    movements: movementCount,
    transfers: transferCount,
    customers: customers.length,
    orders: orders.length,
    suppliers: suppliers.length,
    purchaseOrders: purchaseOrders.length,
    stockAlerts: Math.min(10, lowStockProducts.length),
  };
}

// Re-export the prisma client so API route can disconnect if needed.
export { prisma };
