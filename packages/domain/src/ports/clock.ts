export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  readonly #fixed: Date;

  constructor(fixed: Date) {
    this.#fixed = fixed;
  }

  now(): Date {
    return new Date(this.#fixed.getTime());
  }
}
