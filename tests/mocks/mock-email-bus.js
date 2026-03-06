export class MockEmailBus {
  constructor() {
    this.messages = [];
  }

  send(message) {
    this.messages.push({ ...message, sent_at: new Date().toISOString() });
  }

  pollByRequestId(requestId) {
    return this.messages.filter((message) => message.request_id === requestId);
  }

  clear() {
    this.messages.length = 0;
  }
}
