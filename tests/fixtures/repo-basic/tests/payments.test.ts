import assert from "node:assert/strict";
import { test } from "node:test";
import { type Payment, type PaymentRepository, PaymentService } from "../src/payments/service.ts";

test("charge saves the payment through the repository port", async () => {
  const saved: Payment[] = [];
  const repository: PaymentRepository = {
    findById: async () => null,
    save: async (payment) => {
      saved.push(payment);
    },
  };
  const service = new PaymentService(repository);
  const payment = await service.charge("pay_1", 500, "USD");
  assert.equal(saved.length, 1);
  assert.equal(payment.amountCents, 500);
});
