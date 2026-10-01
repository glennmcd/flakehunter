export type Behaviour =
  /** Always passes. */
  | { type: "stable" }
  /** Always reported as skipped (e.g. @Disabled). */
  | { type: "skipped" }
  /**
   * Fails with `failProbability` on each try. `retries` extra in-suite tries follow a failure, each appearing as
   * another testcase entry (like a retry plugin). Only flaky while `activeUntilDaysAgo <= age <= activeFromDaysAgo`
   * (age in whole days before today), so a test can start or stop flaking inside the window.
   */
  | {
      type: "flaky";
      failProbability: number;
      retries: number;
      failureKind: "failure" | "error";
      message: string;
      exception: string;
      activeFromDaysAgo?: number;
      activeUntilDaysAgo?: number;
    }
  /** A genuinely broken test: fails every time until it was fixed `fixedDaysAgo` days ago. */
  | { type: "failing-until"; fixedDaysAgo: number; message: string; exception: string };

export interface DemoTest {
  classname: string;
  name: string;
  kind: "unit" | "integration";
  behaviour: Behaviour;
}

export function testKey(test: { classname: string; name: string }): string {
  return `${test.classname}::${test.name}`;
}

const ASSERTION = "org.opentest4j.AssertionFailedError";

const stable = (kind: DemoTest["kind"], classname: string, names: string[]): DemoTest[] =>
  names.map((name) => ({ classname, name, kind, behaviour: { type: "stable" } }));

const skipped = (kind: DemoTest["kind"], classname: string, name: string): DemoTest => ({
  classname,
  name,
  kind,
  behaviour: { type: "skipped" },
});

const flaky = (
  kind: DemoTest["kind"],
  classname: string,
  name: string,
  behaviour: Omit<Extract<Behaviour, { type: "flaky" }>, "type">,
): DemoTest => ({ classname, name, kind, behaviour: { type: "flaky", ...behaviour } });

/** A fake e-commerce service's test suite: about 45 tests, mostly stable, six flaky, one fixed failure. */
export const DEMO_TESTS: readonly DemoTest[] = [
  ...stable("unit", "com.acme.cart.CartServiceTest", [
    "addsItem",
    "removesItem",
    "appliesCoupon",
    "calculatesTotal",
    "rejectsNegativeQuantity",
    "mergesDuplicateLines",
  ]),
  ...stable("unit", "com.acme.cart.PriceCalculatorTest", [
    "roundsHalfUp",
    "appliesRegionalTax",
    "handlesZeroTotal",
    "convertsCurrency",
  ]),
  ...stable("unit", "com.acme.catalog.ProductRepositoryTest", [
    "findsBySku",
    "listsByCategory",
    "paginatesResults",
    "sortsByPrice",
  ]),
  skipped("unit", "com.acme.catalog.ProductRepositoryTest", "bulkImport"),
  ...stable("unit", "com.acme.catalog.SearchIndexerTest", [
    "indexesNewProduct",
    "removesDeletedProduct",
    "rebuildsIndex",
  ]),
  flaky("unit", "com.acme.catalog.SearchIndexerTest", "indexesConcurrently", {
    failProbability: 0.08,
    retries: 0,
    failureKind: "failure",
    message: "expected index size <3> but was <2>",
    exception: ASSERTION,
  }),
  ...stable("unit", "com.acme.auth.TokenServiceTest", ["issuesToken", "rejectsTamperedToken", "expiresOldToken"]),
  flaky("unit", "com.acme.auth.TokenServiceTest", "refreshesExpiringToken", {
    failProbability: 0.3,
    retries: 0,
    failureKind: "failure",
    message: "Token expired before refresh completed",
    exception: ASSERTION,
    activeFromDaysAgo: 7,
  }),
  ...stable("unit", "com.acme.auth.PasswordHasherTest", [
    "hashesWithSalt",
    "verifiesCorrectPassword",
    "rejectsWrongPassword",
  ]),
  ...stable("unit", "com.acme.shipping.RateCalculatorTest", [
    "calculatesGroundRate",
    "calculatesExpressRate",
    "appliesFreeShippingThreshold",
  ]),
  {
    classname: "com.acme.shipping.RateCalculatorTest",
    name: "supportsNewCarrier",
    kind: "unit",
    behaviour: {
      type: "failing-until",
      fixedDaysAgo: 12,
      message: "No rate table for carrier 'NORTHWIND'",
      exception: "java.lang.IllegalStateException",
    },
  },
  ...stable("unit", "com.acme.notifications.EmailTemplateTest", ["rendersOrderConfirmation", "escapesHtml"]),
  flaky("unit", "com.acme.notifications.EmailTemplateTest", "rendersLocalizedDate", {
    failProbability: 0.18,
    retries: 0,
    failureKind: "failure",
    message: "expected: <1 Oct 2026> but was: <Oct 1, 2026>",
    exception: ASSERTION,
    activeUntilDaysAgo: 21,
  }),
  ...stable("integration", "com.acme.integration.CheckoutFlowIT", [
    "appliesPromoAtCheckout",
    "rejectsExpiredCard",
    "sendsConfirmationEmail",
  ]),
  flaky("integration", "com.acme.integration.CheckoutFlowIT", "completesCheckout", {
    failProbability: 0.22,
    retries: 0,
    failureKind: "failure",
    message: "expected: <200> but was: <503>",
    exception: ASSERTION,
  }),
  skipped("integration", "com.acme.integration.CheckoutFlowIT", "supportsGiftCards"),
  ...stable("integration", "com.acme.integration.PaymentGatewayIT", ["authorizesPayment", "refundsPayment"]),
  flaky("integration", "com.acme.integration.PaymentGatewayIT", "retriesOnTimeout", {
    failProbability: 0.35,
    retries: 2,
    failureKind: "error",
    message: "Read timed out",
    exception: "java.net.SocketTimeoutException",
  }),
  ...stable("integration", "com.acme.integration.InventorySyncIT", ["reservesStock", "releasesStockOnCancel"]),
  flaky("integration", "com.acme.integration.InventorySyncIT", "syncsStockLevels", {
    failProbability: 0.12,
    retries: 1,
    failureKind: "failure",
    message: "expected: <42> but was: <41>",
    exception: ASSERTION,
  }),
  ...stable("integration", "com.acme.integration.OrderApiIT", ["createsOrder", "listsOrders", "cancelsOrder"]),
];
