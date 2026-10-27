const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const STAMP = [{ text: "99 SPEED MART SDN. BHD. (519537-X) (1988) NS Tmn Gadong Indah No 1 (Single Storey), Jln Gadong Indah" }];
const REST = "NO 1 (SINGLE STOREY), JLN GADONG INDAH 3, TMN GADONG INDAH 1, 71900 LABU, NEGERI SEMBILAN";

async function addressOf(page, context, shipTo) {
  await serve(context, { model: () => ({ json: { document_type: "invoice", document_number: "A1", parties: [{ role: "bill_to", name: "99 SPEED MART SDN. BHD." }, { role: "ship_to", ...shipTo }], stamps_and_chops: STAMP, tables: [] } }), geo: () => [] });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  return page.locator(".rt-addr").first();
}

test("a lone branch number moved into name is brought back into the delivery address", async ({ page, context }) => {
  const a = await addressOf(page, context, { name: "1988", address: "NS TMN GADONG INDAH (DD) " + REST });
  await expect(a).toContainText("1988 NS TMN GADONG INDAH (DD) NO 1");
});

test("the branch-name line kept in name goes back into the address, and a missing number is taken from the delivery stamp", async ({ page, context }) => {
  const a = await addressOf(page, context, { name: "NS TMN GADONG INDAH (DD)", address: REST });
  await expect(a).toContainText("1988 NS TMN GADONG INDAH (DD) NO 1");
});

test("a complete address block is left as it is", async ({ page, context }) => {
  const a = await addressOf(page, context, { name: null, address: "1988 NS TMN GADONG INDAH (DD) " + REST });
  await expect(a).toHaveText("1988 NS TMN GADONG INDAH (DD) " + REST);
});
