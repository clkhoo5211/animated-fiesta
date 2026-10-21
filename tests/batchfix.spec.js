const { test, expect } = require("@playwright/test");
const { serve, preset, FIX } = require("./helpers");

const ROWS = [["1", "BL P", "8076 BUTTERLITE", "20.00 UNIT", "4.91", "98.20"], ["2", "AH", "8092 AYAMAS HOT", "6.00 UNIT", "20.86", "125.16"], ["3", "FP7.5", "8104 FRIZZ POPIA", "10.00 UNIT", "4.96", "49.60"],
  ["4", "RBB", "8436 RAMLY BEEF BURGER", "12.00 UNIT", "7.75", "93.00"], ["5", "ACF", "9150 AYAMAS FRANKFURTERS", "16.00 UNIT", "5.27", "84.32"], ["6", "ACFC", "9153 AYAMAS CRISPY", "6.00 UNIT", "20.10", "120.60"], ["7", "MYFF", "9251 MYDIBEL FRIES", "1.00 CTN", "80.00", "80.00"]];
const table = rows => ({ name: null, columns: [{ name: "No", role: "id" }, { name: "Item Code", role: "text" }, { name: "Description", role: "text" }, { name: "Qty", role: "qty" }, { name: "Price", role: "unit_price" }, { name: "Total", role: "amount" }], rows, row_kinds: rows.map(() => "line") });
const STREETS = ["LORONG LUKUT MAKMUR 1, TMN LUKUT MAKMUR", "JALAN BUKIT EKA BIZ, TAMAN BUKIT EKA", "JLN PUSAT DAGANGAN SENDAYAN 3/3", "JALAN NUSARI BAYU 7/1 NUSARI BIZ", "PERSIARAN METRO SENDAYAN 1", "JLN SPRINGHILL 9/1 BDR SPRINGHILL"];
let pg = 0;
const inv = (no, date, total, ship, rows = ROWS, stamp = "99 SPEED MART (3420) NS TMN LUKUT", street = STREETS[pg]) => ({ document_type: "invoice", document_number: no, document_date: date, grand_total: total, tables: [table(rows)], rotation_degrees: "0",
  stamps_and_chops: [{ text: stamp }], parties: [{ role: "ship_to", name: ship, address: `NO. 4 & 5 (GF), ${street}, 71010 PORT DICKSON` }] });

async function run(page, context, model) {
  await serve(context, { model: ({ text, doc, model: m }) => { const n = +/PAGE (\d)/.exec(doc || text)[1]; pg = n - 1; return { json: model(n, m === "model-a" ? "a" : "b") } } });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("six_pages.pdf"));
  await page.click("#go");
  await page.waitForFunction(() => { const j = [...document.querySelectorAll(".job")]; return j.length > 0 && j.every((x) => !["run", "wait"].includes(x.dataset.status)) }, null, { timeout: 170_000 });
  return page.evaluate(async () => {
    const r = await new Promise((res) => { const req = indexedDB.open("invoicelens"); req.onsuccess = () => { const g = req.result.transaction("jobs").objectStore("jobs").getAll(); g.onsuccess = () => res(g.result) } });
    return r[0].result.segments.map((sg) => ({ f: sg.final_result, c: sg.consensus || [], s: sg.suspects || [] }));
  });
}

test("whole-file consistency: date, numbering, store number from the stamp, copy lines/totals", async ({ page, context }) => {
  test.setTimeout(200_000);
  const wrong = ROWS.map(r => r.slice()); wrong[1] = ["2", "AH", "8092 AYAMAS HOT", "5.00 UNIT", "20.85", "104.25"]; wrong[6] = ["7", "MYFF", "9251 MYDIBEL FRIES", "1.00 CTN", "90.00", "90.00"];
  const segs = await run(page, context, (n, k) => {
    if (n === 1) return inv("A261001101", "7/10/2026", "652.88", "3420 NS TMN LUKUT");          // total misread, lines right
    if (n === 2) return inv("A261001101", "7/10/2026", "650.88", "3420 NS TMN LUKUT", wrong, undefined, STREETS[0]);     // copy: total right, two lines misread
    if (n === 3) return inv("A261001103", "7/10/2026", "650.88", k === "a" ? "7420 NS TMN LUKUT" : "3420 NS TMN LUKUT"); // store number misread
    if (n === 4) return inv(k === "a" ? "A2636612270" : "A261001104", "7/10/2026", "650.88", "3420 NS TMN LUKUT");
    if (n === 5) return inv("A2636612271", "7/10/2026", "650.88", "3420 NS TMN LUKUT");        // nothing fits the numbering: flagged
    return inv("A261001106", "7/15/2025", "650.88", "3420 NS TMN LUKUT");                         // both models read an impossible date
  });
  expect(segs[0].f.grand_total).toBe("650.88");
  expect(segs[1].f.tables[0].rows[1].slice(3)).toEqual(["6.00 UNIT", "20.86", "125.16"]);
  expect(segs[1].f.tables[0].rows[6].slice(3)).toEqual(["1.00 CTN", "80.00", "80.00"]);
  expect(segs[2].f.parties[0].name).toBe("3420 NS TMN LUKUT");
  expect(segs[3].f.document_number).toBe("A261001104");
  expect(segs[4].s).toContain("docno");
  expect(segs[5].f.document_date).toBe("7/10/2026");
});


