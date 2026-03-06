import { describe, expect, it } from "vitest";

import { ERROR_DOMAIN, REQUEST_STATUS } from "../../packages/contracts/src/index.js";

describe("@croc/contracts", () => {
  it("contains MVP request statuses", () => {
    expect(REQUEST_STATUS).toMatchObject({
      CREATED: "CREATED",
      ACKED: "ACKED",
      SUCCEEDED: "SUCCEEDED",
      TIMED_OUT: "TIMED_OUT",
      UNVERIFIED: "UNVERIFIED"
    });
  });

  it("contains stable error domains", () => {
    expect(Object.values(ERROR_DOMAIN)).toEqual(
      expect.arrayContaining(["AUTH", "CONTRACT", "EXEC", "RESULT", "DELIVERY", "TEMPLATE", "PLATFORM"])
    );
  });
});
