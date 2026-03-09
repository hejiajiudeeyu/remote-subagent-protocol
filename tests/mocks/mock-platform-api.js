export class MockPlatformApi {
  constructor() {
    this.tokens = new Map();
  }

  registerUser(userId = "user_mock") {
    return {
      user_id: userId,
      api_key: `sk_mock_${userId}`,
      role_scopes: ["buyer"]
    };
  }

  issueTaskToken(payload) {
    const token = `mock_token_${payload.request_id}`;
    const claims = {
      request_id: payload.request_id,
      buyer_id: payload.buyer_id,
      seller_id: payload.seller_id,
      subagent_id: payload.subagent_id,
      exp: Math.floor(Date.now() / 1000) + 900
    };
    this.tokens.set(token, claims);
    return { task_token: token, claims };
  }

  introspect(token) {
    const claims = this.tokens.get(token);
    if (!claims) {
      return { active: false, error: { code: "AUTH_TOKEN_NOT_FOUND", message: "token not found in store", retryable: false } };
    }
    return { active: true, claims };
  }
}
