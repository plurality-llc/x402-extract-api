import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Creates a paid fetch function that properly handles POST requests
 * through the x402 payment flow.
 *
 * The default wrapFetchWithPayment from @x402/fetch can lose the
 * method/body on retry. This wrapper preserves them.
 */
export function createPaidFetch(privateKey) {
  const signer = privateKeyToAccount(privateKey);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  return async (url, opts = {}) => {
    // First request — expect 402
    const firstRes = await fetch(url, opts);

    if (firstRes.status !== 402) return firstRes;

    // Parse payment requirements from 402 response
    const getHeader = (name) => firstRes.headers.get(name);
    let body;
    try {
      const text = await firstRes.text();
      if (text) body = JSON.parse(text);
    } catch {}

    const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);

    // Create payment payload (signs the transaction)
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // Retry with payment headers — explicitly preserve method and body
    const retryOpts = {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...paymentHeaders,
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
      },
    };

    return fetch(url, retryOpts);
  };
}
