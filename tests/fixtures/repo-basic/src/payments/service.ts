export interface Payment {
  id: string;
  amountCents: number;
  currency: string;
}

/** Port the service depends on; the concrete store lives elsewhere. */
export interface PaymentRepository {
  findById(id: string): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
}

/**
 * Payments follow the repository pattern: the service holds no storage details,
 * only the `PaymentRepository` port.
 */
export class PaymentService {
  readonly #repository: PaymentRepository;

  constructor(repository: PaymentRepository) {
    this.#repository = repository;
  }

  async charge(id: string, amountCents: number, currency: string): Promise<Payment> {
    const payment: Payment = { id, amountCents, currency };
    await this.#repository.save(payment);
    return payment;
  }
}