const finalOf = (page) => page.evaluate(async () => {
  const r = await new Promise((res) => { const req = indexedDB.open("invoicelens"); req.onsuccess = () => { const g = req.result.transaction("jobs").objectStore("jobs").getAll(); g.onsuccess = () => res(g.result) } });
  return r[0].result.segments.map((sg) => ({ f: sg.final_result, s: sg.suspects || [], st: sg.straightened || 0, rr: sg.rotation_rejected || 0 }));
});

test("a page wrongly called sideways: the turned read (two models that disagree completely) is thrown away and the upright read kept", async ({ page, context }) => {
  const n = { "model-a": 0, "model-b": 0 };
  const calls = await serve(context, { model: ({ model }) => {
    const k = ++n[model];
    if (k === 1) return { json: { ...inv("A261001101", "7/10/2026", "650.88", "3420 NS TMN LUKUT"), rotation_degrees: model === "model-a" ? "90" : "0" } };
    return { json: model === "model-a" ? { document_type: "delivery_order", document_number: "DO-2024-001", parties: [{ role: "supplier", name: "Syarikat Maju Jaya" }], tables: [], rotation_degrees: "0" }
      : { document_type: "delivery_order", document_number: "2024052001", parties: [{ role: "supplier", name: "MEGAH GLOBAL" }], tables: [], rotation_degrees: "0" } };
  } });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await page.waitForFunction(() => { const j = [...document.querySelectorAll(".job")]; return j.length > 0 && j.every((x) => !["run", "wait"].includes(x.dataset.status)) }, null, { timeout: 60_000 });
  const [sg] = await finalOf(page);
  expect(calls.length).toBe(4);
  expect(sg.f.document_number).toBe("A261001101");
  expect(sg.st).toBe(0);
  expect(sg.rr).toBe(90);
  expect(sg.s).toContain("rotation");
});

test("rows with one cell too few (item code + description in one cell) or too many (unit split off the quantity) are reshaped so they add up", async ({ page, context }) => {
  const cols = [{ name: "No", role: "number" }, { name: "Item Code", role: "id" }, { name: "Description", role: "text" }, { name: "Qty", role: "qty" }, { name: "Price", role: "unit_price" }, { name: "Discount", role: "text" }, { name: "Total", role: "amount" }];
  await serve(context, { model: ({ model }) => ({ json: { document_type: "invoice", document_number: "A1", grand_total: "300.00", rotation_degrees: "0",
    tables: [{ columns: cols, rows: model === "model-a"
      ? [["1", "ABD (10X850GM) 8091 AYAMAS DRUMMET", "6.00 UNIT", "20.00", "", "120.00"], ["2", "RBB (36X420GM) 8436 RAMLY BURGER", "12.00 UNIT", "15.00", "", "180.00"]]
      : [["1", "ABD", "8091 AYAMAS DRUMMET", "6.00", "UNIT", "20.00", "", "120.00"], ["2", "RBB", "8436 RAMLY BURGER", "12.00", "UNIT", "15.00", "", "180.00"]] }] } }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await page.waitForFunction(() => { const j = [...document.querySelectorAll(".job")]; return j.length > 0 && j.every((x) => !["run", "wait"].includes(x.dataset.status)) }, null, { timeout: 60_000 });
  const [sg] = await finalOf(page);
  const t = sg.f.tables[0];
  expect(t.rows.every((r) => r.length === t.columns.length)).toBe(true);
  expect(t.rows[0].at(-1)).toBe("120.00");
  const pr = (r) => r.filter((c, i) => ["qty", "unit_price", "amount"].includes(t.columns[i].role));
  expect(pr(t.rows[1])).toEqual(["12.00 UNIT", "15.00", "180.00"]);
  expect(sg.s).not.toContain("checks");
});
