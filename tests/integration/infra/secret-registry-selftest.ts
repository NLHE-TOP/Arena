#!/usr/bin/env tsx
/**
 * Focused regression for the generated-secret authority boundary.
 *
 * Product-authorized credentials must be redacted/manifested but allowed in an
 * NLHE child; platform-authority secrets must be rejected by the same check.
 */
import { verifySecretRegistryBoundary } from './secret-registry.js';

const { checks } = verifySecretRegistryBoundary();
console.log(`secret registry boundary PASS: ${checks.join(', ')}`);
