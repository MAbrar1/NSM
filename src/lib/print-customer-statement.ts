import { formatCurrencyBase } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER STATEMENT PRINTER
   Opens a print window with a clean khata ledger: charges, payments,
   refunds and the running balance, ending at the current outstanding.
   ═══════════════════════════════════════════════════════════════ */

export interface StatementRow {
  date: string;
  type: "charge" | "payment" | "refund";
  label: string;
  method?: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementData {
  customer: { name: string; phone?: string | null; email?: string | null };
  rows: StatementRow[];
  outstanding: number;
  buckets: { b0_30: number; b31_60: number; b61_90: number; b90plus: number };
  generatedAt: string;
}

export interface StatementSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function printCustomerStatement(
  data: StatementData,
  settings: StatementSettings
): void {
  const rows = data.rows.length
    ? data.rows
        .map(
          (r) => `
      <tr class="${esc(r.type)}">
        <td>${esc(new Date(r.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }))}</td>
        <td>${esc(r.label)}${r.method ? ` <span class="muted">(${esc(r.method)})</span>` : ""}</td>
        <td class="right">${r.debit ? esc(formatCurrencyBase(r.debit)) : ""}</td>
        <td class="right">${r.credit ? esc(formatCurrencyBase(r.credit)) : ""}</td>
        <td class="right strong">${esc(formatCurrencyBase(r.balance))}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="center muted">No transactions on record.</td></tr>`;

  const ageRow = (label: string, v: number) =>
    `<div class="age"><span>${esc(label)}</span><span class="right">${esc(formatCurrencyBase(v))}</span></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Statement — ${esc(data.customer.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; background: #fff; font-size: 12px; line-height: 1.45; }
  .sheet { max-width: 700px; margin: 24px auto; padding: 0 16px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; }
  .store { font-size: 18px; font-weight: 700; letter-spacing: 0.4px; }
  .muted { color: #666; font-size: 10px; }
  .title { text-align: right; }
  .title h1 { font-size: 15px; letter-spacing: 2px; text-transform: uppercase; }
  .meta { margin: 12px 0; display: flex; justify-content: space-between; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; color: #555; border-bottom: 1px solid #999; padding: 5px 4px; }
  td { padding: 5px 4px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  .right { text-align: right; }
  .center { text-align: center; }
  .strong { font-weight: 700; }
  tr.payment td { color: #166534; }
  tr.refund td { color: #92400e; }
  .summary { margin-top: 14px; display: flex; justify-content: space-between; gap: 16px; }
  .aging { flex: 1; border: 1px solid #ccc; padding: 8px 10px; }
  .aging h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #555; margin-bottom: 6px; }
  .age { display: flex; justify-content: space-between; font-size: 11px; padding: 1.5px 0; }
  .balance { flex: 1; border: 2px solid #111; padding: 12px 10px; text-align: center; align-self: stretch; }
  .balance .amount { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .balance.due .amount { color: #b45309; }
  .footer { margin-top: 18px; border-top: 1px solid #ccc; padding-top: 8px; font-size: 10px; color: #666; display: flex; justify-content: space-between; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div>
        <div class="store">${esc(settings.storeName)}</div>
        ${settings.storeAddress ? `<div class="muted">${esc(settings.storeAddress)}</div>` : ""}
        ${settings.storePhone ? `<div class="muted">${esc(settings.storePhone)}</div>` : ""}
      </div>
      <div class="title">
        <h1>Statement of Account</h1>
        <div class="muted">Generated ${esc(new Date(data.generatedAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric" }))}</div>
      </div>
    </div>
    <div class="meta">
      <div><strong>${esc(data.customer.name)}</strong>${data.customer.phone ? `<div class="muted">${esc(data.customer.phone)}</div>` : ""}${data.customer.email ? `<div class="muted">${esc(data.customer.email)}</div>` : ""}</div>
    </div>
    <table>
      <thead>
        <tr><th>Date</th><th>Transaction</th><th class="right">Charge</th><th class="right">Credit</th><th class="right">Balance</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary">
      <div class="aging">
        <h3>Aging of open dues</h3>
        ${ageRow("0–30 days", data.buckets.b0_30)}
        ${ageRow("31–60 days", data.buckets.b31_60)}
        ${ageRow("61–90 days", data.buckets.b61_90)}
        ${ageRow("90+ days", data.buckets.b90plus)}
      </div>
      <div class="balance ${data.outstanding > 0 ? "due" : ""}">
        <div class="muted">CURRENT BALANCE DUE</div>
        <div class="amount">${esc(formatCurrencyBase(data.outstanding))}</div>
      </div>
    </div>
    <div class="footer">
      <span>This statement reflects all transactions recorded in the register.</span>
      <span>${esc(settings.storeName)}</span>
    </div>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=760,height=900");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  setTimeout(() => {
    win.focus();
    win.print();
  }, 350);
}
