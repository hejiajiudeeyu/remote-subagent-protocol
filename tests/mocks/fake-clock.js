export class FakeClock {
  constructor(startMs = Date.now()) {
    this.nowMs = startMs;
  }

  now() {
    return this.nowMs;
  }

  tick(ms) {
    this.nowMs += ms;
    return this.nowMs;
  }
}
