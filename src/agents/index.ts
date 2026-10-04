/**
 * Durable product AgentRuntime public surface.
 *
 * Product wiring (API/orchestration) constructs:
 *
 * ```ts
 * const runtime = new AgentRuntime(config, {
 *   transport: new SdkAgentTransport({ baseUrl, token }),
 *   store: productStore,
 *   providerFactory: createProductDecisionProviderFactory({
 *     baseUrl: agent.baseUrl,
 *     model: agent.model,
 *     apiKey: credentials.apiKey,
 *     inputUsdMicroPerMillionTokens: agent.pricing.inputMicroUsdPerMillionTokens,
 *     outputUsdMicroPerMillionTokens: agent.pricing.outputMicroUsdPerMillionTokens,
 *   }),
 *   limiter, // one shared DecisionConcurrencyLimiter(maxConcurrency)
 *   audit,
 * });
 * await runtime.start();
 * ```
 */
export * from './contracts.js';
export * from './limiter.js';
export * from './runtime.js';
export * from './sdk-transport.js';
